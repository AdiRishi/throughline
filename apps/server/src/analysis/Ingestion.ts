/**
 * Ingestion: a pull request in, a journey out, honest progress throughout.
 *
 * Callers see "start a job, watch events, get a journey". Clone orchestration,
 * prompt assembly, validation, and repair are implementation.
 *
 * The rung structure is the whole point. Each stage validates with a pure
 * checker, feeds precise violations back to the same harness thread for up to
 * two correction rounds, regenerates narration once if it still fails, and — at
 * the floor — finishes the artifact itself, honestly, recording every fallback
 * it stood on. That floor is what makes "the agent always commits" an invariant
 * of the system rather than a hope about the model.
 *
 * Failure here is always *operational* — a clone error, a crashed harness, a
 * full disk. There is no analytical failure: "too tangled to decompose" is not
 * an outcome the pipeline can produce.
 *
 * @module analysis/Ingestion
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  DoorGhUnavailableError,
  DoorGitHubParkedError,
  DoorInvalidUrlError,
  DoorNoHarnessError,
  DoorNotFoundError,
  DoorNotOpenError,
  JOURNEY_FORMAT_VERSION,
  prRefKey,
  type AnalysisActivity,
  type AnalysisActivityLine,
  type Cluster,
  type DoorRejection,
  type Hint,
  type HintId,
  type Hunk,
  type IngestionJob,
  type IngestionPhase,
  type IngestionStreamEvent,
  type Journey,
  type JourneyId,
  type JobId,
  type PrDetail,
  type PrRef,
  type SeedHunk,
} from "@app/contracts";
import { formatViolations, validateJourney, type JourneyContext } from "@app/journey/coverage";
import { downgradeUnresolvableLinks, makeEvidenceContext } from "@app/journey/evidence";
import {
  degeneratePlan,
  materializePlan,
  validatePlan,
  type JourneyPlan,
  type PlannedCluster,
} from "@app/journey/plan";
import { parsePrUrl } from "@app/shared/prUrl";

import { GitHub } from "../github/GitHub.ts";
import {
  AnalysisHarness,
  type HarnessAdapter,
  type HarnessError,
  type HarnessEvent,
  type HarnessSession,
} from "../harness/AnalysisHarness.ts";
import { JourneyStore } from "../journeys/JourneyStore.ts";
import { Workspaces, type PreparedRun } from "../workspace/Workspaces.ts";
import {
  clusterNarrationPrompt,
  hunkLine,
  overviewPrompt,
  planPrompt,
  repairPrompt,
} from "./prompts.ts";
import {
  CLUSTER_NARRATION_JSON_SCHEMA,
  OVERVIEW_JSON_SCHEMA,
  PLAN_JSON_SCHEMA,
  readClusterNarration,
  readOverview,
  readPlan,
} from "./schemas.ts";

export class Ingestion extends Context.Service<
  Ingestion,
  {
    /**
     * Door rejections are this method's only error channel. Once a job exists,
     * everything else is reported through the job's own stream.
     */
    readonly start: (input: {
      readonly target:
        | { readonly kind: "ref"; readonly pr: PrRef }
        | { readonly kind: "url"; readonly url: string };
      readonly reanalyze: boolean;
    }) => Effect.Effect<
      { readonly jobId: JobId; readonly pr: PrRef; readonly existingJourneyId: JourneyId | null },
      DoorRejection
    >;
    readonly cancel: (jobId: JobId) => Effect.Effect<void>;
    /** Snapshot then live, per PR. Leaving and coming back costs nothing. */
    readonly watch: (pr: PrRef) => Stream.Stream<IngestionStreamEvent>;
    /** Which PRs have a live job — the welcome screen's "analyzing" state. */
    readonly activePrs: Effect.Effect<ReadonlySet<string>>;
  }
>()("@app/server/analysis/Ingestion") {}

/** Correction rounds per stage, per the repair ladder. */
const REPAIR_ROUNDS = 2;
/** Recent activity kept for the transition's live feed. */
const TRAIL_LENGTH = 3;
/** How often buffered harness events are folded into the published job. */
const ACTIVITY_FLUSH = Duration.millis(180);

/** What one cluster's narration run yields, whichever rung produced it. */
interface NarrationResult {
  readonly cluster: Cluster;
  readonly hints: ReadonlyArray<Hint>;
  readonly model: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

interface JobState {
  readonly job: IngestionJob;
  readonly fiber: Fiber.Fiber<void, never> | null;
}

export const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const workspaces = yield* Workspaces;
  const harnesses = yield* AnalysisHarness;
  const store = yield* JourneyStore;

  // Harness runs are heavy. One at a time, globally; queued jobs say so.
  const analysisGate = yield* Semaphore.make(1);
  const jobs = yield* SynchronizedRef.make<ReadonlyMap<string, JobState>>(new Map());
  const events = yield* PubSub.unbounded<IngestionStreamEvent>();
  const sequence = yield* Ref.make(0);

