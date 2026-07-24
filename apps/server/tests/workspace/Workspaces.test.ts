// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CommitSha,
  type GitHubOwner,
  type GitHubRepositoryName,
  type PrRef,
  RepositoryPath,
  type RepositoryPath as RepositoryPathValue,
} from "@app/contracts";

import * as ServerConfig from "../../src/config.ts";
import * as GitProcess from "../../src/workspace/GitProcess.ts";
import * as CloneAccess from "../../src/workspace/WorkspaceCloneAccess.ts";
import * as Workspaces from "../../src/workspace/Workspaces.ts";
import { gitExpect, makeGitFixture } from "./fixture.ts";

const decodeCommitSha = Schema.decodeUnknownSync(CommitSha);
const decodeRepositoryPath = Schema.decodeUnknownSync(RepositoryPath);

const testConfig = (dataDir: string) =>
  ServerConfig.make({
    appName: "Test App",
    version: "0.0.0-test",
    startedAt: DateTime.makeUnsafe(0),
    host: "127.0.0.1",
    port: 0,
    staticDir: undefined,
    devWebUrl: undefined,
    bootstrapToken: "boot-secret",
    dataDir,
  });

const failedWorkspaceError = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail" && reason.error instanceof Workspaces.WorkspaceError) {
      return reason.error;
    }
  }
  return undefined;
};

const hunkFactsFor = (prepared: Workspaces.PreparedWorkspace, repositoryPath: string) =>
  prepared.hunks
    .filter((hunk) => hunk.path === repositoryPath)
    .map(({ oldStart, oldLines, newStart, newLines, fileKind }) => ({
      oldStart,
      oldLines,
      newStart,
      newLines,
      fileKind,
    }));

