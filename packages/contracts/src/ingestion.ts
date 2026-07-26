/**
 * Ingestion: the door, the job, and the honest progress stream.
 *
 * Two error channels that must never be conflated:
 *  - **Door rejections** are the only failures of `ingestion.start`. They are
 *    answered before a job exists: a bad URL, a `gh` that can't see the PR, no
 *    usable harness.
 *  - **Operational faults** fail a running job — a clone error, a crashed
 *    harness, a full disk. They are visible and retryable.
 *
 * What cannot exist is an *analytical* failure. "Too tangled to decompose" is
 * never an outcome; the repair ladder guarantees a valid journey always exists.
 *
 * @module ingestion
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PrRef } from "./github.ts";
import { HarnessKind, JourneyId } from "./journey.ts";

export const JobId = TrimmedNonEmptyString.pipe(Schema.brand("JobId"));
export type JobId = typeof JobId.Type;

// ── The door ────────────────────────────────────────────────────────────────

/** The pasted text is not a GitHub pull request URL. */
export class DoorInvalidUrlError extends Schema.TaggedErrorClass<DoorInvalidUrlError>()(
  "DoorInvalidUrlError",
  { input: Schema.String },
) {
  override get message(): string {
    return `"${this.input}" is not a GitHub pull request URL.`;
  }
}

