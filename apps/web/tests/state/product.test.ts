import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  ClusterId,
  GitHubPrListStreamEvent,
  PrRef,
  ReadState,
  RepositoryPath,
  type IngestionJob,
} from "@app/contracts";

import {
  acceptedIngestionJobForRequest,
  applyOptimisticReadMark,
  applyPullRequestListEvent,
  INITIAL_PULL_REQUEST_LIST,
  makeIngestionStartRequest,
  ownsIngestionStartRequest,
} from "../../src/state/product.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.toCodecJson(GitHubPrListStreamEvent));
const decodeReadState = Schema.decodeUnknownSync(Schema.toCodecJson(ReadState));
const decodeClusterId = Schema.decodeUnknownSync(ClusterId);
const decodePath = Schema.decodeUnknownSync(RepositoryPath);
const decodePrRef = Schema.decodeUnknownSync(PrRef);

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

describe("applyOptimisticReadMark", () => {
  it("reflects one cluster-file acknowledgement immediately and can undo it", () => {
    const state = decodeReadState({
      journeyId: "journey-1",
      readFiles: [{ clusterId: "cluster-1", path: "src/existing.ts" }],
      displayMode: "inline",
      updatedAt: "2026-07-25T00:00:00.000Z",
    });
    const input = {
      journeyId: state.journeyId,
      clusterId: decodeClusterId("cluster-2"),
      path: decodePath("src/new.ts"),
    };

    const marked = applyOptimisticReadMark(state, input, true);
    expect(marked.readFiles).toEqual([
      { clusterId: "cluster-1", path: "src/existing.ts" },
      { clusterId: "cluster-2", path: "src/new.ts" },
    ]);

    expect(applyOptimisticReadMark(marked, input, false).readFiles).toEqual([
      { clusterId: "cluster-1", path: "src/existing.ts" },
    ]);
  });
});

describe("ingestion start request ownership", () => {
  const acceptedJob = {
    id: "job-accepted",
    pr: { owner: "canonical-owner", repo: "renamed-repository", number: 7 },
  } as IngestionJob;

  it("does not expose another pull request's in-flight result", () => {
    const first = makeIngestionStartRequest({
      type: "ref",
      ref: decodePrRef({ owner: "throughline", repo: "first", number: 1 }),
    });
    const second = makeIngestionStartRequest({
      type: "ref",
      ref: decodePrRef({ owner: "throughline", repo: "second", number: 2 }),
    });

    expect(ownsIngestionStartRequest(second.id, first.id)).toBe(false);
    expect(
      acceptedIngestionJobForRequest(second.id, {
        requestId: first.id,
        job: acceptedJob,
      }),
    ).toBeNull();
  });

  it("uses the canonical pull request returned by the accepted request", () => {
    const request = makeIngestionStartRequest({
      type: "url",
      url: "https://github.com/previous-owner/previous-name/pull/7",
    });

    expect(
      acceptedIngestionJobForRequest(request.id, {
        requestId: request.id,
        job: acceptedJob,
      })?.pr,
    ).toEqual(acceptedJob.pr);
  });
});