  const publish = Effect.fn("ingestion.publish")(function* (job: IngestionJob) {
    const next = yield* Ref.updateAndGet(sequence, (value) => value + 1);
    yield* PubSub.publish(events, { version: 1, sequence: next, type: "update", job });
  });

  const putJob = Effect.fn("ingestion.putJob")(function* (job: IngestionJob) {
    yield* SynchronizedRef.update(jobs, (current) => {
      const next = new Map(current);
      const existing = next.get(prRefKey(job.pr));
      next.set(prRefKey(job.pr), { job, fiber: existing?.fiber ?? null });
      return next;
    });
    yield* publish(job);
  });

  const currentJob = (pr: PrRef) =>
    SynchronizedRef.get(jobs).pipe(Effect.map((map) => map.get(prRefKey(pr))?.job ?? null));

  /**
   * The door. The only place "no" is an allowed answer — analysis itself never
   * fails analytically, so every rejection has to happen before a job exists.
   */
  const door = Effect.fn("ingestion.door")(function* (target: {
    readonly kind: "ref" | "url";
    readonly pr?: PrRef;
    readonly url?: string;
  }) {
    const ref = target.kind === "ref" ? (target.pr ?? null) : parsePrUrl(target.url ?? "");
    if (ref === null) {
      return yield* new DoorInvalidUrlError({ input: target.url ?? "" });
    }

    const viewer = yield* github.identity.pipe(Effect.orElseSucceed(() => null));
    if (viewer === null || !viewer.ghInstalled) {
      return yield* new DoorGhUnavailableError({
        reason: "not-installed",
        detail: "Install the GitHub CLI (gh), then sign in with `gh auth login`.",
      });
    }
    if (!viewer.authenticated) {
      return yield* new DoorGhUnavailableError({
        reason: "not-authenticated",
        detail: "Run `gh auth login` to let Throughline see your pull requests.",
      });
    }

    const detail: PrDetail = yield* github
      .pr(ref)
      .pipe(
        Effect.catch((cause) =>
          Effect.fail(
            cause._tag === "GitHubParkedError"
              ? new DoorGitHubParkedError({ resetAt: cause.resetAt })
              : new DoorNotFoundError({ pr: ref }),
          ),
        ),
      );

    if (detail.summary.state === "closed") {
      return yield* new DoorNotOpenError({ pr: ref, state: "closed without merging" });
    }

    const settings = yield* store.settings;
    const adapter = yield* harnesses.select(settings.harness);
    if (adapter === null) {
      return yield* new DoorNoHarnessError({
        detail:
          "Throughline analyses run on your own agent harness. Install and sign in to Codex (`codex login`) or Claude Code (`claude`).",
      });
    }

    return { ref, detail, adapter };
  });

  const start = Effect.fn("ingestion.start")(function* (input: {
    readonly target:
      | { readonly kind: "ref"; readonly pr: PrRef }
      | { readonly kind: "url"; readonly url: string };
    readonly reanalyze: boolean;
  }): Effect.fn.Return<
    { readonly jobId: JobId; readonly pr: PrRef; readonly existingJourneyId: JourneyId | null },
    DoorRejection
  > {
    const opened = yield* door(
      input.target.kind === "ref"
        ? { kind: "ref", pr: input.target.pr }
        : { kind: "url", url: input.target.url },
    );
    const { ref, detail, adapter } = opened;

    const existing = yield* store.rowFor(ref);
    if (existing !== null && !input.reanalyze) {
      return {
        jobId: `job-existing-${existing.journeyId}` as JobId,
        pr: ref,
        existingJourneyId: existing.journeyId,
      };
    }

    const live = yield* currentJob(ref);
    if (live !== null && isLive(live.phase)) {
      // One active job per PR. Re-opening a PR mid-run joins the run in
      // progress rather than starting a second one.
      return { jobId: live.jobId, pr: ref, existingJourneyId: null };
    }

    const now = yield* DateTime.now;
    const jobId =
      `job-${ref.owner}-${ref.repo}-${ref.number}-${DateTime.toEpochMillis(now)}` as JobId;
    const job: IngestionJob = {
      jobId,
      pr: ref,
      title: detail.summary.title,
      harness: adapter.kind,
      startedAt: now,
      updatedAt: now,
      phase: "queued",
      queuePosition: 0,
      facts: {
        headSha: detail.summary.headSha,
        baseSha: null,
        worktreeFiles: null,
        changedFiles: detail.summary.changedFiles,
        additions: detail.summary.additions,
        deletions: detail.summary.deletions,
        seedHunks: null,
        clusters: null,
      },
      activity: null,
      failure: null,
      journeyId: null,
      reanalysis: existing !== null,
    };
    yield* putJob(job);

    // Forked and daemonized: the job is server-side, so the renderer may close
    // its window, navigate away, or disconnect entirely. That is what makes
    // ingestion leavable.
    // The job gets its own scope, which outlives the RPC call that started it:
    // that is what "leavable" means concretely. Cancelling closes it.
    const fiber = yield* Effect.forkDetach(
      runJob({ job, detail, adapter }).pipe(
        Effect.catchCause((cause) =>
          failJob(job, "resolving", "The run stopped unexpectedly.", String(cause)),
        ),
        Effect.scoped,
      ),
    );
    yield* SynchronizedRef.update(jobs, (current) => {
      const next = new Map(current);
      const state = next.get(prRefKey(ref));
      if (state !== undefined) next.set(prRefKey(ref), { ...state, fiber });
      return next;
    });

    return { jobId, pr: ref, existingJourneyId: null };
  });

