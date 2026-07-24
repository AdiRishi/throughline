import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { JourneyId } from "./productIds.ts";

export const GitHubOwner = TrimmedNonEmptyString.pipe(Schema.brand("GitHubOwner"));
export type GitHubOwner = typeof GitHubOwner.Type;

export const GitHubRepositoryName = TrimmedNonEmptyString.pipe(
  Schema.brand("GitHubRepositoryName"),
);
export type GitHubRepositoryName = typeof GitHubRepositoryName.Type;

export const PullRequestNumber = PositiveInt.pipe(Schema.brand("PullRequestNumber"));
export type PullRequestNumber = typeof PullRequestNumber.Type;

export const CommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)).pipe(
  Schema.brand("CommitSha"),
);
export type CommitSha = typeof CommitSha.Type;

export const PrRef = Schema.Struct({
  owner: GitHubOwner,
  repo: GitHubRepositoryName,
  number: PullRequestNumber,
});
export type PrRef = typeof PrRef.Type;

export const PullRequestState = Schema.Literals(["open", "merged", "closed"]);
export type PullRequestState = typeof PullRequestState.Type;

export const GitHubAuthState = Schema.Literals(["authenticated", "unauthenticated", "unavailable"]);
export type GitHubAuthState = typeof GitHubAuthState.Type;

export const Viewer = Schema.Struct({
  auth: GitHubAuthState,
  login: Schema.NullOr(TrimmedNonEmptyString),
  name: Schema.NullOr(TrimmedNonEmptyString),
  avatarUrl: Schema.NullOr(Schema.String),
});
export type Viewer = typeof Viewer.Type;

export const PullRequestAuthor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.NullOr(Schema.String),
});
export type PullRequestAuthor = typeof PullRequestAuthor.Type;

export const PullRequestJourneyState = Schema.Struct({
  journeyId: JourneyId,
  progress: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  markedFiles: NonNegativeInt,
  clusterFiles: NonNegativeInt,
  stale: Schema.Boolean,
  pinnedHeadSha: CommitSha,
});
export type PullRequestJourneyState = typeof PullRequestJourneyState.Type;

export const PrSummary = Schema.Struct({
  ref: PrRef,
  title: TrimmedNonEmptyString,
  author: PullRequestAuthor,
  url: TrimmedNonEmptyString,
  state: PullRequestState,
  baseRefName: TrimmedNonEmptyString,
  headSha: CommitSha,
  updatedAt: Schema.DateTimeUtc,
  mergedAt: Schema.NullOr(Schema.DateTimeUtc),
  changedFiles: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  journey: Schema.NullOr(PullRequestJourneyState),
});
export type PrSummary = typeof PrSummary.Type;

export const PrDetail = Schema.Struct({
  ...PrSummary.fields,
  body: Schema.String,
  baseSha: CommitSha,
});
export type PrDetail = typeof PrDetail.Type;

export const GitHubPrListSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  pullRequests: Schema.Array(PrSummary),
  refreshedAt: Schema.DateTimeUtc,
});
export type GitHubPrListSnapshotEvent = typeof GitHubPrListSnapshotEvent.Type;

export const GitHubPrListUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("updated"),
  pullRequests: Schema.Array(PrSummary),
  refreshedAt: Schema.DateTimeUtc,
});
export type GitHubPrListUpdatedEvent = typeof GitHubPrListUpdatedEvent.Type;

export const GitHubPrListStreamEvent = Schema.Union([
  GitHubPrListSnapshotEvent,
  GitHubPrListUpdatedEvent,
]);
export type GitHubPrListStreamEvent = typeof GitHubPrListStreamEvent.Type;

export class GitHubParkedError extends Schema.TaggedErrorClass<GitHubParkedError>()(
  "GitHubParkedError",
  {
    resetAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return `GitHub access is parked until ${String(this.resetAt)}.`;
  }
}

export class GitHubReadError extends Schema.TaggedErrorClass<GitHubReadError>()("GitHubReadError", {
  reason: Schema.Literals(["unavailable", "unauthenticated", "transport"]),
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
