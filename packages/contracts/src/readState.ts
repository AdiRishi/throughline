import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ClusterId, JourneyId } from "./journey.ts";

/**
 * Read state and the local verbs that ride beside it. All of this is
 * local-only: nothing here is ever written back to GitHub.
 */

/** One mode at a time, per journey, sticky until the reviewer switches it. */
export const DisplayMode = Schema.Literals(["inline", "just-the-code", "split"]);
export type DisplayMode = typeof DisplayMode.Type;

export const DEFAULT_DISPLAY_MODE: DisplayMode = "inline";

/** The product's unit of marking: a file within a cluster. */
export const ReadMark = Schema.Struct({
  clusterId: ClusterId,
  path: TrimmedNonEmptyString,
});
export type ReadMark = typeof ReadMark.Type;

/**
 * Mutable, server-owned, one document per journey. `journeyId` pairing makes
 * reanalysis resets automatic: a new journey simply has no read state yet.
 */
export const ReadState = Schema.Struct({
  journeyId: JourneyId,
  readFiles: Schema.Array(ReadMark),
  displayMode: DisplayMode,
  updatedAt: Schema.DateTimeUtc,
});
export type ReadState = typeof ReadState.Type;

export const ReadStateJson = Schema.fromJsonString(Schema.toCodecJson(ReadState));

/**
 * `readState.subscribe` events. Every event carries the whole document — it is
 * tiny, and a full snapshot cannot drift the way a patch stream can. The
 * monotonic `sequence` is what lets a reconnecting subscriber (or a second
 * window) fold without gaps or duplicates.
 */
export const ReadStateStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literals(["snapshot", "update"]),
  state: ReadState,
});
export type ReadStateStreamEvent = typeof ReadStateStreamEvent.Type;

// ── RPC payloads ────────────────────────────────────────────────────────────

export const ReadStateRef = Schema.Struct({
  journeyId: JourneyId,
});
export type ReadStateRef = typeof ReadStateRef.Type;

export const MarkFileInput = Schema.Struct({
  journeyId: JourneyId,
  clusterId: ClusterId,
  path: TrimmedNonEmptyString,
});
export type MarkFileInput = typeof MarkFileInput.Type;

export const SetDisplayModeInput = Schema.Struct({
  journeyId: JourneyId,
  displayMode: DisplayMode,
});
export type SetDisplayModeInput = typeof SetDisplayModeInput.Type;
