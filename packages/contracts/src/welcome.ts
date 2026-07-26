/**
 * The welcome screen's view of the world: your repositories and their PRs,
 * enriched server-side with each PR's journey state and your local marks.
 *
 * The enrichment happens on the server because staleness and progress are
 * derivations over data the renderer would otherwise have to fetch per row.
 *
 * @module welcome
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitSha, PrRef, PrSummary, Viewer } from "./github.ts";
import { JourneyId } from "./journey.ts";

/**
 * What the reviewer has said locally about a PR. None of this reaches GitHub.
 */
export const PrMarks = Schema.Struct({
  /** A manual "I'm done with this", independent of journey progress. */
  reviewed: Schema.Boolean,
  hidden: Schema.Boolean,
  /** A merged PR dismissed before its ~week in the Merged section expires. */
  dismissedMerged: Schema.Boolean,
});
export type PrMarks = typeof PrMarks.Type;

export const LocalPrState = Schema.Struct({
  reviewed: Schema.Array(PrRef),
  hidden: Schema.Array(PrRef),
  dismissedMerged: Schema.Array(PrRef),
});
export type LocalPrState = typeof LocalPrState.Type;

/**
 * A PR's journey, as the list needs it. Staleness is computed at display time
 * from the cached PR view, so it can never be stale about being stale.
 */
export const PrJourneyState = Schema.Struct({
  journeyId: JourneyId,
  analyzedAt: Schema.DateTimeUtc,
  pinnedHeadSha: GitSha,
  stale: Schema.Boolean,
  clusterCount: NonNegativeInt,
  filesTotal: NonNegativeInt,
  filesRead: NonNegativeInt,
  hunksHomed: NonNegativeInt,
  hunksRead: NonNegativeInt,
  /** One fraction per cluster, in journey order — the list's segmented bar. */
  clusterFractions: Schema.Array(Schema.Number),
  currentClusterPosition: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  complete: Schema.Boolean,
});
export type PrJourneyState = typeof PrJourneyState.Type;

export const PrListEntry = Schema.Struct({
  pr: PrSummary,
  journey: Schema.NullOr(PrJourneyState),
  marks: PrMarks,
  /** True while an ingestion job for this PR is live — the row says "analyzing". */
  ingesting: Schema.Boolean,
});
export type PrListEntry = typeof PrListEntry.Type;

export const RepoPrGroup = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  entries: Schema.Array(PrListEntry),
});
export type RepoPrGroup = typeof RepoPrGroup.Type;

/**
 * Why the list is empty or partial, stated plainly rather than as a spinner
 * that never resolves. `parked` carries the reset instant so the UI can say
 * *when*, not just *that*.
 */
export const PrListStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ok") }),
  Schema.Struct({ kind: Schema.Literal("loading") }),
  Schema.Struct({
    kind: Schema.Literal("gh-unavailable"),
    reason: Schema.Literals(["not-installed", "not-authenticated"]),
    detail: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("parked"), resetAt: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("error"), detail: Schema.String }),
]);
export type PrListStatus = typeof PrListStatus.Type;

export const PrListView = Schema.Struct({
  viewer: Viewer,
  status: PrListStatus,
  /** Open PRs, grouped by repository, repos ordered by most recent activity. */
  repos: Schema.Array(RepoPrGroup),
  /** Merged within the lingering window, newest first. */
  merged: Schema.Array(PrListEntry),
  refreshedAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type PrListView = typeof PrListView.Type;

export const PrListSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  view: PrListView,
});
export type PrListSnapshotEvent = typeof PrListSnapshotEvent.Type;

export const PrListChangedEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("changed"),
  view: PrListView,
});
export type PrListChangedEvent = typeof PrListChangedEvent.Type;

export const PrListStreamEvent = Schema.Union([PrListSnapshotEvent, PrListChangedEvent]);
export type PrListStreamEvent = typeof PrListStreamEvent.Type;

/** How long a merged PR lingers on the welcome screen before it leaves on its own. */
export const MERGED_LINGER_DAYS = 7;
