import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The journey artifact and everything in it. This file is the machine-readable
 * form of `CONTEXT.md`'s language: a journey partitions a pull request's diff
 * into ordered clusters, every hunk has exactly one home, and coverage is a
 * checked invariant rather than a promise.
 *
 * The artifact is immutable — the output of exactly one analysis run, written in
 * one transaction and never patched. Everything mutable (read state, display
 * mode) lives outside it, in `readState.ts`.
 */

// ── Identity ────────────────────────────────────────────────────────────────

/** A pull request, the way every surface in the product names one. */
export const PrRef = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type PrRef = typeof PrRef.Type;

/** Unique per analysis run — read marks are meaningless against another one. */
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

/** A cluster's attention classification. Never risk, severity, or quality. */
export const Weight = Schema.Literals(["core", "supporting", "mechanical"]);
export type Weight = typeof Weight.Type;

/**
 * Markdown with one extension: evidence links as `tl:` URIs
 * (`tl:hunk/h12`, `tl:file/src/auth/token.ts`, `tl:symbol/src/auth/token.ts#issueToken`).
 * Evidence lives *in* the text so there is no parallel refs array to drift.
 */
export const Narrative = Schema.Struct({
  markdown: Schema.String,
});
export type Narrative = typeof Narrative.Type;

// ── Hunks and the partition ─────────────────────────────────────────────────

/**
 * Why a changed file carries a synthetic file-level hunk instead of line
 * ranges. These files have no changed *lines* but are still changed *files*, so
 * they need a placeable unit for the partition to cover every change.
 */
export const HunkFileKind = Schema.Literals([
  "binary",
  "rename",
  "mode",
  "symlink",
  "submodule",
  "empty",
]);
export type HunkFileKind = typeof HunkFileKind.Type;

/**
 * Throughline's atomic unit of placement: a contiguous run of changed lines
 * serving one concern. Line counts of 0 are legal (a pure insertion has
 * `oldLines: 0`); a file-level hunk has both at 0 and carries a `fileKind`.
 */
export const Hunk = Schema.Struct({
  id: HunkId,
  /** New path; the old path for pure deletions. */
  path: TrimmedNonEmptyString,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  /** Set only on file-level hunks, which the agent may never split. */
  fileKind: Schema.optionalKey(HunkFileKind),
  /** The seed hunk this is a split of; equals `id` when unsplit. */
  seedId: HunkId,
  home: ClusterId,
});
export type Hunk = typeof Hunk.Type;

export const FileChangeKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
]);
export type FileChangeKind = typeof FileChangeKind.Type;

