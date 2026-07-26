/**
 * The journey artifact — the whole product as data.
 *
 * A journey is immutable: the output of exactly one whole analysis run,
 * committed in a single transaction and never patched. Everything mutable
 * (read marks, display mode) lives outside it, keyed by `journeyId`.
 *
 * The schemas here are what make the vision's guarantees checkable by a
 * machine: `@app/journey` validates a candidate journey against them plus the
 * coverage rules before the server will persist it.
 *
 * @module journey
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitSha, PrRef } from "./github.ts";

/** Unique per analysis run. Read state is paired to it, so a rerun resets progress. */
export const JourneyId = TrimmedNonEmptyString.pipe(Schema.brand("JourneyId"));
export type JourneyId = typeof JourneyId.Type;

/** `"c3"` — dense, 1-based, in journey order. */
export const ClusterId = TrimmedNonEmptyString.pipe(Schema.brand("ClusterId"));
export type ClusterId = typeof ClusterId.Type;

/** `"h12"` — dense, ordered by (path, position). */
export const HunkId = TrimmedNonEmptyString.pipe(Schema.brand("HunkId"));
export type HunkId = typeof HunkId.Type;

export const HintId = TrimmedNonEmptyString.pipe(Schema.brand("HintId"));
export type HintId = typeof HintId.Type;

/**
 * Prose with evidence in it. Markdown with one extension: `tl:` URIs —
 * `tl:hunk/h12`, `tl:file/src/auth/token.ts`,
 * `tl:symbol/src/auth/token.ts#issueToken`. There is deliberately no parallel
 * refs array: a second list would drift from the text it describes.
 */
export const Narrative = Schema.Struct({
  markdown: Schema.String,
});
export type Narrative = typeof Narrative.Type;

/**
 * A cluster's attention classification. Guidance about comprehension effort —
 * never risk, severity, or quality (those words are banned; see CONTEXT.md).
 */
export const Weight = Schema.Literals(["core", "supporting", "mechanical"]);
export type Weight = typeof Weight.Type;

/**
 * How a file changed between the pinned base and head. `renamed` and `copied`
 * carry `oldPath`; `deleted` files are keyed by their old path.
 */
export const FileChangeKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
]);
export type FileChangeKind = typeof FileChangeKind.Type;

export const FileChange = Schema.Struct({
  /** New path — the old path for pure deletions. Unique across the array. */
  path: TrimmedNonEmptyString,
  oldPath: Schema.NullOr(TrimmedNonEmptyString),
  changeKind: FileChangeKind,
  binary: Schema.Boolean,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Present when the mode changed (`100644` → `100755`, symlink, submodule). */
  oldMode: Schema.NullOr(Schema.String),
  newMode: Schema.NullOr(Schema.String),
});
export type FileChange = typeof FileChange.Type;

/**
 * Why a file-level hunk exists: the file changed but yielded no changed lines.
 * A file-level hunk is homed, validated, and counted like any other — which is
 * what makes the partition cover every changed *file*, not merely every
 * changed line. The agent may never split one.
 */
export const FileHunkKind = Schema.Literals([
  "binary",
  "rename",
  "mode",
  "symlink",
  "submodule",
  "empty",
]);
export type FileHunkKind = typeof FileHunkKind.Type;

/**
 * Throughline's atomic unit of placement.
 *
 * Line ranges are half-open in the usual patch sense: `oldStart` is 1-based and
 * `oldLines` may be 0 (a pure insertion), and likewise for the new side. A
 * hunk with `fileKind` set is a file-level hunk and carries no line ranges.
 */
export const Hunk = Schema.Struct({
  id: HunkId,
  path: TrimmedNonEmptyString,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  fileKind: Schema.NullOr(FileHunkKind),
  /** The seed hunk this is a split of; equals `id` when unsplit. */
  seedId: HunkId,
  home: ClusterId,
});
export type Hunk = typeof Hunk.Type;

/**
 * A seed hunk, before any agent involvement: the deterministic parse of the
 * zero-context diff. Seeds and the changed-line set they cover are computed
 * facts, which is the mechanism behind the coverage guarantee.
 */
export const SeedHunk = Schema.Struct({
  id: HunkId,
  path: TrimmedNonEmptyString,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  fileKind: Schema.NullOr(FileHunkKind),
});
export type SeedHunk = typeof SeedHunk.Type;

export const Cluster = Schema.Struct({
  id: ClusterId,
  /** 1-based journey order. */
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  title: TrimmedNonEmptyString,
  weight: Weight,
  /** Leads the cluster page. */
  narrative: Narrative,
  /** The compressed 2–3 sentence account the Overview map shows. */
  mapEntry: Narrative,
  /** Relationships to *earlier* clusters only. */
  buildsOn: Schema.Array(ClusterId),
  /**
   * Narrative order, never alphabetical: every path hosting a homed or
   * resurfaced hunk, exactly once.
   */
  fileOrder: Schema.Array(TrimmedNonEmptyString),
  /** Hunks homed elsewhere, revisited here for a cross-cutting perspective. */
  resurfaced: Schema.Array(
    Schema.Struct({
      hunkId: HunkId,
      note: Narrative,
    }),
  ),
});
export type Cluster = typeof Cluster.Type;

