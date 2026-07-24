import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { GitHubPrListStreamEvent } from "@app/contracts";

import { applyPullRequestListEvent, INITIAL_PULL_REQUEST_LIST } from "../../src/state/product.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(GitHubPrListStreamEvent));

const pullRequest = (number: number, title: string) => ({
  ref: { owner: "throughline", repo: "fixture", number },
  title,
  author: { login: "reviewer", avatarUrl: null },
  url: `https://github.com/throughline/fixture/pull/${number}`,
  state: "open",
  baseRefName: "main",
  headSha: String(number).padStart(40, "0"),
  updatedAt: "2026-07-25T00:00:00.000Z",
  mergedAt: null,
  changedFiles: 1,
  additions: 1,
  deletions: 0,
  journey: null,
});

describe("applyPullRequestListEvent", () => {
  it("replaces stale rows when a reconnect snapshot arrives", () => {
    const first = applyPullRequestListEvent(
      INITIAL_PULL_REQUEST_LIST,
      decodeEvent({
        version: 1,
        sequence: 4,
        type: "updated",
        pullRequests: [pullRequest(1, "Old row")],
        refreshedAt: "2026-07-25T00:01:00.000Z",
      }),
    );

    const reconnected = applyPullRequestListEvent(
      first,
      decodeEvent({
        version: 1,
        sequence: 5,
        type: "snapshot",
        pullRequests: [pullRequest(2, "Current row")],
        refreshedAt: "2026-07-25T00:02:00.000Z",
      }),
    );

    expect(reconnected.ready).toBe(true);
    expect(reconnected.sequence).toBe(5);
    expect(reconnected.pullRequests.map((pr) => pr.title)).toEqual(["Current row"]);
  });
});
