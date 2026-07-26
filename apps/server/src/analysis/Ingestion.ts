/**
 * `Ingestion` — PR in, journey out, honest progress events.
 *
 * Callers see three verbs: start a job, watch events, and (rarely) cancel. Clone
 * orchestration, prompt assembly, validation, and repair are implementation.
 *
 * The shape that matters most in this file is the **ladder**, because it is what
 * turns the vision's always-commit principle into an invariant of the system
 * rather than a hope about a model:
 *
 * 1. **Validate** — pure validators return precise, machine-generated violations.
 * 2. **Repair** — those violations go back to the *same thread* as a correction
 *    turn, up to two rounds. Most failures are near-misses.
 * 3. **Regenerate** — narration that still fails is discarded and rerun once;
 *    a clean second attempt beats deterministically mutilating prose.
 * 4. **Deterministic completion** — at the floor, the pipeline finishes the
 *    artifact itself, honestly, and records every fallback it stood on.
 *
 * Failure is *operational*, never analytical. A clone error, a crashed harness, a
 * full disk can fail a run and say so plainly, with retry as the remedy. What
 * cannot exist is "too tangled to decompose".
 *
 * @module analysis/Ingestion
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  DoorRejection,
  type AnalysisStage,
  type HarnessKind,
  type IngestionJob,
  type IngestionPhase,
  type Journey,
  type JourneyId,
  type PrRef,
  type PrSummary,
  type StartIngestionResult,
} from "@app/contracts";
import {
  formatViolations,
  validateJourney,
  type PinnedTree,
  type Violation,
} from "@app/journey/coverage";
import {
  assembleNarration,
  degeneratePlan,
  materializePlan,
  type ClusterNarrationInput,
  type JourneyPlanInput,
  type MaterializedPlan,
  type OverviewNarrationInput,
} from "@app/journey/plan";

import { GitHub, type GitHubError } from "../github/GitHub.ts";
import { AnalysisHarness } from "../harness/AnalysisHarness.ts";
import type { HarnessActivity, HarnessSession } from "../harness/model.ts";
import { JourneyStore, prKey } from "../journeys/JourneyStore.ts";
import { Workspaces, type PreparedRun } from "../workspace/Workspaces.ts";
import {
  CLUSTER_SCHEMA,
  clusterPrompt,
  OVERVIEW_SCHEMA,
  overviewPrompt,
  PLAN_SCHEMA,
  planPrompt,
  repairPrompt,
} from "./prompts.ts";

/** Harness runs are heavy; exactly one analysis runs at a time, and the queue says so. */
const ANALYSIS_CONCURRENCY = 1;
/** Two correction rounds, per the specification. */
const REPAIR_ROUNDS = 2;
/** How much recent activity the transition's trail shows. */
const TRAIL_LENGTH = 6;

export class Ingestion extends Context.Service<
  Ingestion,
  {
    /** Door checks, then a supervised job. Door rejections are the only errors. */
    readonly start: (input: {
      readonly ref: PrRef;
      readonly reanalyze: boolean;
    }) => Effect.Effect<StartIngestionResult, DoorRejection>;
    /** Closes the job's scope; the harness subprocess dies with it. */
    readonly cancel: (ref: PrRef) => Effect.Effect<void>;
    readonly jobs: Effect.Effect<ReadonlyArray<IngestionJob>>;
    /** Every job-state change, for the snapshot-then-live stream. */
    readonly changes: Stream.Stream<ReadonlyArray<IngestionJob>>;
  }
>()("@app/server/analysis/Ingestion") {}

interface JobRecord {
  readonly state: IngestionJob;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const harnesses = yield* AnalysisHarness;
  const store = yield* JourneyStore;
  const workspaces = yield* Workspaces;
  const crypto = yield* Crypto.Crypto;

  const jobs = yield* SynchronizedRef.make<ReadonlyMap<string, JobRecord>>(new Map());
  const changes = yield* PubSub.unbounded<ReadonlyArray<IngestionJob>>();
  const analysisGate = yield* Semaphore.make(ANALYSIS_CONCURRENCY);
  /** Owns every job fiber, so a server shutdown tears down running analyses. */
  const jobScope = yield* Effect.scope;