/**
 * The journey-level narrative the agent writes deliberately. The map's entries
 * are the clusters' own `mapEntry` values — the map and the territory can't
 * disagree because they are the same prose.
 */
export const Overview = Schema.Struct({
  brief: Narrative,
  whereToBegin: Narrative,
});
export type Overview = typeof Overview.Type;

export const HintKind = Schema.Literals([
  "connection",
  "complexity",
  "ripple",
  "pattern-echo",
  "behavior",
  "resurfacing",
]);
export type HintKind = typeof HintKind.Type;

/**
 * Scroll-anchored guidance. Anchors may cover unchanged lines (ripple context
 * legitimately points at code the diff didn't touch) but must lie within the
 * file at the pinned revision.
 */
export const Hint = Schema.Struct({
  id: HintId,
  clusterId: ClusterId,
  kind: HintKind,
  anchor: Schema.Struct({
    path: TrimmedNonEmptyString,
    side: Schema.Literals(["old", "new"]),
    startLine: Schema.Int.check(Schema.isGreaterThan(0)),
    endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  body: Narrative,
});
export type Hint = typeof Hint.Type;

export const HarnessKind = Schema.Literals(["codex", "claude"]);
export type HarnessKind = typeof HarnessKind.Type;

/**
 * Which harness built this journey, and what the pipeline had to do for itself.
 * Honesty, not UI: a journey that stood on the deterministic floor says so.
 */
export const Provenance = Schema.Struct({
  harnessKind: HarnessKind,
  model: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(
    Schema.Struct({
      inputTokens: NonNegativeInt,
      outputTokens: NonNegativeInt,
    }),
  ),
  /** Every deterministic-completion fallback the pipeline stood on, in order. */
  fallbacks: Schema.Array(Schema.String),
  /** The run directory's id — where transcripts and materialized inputs live. */
  runId: TrimmedNonEmptyString,
});
export type Provenance = typeof Provenance.Type;

/** The PR's own words, captured at analysis time so the artifact is self-contained. */
export const PrSnapshot = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  authorLogin: Schema.String,
  url: Schema.String,
});
export type PrSnapshot = typeof PrSnapshot.Type;

/**
 * The artifact. `formatVersion` is the blob's own version, independent of the
 * database schema: an undecodable or future-versioned blob is treated as
 * absent — re-ingest, never crash.
 */
export const JOURNEY_FORMAT_VERSION = 1;

export const Journey = Schema.Struct({
  formatVersion: Schema.Literal(JOURNEY_FORMAT_VERSION),
  id: JourneyId,
  pr: PrRef,
  prSnapshot: PrSnapshot,
  pinned: Schema.Struct({
    headSha: GitSha,
    /** merge-base(base branch, head) at analysis time. */
    baseSha: GitSha,
    analyzedAt: Schema.DateTimeUtc,
  }),
  provenance: Provenance,
  overview: Overview,
  /** In journey order. */
  clusters: Schema.Array(Cluster),
  /** The complete partition — every changed line, every changed file. */
  hunks: Schema.Array(Hunk),
  files: Schema.Array(FileChange),
  hints: Schema.Array(Hint),
});
export type Journey = typeof Journey.Type;

// ── Coverage violations ─────────────────────────────────────────────────────

/**
 * What a validator returns. These strings are fed verbatim into the harness
 * repair turn, so they are written to be actionable by a model as well as by a
 * human: identify the object, say precisely what is wrong.
 */
export const CoverageViolationKind = Schema.Literals([
  "hunk-unassigned",
  "hunk-unknown-home",
  "line-uncovered",
  "line-covered-twice",
  "split-does-not-tile-seed",
  "split-of-file-hunk",
  "file-hunk-missing",
  "file-hunk-duplicated",
  "unknown-hunk",
  "unknown-path",
  "cluster-empty",
  "cluster-order-invalid",
  "builds-on-forward-reference",
  "builds-on-unknown-cluster",
  "file-order-mismatch",
  "resurfaced-unknown-hunk",
  "resurfaced-at-home",
  "resurfaced-forward-reference",
  "evidence-link-unresolvable",
  "hint-anchor-out-of-range",
  "hint-unknown-cluster",
]);
export type CoverageViolationKind = typeof CoverageViolationKind.Type;

export const CoverageViolation = Schema.Struct({
  kind: CoverageViolationKind,
  /** Human- and model-readable: "h17 is not assigned to any cluster." */
  message: Schema.String,
  path: Schema.NullOr(Schema.String),
  hunkId: Schema.NullOr(HunkId),
  clusterId: Schema.NullOr(ClusterId),
});
export type CoverageViolation = typeof CoverageViolation.Type;
