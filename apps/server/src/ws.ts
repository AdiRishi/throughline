/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate.
 * `/ws` serves the complete product group together with the server supervision
 * methods. Product handlers translate every typed internal failure to a
 * schema-serializable wire error.
 *
 * @module ws
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Rpc, RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  CompleteWsRpcGroup,
  JourneyNotFoundError,
  PRODUCT_WS_METHODS,
  ProductOperationError,
  ProductWsRpcGroup,
  ReadStateMarkInvalidError,
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
} from "@app/contracts";
import { safeDiagnosticErrorType } from "@app/shared/safeLog";

import * as Ingestion from "./analysis/Ingestion.ts";
import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as GitHub from "./github/GitHub.ts";
import * as Harness from "./harness/AnalysisHarness.ts";
import * as JourneyQuery from "./journeys/JourneyQuery.ts";
import * as JourneyState from "./journeys/JourneyState.ts";
import * as JourneyStore from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as PullRequestIndex from "./pullRequests/PullRequestIndex.ts";
import * as Workspaces from "./workspace/Workspaces.ts";

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
 * Register the core server handlers. Product handlers are kept in their own
 * layer so they can be exercised through the in-memory RPC transport.
 */
const makeCoreWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;

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
      });
    }),
  );

const nonEmptyDetail = (detail: string): string =>
  detail.trim() || "The operation could not be completed.";

const logRpcFailure = (method: string, error: unknown) =>
  Effect.logWarning("RPC operation failed").pipe(
    Effect.annotateLogs({
      component: "rpc",
      rpcMethod: method,
      errorType: safeDiagnosticErrorType(error),
    }),
  );

const withRpcFailureLogging =
  (method: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.tapError((error) => logRpcFailure(method, error)));

const withRpcStreamFailureLogging =
  (method: string) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(Stream.tapError((error) => logRpcFailure(method, error)));

const storeOperationError =
  (operation: string) =>
  (error: JourneyStore.JourneyStoreError): ProductOperationError =>
    new ProductOperationError({
      reason: "storage",
      operation,
      detail: nonEmptyDetail(error.message),
    });

const workspaceOperationError =
  (operation: string) =>
  (error: Workspaces.WorkspaceError): ProductOperationError =>
    new ProductOperationError({
      reason: "workspace",
      operation,
      detail: nonEmptyDetail(error.detail),
    });

const indexOperationError =
  (operation: string) =>
  (
    error: PullRequestIndex.PullRequestIndexError,
  ):
    | Exclude<
        PullRequestIndex.PullRequestIndexError,
        JourneyStore.JourneyStoreError | Workspaces.WorkspaceError
      >
    | ProductOperationError =>
    error instanceof JourneyStore.JourneyStoreError
      ? storeOperationError(operation)(error)
      : error instanceof Workspaces.WorkspaceError
        ? workspaceOperationError(operation)(error)
        : error;

const journeyQueryGetError =
  (operation: string) =>
  (
    error: JourneyQuery.JourneyQueryGetError,
  ):
    | Exclude<
        JourneyQuery.JourneyQueryGetError,
        JourneyStore.JourneyStoreError | Workspaces.WorkspaceError
      >
    | ProductOperationError => {
    if (error instanceof JourneyStore.JourneyStoreError) {
      return storeOperationError(operation)(error);
    }
    return error instanceof Workspaces.WorkspaceError
      ? workspaceOperationError(operation)(error)
      : error;
  };

const journeyQueryArtifactError =
  (operation: string) =>
  (
    error: JourneyQuery.JourneyQueryArtifactError,
  ):
    | Exclude<
        JourneyQuery.JourneyQueryArtifactError,
        JourneyStore.JourneyStoreError | Workspaces.WorkspaceError
      >
    | ProductOperationError => {
    if (error instanceof JourneyStore.JourneyStoreError) {
      return storeOperationError(operation)(error);
    }
    return error instanceof Workspaces.WorkspaceError
      ? workspaceOperationError(operation)(error)
      : error;
  };