/** Every changed file in the pull request, with rename tracking. */
export const FileChange = Schema.Struct({
  /** New path; the old path for pure deletions. */
  path: TrimmedNonEmptyString,
  /** Present for renames and copies. */
  oldPath: Schema.optionalKey(TrimmedNonEmptyString),
  kind: FileChangeKind,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Git reported this file as binary; it renders as what it is, not as a diff. */
  binary: Schema.Boolean,
  /** Set when git reported a mode change (including symlink/submodule flips). */
  oldMode: Schema.optionalKey(TrimmedNonEmptyString),
  newMode: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FileChange = typeof FileChange.Type;

// ── Clusters ────────────────────────────────────────────────────────────────

/** A hunk homed elsewhere, revisited here for a cross-cutting perspective. */
export const ResurfacedHunk = Schema.Struct({
  hunkId: HunkId,
  note: Narrative,
});
export type ResurfacedHunk = typeof ResurfacedHunk.Type;

/** One describable step of the journey. */
export const Cluster = Schema.Struct({
  id: ClusterId,
  /** 1-based journey order. */
  position: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  title: TrimmedNonEmptyString,
  weight: Weight,
  /** Leads the cluster page. */
  narrative: Narrative,
  /** The compressed two-to-three sentence account shown on the Overview map. */
  mapEntry: Narrative,
  /** Relationships to *earlier* clusters only. */
  buildsOn: Schema.Array(ClusterId),
  /** Narrative order: every path hosting a homed or resurfaced hunk, once. */
  fileOrder: Schema.Array(TrimmedNonEmptyString),
  resurfaced: Schema.Array(ResurfacedHunk),
});
export type Cluster = typeof Cluster.Type;

// ── The Overview ────────────────────────────────────────────────────────────

/**
 * Per-cluster attention guidance shown as the Overview's closing strip
 * ("1 read closely → 4 walk quickly"). Guidance about attention, never a
 * verdict on the code.
 */
export const AttentionNote = Schema.Struct({
  clusterId: ClusterId,
  phrase: TrimmedNonEmptyString,
});
export type AttentionNote = typeof AttentionNote.Type;

/**
 * The journey-level narrative the agent writes deliberately. The map's entries
 * are not stored here — they derive from each cluster's `mapEntry`, so the map
 * and the territory cannot disagree.
 */
export const Overview = Schema.Struct({
  brief: Narrative,
  whereToBegin: Narrative,
  attention: Schema.Array(AttentionNote),
});
export type Overview = typeof Overview.Type;

// ── Hints ───────────────────────────────────────────────────────────────────

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
 * Where a hint attaches. Anchors may cover unchanged lines — ripple context
 * legitimately points at code the diff didn't touch — but must lie within the
 * file at the pinned revision.
 */
export const HintAnchor = Schema.Struct({
  path: TrimmedNonEmptyString,
  side: Schema.Literals(["old", "new"]),
  startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  endLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type HintAnchor = typeof HintAnchor.Type;

export const Hint = Schema.Struct({
  id: HintId,
  /** Hints ride the cluster whose reading they accompany. */
  clusterId: ClusterId,
  kind: HintKind,
  anchor: HintAnchor,
  body: Narrative,
});
export type Hint = typeof Hint.Type;

// ── Provenance ──────────────────────────────────────────────────────────────

export const HarnessKind = Schema.Literals(["codex", "claude"]);
export type HarnessKind = typeof HarnessKind.Type;

export const HarnessUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
});
export type HarnessUsage = typeof HarnessUsage.Type;

/**
 * Which harness built this journey, and every deterministic fallback the
 * pipeline had to stand on. Honesty, not UI: a journey that needed the floor
 * says so in the artifact.
 */
export const Provenance = Schema.Struct({
  harnessKind: HarnessKind,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  usage: Schema.optionalKey(HarnessUsage),
  /** Machine-generated notes, one per fallback taken. Empty is the good case. */
  fallbacks: Schema.Array(Schema.String),
});
export type Provenance = typeof Provenance.Type;

/**
 * The pull request's own words, pinned at analysis time. Shown collapsed at the
 * bottom of the Overview — reference material behind the reconstructed story.
 */
export const PrWords = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  author: Schema.String,
  url: Schema.String,
  createdAt: Schema.DateTimeUtc,
});
export type PrWords = typeof PrWords.Type;

/** What `baseSha..headSha` every claim in the artifact is a claim about. */
export const JourneyPin = Schema.Struct({
  headSha: TrimmedNonEmptyString,
  /** merge-base(base branch, head) at analysis time. */
  baseSha: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  analyzedAt: Schema.DateTimeUtc,
});
export type JourneyPin = typeof JourneyPin.Type;

/**
 * The artifact. `formatVersion` is the blob's own version, independent of the
 * database schema: an undecodable or future-versioned blob is treated as
 * absent (re-ingest, never crash).
 */
export const Journey = Schema.Struct({
  formatVersion: Schema.Literal(1),
  id: JourneyId,
  pr: PrRef,
  prWords: PrWords,
  pinned: JourneyPin,
  provenance: Provenance,
  overview: Overview,
  /** In journey order. */
  clusters: Schema.Array(Cluster),
  /** The complete partition: every changed line, every changed file. */
  hunks: Schema.Array(Hunk),
  files: Schema.Array(FileChange),
  hints: Schema.Array(Hint),
});
export type Journey = typeof Journey.Type;

/** JSON wire/disk codec — `analyzedAt` and `createdAt` travel as ISO strings. */
export const JourneyJson = Schema.fromJsonString(Schema.toCodecJson(Journey));
