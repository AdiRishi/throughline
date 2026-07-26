import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HarnessKind, PrRef } from "./journey.ts";

export const GitHubAuthState = Schema.Literals(["authenticated", "unauthenticated", "unavailable"]);
export type GitHubAuthState = typeof GitHubAuthState.Type;

export const GitHubViewer = Schema.Struct({
  state: GitHubAuthState,
  login: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  avatarUrl: Schema.optionalKey(TrimmedNonEmptyString),
  setupInstructions: Schema.optionalKey(TrimmedNonEmptyString),
});
export type GitHubViewer = typeof GitHubViewer.Type;

export const PullRequestState = Schema.Literals(["open", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const PullRequestAuthor = Schema.Struct({
  login: TrimmedNonEmptyString,
  avatarUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PullRequestAuthor = typeof PullRequestAuthor.Type;

export const PullRequestSummary = Schema.Struct({
  ref: PrRef,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  author: PullRequestAuthor,
  state: PullRequestState,
  isDraft: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
  mergedAt: Schema.NullOr(Schema.DateTimeUtc),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changedFiles: NonNegativeInt,
  headSha: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  journey: Schema.Struct({
    exists: Schema.Boolean,
    stale: Schema.Boolean,
    readHunks: NonNegativeInt,
    totalHunks: NonNegativeInt,
  }),
});
export type PullRequestSummary = typeof PullRequestSummary.Type;

export const PullRequestDetail = Schema.Struct({
  ...PullRequestSummary.fields,
  body: Schema.String,
  baseSha: TrimmedNonEmptyString,
  repositoryUrl: TrimmedNonEmptyString,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

export const GitHubPrsSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  pullRequests: Schema.Array(PullRequestSummary),
});
export type GitHubPrsSnapshot = typeof GitHubPrsSnapshot.Type;

export const GitHubPrsUpdated = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("updated"),
  pullRequests: Schema.Array(PullRequestSummary),
});
export type GitHubPrsUpdated = typeof GitHubPrsUpdated.Type;

export const GitHubPrsStreamEvent = Schema.Union([GitHubPrsSnapshot, GitHubPrsUpdated]);
export type GitHubPrsStreamEvent = typeof GitHubPrsStreamEvent.Type;

export const GitHubParked = Schema.Struct({
  resetAt: Schema.DateTimeUtc,
});
export type GitHubParked = typeof GitHubParked.Type;

export class GitHubUnavailableError extends Schema.TaggedErrorClass<GitHubUnavailableError>()(
  "GitHubUnavailableError",
  {
    reason: Schema.Literals(["gh-unavailable", "unauthenticated", "parked", "transport"]),
    detail: TrimmedNonEmptyString,
    resetAt: Schema.optionalKey(Schema.DateTimeUtc),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const DoorRejectionReason = Schema.Literals([
  "invalid-url",
  "gh-unavailable",
  "not-found",
  "not-open",
  "no-harness",
]);
export type DoorRejectionReason = typeof DoorRejectionReason.Type;

export class IngestionDoorError extends Schema.TaggedErrorClass<IngestionDoorError>()(
  "IngestionDoorError",
  {
    reason: DoorRejectionReason,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const HarnessAuthState = Schema.Literals(["authenticated", "unauthenticated", "unknown"]);
export type HarnessAuthState = typeof HarnessAuthState.Type;

export const HarnessStatus = Schema.Struct({
  kind: HarnessKind,
  installed: Schema.Boolean,
  version: Schema.optionalKey(TrimmedNonEmptyString),
  auth: HarnessAuthState,
  setupInstructions: TrimmedNonEmptyString,
});
export type HarnessStatus = typeof HarnessStatus.Type;
