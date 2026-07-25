import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  type AnalysisStage,
  GitHubReadError,
  IngestionDoorRejectionError,
  IngestionJobId,
  type IngestionActivity,
  type IngestionJob,
  type IngestionJobId as IngestionJobIdValue,
  type IngestionPhase,
  type IngestionSource,
  type IngestionStreamEvent,
  JourneyId,
  type PrDetail,
  type PrRef,
  RepositoryPath,
  type RepositoryPath as RepositoryPathValue,
} from "@app/contracts";

import * as GitHub from "../github/GitHub.ts";
import * as Harness from "../harness/AnalysisHarness.ts";
import * as JourneyStore from "../journeys/JourneyStore.ts";
import { fromLivePubSub, fromLiveSubscription } from "../liveSubscription.ts";
import * as AnalysisPipeline from "./AnalysisPipeline.ts";

const decodeIngestionJobId = Schema.decodeUnknownEffect(IngestionJobId);
const decodeJourneyId = Schema.decodeUnknownEffect(JourneyId);
const isRepositoryPath = Schema.is(RepositoryPath);

interface RuntimeJob {
  job: IngestionJob;
  readonly harness: Harness.AnalysisHarness;
  cancelRequested: boolean;
  stage: AnalysisStage;
  readonly observedFiles: Set<string>;
  scope?: Scope.Closeable;
  fiber?: Fiber.Fiber<void, never>;
}

interface PublishedUpdate {
  readonly prKey: string;
  readonly sequence: number;
  readonly job: IngestionJob;
}

interface State {
  readonly jobs: Map<string, RuntimeJob>;
  readonly activeByPr: Map<string, string>;
  readonly latestByPr: Map<string, string>;
  readonly sequenceByPr: Map<string, number>;
  pending: Array<string>;
  running: string | null;
}

export class Ingestion extends Context.Service<
  Ingestion,
  {
    readonly start: (
      source: IngestionSource,
    ) => Effect.Effect<IngestionJob, IngestionDoorRejectionError>;
    readonly cancel: (jobId: IngestionJobIdValue) => Effect.Effect<IngestionJob | null>;
    readonly subscribe: (pr: PrRef) => Stream.Stream<IngestionStreamEvent>;
    readonly changes: Stream.Stream<IngestionJob>;
  }
>()("@app/server/analysis/Ingestion") {}

const prKey = (pr: PrRef): string => `${pr.owner}/${pr.repo}#${pr.number}`;

const sourceLabel = (source: IngestionSource): string =>
  source.type === "url"
    ? source.url
    : `${source.ref.owner}/${source.ref.repo}#${source.ref.number}`;

const doorError = (
  reason: IngestionDoorRejectionError["reason"],
  source: IngestionSource,
  detail: string,
): IngestionDoorRejectionError =>
  new IngestionDoorRejectionError({
    reason,
    input: sourceLabel(source),
    detail,
  });

const isIngestible = (detail: PrDetail, now: DateTime.Utc): boolean => {
  if (detail.state === "open") return true;
  if (detail.state !== "merged" || detail.mergedAt === null) return false;
  return (
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(detail.mergedAt) <=
    7 * 24 * 60 * 60 * 1_000
  );
};

const terminal = (phase: IngestionPhase): boolean =>
  phase === "complete" || phase === "cancelled" || phase === "failed";

const normalizeObservedPath = (value: string | undefined): RepositoryPathValue | null => {
  if (value === undefined || value.includes("\0") || value.includes("\\")) return null;
  const normalized = value.replaceAll("\\", "/");
  const repositoryMarker = "/repository/";
  const markerIndex = normalized.lastIndexOf(repositoryMarker);
  const candidate = normalized.startsWith("repository/")
    ? normalized.slice("repository/".length)
    : markerIndex === -1
      ? null
      : normalized.slice(markerIndex + repositoryMarker.length);
  return candidate !== null && isRepositoryPath(candidate) ? candidate : null;
};

