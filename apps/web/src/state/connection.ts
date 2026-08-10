import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Socket from "effect/unstable/socket/Socket";

import { bootstrapRemoteBearerSession } from "@app/client-runtime/authorization";
import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionSupervisor,
  connectionSupervisorLayer,
  ConnectionTransientError,
  mapBearerBootstrapError,
  INITIAL_CONNECTION_STATE,
  type PreparedConnection,
} from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { ServerConfig, ServerLifecyclePhase } from "@app/contracts";

import { isElectron, resolveConnectionTargetResult } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { ClientTracingLive, configureClientTracing } from "../observability/clientTracing.ts";
import { browserConnectivityLayer, browserWakeupsLayer } from "./platformSignals.ts";

const BOOTSTRAP_TOKEN = import.meta.env.VITE_BOOTSTRAP_TOKEN;

/**
 * Obtain a bearer token (integration contract):
 * - In the shell: ask the bridge.
 * - In the browser: POST the bootstrap credential and read `access_token`.
 */
function obtainBearerToken(httpBaseUrl: string): Effect.Effect<string, ConnectionAttemptError> {
  if (isElectron && window.desktopBridge) {
    const bridge = window.desktopBridge;
    return Effect.tryPromise({
      try: () => bridge.getBearerToken(),
      catch: (cause) =>
        new ConnectionTransientError({
          reason: "transport",
          detail: `Bridge failed to mint a bearer token: ${String(cause)}`,
        }),
    });
  }
  return bootstrapRemoteBearerSession({
    httpBaseUrl,
    credential: BOOTSTRAP_TOKEN,
    clientMetadata: { label: "web", deviceType: "web" },
  }).pipe(
    Effect.map((session) => session.access_token),
    Effect.mapError(mapBearerBootstrapError),
    // The browser path talks HTTP through Effect's client rather than raw
    // `fetch`, so the exchange needs a concrete implementation.
    Effect.provide(FetchHttpClient.layer),
  );
}

/** Build the fully-formed WS URL, carrying the token as a query param. */
function socketUrl(wsBaseUrl: string, token: string): string {
  const base = wsBaseUrl.replace(/\/$/, "");
  return `${base}/ws?access_token=${encodeURIComponent(token)}`;
}

/**
 * The connection layer: the supervisor (which owns the socket + reconnect
 * loop) over the one platform seam it needs — a browser WebSocket constructor.
 * The connection target and bearer token are resolved inside EVERY attempt, so
 * a bridge whose server bootstrap is not ready yet, or a failed mint, is just
 * another transient failure the supervisor backs off from and retries — while
 * a rejected credential (401/403) blocks the loop until it changes.
 */
export function makeConnectionLayer(): Layer.Layer<ConnectionSupervisor> {
  const connection: PreparedConnection = {
    label: "server",
    prepareSocketUrl: Effect.suspend(() => {
      // A target that cannot be parsed is broken configuration, not weather:
      // backing off would retry the same malformed URL forever, and letting the
      // throw escape would make it a defect that kills the runtime and every
      // atom on it. Park instead, with the reason on the connection state where
      // the UI already renders it.
      const targetRead = resolveConnectionTargetResult();
      if (targetRead._tag === "Failure") {
        return Effect.fail(
          new ConnectionBlockedError({
            reason: "configuration",
            detail: errorMessage(targetRead.cause),
          }),
        );
      }
      const target = targetRead.target;
      return obtainBearerToken(target.httpBaseUrl).pipe(
        // The trace-ingest route is bearer-gated like `/ws`, so hand the
        // exporter the credential this attempt just minted. Tracing is not
        // load-bearing: a failure here must never fail the connection.
        Effect.tap((token) =>
          Effect.promise(() => configureClientTracing({ bearerToken: token })).pipe(Effect.ignore),
        ),
        Effect.map((token) => socketUrl(target.wsBaseUrl, token)),
      );
    }),
  };
  return connectionSupervisorLayer(connection).pipe(
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    // Without these the supervisor's platform seams stay at their no-op
    // defaults, and a `blocked` connection has nothing that can wake it.
    Layer.provide(browserConnectivityLayer),
    Layer.provide(browserWakeupsLayer),
    Layer.provideMerge(observabilityLayer),
  );
}

/**
 * The renderer's observability, mirroring the server and shell: pretty logs to
 * the DevTools console, plus `Logger.tracerLogger` so logs emitted inside a
 * span become span events. The tracer exports those spans to the server, which
 * writes them into the same trace file it writes its own spans to — so a
 * renderer failure is readable without opening DevTools.
 *
 * `configureClientTracing` is kicked off when the layer is built rather than at
 * module load, because the export URL depends on the resolved connection
 * target. Until it completes, spans are local-only.
 */
const observabilityLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
  ClientTracingLive,
  Layer.effectDiscard(Effect.promise(() => configureClientTracing())),
);

/**
 * Build the app's atoms against an `AtomRuntime` that provides the supervisor.
 * A factory (rather than module-level atoms) so tests can instantiate the same
 * atoms over a scripted runtime — the pattern the reference repo uses for its
 * state modules.
 */
export function createConnectionAtoms<R, E>(
  runtime: Atom.AtomRuntime<ConnectionSupervisor | R, E>,
) {
  const stateResultAtom = runtime.atom(
    Stream.unwrap(
      ConnectionSupervisor.pipe(
        Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
      ),
    ),
    { initialValue: INITIAL_CONNECTION_STATE },
  );

  /** The coarse phase + attempt count the UI renders. Never empty. */
  const stateAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(stateResultAtom)), () => INITIAL_CONNECTION_STATE),
  ).pipe(Atom.withLabel("connection-state"));

  /**
   * Server config, re-fetched per session: every fresh session emits one
   * `getConfig` result (the "first request doubles as initial sync" contract),
   * and a drop clears it back to null. A failed fetch also yields null instead
   * of killing the stream, so the next reconnect still re-syncs.
   */
  const serverConfigResultAtom = runtime.atom(
    Stream.unwrap(
      ConnectionSupervisor.pipe(
        Effect.map((supervisor) =>
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.switchMap(
              Option.match({
                onNone: () => Stream.succeed(null),
                onSome: () =>
                  Stream.fromEffect(
                    rpcRequest("server.getConfig", {}).pipe(
                      Effect.option,
                      Effect.map(Option.getOrNull),
                    ),
                  ),
              }),
            ),
          ),
        ),
      ),
    ),
  );

  const serverConfigAtom = Atom.make((get): ServerConfig | null =>
    Option.getOrElse(AsyncResult.value(get(serverConfigResultAtom)), () => null),
  ).pipe(Atom.withLabel("server-config"));

  // Live lifecycle stream. The client-runtime subscription watches the session
  // ref and re-attaches across reconnects by itself, so the atom subscribes
  // once for as long as it stays mounted.
  const lifecycleResultAtom = runtime.atom(
    rpcSubscribe("server.subscribeLifecycle", {}).pipe(Stream.map((event) => event.phase)),
  );

  const lifecycleAtom = Atom.make((get): ServerLifecyclePhase | null =>
    Option.getOrNull(AsyncResult.value(get(lifecycleResultAtom))),
  ).pipe(Atom.withLabel("server-lifecycle"));

  return {
    state: stateAtom,
    serverConfig: serverConfigAtom,
    lifecycle: lifecycleAtom,
  } as const;
}

/** The app's runtime + atoms. Components import these; tests build their own. */
export const connectionRuntime: Atom.AtomRuntime<ConnectionSupervisor> =
  Atom.runtime(makeConnectionLayer());

export const connectionAtoms = createConnectionAtoms(connectionRuntime);