  const failJob = Effect.fn("ingestion.failJob")(function* (
    job: IngestionJob,
    phase: IngestionPhase,
    message: string,
    detail: string,
  ) {
    const now = yield* DateTime.now;
    yield* Effect.logWarning("Ingestion failed.", { pr: prRefKey(job.pr), phase, detail });
    yield* putJob({
      ...job,
      phase: "failed",
      updatedAt: now,
      failure: { message, detail, phase },
    });
  });

  /** The whole pipeline for one job. */
  const runJob = Effect.fn("ingestion.runJob")(function* (input: {
    readonly job: IngestionJob;
    readonly detail: PrDetail;
    readonly adapter: HarnessAdapter;
  }) {
    const { detail, adapter } = input;
    let job = input.job;

    const advance = Effect.fn("ingestion.advance")(function* (patch: Partial<IngestionJob>) {
      const now = yield* DateTime.now;
      job = { ...job, ...patch, updatedAt: now };
      yield* putJob(job);
      return job;
    });

    yield* analysisGate.withPermits(1)(
      Effect.gen(function* () {
        yield* advance({ phase: "resolving", queuePosition: 0 });

        const runId = `${DateTime.toEpochMillis(job.startedAt)}`;
        const prepared = yield* workspaces
          .prepare({
            pr: job.pr,
            runId,
            expectedHeadSha: detail.summary.headSha,
            baseRefName: detail.summary.baseRefName,
            onStep: (step, stepDetail) =>
              advance({
                phase: step === "cloning" ? "cloning" : "diffing",
                facts: { ...job.facts, ...(step === "diffing" ? {} : {}) },
              }).pipe(
                Effect.andThen(Effect.logInfo("ingestion step", { step, detail: stepDetail })),
              ),
          })
          .pipe(
            Effect.tapError((cause) =>
              failJob(job, job.phase, "Preparing the workspace failed.", cause.message),
            ),
          );

        yield* advance({
          facts: {
            ...job.facts,
            headSha: prepared.headSha,
            baseSha: prepared.baseSha,
            worktreeFiles: prepared.worktreeFileCount,
            changedFiles: prepared.files.length,
            seedHunks: prepared.seeds.length,
          },
        });

        const journey = yield* analyze({
          job,
          detail,
          adapter,
          prepared,
          advance,
        });

        yield* advance({ phase: "saving" });
        yield* store.saveJourney(journey);
        yield* advance({ phase: "complete", journeyId: journey.id, activity: null });
      }).pipe(
        Effect.catch((cause) =>
          failJob(
            job,
            job.phase,
            "The run stopped before it could finish.",
            (cause as { message?: string }).message ?? String(cause),
          ),
        ),
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            yield* putJob({ ...job, phase: "cancelled", updatedAt: now });
          }),
        ),
      ),
    );
  });

  /**
   * Stage 1 then stage 2, each with its own ladder. Always returns a journey.
   */
  const analyze = Effect.fn("ingestion.analyze")(function* (input: {
    readonly job: IngestionJob;
    readonly detail: PrDetail;
    readonly adapter: HarnessAdapter;
    readonly prepared: PreparedRun;
    readonly advance: (patch: Partial<IngestionJob>) => Effect.Effect<IngestionJob>;
  }) {
    const { detail, prepared, advance } = input;
    const fallbacks: string[] = [];

    const activity = yield* makeActivityTracker({
      changedPaths: new Set(prepared.files.map((file) => file.path)),
      advance: (next) => advance({ activity: next }),
    });

    const openSession = (label: string) =>
      input.adapter.session({ worktree: prepared.worktreePath, label });

    yield* advance({ phase: "analyzing" });
    yield* activity.setStage("plan", null, null);
    const flusher = yield* Effect.forkScoped(
      Effect.repeat(activity.flush, Schedule.spaced(ACTIVITY_FLUSH)),
    );

    // ── Stage 1: the plan ───────────────────────────────────────────────────
    // One session for the whole stage: its repair rounds are corrections to the
    // same answer, so they belong in the same conversation.
    const planSession = yield* openSession(`${prRefKey(input.job.pr)} plan`);
    const plan = yield* runPlanStage({
      session: planSession,
      detail,
      prepared,
      activity,
      fallbacks,
    });
    const materialized = materializePlan({
      seeds: prepared.seeds,
      files: prepared.files,
      plan,
    });
    fallbacks.push(...materialized.fallbacks);

    yield* advance({
      facts: { ...input.job.facts, clusters: materialized.clusters.length },
    });

    // ── Stage 2: the words ──────────────────────────────────────────────────
    yield* activity.setStage("narrate", 0, materialized.clusters.length);
    const narrated = yield* runNarrationStage({
      openSession,
      detail,
      prepared,
      planned: materialized.clusters,
      hunks: materialized.hunks,
      activity,
      fallbacks,
      advance,
    });

    yield* Fiber.interrupt(flusher);
    yield* activity.flush;

    const overview = yield* runOverviewStage({
      session: yield* openSession(`${prRefKey(input.job.pr)} overview`),
      detail,
      clusters: narrated.clusters,
      context: narrated.context,
      fallbacks,
    });

    yield* advance({ phase: "validating" });

    const now = yield* DateTime.now;
    const journey: Journey = {
      formatVersion: JOURNEY_FORMAT_VERSION,
      id: `${input.job.pr.owner}-${input.job.pr.repo}-${input.job.pr.number}-${DateTime.toEpochMillis(now)}` as JourneyId,
      pr: input.job.pr,
      prSnapshot: {
        title: detail.summary.title,
        body: detail.body,
        authorLogin: detail.summary.authorLogin,
        url: detail.summary.url,
      },
      pinned: {
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        analyzedAt: now,
      },
      provenance: {
        harnessKind: input.adapter.kind,
        model: narrated.model,
        usage: narrated.usage,
        fallbacks,
        runId: prepared.runId,
      },
      overview,
      clusters: narrated.clusters,
      hunks: materialized.hunks,
      files: prepared.files,
      hints: narrated.hints,
    };

    // Belt and braces: the floor above already guarantees a valid partition,
    // and this is the check that says so out loud. Anything it still finds is
    // a bug in the pipeline, not in the model — log it rather than shipping a
    // journey that fails its own guarantee.
    const violations = validateJourney(journey, narrated.context);
    if (violations.length > 0) {
      yield* Effect.logError("A journey reached persistence with violations.", {
        violations: formatViolations(violations, { limit: 10 }),
      });
    }
    return journey;
  });

  // ── Stage 1 ───────────────────────────────────────────────────────────────

  const runPlanStage = Effect.fn("ingestion.planStage")(function* (input: {
    readonly session: HarnessSession;
    readonly detail: PrDetail;
    readonly prepared: PreparedRun;
    readonly activity: ActivityTracker;
    readonly fallbacks: string[];
  }) {
    const ask = (prompt: string) =>
      input.session
        .ask({
          prompt,
          outputSchema: PLAN_JSON_SCHEMA,
          onEvent: input.activity.observe,
        })
        .pipe(Effect.result);

    let prompt = planPrompt({
      pr: input.detail,
      files: input.prepared.files,
      seeds: input.prepared.seeds,
    });

    for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
      if (round > 0) yield* input.activity.repairRound;
      const answer = yield* ask(prompt);
      if (answer._tag === "Failure") {
        input.fallbacks.push(`The plan run failed (${answer.failure.message}).`);
        break;
      }
      const decoded = yield* readPlan(answer.success.output).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        prompt = repairPrompt({
          violations: `The answer did not match the required shape: ${String(decoded.failure)}`,
          round: round + 1,
        });
        continue;
      }
      const plan: JourneyPlan = decoded.success;
      const violations = validatePlan({
        seeds: input.prepared.seeds,
        files: input.prepared.files,
        plan,
      });
      if (violations.length === 0) return plan;

      yield* Effect.logInfo("Plan validation found violations; asking for a correction.", {
        round: round + 1,
        count: violations.length,
      });
      if (round === REPAIR_ROUNDS) {
        input.fallbacks.push(
          `The plan still had ${violations.length} problem(s) after ${REPAIR_ROUNDS} correction rounds; the pipeline completed it deterministically.`,
        );
        return plan;
      }
      prompt = repairPrompt({ violations: formatViolations(violations), round: round + 1 });
    }

    // The absolute floor: a plan built with no usable agent output at all.
    input.fallbacks.push(
      "No usable plan was produced, so the journey was grouped by directory — dreadful, but complete and honest.",
    );
    return degeneratePlan({ seeds: input.prepared.seeds, files: input.prepared.files });
  });

  // ── Stage 2 ───────────────────────────────────────────────────────────────

  const runNarrationStage = Effect.fn("ingestion.narrationStage")(function* (input: {
    /** A *fresh* session per cluster: each run's context is one cluster deep,
     * not the whole change, which is also what makes these parallelizable
     * later without touching anything else. */
    readonly openSession: (label: string) => Effect.Effect<HarnessSession, HarnessError>;
    readonly detail: PrDetail;
    readonly prepared: PreparedRun;
    readonly planned: ReadonlyArray<PlannedCluster>;
    readonly hunks: ReadonlyArray<Hunk>;
    readonly activity: ActivityTracker;
    readonly fallbacks: string[];
    readonly advance: (patch: Partial<IngestionJob>) => Effect.Effect<IngestionJob>;
  }) {
    const seedsById = new Map(input.prepared.seeds.map((seed) => [seed.id as string, seed]));
    const context = makeContext({
      seeds: input.prepared.seeds,
      hunks: input.hunks,
      prepared: input.prepared,
    });

    const clusters: Cluster[] = [];
    const hints: Hint[] = [];
    let model: string | null = null;
    const totals = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    let hintCounter = 0;

    for (const [index, planned] of input.planned.entries()) {
      yield* input.activity.setStage("narrate", index, input.planned.length);

      const homed = input.hunks.filter((hunk) => hunk.home === planned.id);
      const earlier = input.hunks.filter((hunk) => {
        const home = input.planned.find((entry) => entry.id === hunk.home);
        return home !== undefined && home.position < planned.position;
      });

      const prompt = clusterNarrationPrompt({
        pr: input.detail,
        cluster: planned,
        allClusters: input.planned,
        hunkLines: homed.map((hunk) => hunkLine(seedsById.get(hunk.seedId) ?? toSeed(hunk))),
        earlierHunkLines: earlier
          .slice(0, 120)
          .map((hunk) => hunkLine(seedsById.get(hunk.seedId) ?? toSeed(hunk))),
      });

      const narration: NarrationResult = yield* narrateOne({
        session: yield* input.openSession(`cluster ${planned.position}`),
        prompt,
        planned,
        clusters: input.planned,
        hunks: input.hunks,
        context,
        activity: input.activity,
        fallbacks: input.fallbacks,
        nextHintId: () => `hint-${(hintCounter += 1)}` as HintId,
      });

      if (narration.model !== null) model = narration.model;
      if (narration.usage !== null) {
        sawUsage = true;
        totals.inputTokens += narration.usage.inputTokens;
        totals.outputTokens += narration.usage.outputTokens;
      }
      clusters.push(narration.cluster);
      hints.push(...narration.hints);
    }

    yield* input.activity.setStage("narrate", input.planned.length, input.planned.length);
    return { clusters, hints, context, model, usage: sawUsage ? totals : null };
  });

  const narrateOne = Effect.fn("ingestion.narrateOne")(function* (input: {
    readonly session: HarnessSession;
    readonly prompt: string;
    readonly planned: PlannedCluster;
    readonly clusters: ReadonlyArray<PlannedCluster>;
    readonly hunks: ReadonlyArray<Hunk>;
    readonly context: JourneyContext;
    readonly activity: ActivityTracker;
    readonly fallbacks: string[];
    readonly nextHintId: () => HintId;
    // Annotated because `runNarrationStage` above calls this before it is
    // defined; without it TypeScript infers the pair circularly.
  }): Effect.fn.Return<NarrationResult> {
    const ask = (prompt: string) =>
      input.session
        .ask({
          prompt,
          outputSchema: CLUSTER_NARRATION_JSON_SCHEMA,
          onEvent: input.activity.observe,
        })
        .pipe(Effect.result);

    let prompt = input.prompt;
    let best: NarrationResult | null = null;

    // Rung 2 (repair) then rung 3 (one clean regeneration). Narration runs are
    // per cluster and cheap, and a fresh second attempt beats deterministically
    // mutilating prose.
    for (let round = 0; round <= REPAIR_ROUNDS + 1; round += 1) {
      if (round > 0) yield* input.activity.repairRound;
      const answer = yield* ask(prompt);
      if (answer._tag === "Failure") {
        input.fallbacks.push(
          `Narration for "${input.planned.title}" failed (${answer.failure.message}).`,
        );
        break;
      }
      const decoded = yield* readClusterNarration(answer.success.output).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        prompt = repairPrompt({
          violations: `The answer did not match the required shape: ${String(decoded.failure)}`,
          round: round + 1,
        });
        continue;
      }

      const assembled = assembleCluster({
        planned: input.planned,
        clusters: input.clusters,
        hunks: input.hunks,
        narration: decoded.success,
        context: input.context,
        nextHintId: input.nextHintId,
      });
      best = {
        cluster: assembled.cluster,
        hints: assembled.hints,
        model: answer.success.model,
        usage: answer.success.usage,
      };
      if (assembled.problems.length === 0) return best;

      if (round === REPAIR_ROUNDS) {
        // Rung 3: discard and rerun fresh, once, rather than repairing again.
        prompt = input.prompt;
        continue;
      }
      if (round > REPAIR_ROUNDS) {
        input.fallbacks.push(
          `Narration for "${input.planned.title}" still had ${assembled.problems.length} problem(s); unresolvable links were downgraded to plain text and invalid hints were dropped.`,
        );
        return best;
      }
      prompt = repairPrompt({ violations: assembled.problems.join("\n"), round: round + 1 });
    }

    if (best !== null) return best;

    // Rung 4: the pipeline writes the words itself, saying exactly what happened.
    input.fallbacks.push(
      `No narration was produced for "${input.planned.title}"; the pipeline wrote a placeholder that says so.`,
    );
    return {
      cluster: fallbackCluster(input.planned, input.hunks),
      hints: [],
      model: null,
      usage: null,
    } satisfies NarrationResult;
  });

  const runOverviewStage = Effect.fn("ingestion.overviewStage")(function* (input: {
    readonly session: HarnessSession;
    readonly detail: PrDetail;
    readonly clusters: ReadonlyArray<Cluster>;
    readonly context: JourneyContext;
    readonly fallbacks: string[];
  }) {
    let prompt = overviewPrompt({ pr: input.detail, clusters: input.clusters });

    for (let round = 0; round <= REPAIR_ROUNDS; round += 1) {
      const answer = yield* input.session
        .ask({ prompt, outputSchema: OVERVIEW_JSON_SCHEMA, onEvent: () => {} })
        .pipe(Effect.result);
      if (answer._tag === "Failure") break;

      const decoded = yield* readOverview(answer.success.output).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        prompt = repairPrompt({
          violations: `The answer did not match the required shape: ${String(decoded.failure)}`,
          round: round + 1,
        });
        continue;
      }

      const brief = downgradeUnresolvableLinks(decoded.success.brief, input.context);
      const whereToBegin = downgradeUnresolvableLinks(decoded.success.whereToBegin, input.context);
      if (brief.downgraded.length + whereToBegin.downgraded.length > 0) {
        input.fallbacks.push(
          `The Overview linked to ${[...brief.downgraded, ...whereToBegin.downgraded].join(", ")}, which does not resolve; those links were downgraded to plain text.`,
        );
      }
      return {
        brief: { markdown: brief.markdown },
        whereToBegin: { markdown: whereToBegin.markdown },
      };
    }

    input.fallbacks.push("No Overview was produced; the pipeline wrote one from the plan.");
    return {
      brief: {
        markdown: `This journey was assembled without an agent-written overview. It covers ${input.clusters.length} cluster${input.clusters.length === 1 ? "" : "s"}, in order, and every changed line in the pull request appears in exactly one of them.`,
      },
      whereToBegin: {
        markdown: `Start at cluster 1 and walk in order.`,
      },
    };
  });

  // ── The job bus ───────────────────────────────────────────────────────────

  const watch = (pr: PrRef): Stream.Stream<IngestionStreamEvent> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const buffer = yield* Queue.unbounded<IngestionStreamEvent>();
        yield* Effect.forkScoped(
          Stream.fromPubSub<IngestionStreamEvent>(events).pipe(
            Stream.filter(
              (event) => event.type === "update" && prRefKey(event.job.pr) === prRefKey(pr),
            ),
            Stream.runForEach((event) => Queue.offer(buffer, event)),
          ),
        );
        const job = yield* currentJob(pr);
        const current = yield* Ref.get(sequence);
        const snapshot: IngestionStreamEvent = {
          version: 1,
          sequence: current,
          type: "snapshot",
          job,
        };
        return Stream.concat(
          Stream.make(snapshot),
          Stream.fromQueue(buffer).pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          ),
        );
      }),
    );

  return Ingestion.of({
    start,
    cancel: (jobId) =>
      SynchronizedRef.get(jobs).pipe(
        Effect.flatMap((map) => {
          for (const state of map.values()) {
            if (state.job.jobId === jobId && state.fiber !== null) {
              return Fiber.interrupt(state.fiber);
            }
          }
          return Effect.void;
        }),
      ),
    watch,
    activePrs: SynchronizedRef.get(jobs).pipe(
      Effect.map(
        (map) =>
          new Set(
            [...map.entries()].filter(([, state]) => isLive(state.job.phase)).map(([key]) => key),
          ),
      ),
    ),
  });
});

