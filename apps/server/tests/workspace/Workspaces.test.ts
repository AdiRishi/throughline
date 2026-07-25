import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { JourneyId, PullRequestDetail } from "@app/contracts";

import * as ServerConfig from "../../src/config.ts";
import { GitHub } from "../../src/github/GitHub.ts";
import * as ProcessRunner from "../../src/process/ProcessRunner.ts";
import { Workspaces, layer as workspacesLayer } from "../../src/workspace/Workspaces.ts";

interface RepositoryFixture {
  readonly root: string;
  readonly remote: string;
  readonly headSha: string;
  readonly baseSha: string;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
  }).trim();
}

function createRepositoryFixture(): RepositoryFixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "throughline-workspaces-test-"));
  const source = NodePath.join(root, "source");
  const remote = NodePath.join(root, "origin.git");
  NodeFS.mkdirSync(source);

  git(source, ["init", "--initial-branch=main"]);
  git(source, ["config", "user.name", "Throughline Test"]);
  git(source, ["config", "user.email", "throughline@example.test"]);
  git(source, ["config", "commit.gpgsign", "false"]);
  NodeFS.writeFileSync(NodePath.join(source, "cart.js"), "export const total = 1;\n");
  git(source, ["add", "cart.js"]);
  git(source, ["commit", "-m", "chore: add cart"]);
  const baseSha = git(source, ["rev-parse", "HEAD"]);

  git(source, ["switch", "-c", "feature"]);
  NodeFS.writeFileSync(NodePath.join(source, "cart.js"), "export const total = 2;\n");
  git(source, ["commit", "-am", "feat: update cart"]);
  const headSha = git(source, ["rev-parse", "HEAD"]);

  git(root, ["init", "--bare", remote]);
  git(source, ["remote", "add", "origin", remote]);
  git(source, ["push", "origin", "main"]);
  git(source, ["push", "origin", "feature:refs/pull/1/head"]);

  return { root, remote, headSha, baseSha };
}

function detailFor(fixture: RepositoryFixture): PullRequestDetail {
  return {
    ref: { owner: "owner", repo: "repo", number: 1 },
    title: "Update cart",
    url: "https://example.test/owner/repo/pull/1",
    author: { login: "reviewer" },
    state: "open",
    isDraft: false,
    updatedAt: DateTime.makeUnsafe(0),
    mergedAt: null,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    baseBranch: "main",
    headBranch: "feature",
    body: "",
    repositoryUrl: fixture.remote,
    journey: {
      exists: false,
      stale: false,
      readHunks: 0,
      totalHunks: 0,
    },
  };
}

function layerFor(fixture: RepositoryFixture) {
  const dataDir = NodePath.join(fixture.root, "data");
  const config = ServerConfig.layer(
    ServerConfig.make({
      appName: "Throughline Test",
      version: "0.0.0-test",
      startedAt: DateTime.makeUnsafe(0),
      host: "127.0.0.1",
      port: 0,
      staticDir: undefined,
      devWebUrl: undefined,
      bootstrapToken: "test",
      dataDir,
      logDir: NodePath.join(dataDir, "logs"),
      serverTracePath: NodePath.join(dataDir, "logs", "server.trace.ndjson"),
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 1,
      traceMaxBytes: 1024,
      traceMaxFiles: 1,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 1000,
      otlpServiceName: "throughline-test",
    }),
  );
  const github = Layer.succeed(
    GitHub,
    GitHub.of({
      identity: () => Effect.die("unused"),
      openPrs: () => Effect.die("unused"),
      pr: () => Effect.die("unused"),
      resolveUrl: () => Effect.die("unused"),
      cloneToken: Effect.succeed("test-token"),
      changes: Stream.empty,
    }),
  );
  const processRunner = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

  return workspacesLayer.pipe(
    Layer.provide(Layer.mergeAll(config, github, processRunner, NodeServices.layer)),
  );
}

describe("Workspaces", () => {
  it.effect("reaps an interrupted worktree before preparing the next run for the same PR", () =>
    Effect.acquireUseRelease(
      Effect.sync(createRepositoryFixture),
      (fixture) =>
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const first = yield* workspaces.prepare(detailFor(fixture), "journey-1" as JourneyId);
          assert.isTrue(NodeFS.existsSync(first.worktree));

          const second = yield* workspaces.prepare(detailFor(fixture), "journey-2" as JourneyId);
          assert.isFalse(NodeFS.existsSync(first.worktree));
          assert.isTrue(NodeFS.existsSync(NodePath.join(first.runDir, "diff", "full.patch")));
          assert.isTrue(NodeFS.existsSync(second.worktree));

          yield* second.cleanup;
          assert.isFalse(NodeFS.existsSync(second.worktree));
        }).pipe(Effect.provide(layerFor(fixture))),
      (fixture) =>
        Effect.sync(() => {
          NodeFS.rmSync(fixture.root, { recursive: true, force: true });
        }),
    ),
  );
});