const journeyQueryFileError =
  (operation: string) =>
  (
    error: JourneyQuery.JourneyQueryFileError,
  ):
    | Exclude<
        JourneyQuery.JourneyQueryFileError,
        JourneyStore.JourneyStoreError | Workspaces.WorkspaceError
      >
    | ProductOperationError => {
    if (error instanceof JourneyStore.JourneyStoreError) {
      return storeOperationError(operation)(error);
    }
    return error instanceof Workspaces.WorkspaceError
      ? workspaceOperationError(operation)(error)
      : error;
  };

const journeyStateError =
  (operation: string) =>
  (error: JourneyState.JourneyStateError): JourneyNotFoundError | ProductOperationError => {
    if (error instanceof JourneyState.JourneyStateNotFoundError) {
      return new JourneyNotFoundError({ journeyId: error.journeyId });
    }
    return storeOperationError(operation)(error);
  };

const journeyStateMutationError =
  (operation: string) =>
  (
    error: JourneyState.JourneyStateMutationError,
  ): JourneyNotFoundError | ReadStateMarkInvalidError | ProductOperationError => {
    if (error instanceof JourneyState.InvalidReadMarkError) {
      return new ReadStateMarkInvalidError({
        journeyId: error.journeyId,
        clusterId: error.clusterId,
        path: error.path,
      });
    }
    return journeyStateError(operation)(error);
  };

