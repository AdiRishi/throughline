import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcTest } from "effect/unstable/rpc";

import {
  ClusterId,
  IngestionJob,
  JourneyId,
  PRODUCT_WS_METHODS,
  PrRef,
  ProductOperationError,
  ProductWsRpcGroup,
  ReadStateMarkInvalidError,
  RepositoryPath,
  type GitHubPrListUpdatedEvent,
  type LocalPrState,
  type ReadState,
} from "@app/contracts";

import * as Ingestion from "../src/analysis/Ingestion.ts";
import * as GitHub from "../src/github/GitHub.ts";
import * as Harness from "../src/harness/AnalysisHarness.ts";
import * as JourneyQuery from "../src/journeys/JourneyQuery.ts";
import * as JourneyState from "../src/journeys/JourneyState.ts";
import * as JourneyStore from "../src/journeys/JourneyStore.ts";
import * as PullRequestIndex from "../src/pullRequests/PullRequestIndex.ts";
import { pullRequestIndexSyncLayer } from "../src/server.ts";
import * as Workspaces from "../src/workspace/Workspaces.ts";
import { makeProductWsRpcLayer } from "../src/ws.ts";

const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodeJourneyId = Schema.decodeUnknownSync(JourneyId);
const decodeClusterId = Schema.decodeUnknownSync(ClusterId);
const decodeRepositoryPath = Schema.decodeUnknownSync(RepositoryPath);
const decodeIngestionJob = Schema.decodeUnknownSync(Schema.toCodecJson(IngestionJob));

const PR = decodePrRef({ owner: "effect-ts", repo: "throughline", number: 42 });
const JOURNEY_ID = decodeJourneyId("journey-42");
const CLUSTER_ID = decodeClusterId("cluster-core");
const PATH = decodeRepositoryPath("src/core.ts");
const NOW = DateTime.makeUnsafe("2026-07-25T00:00:00.000Z");
const READ_STATE: ReadState = {
  journeyId: JOURNEY_ID,
  readFiles: [{ clusterId: CLUSTER_ID, path: PATH }],
  displayMode: "inline",
  updatedAt: NOW,
};
const LOCAL_PR_STATE: LocalPrState = {
  reviewed: [PR],
  hidden: [],
  dismissedMerged: [],
};
const INDEX_EVENT: GitHubPrListUpdatedEvent = {
  version: 1,
  sequence: 1,
  type: "updated",
  pullRequests: [],
  refreshedAt: NOW,
};

interface ProductServiceOverrides {
  readonly github?: Partial<GitHub.GitHub["Service"]>;
  readonly pullRequests?: Partial<PullRequestIndex.PullRequestIndex["Service"]>;
  readonly ingestion?: Partial<Ingestion.Ingestion["Service"]>;
  readonly journeyQuery?: Partial<JourneyQuery.JourneyQuery["Service"]>;
  readonly journeyState?: Partial<JourneyState.JourneyState["Service"]>;
  readonly store?: Partial<JourneyStore.JourneyStore["Service"]>;
  readonly harnesses?: Partial<Harness.AnalysisHarnessRegistry["Service"]>;
}

const productHandlerLayer = (overrides: ProductServiceOverrides) =>
  makeProductWsRpcLayer().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(GitHub.GitHub)(overrides.github ?? {}),
        Layer.mock(PullRequestIndex.PullRequestIndex)(overrides.pullRequests ?? {}),
        Layer.mock(Ingestion.Ingestion)(overrides.ingestion ?? {}),
        Layer.mock(JourneyQuery.JourneyQuery)(overrides.journeyQuery ?? {}),
        Layer.mock(JourneyState.JourneyState)(overrides.journeyState ?? {}),
        Layer.mock(JourneyStore.JourneyStore)(overrides.store ?? {}),
        Layer.mock(Harness.AnalysisHarnessRegistry)(overrides.harnesses ?? {}),
      ),
    ),
  );