  const snapshot = SynchronizedRef.get(jobs).pipe(
    Effect.map((map) => [...map.values()].map((record) => record.state)),
  );

  const publish = Effect.gen(function* () {
    const current = yield* snapshot;
    yield* PubSub.publish(changes, current);
  });

  /** Every state transition goes through here, so nothing moves unobserved. */
  const patch = (ref: PrRef, update: (state: IngestionJob) => IngestionJob) =>
    SynchronizedRef.updateEffect(jobs, (map) =>
      Effect.gen(function* () {
        const existing = map.get(prKey(ref));
        if (existing === undefined) return map;
        const updatedAt = yield* DateTime.now;
        const next = new Map(map);
        next.set(prKey(ref), {
          ...existing,
          state: { ...update(existing.state), updatedAt },
        });
        return next;
      }),
    ).pipe(Effect.andThen(publish));

  const setPhase = (ref: PrRef, phase: IngestionPhase, detail: string | null) =>
    patch(ref, (state) => ({ ...state, phase, detail }));

  // ── The door ──────────────────────────────────────────────────────────────

  /**
   * Ingestion's precondition checks — the only place "no" is an allowed answer.
   * Every rejection happens *before* a job exists, which is what makes
   * `ingestion.start`'s error channel honest.
   */
  const door = Effect.fn("ingestion.door")(function* (ref: PrRef) {
    const viewer = yield* github.identity;
    if (viewer.auth !== "authenticated") {
      return yield* new DoorRejection({
        reason: "gh-unavailable",
        detail:
          viewer.detail ??
          "Throughline reads GitHub through the GitHub CLI. Install `gh` and run `gh auth login`.",
        resetAt: null,
      });
    }

    const pr = yield* github.pr(ref).pipe(Effect.mapError(doorFromGitHub));
    if (pr.state === "closed") {
      return yield* new DoorRejection({
        reason: "not-open",
        detail: "That pull request is closed without being merged, so there is nothing to walk.",
        resetAt: null,
      });
    }

    const settings = yield* store.settings.pipe(Effect.orDie);
    const report = yield* harnesses.report(settings.harness);
    if (report.active === null) {
      return yield* new DoorRejection({
        reason: "no-harness",
        detail: describeHarnessDoor(report.harnesses),
        resetAt: null,
      });
    }

    return { pr, harness: report.active } as const;
  });

  // ── The job ───────────────────────────────────────────────────────────────

  const start: Ingestion["Service"]["start"] = Effect.fn("ingestion.start")(function* (input) {
    const { ref } = input;
    const key = prKey(ref);

    const existing = yield* SynchronizedRef.get(jobs).pipe(Effect.map((map) => map.get(key)));
    if (existing !== undefined && isLive(existing.state.phase)) {
      // Leavable and joinable: a second window opening the same PR watches the
      // running job rather than starting a second one.
      return { jobId: existing.state.jobId, ref, joined: true };
    }

    if (!input.reanalyze) {
      const already = yield* store.journey(ref).pipe(Effect.orDie);
      if (Option.isSome(already)) {
        return { jobId: already.value.id, ref, joined: true };
      }
    }

    const checked = yield* door(ref);
    const jobId = yield* newId("job");
    const startedAt = yield* DateTime.now;

    const queued = yield* SynchronizedRef.get(jobs).pipe(
      Effect.map((map) => [...map.values()].filter((record) => isLive(record.state.phase)).length),
    );

    const initial: IngestionJob = {
      jobId,
      pr: ref,
      phase: queued > 0 ? "queued" : "resolving",
      startedAt,
      updatedAt: startedAt,
      prTitle: checked.pr.title,
      headSha: checked.pr.headSha,
      baseSha: null,
      detail:
        queued > 0
          ? `Waiting for ${queued} other analysis to finish — only one runs at a time.`
          : "Resolving the pull request",
      changedFiles: checked.pr.changedFiles,
      additions: checked.pr.additions,
      deletions: checked.pr.deletions,
      filesOnDisk: null,
      stage: null,
      stageProgress: null,
      activity: null,
      harness: checked.harness,
      journeyId: null,
      failure: null,
      queuePosition: queued > 0 ? queued : null,
    };

    // `Effect.scoped` makes the job's scope the fiber's own, so interrupting the
    // fiber runs the finalizers that abort the harness — cancellation needs no
    // second mechanism.
    const fiber = yield* Effect.forkIn(
      Effect.scoped(runJob({ ref, pr: checked.pr, harness: checked.harness })),
      jobScope,
    );

    yield* SynchronizedRef.update(jobs, (map) => {
      const next = new Map(map);
      next.set(key, { state: initial, fiber });
      return next;
    });
    yield* publish;

    return { jobId, ref, joined: false };
  });

