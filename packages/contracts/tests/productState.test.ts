import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { GitHubPrListStreamEvent, PrRef, PrSummary, Viewer } from "../src/github.ts";
import { IngestionDoorRejectionError, IngestionStreamEvent } from "../src/ingestion.ts";
import {
  PRODUCT_WS_METHODS,
  ProductOperationError,
  ProductWsRpcGroup,
  ReadStateMarkInvalidError,
} from "../src/productRpc.ts";

const decodeViewer = Schema.decodeUnknownSync(Viewer);
const decodePr = Schema.decodeUnknownSync(Schema.toCodecJson(PrSummary));
const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodePrEvent = Schema.decodeUnknownSync(Schema.toCodecJson(GitHubPrListStreamEvent));
const decodeIngestionEvent = Schema.decodeUnknownSync(Schema.toCodecJson(IngestionStreamEvent));
const decodeProductOperationError = Schema.decodeUnknownSync(
  Schema.toCodecJson(ProductOperationError),
);
const decodeReadStateMarkInvalidError = Schema.decodeUnknownSync(
  Schema.toCodecJson(ReadStateMarkInvalidError),
);

const PR = {
  ref: { owner: "octo", repo: "app", number: 7 },
  title: "Add authentication",
  author: { login: "author", avatarUrl: null },
  url: "https://github.com/octo/app/pull/7",
  state: "open",
  baseRefName: "main",
  headSha: "2222222222222222222222222222222222222222",
  updatedAt: "2026-07-25T00:00:00.000Z",
  mergedAt: null,
  changedFiles: 8,
  additions: 120,
  deletions: 30,
  journey: null,
};

describe("GitHub view contracts", () => {
  it("represents parked identity without inventing a viewer login", () => {
    assert.deepEqual(
      decodeViewer({
        auth: "unauthenticated",
        login: null,
        name: null,
        avatarUrl: null,
      }),
      {
        auth: "unauthenticated",
        login: null,
        name: null,
        avatarUrl: null,
      },
    );
  });

  it("decodes PR timestamps in both detail and snapshot/live list shapes", () => {
    assert.isTrue(DateTime.isDateTime(decodePr(PR).updatedAt));
    const event = decodePrEvent({
      version: 1,
      sequence: 4,
      type: "snapshot",
      pullRequests: [PR],
      refreshedAt: "2026-07-25T00:01:00.000Z",
    });
    assert.strictEqual(event.type, "snapshot");
    assert.isTrue(DateTime.isDateTime(event.refreshedAt));
  });

  it("rejects repository identity segments that could escape filesystem roots", () => {
    for (const ref of [
      { owner: "..", repo: "app", number: 1 },
      { owner: "octo/team", repo: "app", number: 1 },
      { owner: "octo", repo: "../app", number: 1 },
      { owner: "octo", repo: "app\\nested", number: 1 },
    ]) {
      assert.throws(() => decodePrRef(ref));
    }
  });
});

describe("ingestion contracts", () => {
  it("carries only observed analysis activity and monotonic counters", () => {
    const event = decodeIngestionEvent({
      version: 1,
      sequence: 9,
      type: "updated",
      job: {
        id: "job-1",
        pr: PR.ref,
        phase: "analyzing",
        queuePosition: null,
        startedAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:01:00.000Z",
        activity: {
          stage: "planning",
          currentAction: "Tracing imports",
          currentFile: "src/auth.ts",
          recentActions: ["Read package boundary"],
          counters: {
            filesWalked: 12,
            symbolsTraced: 4,
            callSitesFollowed: 2,
          },
        },
        journeyId: null,
        failure: null,
      },
    });

    assert.strictEqual(event.type, "updated");
    if (event.job === null) assert.fail("updated events carry a job");
    assert.strictEqual(event.job.activity?.counters.filesWalked, 12);
  });

  it("keeps door rejection reasons distinct from operational run failures", () => {
    const rejection = new IngestionDoorRejectionError({
      reason: "not-found",
      input: "https://github.com/octo/private/pull/1",
      detail: "The pull request is not visible.",
    });
    assert.strictEqual(rejection._tag, "IngestionDoorRejectionError");
    assert.strictEqual(rejection.message, "The pull request is not visible.");
  });
});

describe("product RPC contracts", () => {
  it("exposes retry as an explicit GitHub recovery operation", () => {
    assert.isTrue(ProductWsRpcGroup.requests.has(PRODUCT_WS_METHODS.githubRetry));
  });

  it("decodes operational and invalid-read errors from their JSON wire shapes", () => {
    const operationError = decodeProductOperationError({
      _tag: "ProductOperationError",
      reason: "workspace",
      operation: PRODUCT_WS_METHODS.journeyFileContent,
      detail: "The pinned workspace is unavailable.",
    });
    assert.strictEqual(operationError.reason, "workspace");
    assert.strictEqual(operationError.message, "The pinned workspace is unavailable.");

    const invalidMark = decodeReadStateMarkInvalidError({
      _tag: "ReadStateMarkInvalidError",
      journeyId: "journey-1",
      clusterId: "cluster-1",
      path: "src/auth.ts",
    });
    assert.strictEqual(invalidMark.clusterId, "cluster-1");
    assert.strictEqual(
      invalidMark.message,
      "The file 'src/auth.ts' is not homed in the requested cluster.",
    );
  });
});