describe("product WebSocket RPC handlers", () => {
  it.effect("wires explicit retry and recomputes the PR index after local state changes", () => {
    let retryCalls = 0;
    let recomputeCalls = 0;

    return Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ProductWsRpcGroup);

        yield* client[PRODUCT_WS_METHODS.githubRetry]({});
        const readState = yield* client[PRODUCT_WS_METHODS.readStateMarkFile]({
          journeyId: JOURNEY_ID,
          clusterId: CLUSTER_ID,
          path: PATH,
        });
        const prState = yield* client[PRODUCT_WS_METHODS.prStateReviewed]({
          pr: PR,
          active: true,
        });

        assert.strictEqual(retryCalls, 1);
        assert.strictEqual(recomputeCalls, 2);
        assert.deepStrictEqual(readState, READ_STATE);
        assert.deepStrictEqual(prState, LOCAL_PR_STATE);
      }).pipe(
        Effect.provide(
          productHandlerLayer({
            pullRequests: {
              retry: () =>
                Effect.sync(() => {
                  retryCalls += 1;
                  return INDEX_EVENT;
                }),
              recompute: () =>
                Effect.sync(() => {
                  recomputeCalls += 1;
                  return Option.none();
                }),
            },
            journeyState: {
              mark: () => Effect.succeed(READ_STATE),
            },
            store: {
              setReviewed: () => Effect.succeed(LOCAL_PR_STATE),
            },
          }),
        ),
      ),
    );
  });

  it.effect("finishes accepting ingestion after the caller cancels its request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const accepted = decodeIngestionJob({
          id: "job-accepted",
          pr: PR,
          phase: "queued",
          queuePosition: 1,
          startedAt: null,
          updatedAt: "2026-07-25T00:00:00.000Z",
          activity: null,
          journeyId: null,
          failure: null,
        });

        yield* Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(ProductWsRpcGroup);
          const request = yield* client[PRODUCT_WS_METHODS.ingestionStart]({
            source: { type: "ref", ref: PR },
          }).pipe(Effect.forkChild);

          yield* Deferred.await(entered);
          yield* Fiber.interrupt(request).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(completed);
        }).pipe(
          Effect.provide(
            productHandlerLayer({
              ingestion: {
                start: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    yield* Deferred.succeed(completed, undefined);
                    return accepted;
                  }),
              },
            }),
          ),
        );
      }),
    ),
  );

  it.effect("maps internal validation and operational failures to public wire errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ProductWsRpcGroup);

        const invalidMark = yield* client[PRODUCT_WS_METHODS.readStateMarkFile]({
          journeyId: JOURNEY_ID,
          clusterId: CLUSTER_ID,
          path: PATH,
        }).pipe(Effect.flip);
        assert.instanceOf(invalidMark, ReadStateMarkInvalidError);
        assert.strictEqual(invalidMark.journeyId, JOURNEY_ID);

        const workspaceFailure = yield* client[PRODUCT_WS_METHODS.journeyFileContent]({
          journeyId: JOURNEY_ID,
          path: PATH,
        }).pipe(Effect.flip);
        assert.instanceOf(workspaceFailure, ProductOperationError);
        assert.strictEqual(workspaceFailure.reason, "workspace");
        assert.strictEqual(workspaceFailure.operation, PRODUCT_WS_METHODS.journeyFileContent);

        const storageFailure = yield* client[PRODUCT_WS_METHODS.settingsGet]({}).pipe(Effect.flip);
        assert.instanceOf(storageFailure, ProductOperationError);
        assert.strictEqual(storageFailure.reason, "storage");
        assert.strictEqual(storageFailure.operation, PRODUCT_WS_METHODS.settingsGet);
      }).pipe(
        Effect.provide(
          productHandlerLayer({
            pullRequests: {
              recompute: () => Effect.succeed(Option.none()),
            },
            journeyState: {
              mark: () =>
                Effect.fail(
                  new JourneyState.InvalidReadMarkError({
                    journeyId: JOURNEY_ID,
                    clusterId: CLUSTER_ID,
                    path: PATH,
                  }),
                ),
            },
            journeyQuery: {
              fileContent: () =>
                Effect.fail(
                  new Workspaces.WorkspaceError({
                    reason: "io",
                    detail: "The pinned workspace is unavailable.",
                  }),
                ),
            },
            store: {
              getSettings: Effect.fail(
                new JourneyStore.JourneyStoreError({
                  operation: "read settings",
                  cause: "disk failure",
                }),
              ),
            },
          }),
        ),
      ),
    ),
  );
});

describe("pull request index synchronization", () => {
  it.effect("recomputes after an ingestion job completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recomputed = yield* Deferred.make<void>();
        const completed = decodeIngestionJob({
          id: "job-42",
          pr: PR,
          phase: "complete",
          queuePosition: null,
          startedAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:01:00.000Z",
          activity: null,
          journeyId: JOURNEY_ID,
          failure: null,
        });

        yield* Layer.build(
          pullRequestIndexSyncLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Ingestion.Ingestion)({
                  changes: Stream.make(completed),
                }),
                Layer.mock(PullRequestIndex.PullRequestIndex)({
                  recompute: () =>
                    Deferred.succeed(recomputed, undefined).pipe(Effect.as(Option.none())),
                }),
              ),
            ),
          ),
        );

        yield* Deferred.await(recomputed);
      }),
    ),
  );
});