  /**
   * The whole pipeline. It cannot fail: every operational fault is caught and
   * turned into a visible `failed` phase with retry as the remedy, and every
   * analytical shortfall is absorbed by the ladder.
   */
  const runJob = (input: {
    readonly ref: PrRef;
    readonly pr: PrSummary;
    readonly harness: HarnessKind;
  }): Effect.Effect<void, never, Scope.Scope> =>
    analysisGate
      .withPermits(1)(
        Effect.gen(function* () {
          const { ref, pr } = input;
          yield* setPhase(ref, "resolving", "Resolving the pull request");
          yield* patch(ref, (state) => ({ ...state, queuePosition: null }));

          const journeyId = (yield* newId("j")) as JourneyId;

          yield* setPhase(
            ref,
            "cloning",
            `Cloning ${ref.owner}/${ref.repo} at ${pr.headSha.slice(0, 7)} and its base`,
          );
          const prepared = yield* workspaces.prepare({
            ref,
            runId: journeyId,
            headSha: pr.headSha,
            baseRef: pr.baseRef,
          });
          yield* patch(ref, (state) => ({
            ...state,
            headSha: prepared.headSha,
            baseSha: prepared.baseSha,
            filesOnDisk: prepared.filesOnDisk,
          }));

          yield* setPhase(
            ref,
            "diffing",
            `Reading the change — ${prepared.index.files.length} changed file${prepared.index.files.length === 1 ? "" : "s"}`,
          );

          const journey = yield* analyze({ ref, pr, harness: input.harness, journeyId, prepared });

          yield* setPhase(ref, "saving", "Saving the journey");
          yield* store.commit(journey).pipe(Effect.orDie);
          yield* github.invalidatePr(ref);
          yield* workspaces.releaseWorktree(ref, journeyId);
          yield* workspaces.evictIfNeeded;

          yield* patch(ref, (state) => ({
            ...state,
            phase: "complete",
            detail: null,
            journeyId,
            activity: null,
            stage: null,
            stageProgress: null,
          }));
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (isInterrupt(cause)) {
              yield* patch(input.ref, (state) => ({
                ...state,
                phase: "cancelled",
                detail: "Cancelled.",
                activity: null,
              }));
              return;
            }
            const detail = describeCause(cause);
            yield* Effect.logError("Ingestion failed", { ref: input.ref, cause });
            yield* patch(input.ref, (state) => ({
              ...state,
              phase: "failed",
              detail,
              activity: null,
              failure: { message: detail, retryable: true },
            }));
          }),
        ),
        Effect.withSpan("ingestion.run", {
          attributes: { "pr.key": prKey(input.ref) },
        }),
      );

  // ── The staged analysis ───────────────────────────────────────────────────

  const analyze = Effect.fn("ingestion.analyze")(function* (input: {
    readonly ref: PrRef;
    readonly pr: PrSummary;
    readonly harness: HarnessKind;
    readonly journeyId: JourneyId;
    readonly prepared: PreparedRun;
  }) {
    const { ref, pr, prepared, journeyId } = input;
    const seeds = prepared.index.seeds;
    const tree = pinnedTree(prepared);
    const counters = yield* Ref.make({
      changedFilesOpened: new Set<string>(),
      filesRead: new Set<string>(),
      searchesRun: 0,
      steps: 0,
    });
    const trail = yield* Ref.make<ReadonlyArray<string>>([]);
    const changedPaths = new Set(prepared.index.files.map((file) => file.path));

    /**
     * Activity is pushed synchronously from the SDK's event loop, so it is
     * folded into a `Ref` and mirrored into the job state. Counters are only ever
     * derived from observed events — nothing here is estimated.
     */
    const onActivity = (activity: HarnessActivity): void => {
      void Effect.runPromise(
        Effect.gen(function* () {
          const line = describeActivity(activity);
          yield* Ref.update(counters, (current) => {
            if (activity.kind === "read") {
              const normalized = normalizePath(activity.path, prepared.worktree);
              const filesRead = new Set(current.filesRead).add(normalized);
              const changedFilesOpened = changedPaths.has(normalized)
                ? new Set(current.changedFilesOpened).add(normalized)
                : current.changedFilesOpened;
              return { ...current, filesRead, changedFilesOpened };
            }
            if (activity.kind === "search") {
              return { ...current, searchesRun: current.searchesRun + 1 };
            }
            return { ...current, steps: current.steps + 1 };
          });
          yield* Ref.update(trail, (lines) => [line, ...lines].slice(0, TRAIL_LENGTH));
          const snapshotCounters = yield* Ref.get(counters);
          const snapshotTrail = yield* Ref.get(trail);
          yield* patch(ref, (state) => ({
            ...state,
            activity: {
              action: line,
              trail: snapshotTrail,
              counters: {
                changedFilesOpened: snapshotCounters.changedFilesOpened.size,
                filesRead: snapshotCounters.filesRead.size,
                searchesRun: snapshotCounters.searchesRun,
                steps: snapshotCounters.steps,
              },
            },
          }));
        }),
      );
    };

    const stage = (value: AnalysisStage, detail: string, progress: IngestionJob["stageProgress"]) =>
      patch(ref, (state) => ({
        ...state,
        phase: "analyzing",
        stage: value,
        detail,
        stageProgress: progress,
      }));

    const fallbacks: string[] = [];

    // ── Stage 1: the journey plan ──
    yield* stage("plan", "Walking the diff and the code around it", null);

    const planSession = yield* harnesses.open({
      selected: input.harness,
      worktree: prepared.worktree,
      outputSchema: PLAN_SCHEMA,
      onActivity,
      label: "plan",
    });

    const planResult = yield* runWithRepair({
      session: planSession,
      prompt: planPrompt({
        prTitle: pr.title,
        prBody: pr.body,
        baseRef: prepared.baseRef,
        headSha: prepared.headSha,
        files: prepared.index.files,
        seeds,
        additions: pr.additions,
        deletions: pr.deletions,
      }),
      validate: (value) => {
        const plan = value as JourneyPlanInput;
        const materialized = materializePlan(seeds, plan);
        // A plan that only needed *deterministic completion* is not a validation
        // failure — the fallbacks are the record of what we had to do. What the
        // repair turn is for is a plan whose own arithmetic or references are
        // wrong, which shows up as fallbacks naming ignored input.
        const repairable = materialized.fallbacks.filter(isRepairableFallback);
        return repairable.length === 0
          ? { ok: true as const, value: materialized }
          : {
              ok: false as const,
              violations: repairable.map(
                (message): Violation => ({ code: "seed-unassigned", message }),
              ),
            };
      },
      stageLabel: "plan",
    });

    const plan: MaterializedPlan =
      planResult._tag === "Success"
        ? planResult.value
        : (() => {
            fallbacks.push(
              `the harness could not produce a usable plan (${planResult.detail}), so the journey fell back to the deterministic partition`,
            );
            return materializePlan(seeds, degeneratePlan(seeds));
          })();
    fallbacks.push(...plan.fallbacks);

    yield* workspaces.writeRunArtifact(
      ref,
      journeyId,
      "plan.transcript.ndjson",
      yield* planSession.transcript,
    );

    // ── Stage 2: the words ──
    const scales = plan.clusters.map((cluster) => ({
      id: cluster.id as string,
      position: cluster.position,
      title: cluster.title,
      weight: cluster.weight,
      filesTouched: new Set(
        plan.hunks.filter((hunk) => hunk.home === cluster.id).map((hunk) => hunk.path),
      ).size,
      hunksHomed: plan.hunks.filter((hunk) => hunk.home === cluster.id).length,
    }));

    yield* stage("narrate", "Ordering the clusters and writing each one's narrative", {
      done: 0,
      total: plan.clusters.length + 1,
      label: "the Overview",
    });

    const narrationByCluster = new Map<string, ClusterNarrationInput>();

    // Narration runs per cluster against the frozen plan, so each run's context
    // is one cluster deep rather than forty thousand lines wide — and a failure
    // costs one cluster's prose, not the whole journey.
    let done = 0;
    for (const cluster of plan.clusters) {
      const session = yield* harnesses.open({
        selected: input.harness,
        worktree: prepared.worktree,
        outputSchema: CLUSTER_SCHEMA,
        onActivity,
        label: `narrate-${cluster.id}`,
      });
      const earlier = plan.clusters.filter((entry) => entry.position < cluster.position);
      const result = yield* runWithRepair({
        session,
        prompt: clusterPrompt({
          cluster: {
            id: cluster.id,
            position: cluster.position,
            title: cluster.title,
            weight: cluster.weight,
            fileOrder: cluster.fileOrder,
          },
          total: plan.clusters.length,
          hunks: plan.hunks
            .filter((hunk) => hunk.home === cluster.id)
            .map((hunk) => ({
              id: hunk.id,
              path: hunk.path,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              fileKind: hunk.fileKind,
            })),
          earlier: earlier.map((entry) => ({
            id: entry.id,
            position: entry.position,
            title: entry.title,
          })),
          earlierHunkIds: plan.hunks
            .filter((hunk) => earlier.some((entry) => entry.id === hunk.home))
            .map((hunk) => hunk.id),
        }),
        validate: (value) => ({ ok: true as const, value: value as ClusterNarrationInput }),
        stageLabel: "narration",
      });

      if (result._tag === "Success") {
        narrationByCluster.set(cluster.id, result.value);
      } else {
        fallbacks.push(
          `${cluster.id} (${cluster.title}) could not be narrated by the harness: ${result.detail}`,
        );
      }
      yield* workspaces.writeRunArtifact(
        ref,
        journeyId,
        `narrate-${cluster.id}.transcript.ndjson`,
        yield* session.transcript,
      );

      done += 1;
      yield* stage("narrate", `Writing the narrative for ${cluster.title}`, {
        done,
        total: plan.clusters.length + 1,
        label: cluster.title,
      });
    }

    // The Overview is written last, deliberately: it is a first-class artifact
    // about the whole journey, and by now the journey exists.
    const overviewSession = yield* harnesses.open({
      selected: input.harness,
      worktree: prepared.worktree,
      outputSchema: OVERVIEW_SCHEMA,
      onActivity,
      label: "overview",
    });
    const overviewResult = yield* runWithRepair({
      session: overviewSession,
      prompt: overviewPrompt({
        prTitle: pr.title,
        clusters: scales,
        fileCount: prepared.index.files.length,
        additions: pr.additions,
        deletions: pr.deletions,
      }),
      validate: (value) => ({ ok: true as const, value: value as OverviewNarrationInput }),
      stageLabel: "narration",
    });
    const overview: OverviewNarrationInput =
      overviewResult._tag === "Success" ? overviewResult.value : {};
    if (overviewResult._tag !== "Success") {
      fallbacks.push(`the Overview could not be written by the harness: ${overviewResult.detail}`);
    }
    yield* workspaces.writeRunArtifact(
      ref,
      journeyId,
      "overview.transcript.ndjson",
      yield* overviewSession.transcript,
    );

    // ── Assemble, validate, commit ──
    yield* setPhase(ref, "validating", "Checking that every changed line has a home");

    const narration = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster,
      overview,
    });
    fallbacks.push(...narration.fallbacks);

    const analyzedAt = yield* DateTime.now;
    const usage = yield* overviewSession.usage;

    let journey: Journey = {
      formatVersion: 1,
      id: journeyId,
      pr: ref,
      prWords: {
        title: pr.title,
        body: pr.body,
        author: pr.author,
        url: pr.url,
        createdAt: pr.createdAt,
      },
      pinned: {
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        baseRef: prepared.baseRef,
        analyzedAt,
      },
      provenance: {
        harnessKind: input.harness,
        ...(planSession.model === undefined ? {} : { model: planSession.model }),
        usage,
        fallbacks,
      },
      overview: narration.overview,
      clusters: narration.clusters,
      hunks: plan.hunks,
      files: prepared.index.files,
      hints: narration.hints,
    };

    // The last line of defence. The floor above should have made this
    // unreachable; if it did not, the journey is rebuilt deterministically rather
    // than persisted invalid, because an invalid journey is a broken guarantee.
    let violations = validateJourney(journey, { seeds, tree });
    if (violations.length > 0) {
      yield* Effect.logError("A journey failed final validation; rebuilding it deterministically", {
        ref,
        violations: violations.slice(0, 20),
      });
      const rebuilt = materializePlan(seeds, degeneratePlan(seeds));
      const rebuiltNarration = assembleNarration({
        clusters: rebuilt.clusters,
        hunks: rebuilt.hunks,
        tree,
        narrationByCluster: new Map(),
        overview: {},
      });
      const rebuiltFallbacks = [
        ...fallbacks,
        `the assembled journey failed validation (${formatViolations(violations, 5)}), so it was rebuilt deterministically`,
        ...rebuilt.fallbacks,
        ...rebuiltNarration.fallbacks,
      ];
      journey = {
        ...journey,
        overview: rebuiltNarration.overview,
        clusters: rebuiltNarration.clusters,
        hunks: rebuilt.hunks,
        hints: rebuiltNarration.hints,
        provenance: { ...journey.provenance, fallbacks: rebuiltFallbacks },
      };
      violations = validateJourney(journey, { seeds, tree });
      if (violations.length > 0) {
        // Unreachable by construction: the degenerate partition assigns every
        // seed to a real cluster and carries no evidence links. Dying here is
        // correct — it means a validator and the materializer disagree, which is
        // a bug that must not be papered over with a silently invalid artifact.
        return yield* Effect.die(
          new Error(
            `The deterministic journey did not validate: ${formatViolations(violations, 5)}`,
          ),
        );
      }
    }

    yield* workspaces.appendFallbacks(ref, journeyId, journey.provenance.fallbacks);
    return journey;
  });

  /**
   * Rungs 1–3 of the ladder for one run: ask, validate, repair on the same
   * thread, then regenerate once. Returns a failure only when every rung is
   * exhausted — the caller decides what the floor is for its stage.
   */
  const runWithRepair = <A>(input: {
    readonly session: HarnessSession;
    readonly prompt: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly ok: true; readonly value: A }
      | { readonly ok: false; readonly violations: ReadonlyArray<Violation> };
    readonly stageLabel: "plan" | "narration";
  }): Effect.Effect<
    | { readonly _tag: "Success"; readonly value: A }
    | { readonly _tag: "Failure"; readonly detail: string }
  > =>
    Effect.gen(function* () {
      const attempt = yield* Effect.result(input.session.ask(input.prompt));
      if (Result.isFailure(attempt)) {
        return { _tag: "Failure" as const, detail: attempt.failure.detail };
      }

      let current: unknown = attempt.success;
      for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
        const checked = input.validate(current);
        if (checked.ok) return { _tag: "Success" as const, value: checked.value };
        if (round === REPAIR_ROUNDS) {
          return {
            _tag: "Failure" as const,
            detail: formatViolations(checked.violations, 5),
          };
        }
        yield* Effect.logInfo("Sending a correction turn to the harness", {
          stage: input.stageLabel,
          round: round + 1,
          violations: checked.violations.length,
        });
        const repaired = yield* Effect.result(
          input.session.correct(
            repairPrompt(formatViolations(checked.violations), input.stageLabel),
          ),
        );
        if (Result.isFailure(repaired)) {
          return { _tag: "Failure" as const, detail: repaired.failure.detail };
        }
        current = repaired.success;
      }
      return { _tag: "Failure" as const, detail: "The harness ran out of correction rounds." };
    });

  const newId = (prefix: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => `${prefix}${uuid.replace(/-/g, "").slice(0, 16)}`),
      Effect.orDie,
    );

  return {
    start,

    cancel: (ref) =>
      Effect.gen(function* () {
        const record = yield* SynchronizedRef.get(jobs).pipe(
          Effect.map((map) => map.get(prKey(ref))),
        );
        if (record === undefined || !isLive(record.state.phase)) return;
        if (record.fiber !== null) yield* Fiber.interrupt(record.fiber);
        yield* patch(ref, (state) => ({
          ...state,
          phase: "cancelled",
          detail: "Cancelled.",
          activity: null,
        }));
      }),

    jobs: snapshot,

    get changes() {
      return Stream.fromPubSub(changes);
    },
  } satisfies Ingestion["Service"];
});

