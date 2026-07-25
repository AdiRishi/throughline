import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import type { GitHubPrsStreamEvent, IngestionJobId, IngestionStreamEvent } from "@app/contracts";

import { applyIngestionEvent, applyPullRequestEvent } from "../../src/state/product.ts";

const at = DateTime.makeUnsafe("2026-07-26T00:00:00.000Z");

describe("product state folds", () => {
  it("replaces the pull request snapshot on reconnect", () => {
    const event: GitHubPrsStreamEvent = {
      version: 1,
      sequence: 8,
      type: "snapshot",
      pullRequests: [
        {
          ref: { owner: "openai", repo: "throughline", number: 42 },
          title: "Map the review journey",
          url: "https://github.com/openai/throughline/pull/42",
          author: { login: "octocat" },
          state: "open",
          isDraft: false,
          updatedAt: at,
          mergedAt: null,
          additions: 120,
          deletions: 30,
          changedFiles: 8,
          headSha: "abcdef",
          baseBranch: "main",
          headBranch: "journey",
          journey: {
            exists: true,
            stale: false,
            readHunks: 2,
            totalHunks: 5,
          },
        },
      ],
    };

    expect(applyPullRequestEvent({ ready: false, sequence: 0, pullRequests: [] }, event)).toEqual({
      ready: true,
      sequence: 8,
      pullRequests: event.pullRequests,
    });
  });

  it("keeps the server job list authoritative across updates", () => {
    const event: IngestionStreamEvent = {
      version: 1,
      sequence: 3,
      type: "updated",
      jobs: [
        {
          id: "job-1" as IngestionJobId,
          pr: { owner: "openai", repo: "throughline", number: 42 },
          phase: { type: "validating" },
          startedAt: at,
          updatedAt: at,
        },
      ],
    };

    expect(applyIngestionEvent({ ready: true, sequence: 2, jobs: [] }, event)).toEqual({
      ready: true,
      sequence: 3,
      jobs: event.jobs,
    });
  });
});
