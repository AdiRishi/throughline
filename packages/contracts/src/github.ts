/**
 * GitHub view types: what the `GitHub` module returns and the welcome screen
 * renders. These are Throughline's shapes, not GitHub's — the one module that
 * talks to `gh` decodes the API's payloads into these and nothing else leaks.
 *
 * @module github
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** `owner/repo#number` — the identity of a pull request everywhere in the app. */
export const PrRef = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PrRef = typeof PrRef.Type;

/** Canonical string form, used as a map key and a stable identity in the URL. */
export function prRefKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

export const GitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,40}$/));
export type GitSha = typeof GitSha.Type;

/** The viewer's `gh` identity. Absent login means `gh` is present but signed out. */
export const Viewer = Schema.Struct({
  login: Schema.NullOr(TrimmedNonEmptyString),
  /** False when `gh` is missing entirely — the UI shows install instructions. */
  ghInstalled: Schema.Boolean,
  authenticated: Schema.Boolean,
  /** Host the login belongs to (`github.com` unless the user configured GHES). */
  host: Schema.NullOr(TrimmedNonEmptyString),
});
export type Viewer = typeof Viewer.Type;

export const PrState = Schema.Literals(["open", "merged", "closed"]);
export type PrState = typeof PrState.Type;

/**
 * One pull request as the welcome screen shows it. Scale figures come from the
 * API's own totals so the list can be rendered before anything is cloned.
 */
export const PrSummary = Schema.Struct({
  ref: PrRef,
  title: Schema.String,
  authorLogin: Schema.String,
  url: Schema.String,
  state: PrState,
  isDraft: Schema.Boolean,
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
  mergedAt: Schema.NullOr(Schema.DateTimeUtc),
  headSha: GitSha,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  changedFiles: NonNegativeInt,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type PrSummary = typeof PrSummary.Type;

/** `pr()` adds the body — the PR's own words, shown collapsed on the Overview. */
export const PrDetail = Schema.Struct({
  summary: PrSummary,
  body: Schema.String,
});
export type PrDetail = typeof PrDetail.Type;

/**
 * The rate-limit park. The module refuses every call — including a
 * user-initiated refresh — until `resetAt`, and says so honestly.
 */
export class GitHubParkedError extends Schema.TaggedErrorClass<GitHubParkedError>()(
  "GitHubParkedError",
  {
    resetAt: Schema.DateTimeUtc,
    reason: Schema.Literals(["rate-limit", "secondary-rate-limit"]),
  },
) {
  override get message(): string {
    return `GitHub rate limit reached; parked until ${this.resetAt.toString()}.`;
  }
}

/** `gh` is missing or signed out. Parked with instructions, never retried in a loop. */
export class GitHubUnavailableError extends Schema.TaggedErrorClass<GitHubUnavailableError>()(
  "GitHubUnavailableError",
  {
    reason: Schema.Literals(["not-installed", "not-authenticated"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.reason === "not-installed"
      ? "The GitHub CLI (gh) is not installed."
      : "The GitHub CLI (gh) is not authenticated.";
  }
}

/** Transport/5xx exhaustion, or an unexpected `gh` failure. Retryable by the user. */
export class GitHubRequestError extends Schema.TaggedErrorClass<GitHubRequestError>()(
  "GitHubRequestError",
  {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Int),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `GitHub request "${this.operation}" failed: ${this.detail}`;
  }
}

/** Every failure the `GitHub` module can surface. */
export const GitHubError = Schema.Union([
  GitHubParkedError,
  GitHubUnavailableError,
  GitHubRequestError,
]);
export type GitHubError = typeof GitHubError.Type;
