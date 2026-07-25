/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate.
 * The `WsRpcGroup` exposes server lifecycle, GitHub discovery, ingestion,
 * immutable journey artifacts, reading state, local PR state, and settings.
 *
 * @module ws
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type GitHubPrsStreamEvent,
  type PullRequestSummary,
} from "@app/contracts";
import { journeyProgress } from "@app/journey/progress";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import { GitHub } from "./github/GitHub.ts";
import { AnalysisHarness } from "./harness/AnalysisHarness.ts";
import { Ingestion } from "./ingestion/Ingestion.ts";
import { JourneyStore } from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import { ProductServicesLive } from "./product.ts";
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

/**
 * Register the RPC handlers. Snapshot streams subscribe before reading their
 * durable state, then discard buffered events older than the snapshot boundary.
 */
const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;
      const github = yield* GitHub;
      const ingestion = yield* Ingestion;
      const journeys = yield* JourneyStore;
      const workspaces = yield* Workspaces;
      const analysisHarness = yield* AnalysisHarness;

      const enrich = (
        pullRequests: ReadonlyArray<PullRequestSummary>,
      ): Effect.Effect<ReadonlyArray<PullRequestSummary>> =>
        Effect.gen(function* () {
          const stored = yield* journeys.list;
          return yield* Effect.forEach(
            pullRequests,
            (pullRequest) => {
              const match = stored.find(
                ({ journey }) =>
                  journey.pr.owner === pullRequest.ref.owner &&
                  journey.pr.repo === pullRequest.ref.repo &&
                  journey.pr.number === pullRequest.ref.number,
              );
              if (match === undefined) return Effect.succeed(pullRequest);
              return journeys.getReadState(match.journey.id).pipe(
                Effect.map((readState) => {
                  const progress = journeyProgress(match.journey.hunks, readState);
                  return {
                    ...pullRequest,
                    journey: {
                      exists: true,
                      stale: match.journey.pinned.headSha !== pullRequest.headSha,
                      readHunks: progress.read,
                      totalHunks: progress.total,
                    },
                  };
                }),
                Effect.orElseSucceed(() => pullRequest),
              );
            },
            { concurrency: 8 },
          );
        });

      const enrichPrEvent = (event: GitHubPrsStreamEvent): Effect.Effect<GitHubPrsStreamEvent> =>
        enrich(event.pullRequests).pipe(Effect.map((pullRequests) => ({ ...event, pullRequests })));

      return WsRpcGroup.of({
        [WS_METHODS.serverGetConfig]: () =>
          Effect.succeed({
            appName: config.appName,
            version: config.version,
            startedAt: config.startedAt,
          }),
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
        [WS_METHODS.githubViewer]: (input) => github.identity(input.refresh),
        [WS_METHODS.githubPrs]: (input) =>
          github.openPrs(input.refresh).pipe(Effect.flatMap(enrich)),
        [WS_METHODS.githubSubscribePrs]: () => github.changes.pipe(Stream.mapEffect(enrichPrEvent)),
        [WS_METHODS.ingestionStart]: (input) => ingestion.start(input),
        [WS_METHODS.ingestionCancel]: (input) => ingestion.cancel(input.id),
        [WS_METHODS.ingestionSubscribe]: () => ingestion.changes,
        [WS_METHODS.journeyGet]: (input) =>
          journeys.get(input.pr).pipe(Effect.map((stored) => stored.journey)),
        [WS_METHODS.journeyFilePatch]: (input) =>
          journeys
            .getById(input.journeyId)
            .pipe(Effect.flatMap((stored) => workspaces.filePatch(stored, input.path))),
        [WS_METHODS.journeyFileContent]: (input) =>
          journeys
            .getById(input.journeyId)
            .pipe(Effect.flatMap((stored) => workspaces.fileContent(stored, input.path))),
        [WS_METHODS.journeyFiles]: (input) =>
          journeys.getById(input.journeyId).pipe(
            Effect.flatMap((stored) =>
              Effect.all(
                {
                  patches: Effect.forEach(
                    input.paths,
                    (requestedPath) => workspaces.filePatch(stored, requestedPath),
                    { concurrency: "unbounded" },
                  ),
                  contents: Effect.forEach(
                    input.paths,
                    (requestedPath) => workspaces.fileContent(stored, requestedPath),
                    { concurrency: "unbounded" },
                  ),
                },
                { concurrency: 2 },
              ),
            ),
            Effect.map(({ patches, contents }) => ({
              journeyId: input.journeyId,
              patches,
              contents,
            })),
          ),
        [WS_METHODS.journeyTree]: (input) =>
          journeys
            .getById(input.journeyId)
            .pipe(Effect.flatMap((stored) => workspaces.tree(stored))),
        [WS_METHODS.readStateGet]: (input) => journeys.getReadState(input.journeyId),
        [WS_METHODS.readStateMarkFile]: (input) => journeys.markFile({ ...input, read: true }),
        [WS_METHODS.readStateUnmarkFile]: (input) => journeys.markFile({ ...input, read: false }),
        [WS_METHODS.readStateSetDisplayMode]: (input) => journeys.setDisplayMode(input),
        [WS_METHODS.readStateSubscribe]: (input) => journeys.readStateChanges(input.journeyId),
        [WS_METHODS.prStateGet]: () => journeys.getPrState,
        [WS_METHODS.prStateReviewed]: (input) => journeys.setPrState("reviewed", input),
        [WS_METHODS.prStateHide]: (input) => journeys.setPrState("hidden", input),
        [WS_METHODS.prStateDismissMerged]: (input) => journeys.setPrState("dismissedMerged", input),
        [WS_METHODS.harnessStatus]: () => analysisHarness.statuses,
        [WS_METHODS.settingsGet]: () => journeys.getSettings,
        [WS_METHODS.settingsUpdate]: (input) => journeys.updateSettings(input),
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

    return yield* Effect.gen(function* () {
      const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
        disableTracing: true,
      });
      return yield* rpcWebSocketHttpEffect;
    }).pipe(
      Effect.provide(
        makeWsRpcLayer().pipe(
          Layer.provideMerge(RpcSerialization.layerJson),
          Layer.provide(ProductServicesLive),
        ),
      ),
    );
  }),
);
