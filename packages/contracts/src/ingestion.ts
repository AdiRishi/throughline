import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HarnessKind, JourneyId, PrRef } from "./journey.ts";

/**
 * Ingestion as the renderer sees it. The transition UI is a direct rendering of
 * this stream — the narrated stages the product promises *are* these events, so
 * the narration is honest by construction. There is no invented progress here
 * because there is no other data source.
 */

/**
 * Phases, in order. `analyzing` is where the time goes and carries the activity
 * payload. `failed` is always operational (a clone error, a crashed harness, a
 * full disk) — never analytical: "too tangled to decompose" is not an outcome.
 */
export const IngestionPhase = Schema.Literals([
  "queued",
  "resolving",
  "cloning",
  "diffing",
  "analyzing",
  "validating",
  "saving",
  "complete",
  "cancelled",
  "failed",
]);
export type IngestionPhase = typeof IngestionPhase.Type;

/** Partitioning wants the whole change in view; narrating wants one cluster. */
export const AnalysisStage = Schema.Literals(["plan", "narrate"]);
export type AnalysisStage = typeof AnalysisStage.Type;

/**
 * Counters derived *only* from observed harness events. The names say exactly
 * what was observed: distinct changed files the agent opened, total distinct
 * files it read, searches it ran, and steps it took. Nothing here is estimated.
 */
export const AnalysisCounters = Schema.Struct({
  changedFilesOpened: NonNegativeInt,
  filesRead: NonNegativeInt,
  searchesRun: NonNegativeInt,
  steps: NonNegativeInt,
});
export type AnalysisCounters = typeof AnalysisCounters.Type;

/** What the agent is doing right now, plus a short trail of what it just did. */
export const AnalysisActivity = Schema.Struct({
  action: Schema.NullOr(Schema.String),
  /** Most recent first, capped server-side. */
  trail: Schema.Array(Schema.String),
  counters: AnalysisCounters,
});
export type AnalysisActivity = typeof AnalysisActivity.Type;

/** Narration runs are per cluster, so "3 of 5" is a real fraction. */
export const StageProgress = Schema.Struct({
  done: NonNegativeInt,
  total: NonNegativeInt,
  label: Schema.NullOr(Schema.String),
});
export type StageProgress = typeof StageProgress.Type;

export const IngestionFailure = Schema.Struct({
  message: Schema.String,
  /** Operational faults are retryable by definition; a rerun is a fresh job. */
  retryable: Schema.Boolean,
});
export type IngestionFailure = typeof IngestionFailure.Type;

/** Everything the transition UI renders, for one PR's job. */
export const IngestionJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  pr: PrRef,
  phase: IngestionPhase,
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  /** Present from `resolving` onward. */
  prTitle: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  baseSha: Schema.NullOr(TrimmedNonEmptyString),
  /** A one-line, literal account of the current phase. */
  detail: Schema.NullOr(Schema.String),
  changedFiles: Schema.NullOr(NonNegativeInt),
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  /** Files found on disk after cloning. */
  filesOnDisk: Schema.NullOr(NonNegativeInt),
  stage: Schema.NullOr(AnalysisStage),
  stageProgress: Schema.NullOr(StageProgress),
  activity: Schema.NullOr(AnalysisActivity),
  harness: Schema.NullOr(HarnessKind),
  /** Set once the artifact is committed. */
  journeyId: Schema.NullOr(JourneyId),
  failure: Schema.NullOr(IngestionFailure),
  /** 1-based, set only while `queued`. Analysis runs one at a time. */
  queuePosition: Schema.NullOr(Schema.Int),
});
export type IngestionJob = typeof IngestionJob.Type;

/**
 * `ingestion.subscribe` events — snapshot then live, every event carrying the
 * full set of live jobs. There are at most a handful, so the whole set travels
 * and the welcome screen gets "this PR is analyzing" for free.
 */
export const IngestionStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literals(["snapshot", "update"]),
  jobs: Schema.Array(IngestionJob),
});
export type IngestionStreamEvent = typeof IngestionStreamEvent.Type;

// ── RPC payloads ────────────────────────────────────────────────────────────

/**
 * Start ingestion for a PR. `reanalyze` is the reviewer's explicit choice to
 * rebuild against a new head — never the app's, and always a full rebuild that
 * resets read state.
 */
export const StartIngestionInput = Schema.Struct({
  ref: PrRef,
  reanalyze: Schema.Boolean,
});
export type StartIngestionInput = typeof StartIngestionInput.Type;

export const StartIngestionResult = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  ref: PrRef,
  /** True when a job for this PR was already running and was joined, not started. */
  joined: Schema.Boolean,
});
export type StartIngestionResult = typeof StartIngestionResult.Type;

export const CancelIngestionInput = Schema.Struct({
  ref: PrRef,
});
export type CancelIngestionInput = typeof CancelIngestionInput.Type;