export const layer: Layer.Layer<
  Ingestion,
  never,
  GitHub | Workspaces | AnalysisHarness | JourneyStore
> = Layer.effect(Ingestion, make);

// ── Helpers ─────────────────────────────────────────────────────────────────

function isLive(phase: IngestionPhase): boolean {
  return phase !== "complete" && phase !== "failed" && phase !== "cancelled";
}

function toSeed(hunk: Hunk): SeedHunk {
  return {
    id: hunk.seedId,
    path: hunk.path,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    fileKind: hunk.fileKind,
  };
}

function makeContext(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly hunks: ReadonlyArray<Hunk>;
  readonly prepared: PreparedRun;
}): JourneyContext {
  const treePaths = new Set<string>([
    ...input.prepared.treePaths,
    // Deleted files are legitimate referents: a narrative may point at what a
    // step removed, and that path is not in the head tree.
    ...input.prepared.files.map((file) => file.path),
  ]);
  const evidence = makeEvidenceContext({
    // A link written against a seed survives that seed being split, so both
    // identities resolve.
    hunkIds: [...input.hunks.map((hunk) => hunk.id), ...input.seeds.map((seed) => seed.id)],
    treePaths,
    lineCounts: input.prepared.lineCounts,
    containsSymbol: () => true,
  });
  return { ...evidence, seeds: input.seeds };
}

