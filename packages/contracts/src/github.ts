import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { JourneyId, PrRef } from "./journey.ts";

/**
 * What the renderer knows about GitHub. Everything here is a *view*: the server
 * owns the one `GitHub` module that talks to `gh`, and these are the shapes it
 * publishes. Nothing in this file describes a write — Throughline has no
 * mutating GitHub call anywhere.
 */

/** Whether `gh` is usable at all. An unauthenticated `gh` is a parked state. */
export const GhAuthState = Schema.Literals(["authenticated", "unauthenticated", "missing"]);
export type GhAuthState = typeof GhAuthState.Type;

export const Viewer = Schema.Struct({
  auth: GhAuthState,
  login: Schema.NullOr(TrimmedNonEmptyString),
  /** `gh --version`'s first line, or null when `gh` is missing. */
  ghVersion: Schema.NullOr(TrimmedNonEmptyString),
  /** Set when `gh` is present but unusable — shown verbatim as instruction. */
  detail: Schema.NullOr(Schema.String),
});
export type Viewer = typeof Viewer.Type;

export const PrState = Schema.Literals(["open", "merged", "closed"]);
export type PrState = typeof PrState.Type;

/** One pull request as the welcome screen and the door see it. */
export const PrSummary = Schema.Struct({
  ref: PrRef,
  title: Schema.String,
  author: Schema.String,
  url: Schema.String,
  state: PrState,
  isDraft: Schema.Boolean,
  headSha: TrimmedNonEmptyString,
  baseRef: TrimmedNonEmptyString,
  changedFiles: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  mergedAt: Schema.NullOr(Schema.DateTimeUtc),
  body: Schema.String,
});
export type PrSummary = typeof PrSummary.Type;

/**
 * The journey state the server enriches every listed PR with. Progress is
 * derived here (never stored) so the welcome screen and the reading experience
 * cannot disagree about how far along a journey is.
 */
export const PrJourneyState = Schema.Struct({
  journeyId: JourneyId,
  analyzedAt: Schema.DateTimeUtc,
  pinnedHeadSha: TrimmedNonEmptyString,
  /** True iff the pinned head differs from the PR's current head. */
  stale: Schema.Boolean,
  clusterCount: NonNegativeInt,
  /** 1-based position of the first cluster with unread files, or null when done. */
  currentClusterPosition: Schema.NullOr(Schema.Int),
  filesRead: NonNegativeInt,
  filesTotal: NonNegativeInt,
  /** Read homed hunks over homed hunks, 0–1. */
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  complete: Schema.Boolean,
});
export type PrJourneyState = typeof PrJourneyState.Type;

/** A PR plus everything local Throughline knows about it. */
export const PrListEntry = Schema.Struct({
  pr: PrSummary,
  journey: Schema.NullOr(PrJourneyState),
  /** A manual "I'm done with this", independent of journey progress. */
  reviewed: Schema.Boolean,
  /** True while an ingestion job for this PR is live. */
  ingesting: Schema.Boolean,
});
export type PrListEntry = typeof PrListEntry.Type;

export const PrRepoGroup = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  entries: Schema.Array(PrListEntry),
});
export type PrRepoGroup = typeof PrRepoGroup.Type;

/**
 * The module's honest health, rendered as a calm banner rather than a retry
 * loop. `parked` means a rate limit was reported and *nothing* — not even a
 * user-initiated refresh — will send a request before `resetAt`.
 */
export const GitHubHealth = Schema.Struct({
  status: Schema.Literals(["ok", "parked", "failing"]),
  detail: Schema.NullOr(Schema.String),
  resetAt: Schema.NullOr(Schema.DateTimeUtc),
});
export type GitHubHealth = typeof GitHubHealth.Type;

/**
 * The whole welcome screen in one value. Hidden PRs and dismissed merged PRs
 * are filtered out server-side — the renderer never has to know about marks it
 * cannot see the effect of.
 */
export const PrListSnapshot = Schema.Struct({
  viewer: Viewer,
  groups: Schema.Array(PrRepoGroup),
  /** Merged within the retention window and not dismissed, newest first. */
  merged: Schema.Array(PrListEntry),
  github: GitHubHealth,
  fetchedAt: Schema.DateTimeUtc,
  /** True while a refresh is in flight. */
  refreshing: Schema.Boolean,
});
export type PrListSnapshot = typeof PrListSnapshot.Type;

export const PrListChangeReason = Schema.Literals([
  "initial",
  "refreshed",
  "refreshing",
  "journey-changed",
  "marks-changed",
  "ingestion-changed",
]);
export type PrListChangeReason = typeof PrListChangeReason.Type;

/**
 * `github.subscribePrs` events. Every event is a full snapshot: the list is
 * small, and re-sending it is the cheapest way to make "the map always agrees
 * with the territory" true across windows and reconnects.
 */
export const PrListStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  reason: PrListChangeReason,
  list: PrListSnapshot,
});
export type PrListStreamEvent = typeof PrListStreamEvent.Type;

// ── Local PR marks ──────────────────────────────────────────────────────────

export const SetPrFlagInput = Schema.Struct({
  ref: PrRef,
  value: Schema.Boolean,
});
export type SetPrFlagInput = typeof SetPrFlagInput.Type;

export const PrRefInput = Schema.Struct({
  ref: PrRef,
});
export type PrRefInput = typeof PrRefInput.Type;

/** Every local verb the welcome screen offers, persisted server-side. */
export const LocalPrState = Schema.Struct({
  reviewed: Schema.Array(PrRef),
  hidden: Schema.Array(PrRef),
  dismissedMerged: Schema.Array(PrRef),
});
export type LocalPrState = typeof LocalPrState.Type;

export const LocalPrStateJson = Schema.fromJsonString(Schema.toCodecJson(LocalPrState));

// ── The door ────────────────────────────────────────────────────────────────

/**
 * Ingestion's precondition checks — the only place "no" is an allowed answer.
 * Analysis itself never fails analytically; the door fails *before* a job
 * exists, which is why this is the sole error channel of `ingestion.start`.
 */
export const DoorRejectionReason = Schema.Literals([
  "invalid-url",
  "gh-unavailable",
  "not-found",
  "not-open",
  "no-harness",
  "github-parked",
  "github-unavailable",
]);
export type DoorRejectionReason = typeof DoorRejectionReason.Type;

export class DoorRejection extends Schema.TaggedErrorClass<DoorRejection>()("DoorRejection", {
  reason: DoorRejectionReason,
  detail: Schema.String,
  /** Set for `github-parked`: when the quota resets. */
  resetAt: Schema.NullOr(Schema.DateTimeUtc),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const ResolveUrlInput = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type ResolveUrlInput = typeof ResolveUrlInput.Type;