it.layer(NodeServices.layer)("Workspaces real Git integration", (it) => {
  it.effect(
    "materializes every Git change kind and serves immutable committed artifacts",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "throughline-data-",
        });
        const realGit = yield* GitProcess.make;
        const fixture = yield* makeGitFixture(realGit);
        const commands: GitProcess.GitCommand[] = [];
        const recordingGit = GitProcess.GitProcess.of({
          run: (command) =>
            Effect.sync(() => {
              commands.push(command);
            }).pipe(Effect.flatMap(() => realGit.run(command))),
        });
        const access = CloneAccess.WorkspaceCloneAccess.of({
          get: () =>
            Effect.succeed({
              remoteUrl: fixture.source,
              environment: fixture.hostileEnvironment,
            }),
        });
        const workspaces = yield* Workspaces.make.pipe(
          Effect.provideService(ServerConfig.ServerConfig, testConfig(dataDir)),
          Effect.provideService(GitProcess.GitProcess, recordingGit),
          Effect.provideService(CloneAccess.WorkspaceCloneAccess, access),
        );

        const mismatch = yield* workspaces
          .prepare({
            pr: fixture.pr,
            runId: "mismatch",
            baseTipSha: fixture.baseTipSha,
            headSha: fixture.baseSha,
          })
          .pipe(Effect.exit);
        assert.strictEqual(failedWorkspaceError(mismatch)?.reason, "pinned-head-mismatch");

        const prepared = yield* workspaces.prepare({
          pr: fixture.pr,
          runId: "run-1",
          baseTipSha: fixture.baseTipSha,
          headSha: fixture.headSha,
        });
        assert.strictEqual(prepared.baseSha, fixture.baseSha);
        assert.notStrictEqual(prepared.baseSha, fixture.baseTipSha);
        assert.isTrue(yield* fileSystem.exists(prepared.repositoryDir));
        assert.isTrue(yield* fileSystem.exists(prepared.inputsDir));
        assert.strictEqual(path.dirname(prepared.repositoryDir), prepared.worldDir);
        assert.strictEqual(path.dirname(prepared.inputsDir), prepared.worldDir);
        assert.isFalse(yield* fileSystem.exists(prepared.finalRunDir));

        assert.deepStrictEqual(hunkFactsFor(prepared, "text/modified.txt"), [
          {
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 2,
            fileKind: undefined,
          },
          {
            oldStart: 4,
            oldLines: 1,
            newStart: 5,
            newLines: 1,
            fileKind: undefined,
          },
        ]);
        assert.deepStrictEqual(hunkFactsFor(prepared, "binary/data.bin"), [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: 0,
            newLines: 0,
            fileKind: "binary",
          },
        ]);
        assert.strictEqual(hunkFactsFor(prepared, "empty/added.empty")[0]?.fileKind, "empty");
        assert.strictEqual(hunkFactsFor(prepared, "image/pixel.png")[0]?.fileKind, "binary");
        assert.strictEqual(hunkFactsFor(prepared, "links/current")[0]?.fileKind, "symlink");
        assert.strictEqual(hunkFactsFor(prepared, "mode/script.sh")[0]?.fileKind, "mode");
        assert.strictEqual(hunkFactsFor(prepared, "rename/new name.txt")[0]?.fileKind, "rename");
        assert.strictEqual(hunkFactsFor(prepared, "vendor/module")[0]?.fileKind, "submodule");
        assert.strictEqual(hunkFactsFor(prepared, "odd/empty b file")[0]?.fileKind, "empty");
        assert.deepStrictEqual(hunkFactsFor(prepared, "text/marker-like.txt"), [
          {
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 1,
            fileKind: undefined,
          },
        ]);
        assert.includeMembers(
          [...prepared.tree],
          [
            decodeRepositoryPath("odd/space b/name.txt"),
            decodeRepositoryPath("odd/tab\tname.txt"),
            decodeRepositoryPath("odd/line\nname.txt"),
            decodeRepositoryPath("rename/new name.txt"),
            decodeRepositoryPath("text/unchanged.txt"),
          ],
        );
        assert.notInclude(prepared.tree, decodeRepositoryPath("rename/old name.txt"));
        assert.notInclude(prepared.tree, decodeRepositoryPath("text/deleted.txt"));

        const fullPatch = yield* fileSystem.readFileString(
          path.join(prepared.inputsDir, "diff", "full.patch"),
        );
        assert.notInclude(fullPatch, "\u001b[");
        assert.notInclude(fullPatch, "base-only.txt");
        assert.include(fullPatch, "Subproject commit");
        assert.include(fullPatch, "rename from rename/old name.txt");
        assert.include(fullPatch, 'diff --git "a/odd/line\\nname.txt"');
        const diffCommand = commands.find((command) => command.args.includes("diff"));
        assert.isDefined(diffCommand);
        for (const option of Workspaces.DETERMINISTIC_DIFF_OPTIONS) {
          assert.include(diffCommand?.args, option);
        }
        assert.include(diffCommand?.args, "-O");
        assert.include(diffCommand?.args, "diff.interHunkContext=0");

        const committed = yield* workspaces.finalize(prepared);
        assert.strictEqual(committed.baseSha, fixture.baseSha);
        assert.isFalse(yield* fileSystem.exists(prepared.stagingRunDir));
        assert.isFalse(yield* fileSystem.exists(prepared.repositoryDir));
        assert.isTrue(yield* fileSystem.exists(committed.runDir));
        assert.isTrue(yield* fileSystem.exists(path.join(committed.inputsDir, "contents.json")));

        const modifiedPath = decodeRepositoryPath("text/modified.txt");
        const modifiedPatch = yield* workspaces.filePatch(
          { pr: fixture.pr, runId: "run-1" },
          modifiedPath,
        );
        assert.include(modifiedPatch, "@@ -2 +2,2 @@");
        const modifiedContent = yield* workspaces.fileContent(
          { pr: fixture.pr, runId: "run-1" },
          modifiedPath,
        );
        assert.deepStrictEqual(modifiedContent, {
          type: "text",
          path: modifiedPath,
          old: "header\none\nkeep\nfour\ntail\n",
          new: "header\nONE\nTWO\nkeep\nFOUR\ntail\n",
        });

        const imagePath = decodeRepositoryPath("image/pixel.png");
        const image = yield* workspaces.fileContent({ pr: fixture.pr, runId: "run-1" }, imagePath);
        assert.deepStrictEqual(image, {
          type: "image",
          path: imagePath,
          oldMediaType: "image/png",
          oldBase64: NodeBuffer.Buffer.from(fixture.baseImage).toString("base64"),
          newMediaType: "image/png",
          newBase64: NodeBuffer.Buffer.from(fixture.headImage).toString("base64"),
        });
        const binaryPath = decodeRepositoryPath("binary/data.bin");
        assert.deepStrictEqual(
          yield* workspaces.fileContent({ pr: fixture.pr, runId: "run-1" }, binaryPath),
          {
            type: "binary",
            path: binaryPath,
            oldSize: 5,
            newSize: 6,
          },
        );

        const abandoned = yield* workspaces.prepare({
          pr: fixture.pr,
          runId: "failed-run",
          baseTipSha: fixture.baseTipSha,
          headSha: fixture.headSha,
        });
        yield* workspaces.abandon(abandoned);
        const reaped = yield* workspaces.reapFailedRuns(fixture.pr);
        assert.deepStrictEqual(reaped, [abandoned.stagingRunDir]);
        assert.isFalse(yield* fileSystem.exists(abandoned.stagingRunDir));

        yield* fileSystem.writeFileString(
          path.join(fixture.source, "text", "unchanged.txt"),
          "remote moved after analysis\n",
        );
        yield* gitExpect(realGit, ["add", "-A"], { cwd: fixture.source });
        yield* gitExpect(realGit, ["commit", "-m", "later remote change"], {
          cwd: fixture.source,
        });
        const laterHead = yield* gitExpect(realGit, ["rev-parse", "HEAD"], {
          cwd: fixture.source,
        });
        yield* gitExpect(realGit, ["update-ref", "refs/pull/7/head", laterHead], {
          cwd: fixture.source,
        });

        assert.deepStrictEqual(yield* workspaces.evictCache(0), ["octo/widgets"]);
        assert.isFalse(
          yield* fileSystem.exists(
            path.join(dataDir, "workspaces", "octo", "widgets", "repository.git"),
          ),
        );
        assert.deepStrictEqual(
          yield* workspaces.fileContent({ pr: fixture.pr, runId: "run-1" }, modifiedPath),
          modifiedContent,
        );
        const unchangedPath = decodeRepositoryPath("text/unchanged.txt");
        assert.isNull(
          yield* workspaces.filePatch({ pr: fixture.pr, runId: "run-1" }, unchangedPath),
        );
        assert.deepStrictEqual(
          yield* workspaces.fileContent({ pr: fixture.pr, runId: "run-1" }, unchangedPath),
          {
            type: "text",
            path: unchangedPath,
            old: null,
            new: "available outside the changed set\n",
          },
        );
        const unchangedSubmodule = decodeRepositoryPath("vendor/unchanged");
        assert.deepStrictEqual(
          yield* workspaces.fileContent({ pr: fixture.pr, runId: "run-1" }, unchangedSubmodule),
          {
            type: "binary",
            path: unchangedSubmodule,
            oldSize: null,
            newSize: null,
          },
        );
        assert.deepStrictEqual(
          yield* workspaces.tree({ pr: fixture.pr, runId: "run-1" }),
          prepared.tree,
        );
      }).pipe(Effect.scoped),
    60_000,
  );
});

