/**
 * Read state and the derived progress views.
 *
 * Read tracking is local-only and never written back to GitHub. The unit of
 * marking is the product's: a file within a cluster. Progress is *derived*
 * (`@app/journey/progress`), never stored — stored aggregates can lie.
 *
 * @module reading
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClusterId, JourneyId } from "./journey.ts";

/**
 * One mode at a time, journey-wide, sticky until changed. The top bar's
 * Diff | Code toggle and the file headers' inline/split control both set this
 * one value — placement is reach, not scope.
 */
export const DisplayMode = Schema.Literals(["inline", "just-the-code", "split"]);
export type DisplayMode = typeof DisplayMode.Type;

export const ReadMark = Schema.Struct({
  clusterId: ClusterId,
  path: TrimmedNonEmptyString,
});
export type ReadMark = typeof ReadMark.Type;

/**
 * Marks are meaningless against any other journey, so they are paired to a
 * `journeyId`: reanalysis produces a new id and therefore an empty read state,
 * with no carry-over logic to get wrong.
 */
export const ReadState = Schema.Struct({
  journeyId: JourneyId,
  readFiles: Schema.Array(ReadMark),
  displayMode: DisplayMode,
  updatedAt: Schema.DateTimeUtc,
});
export type ReadState = typeof ReadState.Type;

/** Snapshot-then-live, per journey — multi-window consistency for free. */
export const ReadStateSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  state: ReadState,
});
export type ReadStateSnapshotEvent = typeof ReadStateSnapshotEvent.Type;

export const ReadStateChangedEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("changed"),
  state: ReadState,
});
export type ReadStateChangedEvent = typeof ReadStateChangedEvent.Type;

export const ReadStateStreamEvent = Schema.Union([ReadStateSnapshotEvent, ReadStateChangedEvent]);
export type ReadStateStreamEvent = typeof ReadStateStreamEvent.Type;

// ── Derived progress (computed by `@app/journey/progress`, never stored) ─────

/**
 * A cluster's progress: homed hunks living in read files over homed hunks.
 * Resurfaced hunks count nowhere but home, so they never appear here.
 */
export const ClusterProgress = Schema.Struct({
  clusterId: ClusterId,
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  hunksHomed: NonNegativeInt,
  hunksRead: NonNegativeInt,
  filesTotal: NonNegativeInt,
  filesRead: NonNegativeInt,
  complete: Schema.Boolean,
});
export type ClusterProgress = typeof ClusterProgress.Type;

export const JourneyProgress = Schema.Struct({
  journeyId: JourneyId,
  hunksHomed: NonNegativeInt,
  hunksRead: NonNegativeInt,
  filesTotal: NonNegativeInt,
  filesRead: NonNegativeInt,
  clusters: Schema.Array(ClusterProgress),
  /** 1-based position of the first incomplete cluster; null when finished. */
  currentClusterPosition: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  complete: Schema.Boolean,
});
export type JourneyProgress = typeof JourneyProgress.Type;

// ── File payloads served from the run directory / clone ─────────────────────

export const FilePatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Unified diff with standard context, or empty for a non-textual change. */
  patch: Schema.String,
});
export type FilePatch = typeof FilePatch.Type;

/**
 * Both revisions of one file. `old` is null for added files and for any file
 * outside the changed set (free reading serves the head revision only).
 */
export const FileContent = Schema.Struct({
  path: TrimmedNonEmptyString,
  old: Schema.NullOr(Schema.String),
  new: Schema.NullOr(Schema.String),
  binary: Schema.Boolean,
  /** True when the file was skipped for size; the UI says so rather than lying. */
  omitted: Schema.Boolean,
});
export type FileContent = typeof FileContent.Type;

/** The project's real file tree at the pinned head — not a list of changed paths. */
export const FileTreeListing = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type FileTreeListing = typeof FileTreeListing.Type;

/** The journey artifact is gone (evicted, re-ingested, or never existed). */
export class JourneyNotFoundError extends Schema.TaggedErrorClass<JourneyNotFoundError>()(
  "JourneyNotFoundError",
  {
    journeyId: JourneyId,
  },
) {
  override get message(): string {
    return `No journey exists with id ${this.journeyId}.`;
  }
}

/** A file the journey references is not available on disk any more. */
export class FileUnavailableError extends Schema.TaggedErrorClass<FileUnavailableError>()(
  "FileUnavailableError",
  {
    journeyId: JourneyId,
    path: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Could not read ${this.path} for journey ${this.journeyId}: ${this.detail}`;
  }
}