export const makeProductWsRpcLayer = () =>
  ProductWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const github = yield* GitHub.GitHub;
      const pullRequests = yield* PullRequestIndex.PullRequestIndex;
      const ingestion = yield* Ingestion.Ingestion;
      const journeyQuery = yield* JourneyQuery.JourneyQuery;
      const journeyState = yield* JourneyState.JourneyState;
      const store = yield* JourneyStore.JourneyStore;
      const harnesses = yield* Harness.AnalysisHarnessRegistry;

      const recomputePullRequests = (operation: string) =>
        pullRequests.recompute().pipe(
          Effect.ignore({
            log: "Warn",
            message: `Failed to refresh the pull request index after ${operation}.`,
          }),
        );

      return ProductWsRpcGroup.of({
        [PRODUCT_WS_METHODS.githubViewer]: () =>
          github.identity().pipe(withRpcFailureLogging(PRODUCT_WS_METHODS.githubViewer)),
        [PRODUCT_WS_METHODS.githubPrs]: () =>
          pullRequests.subscribe.pipe(
            withRpcStreamFailureLogging(PRODUCT_WS_METHODS.githubPrs),
            Stream.mapError(indexOperationError(PRODUCT_WS_METHODS.githubPrs)),
          ),
        [PRODUCT_WS_METHODS.githubRefreshPrs]: () =>
          pullRequests
            .refresh()
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.githubRefreshPrs),
              Effect.mapError(indexOperationError(PRODUCT_WS_METHODS.githubRefreshPrs)),
              Effect.asVoid,
            ),
        [PRODUCT_WS_METHODS.githubRetry]: () =>
          pullRequests
            .retry()
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.githubRetry),
              Effect.mapError(indexOperationError(PRODUCT_WS_METHODS.githubRetry)),
              Effect.asVoid,
            ),
        [PRODUCT_WS_METHODS.ingestionStart]: ({ source }) =>
          Rpc.uninterruptible(ingestion.start(source)),
        [PRODUCT_WS_METHODS.ingestionCancel]: ({ jobId }) => ingestion.cancel(jobId),
        [PRODUCT_WS_METHODS.ingestionSubscribe]: ({ pr }) => ingestion.subscribe(pr),
        [PRODUCT_WS_METHODS.journeyGet]: ({ pr }) =>
          journeyQuery
            .get(pr)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.journeyGet),
              Effect.mapError(journeyQueryGetError(PRODUCT_WS_METHODS.journeyGet)),
            ),
        [PRODUCT_WS_METHODS.journeyFilePatch]: ({ journeyId, path }) =>
          journeyQuery
            .filePatch(journeyId, path)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.journeyFilePatch),
              Effect.mapError(journeyQueryFileError(PRODUCT_WS_METHODS.journeyFilePatch)),
            ),
        [PRODUCT_WS_METHODS.journeyFileContent]: ({ journeyId, path }) =>
          journeyQuery
            .fileContent(journeyId, path)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.journeyFileContent),
              Effect.mapError(journeyQueryFileError(PRODUCT_WS_METHODS.journeyFileContent)),
            ),
        [PRODUCT_WS_METHODS.journeyTree]: ({ journeyId }) =>
          journeyQuery
            .tree(journeyId)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.journeyTree),
              Effect.mapError(journeyQueryArtifactError(PRODUCT_WS_METHODS.journeyTree)),
            ),
        [PRODUCT_WS_METHODS.readStateGet]: ({ journeyId }) =>
          journeyState
            .get(journeyId)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.readStateGet),
              Effect.mapError(journeyStateError(PRODUCT_WS_METHODS.readStateGet)),
            ),
        [PRODUCT_WS_METHODS.readStateMarkFile]: ({ clusterId, journeyId, path }) =>
          journeyState.mark(journeyId, { clusterId, path }).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.readStateMarkFile),
            Effect.mapError(journeyStateMutationError(PRODUCT_WS_METHODS.readStateMarkFile)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.readStateMarkFile)),
          ),
        [PRODUCT_WS_METHODS.readStateUnmarkFile]: ({ clusterId, journeyId, path }) =>
          journeyState.unmark(journeyId, { clusterId, path }).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.readStateUnmarkFile),
            Effect.mapError(journeyStateMutationError(PRODUCT_WS_METHODS.readStateUnmarkFile)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.readStateUnmarkFile)),
          ),
        [PRODUCT_WS_METHODS.readStateSetDisplayMode]: ({ displayMode, journeyId }) =>
          journeyState.setDisplayMode(journeyId, displayMode).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.readStateSetDisplayMode),
            Effect.mapError(journeyStateError(PRODUCT_WS_METHODS.readStateSetDisplayMode)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.readStateSetDisplayMode)),
          ),
        [PRODUCT_WS_METHODS.readStateSubscribe]: ({ journeyId }) =>
          journeyState
            .subscribe(journeyId)
            .pipe(
              withRpcStreamFailureLogging(PRODUCT_WS_METHODS.readStateSubscribe),
              Stream.mapError(journeyStateError(PRODUCT_WS_METHODS.readStateSubscribe)),
            ),
        [PRODUCT_WS_METHODS.prStateGet]: () =>
          store.getLocalPrState.pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.prStateGet),
            Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.prStateGet)),
          ),
        [PRODUCT_WS_METHODS.prStateReviewed]: ({ active, pr }) =>
          store.setReviewed(pr, active).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.prStateReviewed),
            Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.prStateReviewed)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.prStateReviewed)),
          ),
        [PRODUCT_WS_METHODS.prStateHide]: ({ active, pr }) =>
          store.setHidden(pr, active).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.prStateHide),
            Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.prStateHide)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.prStateHide)),
          ),
        [PRODUCT_WS_METHODS.prStateDismissMerged]: ({ active, pr }) =>
          store.setDismissedMerged(pr, active).pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.prStateDismissMerged),
            Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.prStateDismissMerged)),
            Effect.tap(() => recomputePullRequests(PRODUCT_WS_METHODS.prStateDismissMerged)),
          ),
        [PRODUCT_WS_METHODS.harnessStatus]: () =>
          harnesses.statuses.pipe(Effect.map((statuses) => ({ harnesses: statuses }))),
        [PRODUCT_WS_METHODS.settingsGet]: () =>
          store.getSettings.pipe(
            withRpcFailureLogging(PRODUCT_WS_METHODS.settingsGet),
            Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.settingsGet)),
          ),
        [PRODUCT_WS_METHODS.settingsUpdate]: ({ harness }) =>
          store
            .setHarness(harness === null ? undefined : harness)
            .pipe(
              withRpcFailureLogging(PRODUCT_WS_METHODS.settingsUpdate),
              Effect.mapError(storeOperationError(PRODUCT_WS_METHODS.settingsUpdate)),
            ),
      });
    }),
  );

const makeCompleteWsRpcLayer = () => Layer.merge(makeCoreWsRpcLayer(), makeProductWsRpcLayer());

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

    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(CompleteWsRpcGroup, {
      disableTracing: true,
    }).pipe(
      Effect.provide(makeCompleteWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))),
    );

    return yield* rpcWebSocketHttpEffect;
  }),
);
