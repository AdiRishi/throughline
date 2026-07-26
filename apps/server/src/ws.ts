/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate,
 * then registers every method in `WsRpcGroup`. The handlers here are thin by
 * design: each one is a call into the module that owns the behaviour, so this
 * file stays a map of the wire surface rather than a place logic accumulates.
 *
 * @module ws
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  FileUnavailableError,
  JourneyNotFoundError,
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type TickEvent,
} from "@app/contracts";

import { Ingestion } from "./analysis/Ingestion.ts";
import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import { GitHub } from "./github/GitHub.ts";
import { AnalysisHarness } from "./harness/AnalysisHarness.ts";
import { JourneyStore } from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import { PrListView } from "./welcome/PrListView.ts";
import { Workspaces } from "./workspace/Workspaces.ts";

/**
 * Extract a bearer token from the upgrade request: `Authorization: Bearer <t>`
 * header, or `?access_token=<t>` query param (browsers can't set WS headers).
 */
function extractBearer(request: HttpServerRequest.HttpServerRequest): Option.Option<string> {
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header)) {
    const match = /^Bearer\s+(.+)$/i.exec(header.value.trim());
    if (match?.[1]) {
      return Option.some(match[1].trim());
    }
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const token = url.value.searchParams.get("access_token");
    if (token) {
      return Option.some(token);
    }
  }
  return Option.none();
}

