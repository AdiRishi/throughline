/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate.
 * Every method in `WsRpcGroup` is registered here, and the split is the
 * architecture's: **unary for immutable artifacts, snapshot-then-live streams for
 * anything that moves.**
 *
 * Every stream in this file follows one shape — buffer the live events first,
 * take a snapshot, then concatenate the snapshot with the buffered live events.
 * Doing it in that order is what makes a reconnecting subscriber fold without a
 * gap or a duplicate; snapshotting first would drop anything that happened while
 * the snapshot was being built.
 *
 * @module ws
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  WS_METHODS,
  WsRpcGroup,
  type IngestionStreamEvent,
  type PrListStreamEvent,
  type ReadStateStreamEvent,
  type ServerLifecycleStreamEvent,
  type TickEvent,
} from "@app/contracts";

import { Ingestion } from "./analysis/Ingestion.ts";
import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import { GitHub } from "./github/GitHub.ts";
import { AnalysisHarness } from "./harness/AnalysisHarness.ts";
import { JourneyReader } from "./journeys/JourneyReader.ts";
import { JourneyStore } from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import { PrList } from "./prs/PrList.ts";

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

/**
 * Buffer live events, snapshot, then replay-and-follow. `sequence` is assigned by
 * the subscription rather than the bus: the underlying stores publish whole
 * values, and monotonic numbering is a property of *this* subscriber, which is
 * exactly what a reconnecting client needs in order to fold safely.
 */
const snapshotThenLive = <Source, Event>(input: {
  readonly live: Stream.Stream<Source>;
  readonly snapshot: Effect.Effect<Source>;
  readonly toEvent: (source: Source, sequence: number, type: "snapshot" | "update") => Event;
}): Stream.Stream<Event> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const buffer = yield* Queue.unbounded<Source>();
      yield* Effect.forkScoped(
        input.live.pipe(Stream.runForEach((item) => Queue.offer(buffer, item))),
      );
      const first = yield* input.snapshot;
      const sequence = yield* Ref.make(0);
      const next = (type: "snapshot" | "update") => (source: Source) =>
        Ref.updateAndGet(sequence, (current) => current + 1).pipe(
          Effect.map((value) => input.toEvent(source, value, type)),
        );
      return Stream.concat(
        Stream.fromEffect(next("snapshot")(first)),
        Stream.fromQueue(buffer).pipe(Stream.mapEffect(next("update"))),
      );
    }),
  );

const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;
      const github = yield* GitHub;
      const prList = yield* PrList;
      const ingestion = yield* Ingestion;
      const store = yield* JourneyStore;
      const reader = yield* JourneyReader;
      const harnesses = yield* AnalysisHarness;

      return WsRpcGroup.of({
        // ── transport templates ──
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

        // ── GitHub ──
        [WS_METHODS.githubViewer]: () => github.identity,

        [WS_METHODS.githubSubscribePrs]: () =>
          snapshotThenLive({
            live: prList.changes,
            snapshot: prList.snapshot.pipe(
              Effect.map((list) => ({ reason: "initial" as const, list })),
            ),
            toEvent: (source, sequence): PrListStreamEvent => ({
              version: 1,
              sequence,
              reason: source.reason,
              list: source.list,
            }),
          }),

        [WS_METHODS.githubRefreshPrs]: () => prList.refresh.pipe(Effect.asVoid),

        [WS_METHODS.githubResolveUrl]: (input) => github.resolveUrl(input.url),

        // ── Ingestion ──
        [WS_METHODS.ingestionStart]: (input) =>
          ingestion.start({ ref: input.ref, reanalyze: input.reanalyze }),

        [WS_METHODS.ingestionCancel]: (input) => ingestion.cancel(input.ref),

        [WS_METHODS.ingestionSubscribe]: () =>
          snapshotThenLive({
            live: ingestion.changes,
            snapshot: ingestion.jobs,
            toEvent: (jobs, sequence, type): IngestionStreamEvent => ({
              version: 1,
              sequence,
              type,
              jobs,
            }),
          }),

        // ── Journey (immutable per journey — cacheable forever client-side) ──
        [WS_METHODS.journeyGet]: (input) => reader.envelope(input.ref),
        [WS_METHODS.journeyFilePatch]: (input) => reader.filePatch(input.journeyId, input.path),
        [WS_METHODS.journeyFileContent]: (input) => reader.fileContent(input.journeyId, input.path),
        [WS_METHODS.journeyTree]: (input) => reader.tree(input.journeyId),

        // ── Read state ──
        [WS_METHODS.readStateGet]: (input) => store.readState(input.journeyId).pipe(Effect.orDie),
        [WS_METHODS.readStateMarkFile]: (input) =>
          store
            .markFile({
              journeyId: input.journeyId,
              clusterId: input.clusterId,
              path: input.path,
              read: true,
            })
            .pipe(Effect.orDie),
        [WS_METHODS.readStateUnmarkFile]: (input) =>
          store
            .markFile({
              journeyId: input.journeyId,
              clusterId: input.clusterId,
              path: input.path,
              read: false,
            })
            .pipe(Effect.orDie),
        [WS_METHODS.readStateSetDisplayMode]: (input) =>
          store
            .setDisplayMode({ journeyId: input.journeyId, displayMode: input.displayMode })
            .pipe(Effect.orDie),
        [WS_METHODS.readStateSubscribe]: (input) =>
          snapshotThenLive({
            // Filtered to this journey: a second window reading a different one
            // must not wake this subscription.
            live: store.changes.pipe(
              Stream.filter(
                (change) => change._tag === "readState" && change.journeyId === input.journeyId,
              ),
              Stream.mapEffect(() => store.readState(input.journeyId).pipe(Effect.orDie)),
            ),
            snapshot: store.readState(input.journeyId).pipe(Effect.orDie),
            toEvent: (state, sequence, type): ReadStateStreamEvent => ({
              version: 1,
              sequence,
              type,
              state,
            }),
          }),

        // ── Local PR marks ──
        [WS_METHODS.prStateSetReviewed]: (input) =>
          store
            .setPrFlag({ ref: input.ref, flag: "reviewed", value: input.value })
            .pipe(Effect.asVoid, Effect.orDie),
        [WS_METHODS.prStateSetHidden]: (input) =>
          store
            .setPrFlag({ ref: input.ref, flag: "hidden", value: input.value })
            .pipe(Effect.asVoid, Effect.orDie),
        [WS_METHODS.prStateDismissMerged]: (input) =>
          store
            .setPrFlag({ ref: input.ref, flag: "dismissedMerged", value: true })
            .pipe(Effect.asVoid, Effect.orDie),

        // ── Harness + settings ──
        [WS_METHODS.harnessStatus]: () =>
          store.settings.pipe(
            Effect.orDie,
            Effect.flatMap((settings) => harnesses.report(settings.harness)),
          ),

        [WS_METHODS.settingsGet]: () => store.settings.pipe(Effect.orDie),

        [WS_METHODS.settingsUpdate]: (input) =>
          store.updateSettings(input).pipe(
            Effect.orDie,
            // A harness change should be visible immediately, so drop the
            // detection cache rather than waiting out its TTL.
            Effect.tap(() => harnesses.invalidate),
          ),
      });
    }),
  );

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
