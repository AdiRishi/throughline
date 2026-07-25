import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  GitHubReadError,
  IngestionDoorRejectionError,
  Journey,
  PrDetail,
  PrRef,
  type IngestionJob,
  type IngestionPhase,
  type Journey as JourneyValue,
  type PrDetail as PrDetailValue,
  type PrRef as PrRefValue,
} from "@app/contracts";

import * as AnalysisPipeline from "../../src/analysis/AnalysisPipeline.ts";
import * as Ingestion from "../../src/analysis/Ingestion.ts";
import * as GitHub from "../../src/github/GitHub.ts";
import {
  AnalysisHarnessRegistry,
  type AnalysisHarness,
} from "../../src/harness/AnalysisHarness.ts";
import * as JourneyStore from "../../src/journeys/JourneyStore.ts";

const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodePrDetail = Schema.decodeUnknownSync(Schema.toCodecJson(PrDetail));
const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));

const ref = (number: number): PrRefValue => decodePrRef({ owner: "acme", repo: "rocket", number });

const detail = (pr: PrRefValue, state: "open" | "closed" = "open") =>
  decodePrDetail({
    ref: pr,
    title: `Pull request ${pr.number}`,
    body: "A complete description.",
    author: { login: "octocat", avatarUrl: null },
    url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
    state,
    baseRefName: "main",
    headSha: "2222222222222222222222222222222222222222",
    baseSha: "1111111111111111111111111111111111111111",
    updatedAt: "2026-07-25T00:00:00.000Z",
    mergedAt: null,
    changedFiles: 0,
    additions: 0,
    deletions: 0,
    journey: null,
  });

const journey = (pr: PrRefValue, id: JourneyValue["id"]): JourneyValue =>
  decodeJourney({
    formatVersion: 1,
    id,
    pr,
    pinned: {
      headSha: "2222222222222222222222222222222222222222",
      baseSha: "1111111111111111111111111111111111111111",
      analyzedAt: "2026-07-25T00:00:00.000Z",
    },
    provenance: { harnessKind: "test" },
    overview: {
      brief: { markdown: "No changed files." },
      whereToBegin: { markdown: "There is nothing to review." },
    },
    clusters: [],
    hunks: [],
    files: [],
    hints: [],
  });

const harness: AnalysisHarness = {
  kind: "test",
  detect: Effect.succeed({
    kind: "test",
    installed: true,
    version: "1.0.0",
    auth: "authenticated",
  }),
  run: () => Effect.die("The fake pipeline owns execution."),
};

const store = JourneyStore.JourneyStore.of({
  listMetadata: Effect.succeed([]),
  listRunReferences: Effect.succeed([]),
  getByPr: () => Effect.succeedNone,
  getById: () => Effect.succeedNone,
  replace: () => Effect.succeedNone,
  remove: () => Effect.succeedNone,
  getReadState: () => Effect.succeedNone,
  setDisplayMode: () => Effect.die("unused"),
  setReadMark: () => Effect.die("unused"),
  getLocalPrState: Effect.succeed({
    reviewed: [],
    hidden: [],
    dismissedMerged: [],
  }),
  setReviewed: () => Effect.die("unused"),
  setHidden: () => Effect.die("unused"),
  setDismissedMerged: () => Effect.die("unused"),
  getSettings: Effect.succeed({}),
  setHarness: () => Effect.succeed({}),
});

const registry = AnalysisHarnessRegistry.of({
  statuses: Effect.succeed([]),
  status: () =>
    Effect.succeed({ kind: "test", installed: true, version: null, auth: "authenticated" }),
  select: () => Effect.succeed(harness),
});

const github = (
  read: (pr: PrRefValue) => Effect.Effect<PrDetailValue, GitHubReadError> = (pr) =>
    Effect.succeed(detail(pr)),
) =>
  GitHub.GitHub.of({
    identity: () => Effect.die("unused"),
    repositories: () => Effect.die("unused"),
    pullRequests: () => Effect.die("unused"),
    openPrs: () => Effect.die("unused"),
    recentlyMergedPrs: () => Effect.die("unused"),
    pr: read,
    refreshPrs: () => Effect.die("unused"),
    retry: () => Effect.die("unused"),
    resolveUrl: () => Effect.die("unused"),
    cloneCredentials: () => Effect.die("unused"),
  });

const makeIngestion = (
  run: AnalysisPipeline.AnalysisPipeline["Service"]["run"],
  githubService = github(),
) =>
  Ingestion.make.pipe(
    Effect.provideService(
      AnalysisPipeline.AnalysisPipeline,
      AnalysisPipeline.AnalysisPipeline.of({ run }),
    ),
    Effect.provideService(GitHub.GitHub, githubService),
    Effect.provideService(JourneyStore.JourneyStore, store),
    Effect.provideService(AnalysisHarnessRegistry, registry),
  );

const awaitPhase = (
  ingestion: Ingestion.Ingestion["Service"],
  pr: PrRefValue,
  phase: IngestionPhase,
): Effect.Effect<IngestionJob> =>
  ingestion.subscribe(pr).pipe(
    Stream.filter((event) => event.job !== null && event.job.phase === phase),
    Stream.runHead,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die(`Stream ended before ${phase}.`),
        onSome: (event) => Effect.succeed(event.job!),
      }),
    ),
  );

