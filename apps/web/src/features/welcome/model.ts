import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PrRef,
  type LocalPrState,
  type PrSummary,
  type PullRequestJourneyState,
} from "@app/contracts";

export const RECENT_MERGED_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export interface WelcomePullRequest {
  readonly pullRequest: PrSummary;
  readonly reviewed: boolean;
}

export interface RepositoryPullRequests {
  readonly key: string;
  readonly owner: PrSummary["ref"]["owner"];
  readonly repo: PrSummary["ref"]["repo"];
  readonly pullRequests: ReadonlyArray<WelcomePullRequest>;
}

export interface WelcomeSections {
  readonly repositories: ReadonlyArray<RepositoryPullRequests>;
  readonly merged: ReadonlyArray<WelcomePullRequest>;
  readonly saved: ReadonlyArray<WelcomePullRequest>;
}

export type JourneyListState = "not-analyzed" | "ready" | "reading" | "complete" | "stale";

const decodePrRef = Schema.decodeUnknownOption(PrRef);

export function pullRequestKey(pr: PrSummary["ref"]): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export function samePullRequestIdentity(left: PrRef, right: PrRef): boolean {
  return (
    left.number === right.number &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

function referenceKeys(references: ReadonlyArray<PrSummary["ref"]>): ReadonlySet<string> {
  return new Set(references.map(pullRequestKey));
}

function byUpdatedAtDescending(left: WelcomePullRequest, right: WelcomePullRequest): number {
  return (
    DateTime.toEpochMillis(right.pullRequest.updatedAt) -
    DateTime.toEpochMillis(left.pullRequest.updatedAt)
  );
}

export function buildWelcomeSections(
  pullRequests: ReadonlyArray<PrSummary>,
  localState: LocalPrState,
  now: DateTime.Utc,
): WelcomeSections {
  const hidden = referenceKeys(localState.hidden);
  const reviewed = referenceKeys(localState.reviewed);
  const dismissedMerged = referenceKeys(localState.dismissedMerged);
  const repositories = new Map<string, RepositoryPullRequests>();
  const merged: Array<WelcomePullRequest> = [];
  const saved: Array<WelcomePullRequest> = [];
  const nowMillis = DateTime.toEpochMillis(now);

  for (const pullRequest of pullRequests) {
    const key = pullRequestKey(pullRequest.ref);
    if (hidden.has(key)) {
      continue;
    }

    const row = {
      pullRequest,
      reviewed: reviewed.has(key),
    } satisfies WelcomePullRequest;

    if (pullRequest.state === "open") {
      const repositoryKey = `${pullRequest.ref.owner}/${pullRequest.ref.repo}`;
      const group = repositories.get(repositoryKey);
      repositories.set(repositoryKey, {
        key: repositoryKey,
        owner: pullRequest.ref.owner,
        repo: pullRequest.ref.repo,
        pullRequests: [...(group?.pullRequests ?? []), row],
      });
      continue;
    }

    if (pullRequest.state === "merged") {
      if (dismissedMerged.has(key)) {
        continue;
      }
      if (
        pullRequest.mergedAt !== null &&
        nowMillis - DateTime.toEpochMillis(pullRequest.mergedAt) <= RECENT_MERGED_WINDOW_MS
      ) {
        merged.push(row);
        continue;
      }
    }

    if (pullRequest.journey !== null) {
      saved.push(row);
    }
  }

  return {
    repositories: [...repositories.values()]
      .map((repository) =>
        Object.assign({}, repository, {
          pullRequests: repository.pullRequests.toSorted(byUpdatedAtDescending),
        }),
      )
      .toSorted((left, right) => left.key.localeCompare(right.key)),
    merged: merged.toSorted((left, right) => {
      const leftMergedAt = left.pullRequest.mergedAt;
      const rightMergedAt = right.pullRequest.mergedAt;
      if (leftMergedAt === null || rightMergedAt === null) {
        return 0;
      }
      return DateTime.toEpochMillis(rightMergedAt) - DateTime.toEpochMillis(leftMergedAt);
    }),
    saved: saved.toSorted(byUpdatedAtDescending),
  };
}

export function waitingReviewCount(sections: WelcomeSections): number {
  let count = 0;
  for (const repository of sections.repositories) {
    for (const row of repository.pullRequests) {
      if (!row.reviewed) {
        count += 1;
      }
    }
  }
  return count;
}

export function journeyListState(journey: PullRequestJourneyState | null): JourneyListState {
  if (journey === null) {
    return "not-analyzed";
  }
  if (journey.stale) {
    return "stale";
  }
  if (journey.progress >= 1) {
    return "complete";
  }
  if (journey.progress > 0) {
    return "reading";
  }
  return "ready";
}

export function parsePullRequestUrl(input: string): PrSummary["ref"] | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com")
  ) {
    return null;
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[2] !== "pull") {
    return null;
  }

  return Option.getOrNull(
    decodePrRef({
      owner: segments[0],
      repo: segments[1],
      number: Number(segments[3]),
    }),
  );
}