const observedCounter = (
  counters: Readonly<Record<string, number>> | undefined,
  key: string,
): number => {
  const value = counters?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

const errorDetail = (
  cause: Cause.Cause<AnalysisPipeline.AnalysisPipelineError>,
): {
  readonly code: string;
  readonly message: string;
} => {
  const squashed = Cause.squash(cause);
  if (squashed instanceof AnalysisPipeline.AnalysisPipelineError) {
    return { code: squashed.code, message: squashed.detail };
  }
  if (squashed instanceof Error) {
    return { code: "analysis", message: squashed.message || "Analysis failed." };
  }
  return { code: "analysis", message: String(squashed) || "Analysis failed." };
};

export const make = Effect.gen(function* () {
  const github = yield* GitHub.GitHub;
  const store = yield* JourneyStore.JourneyStore;
  const harnesses = yield* Harness.AnalysisHarnessRegistry;
  const pipeline = yield* AnalysisPipeline.AnalysisPipeline;
  const crypto = yield* Crypto.Crypto;
  const parentScope = yield* Scope.Scope;
  const mutationGate = yield* Semaphore.make(1);
  const workQueue = yield* Queue.unbounded<string>();
  const updates = yield* PubSub.unbounded<PublishedUpdate>();
  const state: State = {
    jobs: new Map(),
    activeByPr: new Map(),
    latestByPr: new Map(),
    sequenceByPr: new Map(),
    pending: [],
    running: null,
  };

  const publish = (runtime: RuntimeJob): Effect.Effect<void> => {
    const key = prKey(runtime.job.pr);
    const sequence = (state.sequenceByPr.get(key) ?? 0) + 1;
    state.sequenceByPr.set(key, sequence);
    return PubSub.publish(updates, { prKey: key, sequence, job: runtime.job }).pipe(Effect.asVoid);
  };

  const updateQueuePositions = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let index = 0; index < state.pending.length; index += 1) {
        const runtime = state.jobs.get(state.pending[index]!);
        if (runtime === undefined || runtime.job.phase !== "queued") continue;
        const position = index + 1;
        if (runtime.job.queuePosition === position) continue;
        const now = yield* DateTime.now;
        runtime.job = { ...runtime.job, queuePosition: position, updatedAt: now };
        yield* publish(runtime);
      }
    });

  const activeFor = (ref: PrRef): RuntimeJob | undefined => {
    const id = state.activeByPr.get(prKey(ref));
    return id === undefined ? undefined : state.jobs.get(id);
  };

  const setPhase = (id: string, phase: IngestionPhase): Effect.Effect<void> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const runtime = state.jobs.get(id);
        if (
          runtime === undefined ||
          runtime.cancelRequested ||
          terminal(runtime.job.phase) ||
          runtime.job.phase === phase
        ) {
          return;
        }
        const now = yield* DateTime.now;
        runtime.job = {
          ...runtime.job,
          phase,
          queuePosition: null,
          updatedAt: now,
          activity: phase === "analyzing" ? runtime.job.activity : null,
        };
        yield* publish(runtime);
      }),
    );

  const setStage = (id: string, stage: AnalysisStage): Effect.Effect<void> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const runtime = state.jobs.get(id);
        if (runtime === undefined || runtime.cancelRequested || runtime.job.phase !== "analyzing") {
          return;
        }
        runtime.stage = stage;
        const now = yield* DateTime.now;
        runtime.job = { ...runtime.job, activity: null, updatedAt: now };
        yield* publish(runtime);
      }),
    );

  const observe = (
    id: string,
    stage: AnalysisStage,
    event: Harness.HarnessProgressEvent,
  ): Effect.Effect<void> => {
    if (event.type !== "activity") return Effect.void;
    const action = event.action.trim();
    if (action.length === 0) return Effect.void;

    return mutationGate.withPermit(
      Effect.gen(function* () {
        const runtime = state.jobs.get(id);
        if (
          runtime === undefined ||
          runtime.cancelRequested ||
          runtime.job.phase !== "analyzing" ||
          runtime.stage !== stage
        ) {
          return;
        }
        const currentFile = normalizeObservedPath(event.path);
        if (currentFile !== null) runtime.observedFiles.add(currentFile);
        const previous = runtime.job.activity;
        const counters = {
          filesWalked: Math.max(
            runtime.observedFiles.size,
            observedCounter(event.counters, "filesWalked"),
            previous?.counters.filesWalked ?? 0,
          ),
          symbolsTraced: Math.max(
            observedCounter(event.counters, "symbolsTraced"),
            previous?.counters.symbolsTraced ?? 0,
          ),
          callSitesFollowed: Math.max(
            observedCounter(event.counters, "callSitesFollowed"),
            previous?.counters.callSitesFollowed ?? 0,
          ),
        };
        const activity: IngestionActivity = {
          stage,
          currentAction: action,
          currentFile,
          recentActions:
            previous === null
              ? []
              : [...new Set([previous.currentAction, ...previous.recentActions])]
                  .filter((previousAction) => previousAction !== action)
                  .slice(0, 5),
          counters,
        };
        const now = yield* DateTime.now;
        runtime.job = { ...runtime.job, activity, updatedAt: now };
        yield* publish(runtime);
      }),
    );
  };

  const finishComplete = (
    id: string,
    result: AnalysisPipeline.AnalysisPipelineResult,
  ): Effect.Effect<void> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const runtime = state.jobs.get(id);
        if (runtime === undefined) return;
        if (runtime.cancelRequested) {
          const key = prKey(runtime.job.pr);
          const now = yield* DateTime.now;
          runtime.job = {
            ...runtime.job,
            phase: "cancelled",
            queuePosition: null,
            updatedAt: now,
            activity: null,
            failure: null,
          };
          yield* publish(runtime);
          if (state.activeByPr.get(key) === id) state.activeByPr.delete(key);
          if (state.running === id) state.running = null;
          return;
        }
        const key = prKey(runtime.job.pr);
        const now = yield* DateTime.now;
        runtime.job = {
          ...runtime.job,
          phase: "complete",
          queuePosition: null,
          updatedAt: now,
          activity: null,
          journeyId: result.journey.id,
          failure: null,
        };
        yield* publish(runtime);
        if (state.activeByPr.get(key) === id) state.activeByPr.delete(key);
        if (state.running === id) state.running = null;
      }),
    );

  const finishFailed = (
    id: string,
    cause: Cause.Cause<AnalysisPipeline.AnalysisPipelineError>,
  ): Effect.Effect<void> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const runtime = state.jobs.get(id);
        if (runtime === undefined) return;
        if (runtime.cancelRequested || Cause.hasInterrupts(cause)) {
          const key = prKey(runtime.job.pr);
          const now = yield* DateTime.now;
          const alreadyPublished = runtime.job.phase === "cancelled";
          runtime.job = {
            ...runtime.job,
            phase: "cancelled",
            queuePosition: null,
            updatedAt: now,
            activity: null,
            failure: null,
          };
          if (!alreadyPublished) yield* publish(runtime);
          if (state.activeByPr.get(key) === id) state.activeByPr.delete(key);
          if (state.running === id) state.running = null;
          return;
        }
        const failure = errorDetail(cause);
        const key = prKey(runtime.job.pr);
        const now = yield* DateTime.now;
        runtime.job = {
          ...runtime.job,
          phase: "failed",
          queuePosition: null,
          updatedAt: now,
          activity: null,
          failure,
        };
        yield* publish(runtime);
        if (state.activeByPr.get(key) === id) state.activeByPr.delete(key);
        if (state.running === id) state.running = null;
      }),
    );

  const runNext = (id: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const runtime = yield* mutationGate.withPermit(
        Effect.gen(function* () {
          const candidate = state.jobs.get(id);
          if (candidate === undefined || candidate.job.phase !== "queued") {
            return null;
          }
          state.pending = state.pending.filter((pendingId) => pendingId !== id);
          state.running = id;
          const now = yield* DateTime.now;
          candidate.job = {
            ...candidate.job,
            phase: "resolving",
            queuePosition: null,
            startedAt: now,
            updatedAt: now,
          };
          yield* publish(candidate);
          yield* updateQueuePositions();
          return candidate;
        }),
      );
      if (runtime === null) return;

      const runScope = yield* Scope.make("sequential");
      const program = pipeline
        .run({
          pr: runtime.job.pr,
          runId: runtime.job.id,
          journeyId: runtime.job.id as unknown as JourneyId,
          harness: runtime.harness,
          callbacks: {
            onPhase: (phase) => setPhase(id, phase),
            onStage: (stage) => setStage(id, stage),
            onHarnessEvent: (stage, event) => observe(id, stage, event),
          },
        })
        .pipe(
          Scope.provide(runScope),
          Effect.matchCauseEffect({
            onFailure: (cause) => finishFailed(id, cause),
            onSuccess: (result) => finishComplete(id, result),
          }),
          Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
        );
      const fiber = yield* Effect.forkIn(program, parentScope);
      const shouldCancel = yield* mutationGate.withPermit(
        Effect.sync(() => {
          const current = state.jobs.get(id);
          if (current === undefined) return true;
          current.scope = runScope;
          current.fiber = fiber;
          return current.cancelRequested;
        }),
      );
      if (shouldCancel) yield* Fiber.interrupt(fiber);
      yield* Fiber.await(fiber);
    });

  yield* Effect.forkScoped(Effect.forever(Queue.take(workQueue).pipe(Effect.flatMap(runNext))));

  const resolveSource = (source: IngestionSource) =>
    source.type === "ref" ? Effect.succeed(source.ref) : github.resolveUrl(source.url);

  const selectHarness = (source: IngestionSource) =>
    store.getSettings.pipe(
      Effect.mapError((cause) =>
        doorError(
          "harness-unavailable",
          source,
          `Could not read the selected analysis harness: ${cause.message}`,
        ),
      ),
      Effect.flatMap((settings) =>
        harnesses
          .select(settings.harness)
          .pipe(Effect.mapError((cause) => doorError("harness-unavailable", source, cause.detail))),
      ),
    );

  const start = Effect.fn("Ingestion.start")(function* (source: IngestionSource) {
    const ref = yield* resolveSource(source);
    const existing = yield* mutationGate.withPermit(Effect.sync(() => activeFor(ref)?.job ?? null));
    if (existing !== null) return existing;

    const [detail, selectedHarness] = yield* Effect.all(
      [
        github
          .pr(ref)
          .pipe(
            Effect.mapError((cause) =>
              cause instanceof GitHubReadError &&
              (cause.reason === "not-found" || cause.reason === "forbidden")
                ? doorError("not-found", source, "The pull request could not be found.")
                : doorError(
                    "gh-unavailable",
                    source,
                    cause instanceof GitHubReadError
                      ? cause.detail
                      : "GitHub is temporarily unavailable.",
                  ),
            ),
          ),
        selectHarness(source),
      ],
      { concurrency: "unbounded" },
    );
    const now = yield* DateTime.now;
    if (!isIngestible(detail, now)) {
      return yield* doorError(
        "not-open",
        source,
        "Only open or recently merged pull requests can be analyzed.",
      );
    }
    const acceptedRef = detail.ref;

    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(() =>
        doorError("harness-unavailable", source, "Could not allocate an analysis job."),
      ),
    );
    const id = yield* decodeIngestionJobId(uuid).pipe(Effect.orDie);
    yield* decodeJourneyId(uuid).pipe(Effect.orDie);

    return yield* mutationGate.withPermit(
      Effect.gen(function* () {
        const duplicate = activeFor(acceptedRef);
        if (duplicate !== undefined) return duplicate.job;

        const priorId = state.latestByPr.get(prKey(acceptedRef));
        if (priorId !== undefined) {
          const prior = state.jobs.get(priorId);
          if (prior !== undefined && terminal(prior.job.phase)) state.jobs.delete(priorId);
        }
        const queuedAt = yield* DateTime.now;
        const job: IngestionJob = {
          id,
          pr: acceptedRef,
          phase: "queued",
          queuePosition: state.pending.length + 1,
          startedAt: null,
          updatedAt: queuedAt,
          activity: null,
          journeyId: null,
          failure: null,
        };
        const runtime: RuntimeJob = {
          job,
          harness: selectedHarness,
          cancelRequested: false,
          stage: "planning",
          observedFiles: new Set(),
        };
        state.jobs.set(id, runtime);
        state.activeByPr.set(prKey(acceptedRef), id);
        state.latestByPr.set(prKey(acceptedRef), id);
        state.pending.push(id);
        yield* publish(runtime);
        yield* Queue.offer(workQueue, id);
        return runtime.job;
      }),
    );
  });

  const cancel = (jobId: IngestionJobIdValue): Effect.Effect<IngestionJob | null> =>
    Effect.gen(function* () {
      const outcome = yield* mutationGate.withPermit(
        Effect.gen(function* () {
          const runtime = state.jobs.get(jobId);
          if (runtime === undefined || terminal(runtime.job.phase)) {
            return { job: runtime?.job ?? null, fiber: undefined };
          }
          if (runtime.job.phase === "saving") {
            return { job: runtime.job, fiber: undefined };
          }
          runtime.cancelRequested = true;
          const now = yield* DateTime.now;
          runtime.job = {
            ...runtime.job,
            phase: "cancelled",
            queuePosition: null,
            updatedAt: now,
            activity: null,
            failure: null,
          };
          const wasQueued = state.pending.includes(jobId);
          if (wasQueued) {
            state.pending = state.pending.filter((id) => id !== jobId);
            const key = prKey(runtime.job.pr);
            if (state.activeByPr.get(key) === jobId) state.activeByPr.delete(key);
          }
          yield* publish(runtime);
          if (wasQueued) yield* updateQueuePositions();
          return { job: runtime.job, fiber: runtime.fiber };
        }),
      );
      if (outcome.fiber !== undefined) yield* Fiber.interrupt(outcome.fiber);
      return outcome.job;
    });

  return Ingestion.of({
    start,
    cancel,
    subscribe: (ref) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(updates);
          const key = prKey(ref);
          const [sequence, job] = yield* mutationGate.withPermit(
            Effect.sync(() => {
              const latestId = state.latestByPr.get(key);
              return [
                state.sequenceByPr.get(key) ?? 0,
                latestId === undefined ? null : (state.jobs.get(latestId)?.job ?? null),
              ] as const;
            }),
          );
          const snapshot: IngestionStreamEvent = {
            version: 1,
            sequence,
            type: "snapshot",
            job,
          };
          const live = fromLiveSubscription(subscription).pipe(
            Stream.filter((event) => event.prKey === key && event.sequence > sequence),
            Stream.map(
              (event): IngestionStreamEvent => ({
                version: 1,
                sequence: event.sequence,
                type: "updated",
                job: event.job,
              }),
            ),
          );
          return Stream.concat(Stream.make(snapshot), live);
        }),
      ),
    changes: fromLivePubSub(updates).pipe(Stream.map((event) => event.job)),
  });
});

export const serviceLayer = Layer.effect(Ingestion, make);
export const layer = serviceLayer.pipe(Layer.provide(AnalysisPipeline.layer));