describe("Ingestion", () => {
  it.layer(NodeCrypto.layer)("job supervision", (it) => {
    it.effect("runs globally one at a time and publishes honest queue positions", () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const runCount = yield* Ref.make(0);
        const active = yield* Ref.make(0);
        const maxActive = yield* Ref.make(0);
        const service = yield* makeIngestion((input) =>
          Effect.gen(function* () {
            const index = yield* Ref.getAndUpdate(runCount, (count) => count + 1);
            const current = yield* Ref.updateAndGet(active, (count) => count + 1);
            yield* Ref.update(maxActive, (maximum) => Math.max(maximum, current));
            if (index === 0) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
            yield* Ref.update(active, (count) => count - 1);
            return { journey: journey(input.pr, input.journeyId) };
          }),
        );

        const first = yield* service.start({ type: "ref", ref: ref(1) });
        yield* Deferred.await(firstStarted);
        const second = yield* service.start({ type: "ref", ref: ref(2) });
        const third = yield* service.start({ type: "ref", ref: ref(3) });

        assert.strictEqual(first.queuePosition, 1);
        assert.strictEqual(second.queuePosition, 1);
        assert.strictEqual(third.queuePosition, 2);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* awaitPhase(service, ref(1), "complete");
        yield* awaitPhase(service, ref(2), "complete");
        yield* awaitPhase(service, ref(3), "complete");
        assert.strictEqual(yield* Ref.get(maxActive), 1);
        assert.strictEqual(yield* Ref.get(runCount), 3);
      }),
    );

    it.effect("returns the same active job for duplicate starts", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const runCount = yield* Ref.make(0);
        const service = yield* makeIngestion((input) =>
          Effect.gen(function* () {
            yield* Ref.update(runCount, (count) => count + 1);
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { journey: journey(input.pr, input.journeyId) };
          }),
        );
        const pr = ref(11);
        const first = yield* service.start({ type: "ref", ref: pr });
        yield* Deferred.await(started);
        const duplicate = yield* service.start({ type: "ref", ref: pr });

        assert.strictEqual(duplicate.id, first.id);
        assert.strictEqual(yield* Ref.get(runCount), 1);
        yield* Deferred.succeed(release, undefined);
        yield* awaitPhase(service, pr, "complete");
      }),
    );

    it.effect("publishes a concise trail of distinct observed actions", () =>
      Effect.gen(function* () {
        const activityPublished = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const service = yield* makeIngestion((input) =>
          Effect.gen(function* () {
            yield* input.callbacks.onPhase("analyzing");
            yield* input.callbacks.onStage("planning");
            for (const action of [
              "Reading the pinned change",
              "Reading the pinned change",
              "Tracing the change through repository context",
              "Tracing the change through repository context",
              "Reading the pinned change",
            ]) {
              yield* input.callbacks.onHarnessEvent("planning", {
                type: "activity",
                action,
              });
            }
            yield* Deferred.succeed(activityPublished, undefined);
            yield* Deferred.await(release);
            return { journey: journey(input.pr, input.journeyId) };
          }),
        );
        const pr = ref(12);

        yield* service.start({ type: "ref", ref: pr });
        yield* Deferred.await(activityPublished);
        const active = yield* service.subscribe(pr).pipe(
          Stream.filter(
            (event) =>
              event.job?.activity?.currentAction === "Reading the pinned change" &&
              event.job.activity.recentActions[0] ===
                "Tracing the change through repository context",
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        assert.deepStrictEqual(active.job?.activity?.recentActions, [
          "Tracing the change through repository context",
        ]);
        yield* Deferred.succeed(release, undefined);
        yield* awaitPhase(service, pr, "complete");
      }),
    );

    it.effect("interrupts a running job and exposes cancellation as terminal state", () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const service = yield* makeIngestion(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
          ),
        );
        const pr = ref(21);
        const accepted = yield* service.start({ type: "ref", ref: pr });
        yield* Deferred.await(started);

        const cancelled = yield* service.cancel(accepted.id);

        assert.strictEqual(cancelled?.phase, "cancelled");
        yield* Deferred.await(interrupted);
        assert.strictEqual((yield* awaitPhase(service, pr, "cancelled")).id, accepted.id);
      }),
    );

    it.effect("turns post-accept operational failures into failed job events", () =>
      Effect.gen(function* () {
        const service = yield* makeIngestion(() =>
          Effect.fail(
            new AnalysisPipeline.AnalysisPipelineError({
              code: "workspace",
              detail: "Clone failed.",
            }),
          ),
        );
        const pr = ref(31);

        const accepted = yield* service.start({ type: "ref", ref: pr });
        const failed = yield* awaitPhase(service, pr, "failed");

        assert.strictEqual(accepted.phase, "queued");
        assert.deepStrictEqual(failed.failure, {
          code: "workspace",
          message: "Clone failed.",
        });
      }),
    );

    it.effect("rejects at the typed door before allocating a job", () =>
      Effect.gen(function* () {
        const service = yield* makeIngestion(
          () => Effect.die("must not run"),
          github((pr) => Effect.succeed(detail(pr, "closed"))),
        );

        const rejection = yield* service.start({ type: "ref", ref: ref(41) }).pipe(Effect.flip);

        assert.instanceOf(rejection, IngestionDoorRejectionError);
        assert.strictEqual(rejection.reason, "not-open");
      }),
    );
  });
});