/** `gh` is missing or signed out — parked with setup instructions, never retried. */
export class DoorGhUnavailableError extends Schema.TaggedErrorClass<DoorGhUnavailableError>()(
  "DoorGhUnavailableError",
  {
    reason: Schema.Literals(["not-installed", "not-authenticated"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "not-installed"
      ? "The GitHub CLI (gh) is not installed."
      : "The GitHub CLI (gh) is not signed in.";
  }
}

/**
 * The PR is not visible to this login. Deliberately indistinguishable from
 * "private repository" — honestly so; we genuinely cannot tell.
 */
export class DoorNotFoundError extends Schema.TaggedErrorClass<DoorNotFoundError>()(
  "DoorNotFoundError",
  { pr: PrRef },
) {
  override get message(): string {
    return `${this.pr.owner}/${this.pr.repo}#${this.pr.number} is not visible to your gh login.`;
  }
}

/** Closed without merging, or merged long enough ago to be out of scope. */
export class DoorNotOpenError extends Schema.TaggedErrorClass<DoorNotOpenError>()(
  "DoorNotOpenError",
  { pr: PrRef, state: Schema.String },
) {
  override get message(): string {
    return `${this.pr.owner}/${this.pr.repo}#${this.pr.number} is ${this.state}; only open and recently merged pull requests can be ingested.`;
  }
}

/** No agent harness is installed and authenticated — a parked state, like `gh`. */
export class DoorNoHarnessError extends Schema.TaggedErrorClass<DoorNoHarnessError>()(
  "DoorNoHarnessError",
  { detail: Schema.String },
) {
  override get message(): string {
    return "No agent harness is installed and authenticated.";
  }
}

/** Rate limits park the whole GitHub module; the door reports it rather than queueing. */
export class DoorGitHubParkedError extends Schema.TaggedErrorClass<DoorGitHubParkedError>()(
  "DoorGitHubParkedError",
  { resetAt: Schema.DateTimeUtc },
) {
  override get message(): string {
    return `GitHub rate limit reached; parked until ${this.resetAt.toString()}.`;
  }
}

/** Everything `ingestion.start` may answer "no" with — and nothing else. */
export const DoorRejection = Schema.Union([
  DoorInvalidUrlError,
  DoorGhUnavailableError,
  DoorNotFoundError,
  DoorNotOpenError,
  DoorNoHarnessError,
  DoorGitHubParkedError,
]);
export type DoorRejection = typeof DoorRejection.Type;

// ── The job ─────────────────────────────────────────────────────────────────

/**
 * The pipeline's real phases. The transition UI groups them for display, but
 * the wire carries what actually happened — which is what makes the narration
 * honest by construction.
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

/** Which structured run is in flight: partitioning, then narrating. */
export const AnalysisStage = Schema.Literals(["plan", "narrate"]);
export type AnalysisStage = typeof AnalysisStage.Type;

/**
 * Counters derived only from observed harness events — never invented.
 *
 *  - `filesWalked`  — distinct files the harness opened.
 *  - `symbolsTraced`— distinct identifier-shaped search patterns it issued.
 *  - `callSitesFollowed` — file opens that landed on a path a previous search
 *    surfaced; i.e. a symbol traced from its search to a use.
 */
export const AnalysisCounters = Schema.Struct({
  filesWalked: NonNegativeInt,
  filesTotal: NonNegativeInt,
  symbolsTraced: NonNegativeInt,
  callSitesFollowed: NonNegativeInt,
});
export type AnalysisCounters = typeof AnalysisCounters.Type;

/** One observed harness action, as the transition's live feed renders it. */
export const AnalysisActivityLine = Schema.Struct({
  /** Monotonic within a job, so the renderer can key rows without guessing. */
  sequence: NonNegativeInt,
  verb: TrimmedNonEmptyString,
  detail: Schema.String,
});
export type AnalysisActivityLine = typeof AnalysisActivityLine.Type;

export const AnalysisActivity = Schema.Struct({
  stage: AnalysisStage,
  /** Narration is per cluster; these are null during the plan stage. */
  clustersDone: Schema.NullOr(NonNegativeInt),
  clustersTotal: Schema.NullOr(NonNegativeInt),
  current: Schema.NullOr(AnalysisActivityLine),
  /** Most recent first, capped — a trail, not a transcript. */
  trail: Schema.Array(AnalysisActivityLine),
  counters: AnalysisCounters,
  /** Repair rounds stood on so far; shown quietly, because honesty. */
  repairRounds: NonNegativeInt,
});
export type AnalysisActivity = typeof AnalysisActivity.Type;

/** An operational fault. Never analytical — see the module doc. */
export const IngestionFailure = Schema.Struct({
  message: Schema.String,
  detail: Schema.String,
  /** Phase the job died in, so the UI can say where rather than just that. */
  phase: IngestionPhase,
});
export type IngestionFailure = typeof IngestionFailure.Type;

/** Detail lines the transition shows under each stage, filled in as they become true. */
export const IngestionFacts = Schema.Struct({
  headSha: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  /** Files in the head revision on disk, once the worktree exists. */
  worktreeFiles: Schema.NullOr(NonNegativeInt),
  changedFiles: Schema.NullOr(NonNegativeInt),
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  seedHunks: Schema.NullOr(NonNegativeInt),
  clusters: Schema.NullOr(NonNegativeInt),
});
export type IngestionFacts = typeof IngestionFacts.Type;

export const IngestionJob = Schema.Struct({
  jobId: JobId,
  pr: PrRef,
  title: Schema.String,
  harness: HarnessKind,
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  phase: IngestionPhase,
  /** Position in the global queue; 0 means running. */
  queuePosition: NonNegativeInt,
  facts: IngestionFacts,
  activity: Schema.NullOr(AnalysisActivity),
  failure: Schema.NullOr(IngestionFailure),
  /** Set exactly once, when `phase` becomes `complete`. */
  journeyId: Schema.NullOr(JourneyId),
  /** True when this run replaces an existing journey (product 02's reanalysis). */
  reanalysis: Schema.Boolean,
});
export type IngestionJob = typeof IngestionJob.Type;

/**
 * Snapshot-then-live, keyed by PR. A renderer that disconnects mid-run and
 * comes back gets the current job state first, then follows — which is what
 * makes ingestion leavable.
 */
export const IngestionSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  job: Schema.NullOr(IngestionJob),
});
export type IngestionSnapshotEvent = typeof IngestionSnapshotEvent.Type;

export const IngestionUpdateEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("update"),
  job: IngestionJob,
});
export type IngestionUpdateEvent = typeof IngestionUpdateEvent.Type;

export const IngestionStreamEvent = Schema.Union([IngestionSnapshotEvent, IngestionUpdateEvent]);
export type IngestionStreamEvent = typeof IngestionStreamEvent.Type;

export const IngestionStartInput = Schema.Struct({
  /** Either a resolved ref (list click) or a pasted URL (the quieter door). */
  target: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ref"), pr: PrRef }),
    Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
  ]),
  /** A reanalysis discards the existing journey and its read state on success. */
  reanalyze: Schema.Boolean,
});
export type IngestionStartInput = typeof IngestionStartInput.Type;

export const IngestionStartResult = Schema.Struct({
  jobId: JobId,
  pr: PrRef,
  /** Set when a journey already existed and no reanalysis was asked for. */
  existingJourneyId: Schema.NullOr(JourneyId),
});
export type IngestionStartResult = typeof IngestionStartResult.Type;
