import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { Journey, JourneyId, PrRef } from "./journey.ts";

/**
 * The read side of a journey: the RPC shapes the reading experience is served
 * from. Every one of these is immutable per journey, which is what makes them
 * cacheable forever client-side — the artifact is pinned to `baseSha..headSha`
 * and its referents cannot drift.
 */

export class JourneyNotFoundError extends Schema.TaggedErrorClass<JourneyNotFoundError>()(
  "JourneyNotFoundError",
  {
    pr: Schema.optionalKey(PrRef),
    journeyId: Schema.optionalKey(JourneyId),
  },
) {
  override get message(): string {
    return this.journeyId === undefined
      ? "No journey exists for that pull request."
      : `No journey exists with id ${this.journeyId}.`;
  }
}

export class JourneyFileNotFoundError extends Schema.TaggedErrorClass<JourneyFileNotFoundError>()(
  "JourneyFileNotFoundError",
  {
    journeyId: JourneyId,
    path: Schema.String,
  },
) {
  override get message(): string {
    return `${this.path} is not available in this journey's pinned revision.`;
  }
}

/**
 * A journey plus the two facts that are *not* part of the immutable artifact:
 * whether it is stale, and what the PR's head is right now. Staleness is never
 * stored — it is computed at the moment of display, so it cannot be stale about
 * being stale.
 */
export const JourneyEnvelope = Schema.Struct({
  journey: Journey,
  stale: Schema.Boolean,
  /** The PR's current head per the cached GitHub view, or null when unknown. */
  currentHeadSha: Schema.NullOr(TrimmedNonEmptyString),
});
export type JourneyEnvelope = typeof JourneyEnvelope.Type;

export const JourneyRef = Schema.Struct({
  journeyId: JourneyId,
});
export type JourneyRef = typeof JourneyRef.Type;

export const JourneyFileRef = Schema.Struct({
  journeyId: JourneyId,
  path: TrimmedNonEmptyString,
});
export type JourneyFileRef = typeof JourneyFileRef.Type;

/** One changed file's unified diff, with standard context, as `@pierre/diffs` parses it. */
export const FilePatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldPath: Schema.NullOr(TrimmedNonEmptyString),
  patch: Schema.String,
  binary: Schema.Boolean,
});
export type FilePatch = typeof FilePatch.Type;

/**
 * Full old- and new-revision contents. Serves context expansion beyond the
 * patch, the just-the-code view, and free reading of any tree file. `null`
 * means the file does not exist on that side (added or deleted); binary sides
 * carry a byte count instead of text.
 */
export const FileContent = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldText: Schema.NullOr(Schema.String),
  newText: Schema.NullOr(Schema.String),
  oldBinaryBytes: Schema.NullOr(NonNegativeInt),
  newBinaryBytes: Schema.NullOr(NonNegativeInt),
  /** Data URL for images, so the reading surface can render them as images. */
  oldImageDataUrl: Schema.NullOr(Schema.String),
  newImageDataUrl: Schema.NullOr(Schema.String),
});
export type FileContent = typeof FileContent.Type;

/** The project's real file tree at the pinned head — not a list of changed paths. */
export const JourneyTree = Schema.Struct({
  journeyId: JourneyId,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type JourneyTree = typeof JourneyTree.Type;