function assembleCluster(input: {
  readonly planned: PlannedCluster;
  readonly clusters: ReadonlyArray<PlannedCluster>;
  readonly hunks: ReadonlyArray<Hunk>;
  readonly narration: {
    readonly narrative: string;
    readonly mapEntry: string;
    readonly resurfaced: ReadonlyArray<{ readonly hunkId: string; readonly note: string }>;
    readonly hints: ReadonlyArray<{
      readonly kind: string;
      readonly path: string;
      readonly side: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly body: string;
    }>;
  };
  readonly context: JourneyContext;
  readonly nextHintId: () => HintId;
}): { readonly cluster: Cluster; readonly hints: Hint[]; readonly problems: string[] } {
  const problems: string[] = [];
  const hunksById = new Map(input.hunks.map((hunk) => [hunk.id as string, hunk]));

  const narrative = downgradeUnresolvableLinks(input.narration.narrative, input.context);
  const mapEntry = downgradeUnresolvableLinks(input.narration.mapEntry, input.context);
  for (const link of [...narrative.downgraded, ...mapEntry.downgraded]) {
    problems.push(`The evidence link ${link} does not resolve; write one that does or drop it.`);
  }

  const resurfaced: Cluster["resurfaced"][number][] = [];
  const resurfacedPaths: string[] = [];
  for (const entry of input.narration.resurfaced) {
    const hunk = hunksById.get(entry.hunkId);
    if (hunk === undefined) {
      problems.push(`Resurfaced hunk ${entry.hunkId} is not a hunk in this journey.`);
      continue;
    }
    if (hunk.home === input.planned.id) {
      problems.push(
        `Hunk ${entry.hunkId} is homed in this cluster, so it cannot be resurfaced here.`,
      );
      continue;
    }
    const home = input.clusters.find((cluster) => cluster.id === hunk.home);
    if (home === undefined || home.position > input.planned.position) {
      problems.push(
        `Hunk ${entry.hunkId}'s home comes later in the journey; resurfacing is retrospective only.`,
      );
      continue;
    }
    const note = downgradeUnresolvableLinks(entry.note, input.context);
    resurfaced.push({ hunkId: hunk.id, note: { markdown: note.markdown } });
    resurfacedPaths.push(hunk.path);
  }

  const hints: Hint[] = [];
  for (const hint of input.narration.hints) {
    const counts = input.context.lineCounts.get(hint.path);
    const side = hint.side === "old" ? "old" : "new";
    const available = counts === undefined ? 0 : side === "old" ? counts.old : counts.new;
    if (
      counts === undefined ||
      hint.startLine < 1 ||
      hint.endLine < hint.startLine ||
      hint.endLine > available
    ) {
      // Hints are optional aids; coverage is not. An unanchorable hint is
      // dropped rather than allowed to point at nothing.
      problems.push(
        `Hint anchored at ${hint.path}:${hint.startLine}–${hint.endLine} (${side}) is outside that file.`,
      );
      continue;
    }
    const body = downgradeUnresolvableLinks(hint.body, input.context);
    for (const link of body.downgraded) {
      problems.push(`Hint evidence link ${link} does not resolve.`);
    }
    hints.push({
      id: input.nextHintId(),
      clusterId: input.planned.id,
      kind: normalizeHintKind(hint.kind),
      anchor: { path: hint.path, side, startLine: hint.startLine, endLine: hint.endLine },
      body: { markdown: body.markdown },
    });
  }

  const homedPaths = input.hunks
    .filter((hunk) => hunk.home === input.planned.id)
    .map((hunk) => hunk.path);
  const fileOrder = orderedUnique([...input.planned.fileOrder, ...homedPaths, ...resurfacedPaths]);

  return {
    cluster: {
      id: input.planned.id,
      position: input.planned.position,
      title: input.planned.title,
      weight: input.planned.weight,
      narrative: { markdown: narrative.markdown },
      mapEntry: { markdown: mapEntry.markdown },
      buildsOn: input.planned.buildsOn,
      fileOrder,
      resurfaced,
    },
    hints,
    problems,
  };
}