// `Layer.effect` builds within the layer's own scope, which is what `jobScope`
// above borrows: every job fiber lives exactly as long as the server does.
export const layer = Layer.effect(Ingestion, make);

// ── Helpers ─────────────────────────────────────────────────────────────────

export function isLive(phase: IngestionPhase): boolean {
  return phase !== "complete" && phase !== "failed" && phase !== "cancelled";
}

function pinnedTree(prepared: PreparedRun): PinnedTree {
  const contents = new Map<string, string>();
  return {
    paths: new Set(prepared.treePaths),
    lineCounts: prepared.lineCounts,
    // Symbol resolution is a substring check against the head revision, on
    // purpose: no language tooling keeps the guarantee cheap and unambiguous.
    fileContains: (path, symbol) => {
      const text = contents.get(path);
      return text === undefined ? true : text.includes(symbol);
    },
  };
}

function describeActivity(activity: HarnessActivity): string {
  switch (activity.kind) {
    case "read":
      return `reading ${activity.path}`;
    case "search":
      return activity.detail;
    case "command":
      return activity.detail;
    case "step":
      return activity.detail;
  }
}

function normalizePath(candidate: string, worktree: string): string {
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
}

/**
 * A fallback the agent could plausibly fix if asked. Deterministic completion
 * that reflects a *choice* we made (dropping an empty cluster) is not worth a
 * round trip; input we had to ignore because it referenced something unreal is.
 */