const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;
      const github = yield* GitHub;
      const prList = yield* PrListView;
      const ingestion = yield* Ingestion;
      const store = yield* JourneyStore;
      const workspaces = yield* Workspaces;
      const harnesses = yield* AnalysisHarness;

      /**
       * Journey file reads need the run directory the journey was built in.
       * Resolving it here keeps `journeyId` the only thing the renderer has to
       * know about where bytes live.
       */
      const resolveRun = Effect.fn("ws.resolveRun")(function* (journeyId: string) {
        const journey = yield* store.journeyById(journeyId as never);
        if (journey === null) {
          return yield* new JourneyNotFoundError({ journeyId: journeyId as never });
        }
        const runDir = yield* workspaces.runDirectory(journey.pr, journey.provenance.runId);
        return { journey, runDir };
      });

      return WsRpcGroup.of({
        [WS_METHODS.serverGetConfig]: () =>
          Effect.succeed({
            appName: config.appName,
            version: config.version,
            startedAt: config.startedAt,
          }),
        [WS_METHODS.serverEcho]: (input) =>
          DateTime.now.pipe(Effect.map((receivedAt) => ({ message: input.message, receivedAt }))),
        [WS_METHODS.serverSubscribeTicks]: () =>
          Stream.tick("1 second").pipe(
            Stream.mapAccum(
              () => 0,
              (count, _void) => {
                const next = count + 1;
                return [next, [next]] as const;
              },
            ),
            Stream.mapEffect((tick) =>
              DateTime.now.pipe(Effect.map((at): TickEvent => ({ tick, at }))),
            ),
          ),
        [WS_METHODS.serverSubscribeLifecycle]: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((item) => Queue.offer(liveBuffer, item)),
                ),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);

              const snapshot = yield* lifecycleEvents.snapshot;
              const replay = snapshot.events.toSorted((a, b) => a.sequence - b.sequence);
              const live = bufferedLiveStream.pipe(
                Stream.filter(
                  (event: ServerLifecycleStreamEvent) => event.sequence > snapshot.sequence,
                ),
              );
              return Stream.concat(Stream.fromIterable(replay), live);
            }),
          ),

        // ── GitHub ───────────────────────────────────────────────────────────
        [WS_METHODS.githubViewer]: () =>
          github.identity.pipe(
            Effect.orElseSucceed(() => ({
              login: null,
              ghInstalled: false,
              authenticated: false,
              host: null,
            })),
          ),
        [WS_METHODS.githubPrs]: () => prList.current,
        [WS_METHODS.githubSubscribePrs]: () => prList.changes,
        [WS_METHODS.githubRefresh]: () => prList.refresh,

        // ── Ingestion ────────────────────────────────────────────────────────
        [WS_METHODS.ingestionStart]: (input) =>
          ingestion.start({ target: input.target, reanalyze: input.reanalyze }),
        [WS_METHODS.ingestionCancel]: (input) => ingestion.cancel(input.jobId),
        [WS_METHODS.ingestionSubscribe]: (input) => ingestion.watch(input.pr),

        // ── Journey ──────────────────────────────────────────────────────────
        [WS_METHODS.journeyGet]: (input) => store.journeyFor(input.pr),
        [WS_METHODS.journeyFilePatch]: (input) =>
          resolveRun(input.journeyId).pipe(
            Effect.flatMap(({ runDir }) =>
              workspaces
                .filePatch(runDir, input.path)
                .pipe(Effect.map((patch) => ({ path: input.path, patch }))),
            ),
            Effect.mapError(toFileError(input.journeyId, input.path)),
          ),
        [WS_METHODS.journeyFileContent]: (input) =>
          resolveRun(input.journeyId).pipe(
            Effect.flatMap(({ journey, runDir }) =>
              workspaces
                .fileRevisions({
                  pr: journey.pr,
                  runDir,
                  headSha: journey.pinned.headSha,
                  path: input.path,
                })
                .pipe(
                  Effect.map((revisions) => ({
                    path: input.path,
                    old: revisions.old,
                    new: revisions.new,
                    binary: revisions.binary,
                    omitted: revisions.omitted,
                  })),
                ),
            ),
            Effect.mapError(toFileError(input.journeyId, input.path)),
          ),
        [WS_METHODS.journeyTree]: (input) =>
          resolveRun(input.journeyId).pipe(
            Effect.flatMap(({ runDir }) =>
              workspaces.tree(runDir).pipe(Effect.map((paths) => ({ paths }))),
            ),
            Effect.catch((cause) =>
              cause._tag === "JourneyNotFoundError"
                ? Effect.fail(cause)
                : Effect.succeed({ paths: [] as ReadonlyArray<string> }),
            ),
          ),

        // ── Read state ───────────────────────────────────────────────────────
        [WS_METHODS.readStateGet]: (input) => store.readState(input.journeyId),
        [WS_METHODS.readStateMarkFile]: (input) =>
          store.markFile({
            journeyId: input.journeyId,
            clusterId: input.clusterId,
            path: input.path,
            read: true,
          }),
        [WS_METHODS.readStateUnmarkFile]: (input) =>
          store.markFile({
            journeyId: input.journeyId,
            clusterId: input.clusterId,
            path: input.path,
            read: false,
          }),
        [WS_METHODS.readStateSetDisplayMode]: (input) =>
          store.setDisplayMode({ journeyId: input.journeyId, mode: input.mode }),
        [WS_METHODS.readStateSubscribe]: (input) => store.readStateChanges(input.journeyId),

        // ── Local PR marks ───────────────────────────────────────────────────
        [WS_METHODS.prStateReviewed]: (input) =>
          store.setPrMark({ pr: input.pr, mark: "reviewed", value: input.value }),
        [WS_METHODS.prStateHide]: (input) =>
          store.setPrMark({ pr: input.pr, mark: "hidden", value: input.value }),
        [WS_METHODS.prStateDismissMerged]: (input) =>
          store.setPrMark({ pr: input.pr, mark: "dismissedMerged", value: true }),

        // ── Harness + settings ───────────────────────────────────────────────
        [WS_METHODS.harnessStatus]: () =>
          Effect.gen(function* () {
            const statuses = yield* harnesses.statuses;
            const settings = yield* store.settings;
            const active = yield* harnesses.select(settings.harness);
            return {
              harnesses: statuses,
              selected: settings.harness,
              active: active?.kind ?? null,
            };
          }),
        [WS_METHODS.settingsGet]: () => store.settings,
        [WS_METHODS.settingsUpdate]: (input) => store.updateSettings({ harness: input.harness }),
      });
    }),
  );

const toFileError =
  (journeyId: string, path: string) =>
  (cause: { readonly _tag: string; readonly message: string }) =>
    cause._tag === "JourneyNotFoundError"
      ? (cause as unknown as JourneyNotFoundError)
      : new FileUnavailableError({ journeyId: journeyId as never, path, detail: cause.message });

/**
 * The `/ws` upgrade route. Rejects with 401 when no valid bearer is present,
 * otherwise hands the socket to the RPC server.
 */
export const websocketRpcRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* Auth.BearerSessionStore;

    const token = extractBearer(request);
    if (Option.isNone(token)) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }
    const valid = yield* auth.authenticateBearer(token.value);
    if (!valid) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      disableTracing: true,
    }).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

    return yield* rpcWebSocketHttpEffect;
  }),
);