const HINT_KINDS = new Set<Hint["kind"]>([
  "connection",
  "complexity",
  "ripple",
  "pattern-echo",
  "behavior",
  "resurfacing",
]);

function normalizeHintKind(value: string): Hint["kind"] {
  return HINT_KINDS.has(value as Hint["kind"]) ? (value as Hint["kind"]) : "connection";
}

function orderedUnique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function fallbackCluster(planned: PlannedCluster, hunks: ReadonlyArray<Hunk>): Cluster {
  const paths = orderedUnique(
    hunks.filter((hunk) => hunk.home === planned.id).map((hunk) => hunk.path),
  );
  return {
    id: planned.id,
    position: planned.position,
    title: planned.title,
    weight: planned.weight,
    narrative: {
      markdown:
        "The analysis did not produce a narrative for this cluster, so the pipeline is saying so rather than inventing one. The hunks below are its real contents, and they count toward coverage exactly as any other cluster's do.",
    },
    mapEntry: { markdown: "No narrative was produced for this cluster." },
    buildsOn: planned.buildsOn,
    fileOrder: paths,
    resurfaced: [],
  };
}

// ── The activity tracker ────────────────────────────────────────────────────

interface ActivityTracker {
  readonly observe: (event: HarnessEvent) => void;
  readonly setStage: (
    stage: "plan" | "narrate",
    done: number | null,
    total: number | null,
  ) => Effect.Effect<void>;
  readonly repairRound: Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}