it.layer(NodeServices.layer)("Workspaces path boundaries", (it) => {
  it.effect("rejects unsafe owner, repository, run, and file paths before Git access", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "throughline-paths-",
      });
      let gitCalls = 0;
      let accessCalls = 0;
      const git = GitProcess.GitProcess.of({
        run: () =>
          Effect.sync(() => {
            gitCalls += 1;
            return {
              exitCode: 1,
              stdout: new Uint8Array(),
              stderr: "fixture stops after boundary validation",
            };
          }),
      });
      const access = CloneAccess.WorkspaceCloneAccess.of({
        get: () =>
          Effect.sync(() => {
            accessCalls += 1;
            return { remoteUrl: "unused" };
          }),
      });
      const workspaces = yield* Workspaces.make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, testConfig(dataDir)),
        Effect.provideService(GitProcess.GitProcess, git),
        Effect.provideService(CloneAccess.WorkspaceCloneAccess, access),
      );
      const sha = decodeCommitSha("0000000000000000000000000000000000000001");
      const validPr = {
        owner: "octo" as GitHubOwner,
        repo: "widgets" as GitHubRepositoryName,
        number: 7,
      } as PrRef;
      const invalidRuns = [
        {
          pr: { ...validPr, owner: ".." as GitHubOwner },
          runId: "run",
        },
        {
          pr: { ...validPr, owner: "octo/escape" as GitHubOwner },
          runId: "run",
        },
        {
          pr: { ...validPr, repo: "../escape" as GitHubRepositoryName },
          runId: "run",
        },
        {
          pr: { ...validPr, repo: "bad\0repo" as GitHubRepositoryName },
          runId: "run",
        },
        {
          pr: { ...validPr, repo: "bad\\repo" as GitHubRepositoryName },
          runId: "run",
        },
        {
          pr: validPr,
          runId: "../run",
        },
      ];
      for (const invalid of invalidRuns) {
        const exit = yield* workspaces
          .prepare({
            ...invalid,
            baseTipSha: sha,
            headSha: sha,
          })
          .pipe(Effect.exit);
        assert.strictEqual(failedWorkspaceError(exit)?.reason, "invalid-input");
      }

      const invalidFile = yield* workspaces
        .filePatch({ pr: validPr, runId: "run" }, "../secret" as RepositoryPathValue)
        .pipe(Effect.exit);
      assert.strictEqual(failedWorkspaceError(invalidFile)?.reason, "invalid-input");
      assert.strictEqual(gitCalls, 0);
      assert.strictEqual(accessCalls, 0);

      const validDotRepository = yield* workspaces
        .prepare({
          pr: { ...validPr, repo: ".github" as GitHubRepositoryName },
          runId: "run",
          baseTipSha: sha,
          headSha: sha,
        })
        .pipe(Effect.exit);
      assert.notStrictEqual(failedWorkspaceError(validDotRepository)?.reason, "invalid-input");
      assert.strictEqual(gitCalls, 1);
      assert.strictEqual(accessCalls, 1);
    }).pipe(Effect.scoped),
  );
});