function isRepairableFallback(message: string): boolean {
  return (
    message.includes("ignored an assignment") ||
    message.includes("unknown cluster") ||
    message.includes("collapsed an invalid split") ||
    message.includes("unassigned") ||
    message.includes("no usable clusters")
  );
}

function doorFromGitHub(cause: GitHubError): DoorRejection {
  switch (cause._tag) {
    case "GitHubParkedError":
      return new DoorRejection({
        reason: "github-parked",
        detail:
          "GitHub's rate limit is exhausted for your login. Throughline will not send another request until it resets.",
        resetAt: DateTime.makeUnsafe(cause.resetAtMillis),
      });
    case "GitHubUnavailableError":
      return new DoorRejection({ reason: "gh-unavailable", detail: cause.detail, resetAt: null });
    case "GitHubNotFoundError":
      return new DoorRejection({ reason: "not-found", detail: cause.detail, resetAt: null });
    case "GitHubFailedError":
      return new DoorRejection({
        reason: "github-unavailable",
        detail: cause.detail,
        resetAt: null,
      });
  }
}

function describeHarnessDoor(
  harnesses: ReadonlyArray<{ readonly installed: boolean; readonly detail: string | null }>,
): string {
  const details = harnesses
    .map((status) => status.detail)
    .filter((detail): detail is string => detail !== null);
  return details.length === 0
    ? "No agent harness is available to analyse with."
    : details.join(" ");
}

function isInterrupt(cause: unknown): boolean {
  return String(cause).includes("Interrupt");
}

function describeCause(cause: unknown): string {
  const text = String(cause);
  const line =
    text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0 && !entry.startsWith("at ")) ?? text;
  return line.length > 400 ? `${line.slice(0, 397)}…` : line;
}