/**
 * Counters derived only from observed harness events, never invented.
 *
 * Events arrive from inside an SDK's async iterator, so they are buffered into
 * a plain array and folded on a timer. That is also what keeps the transition's
 * feed readable: a burst of twenty file reads becomes one update, not twenty.
 */
const makeActivityTracker = Effect.fn("ingestion.makeActivityTracker")(function* (input: {
  /**
   * The files this pull request changed. "Files walked" is counted against
   * these, not against every path the harness opens: reading the code *around*
   * the change is the point of the analysis, but counting those reads would
   * push the number past the number of files there are.
   */
  readonly changedPaths: ReadonlySet<string>;
  readonly advance: (activity: AnalysisActivity) => Effect.Effect<unknown>;
}) {
  const pending: HarnessEvent[] = [];
  const filesWalked = new Set<string>();
  const symbolsTraced = new Set<string>();
  const searchedPaths = new Set<string>();
  const state = yield* Ref.make<AnalysisActivity>({
    stage: "plan",
    clustersDone: null,
    clustersTotal: null,
    current: null,
    trail: [],
    counters: {
      filesWalked: 0,
      filesTotal: input.changedPaths.size,
      symbolsTraced: 0,
      callSitesFollowed: 0,
    },
    repairRounds: 0,
  });
  const lineSequence = yield* Ref.make(0);

  // An identifier-shaped search pattern IS a symbol being traced; a regex or a
  // phrase is not, and is not counted as one.
  const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

  const flush = Effect.gen(function* () {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    let callSitesFollowed = 0;
    const lines: AnalysisActivityLine[] = [];

    for (const event of batch) {
      if (event.verb === "read" && event.path !== null) {
        if (searchedPaths.has(event.path)) callSitesFollowed += 1;
        // Every read counts as following a call site — that is a fact about
        // the harness — but only a changed file counts as walking the change.
        // The agent's own briefing under `.throughline/` is neither.
        if (input.changedPaths.has(event.path)) filesWalked.add(event.path);
      }
      if (event.verb === "search" && event.pattern !== null && IDENTIFIER.test(event.pattern)) {
        symbolsTraced.add(event.pattern);
        // A file opened after a search for a symbol is that symbol being
        // followed to a use — which is the only honest way to count call sites
        // from what a harness actually tells us.
        searchedPaths.add(event.detail);
      }
      const next = yield* Ref.updateAndGet(lineSequence, (value) => value + 1);
      lines.push({ sequence: next, verb: event.verb, detail: event.detail });
    }

    const current = lines.at(-1) ?? null;
    const previous = yield* Ref.get(state);
    const next: AnalysisActivity = {
      ...previous,
      current,
      trail: [...lines.slice(0, -1), ...previous.trail].slice(0, TRAIL_LENGTH),
      counters: {
        filesWalked: filesWalked.size,
        filesTotal: input.changedPaths.size,
        symbolsTraced: symbolsTraced.size,
        callSitesFollowed: previous.counters.callSitesFollowed + callSitesFollowed,
      },
    };
    yield* Ref.set(state, next);
    yield* input.advance(next);
  });

  return {
    observe: (event) => {
      // Bounded: a very long run must not grow this without limit between
      // flushes. Losing the middle of a burst costs nothing — the counters are
      // sets, and the feed is a trail, not a transcript.
      if (pending.length < 500) pending.push(event);
    },
    setStage: (stage, done, total) =>
      Effect.gen(function* () {
        const next = yield* Ref.updateAndGet(state, (previous) => ({
          ...previous,
          stage,
          clustersDone: done,
          clustersTotal: total,
        }));
        yield* input.advance(next);
      }),
    repairRound: Effect.gen(function* () {
      const next = yield* Ref.updateAndGet(state, (previous) => ({
        ...previous,
        repairRounds: previous.repairRounds + 1,
      }));
      yield* input.advance(next);
    }),
    flush,
  } satisfies ActivityTracker;
});
