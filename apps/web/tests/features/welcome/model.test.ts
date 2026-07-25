import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { PrSummary, type LocalPrState } from "@app/contracts";

import {
  buildWelcomeSections,
  journeyListState,
  parsePullRequestUrl,
  RECENT_MERGED_WINDOW_MS,
  samePullRequestIdentity,
  waitingReviewCount,
} from "../../../src/features/welcome/model.ts";

const decodePullRequest = Schema.decodeUnknownSync(Schema.toCodecJson(PrSummary));
const NOW = DateTime.fromDateUnsafe(new Date("2026-07-25T12:00:00.000Z"));
const EMPTY_LOCAL_STATE: LocalPrState = {
  reviewed: [],
  hidden: [],
  dismissedMerged: [],
};
const SAVED_JOURNEY = {
  journeyId: "journey-saved",
  progress: 0.5,
  markedFiles: 1,
  clusterFiles: 2,
  stale: false,
  pinnedHeadSha: "a".repeat(40),
};

const pullRequest = (
  number: number,
  input?: {
    readonly owner?: string;
    readonly repo?: string;
    readonly state?: "open" | "merged" | "closed";
    readonly updatedAt?: string;
    readonly mergedAt?: string | null;
    readonly journey?: unknown;
  },
) =>
  decodePullRequest({
    ref: {
      owner: input?.owner ?? "throughline",
      repo: input?.repo ?? "console",
      number,
    },
    title: `Pull request ${number}`,
    author: { login: "reviewer", avatarUrl: null },
    url: `https://github.com/throughline/console/pull/${number}`,
    state: input?.state ?? "open",
    baseRefName: "main",
    headSha: String(number).padStart(40, "0"),
    updatedAt: input?.updatedAt ?? "2026-07-25T10:00:00.000Z",
    mergedAt: input?.mergedAt ?? null,
    changedFiles: 4,
    additions: 20,
    deletions: 3,
    journey: input?.journey ?? null,
  });

describe("buildWelcomeSections", () => {
  it("groups open work by repository and applies local reviewed and hidden state", () => {
    const hidden = pullRequest(2);
    const reviewed = pullRequest(3, { owner: "acme", repo: "api" });
    const current = pullRequest(1);

    const sections = buildWelcomeSections(
      [hidden, reviewed, current],
      {
        ...EMPTY_LOCAL_STATE,
        hidden: [hidden.ref],
        reviewed: [reviewed.ref],
      },
      NOW,
    );

    expect(sections.repositories.map((repository) => repository.key)).toEqual([
      "acme/api",
      "throughline/console",
    ]);
    expect(sections.repositories[0]?.pullRequests).toMatchObject([
      { reviewed: true, pullRequest: { ref: { number: 3 } } },
    ]);
    expect(sections.repositories[1]?.pullRequests).toMatchObject([
      { reviewed: false, pullRequest: { ref: { number: 1 } } },
    ]);
    expect(waitingReviewCount(sections)).toBe(1);
  });

  it("shows merged work for exactly seven days and honors permanent dismissal", () => {
    const atBoundary = pullRequest(4, {
      state: "merged",
      mergedAt: new Date(DateTime.toEpochMillis(NOW) - RECENT_MERGED_WINDOW_MS).toISOString(),
    });
    const tooOld = pullRequest(5, {
      state: "merged",
      mergedAt: new Date(DateTime.toEpochMillis(NOW) - RECENT_MERGED_WINDOW_MS - 1).toISOString(),
    });
    const dismissed = pullRequest(6, {
      state: "merged",
      mergedAt: "2026-07-25T11:00:00.000Z",
    });
    const closed = pullRequest(7, { state: "closed" });

    const sections = buildWelcomeSections(
      [tooOld, dismissed, closed, atBoundary],
      {
        ...EMPTY_LOCAL_STATE,
        dismissedMerged: [dismissed.ref],
      },
      NOW,
    );

    expect(sections.merged.map(({ pullRequest: pr }) => pr.ref.number)).toEqual([4]);
  });

  it("keeps saved journeys available after their PR leaves the active windows", () => {
    const oldMerged = pullRequest(8, {
      state: "merged",
      mergedAt: new Date(DateTime.toEpochMillis(NOW) - RECENT_MERGED_WINDOW_MS - 1).toISOString(),
      journey: SAVED_JOURNEY,
    });
    const closed = pullRequest(9, {
      state: "closed",
      journey: { ...SAVED_JOURNEY, journeyId: "journey-closed" },
    });
    const dismissed = pullRequest(10, {
      state: "merged",
      mergedAt: "2026-07-01T00:00:00.000Z",
      journey: { ...SAVED_JOURNEY, journeyId: "journey-dismissed" },
    });

    const sections = buildWelcomeSections(
      [oldMerged, dismissed, closed],
      {
        ...EMPTY_LOCAL_STATE,
        dismissedMerged: [dismissed.ref],
      },
      NOW,
    );

    expect(sections.saved.map(({ pullRequest: pr }) => pr.ref.number)).toEqual([8, 9]);
  });
});

describe("parsePullRequestUrl", () => {
  it("parses canonical GitHub PR URLs, including a trailing slash and query", () => {
    expect(parsePullRequestUrl(" https://github.com/openai/codex/pull/418/?view=files ")).toEqual({
      owner: "openai",
      repo: "codex",
      number: 418,
    });
    expect(parsePullRequestUrl("https://www.github.com/openai/codex/pull/418")).toEqual({
      owner: "openai",
      repo: "codex",
      number: 418,
    });
  });

  it("rejects lookalike hosts, extra path segments, and invalid PR numbers", () => {
    expect(parsePullRequestUrl("https://github.example/openai/codex/pull/418")).toBeNull();
    expect(parsePullRequestUrl("http://github.com/openai/codex/pull/418")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/openai/codex/pull/418/files")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/openai/codex/pull/nope")).toBeNull();
    expect(parsePullRequestUrl("not a URL")).toBeNull();
  });

  it("matches a returned canonical PR identity regardless of URL casing", () => {
    const entered = parsePullRequestUrl("https://github.com/OpenAI/CoDeX/pull/418");
    const canonical = parsePullRequestUrl("https://github.com/openai/codex/pull/418");

    expect(entered).not.toBeNull();
    expect(canonical).not.toBeNull();
    expect(samePullRequestIdentity(entered!, canonical!)).toBe(true);
    expect(
      samePullRequestIdentity(entered!, {
        ...canonical!,
        number: 419 as never,
      }),
    ).toBe(false);
  });
});

describe("journeyListState", () => {
  it("keeps stale distinct even when prior progress is complete", () => {
    expect(journeyListState(null)).toBe("not-analyzed");
    expect(
      journeyListState({
        journeyId: "journey-1" as never,
        progress: 0.4,
        markedFiles: 2,
        clusterFiles: 5,
        stale: false,
        pinnedHeadSha: "a".repeat(40) as never,
      }),
    ).toBe("reading");
    expect(
      journeyListState({
        journeyId: "journey-2" as never,
        progress: 1,
        markedFiles: 5,
        clusterFiles: 5,
        stale: true,
        pinnedHeadSha: "b".repeat(40) as never,
      }),
    ).toBe("stale");
  });
});
