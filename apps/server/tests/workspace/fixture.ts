import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CommitSha,
  type CommitSha as CommitShaValue,
  PrRef,
  type PrRef as PrRefValue,
} from "@app/contracts";

import * as GitProcess from "../../src/workspace/GitProcess.ts";

const decodeCommitSha = Schema.decodeUnknownSync(CommitSha);
const decodePrRef = Schema.decodeUnknownSync(PrRef);
const textDecoder = new TextDecoder();

const BASE_IMAGE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const HEAD_IMAGE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x01,
]);

export interface GitFixture {
  readonly source: string;
  readonly pr: PrRefValue;
  readonly baseSha: CommitShaValue;
  readonly baseTipSha: CommitShaValue;
  readonly headSha: CommitShaValue;
  readonly baseImage: Uint8Array;
  readonly headImage: Uint8Array;
  readonly hostileEnvironment: Readonly<Record<string, string>>;
}

export const gitExpect = Effect.fn("test.gitExpect")(function* (
  git: GitProcess.GitProcess["Service"],
  args: ReadonlyArray<string>,
  options?: {
    readonly cwd?: string | undefined;
    readonly environment?: Readonly<Record<string, string>> | undefined;
  },
) {
  const result = yield* git.run({ args, ...options });
  assert.strictEqual(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return textDecoder.decode(result.stdout).trim();
});

export const makeGitFixture = Effect.fn("test.makeGitFixture")(function* (
  git: GitProcess.GitProcess["Service"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "throughline-workspace-" });
  const source = path.join(root, "source");
  yield* fileSystem.makeDirectory(source, { recursive: true });
  yield* gitExpect(git, ["init", "--initial-branch=main"], { cwd: source });
  yield* gitExpect(git, ["config", "user.name", "Fixture"], { cwd: source });
  yield* gitExpect(git, ["config", "user.email", "fixture@example.com"], {
    cwd: source,
  });
  yield* gitExpect(git, ["config", "commit.gpgsign", "false"], { cwd: source });
  yield* gitExpect(git, ["config", "core.autocrlf", "false"], { cwd: source });
  yield* gitExpect(git, ["config", "core.symlinks", "true"], { cwd: source });
  yield* gitExpect(git, ["config", "core.hooksPath", "/dev/null"], { cwd: source });
  yield* gitExpect(git, ["commit", "--allow-empty", "-m", "gitlink old"], {
    cwd: source,
  });
  const gitlinkOld = yield* gitExpect(git, ["rev-parse", "HEAD"], { cwd: source });

  for (const directory of [
    "binary",
    "empty",
    "image",
    "links",
    "mode",
    "odd",
    "rename",
    "text",
    "vendor",
  ]) {
    yield* fileSystem.makeDirectory(path.join(source, directory), { recursive: true });
  }
  yield* fileSystem.writeFile(
    path.join(source, "binary", "data.bin"),
    Uint8Array.from([0, 1, 2, 3, 4]),
  );
  yield* fileSystem.writeFile(path.join(source, "image", "pixel.png"), BASE_IMAGE);
  yield* fileSystem.writeFileString(
    path.join(source, "mode", "script.sh"),
    "#!/bin/sh\nprintf old\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "rename", "old name.txt"),
    "rename me exactly\n",
  );
  yield* fileSystem.symlink("targets/old", path.join(source, "links", "current"));
  yield* fileSystem.writeFileString(
    path.join(source, "text", "deleted.txt"),
    "obsolete one\nobsolete two\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "text", "modified.txt"),
    "header\none\nkeep\nfour\ntail\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "text", "marker-like.txt"),
    "stable\n-- old header-like\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "text", "unchanged.txt"),
    "available outside the changed set\n",
  );
  yield* gitExpect(git, ["add", "-A"], { cwd: source });
  yield* gitExpect(
    git,
    ["update-index", "--add", "--cacheinfo", `160000,${gitlinkOld},vendor/module`],
    { cwd: source },
  );
  yield* gitExpect(
    git,
    ["update-index", "--add", "--cacheinfo", `160000,${gitlinkOld},vendor/unchanged`],
    { cwd: source },
  );
  yield* gitExpect(git, ["commit", "-m", "base"], { cwd: source });
  const baseSha = decodeCommitSha(yield* gitExpect(git, ["rev-parse", "HEAD"], { cwd: source }));

  yield* fileSystem.writeFile(
    path.join(source, "binary", "data.bin"),
    Uint8Array.from([0, 9, 8, 7, 6, 5]),
  );
  yield* fileSystem.writeFile(path.join(source, "image", "pixel.png"), HEAD_IMAGE);
  yield* fileSystem.writeFileString(path.join(source, "empty", "added.empty"), "");
  yield* fileSystem.chmod(path.join(source, "mode", "script.sh"), 0o755);
  yield* gitExpect(git, ["mv", "rename/old name.txt", "rename/new name.txt"], { cwd: source });
  yield* fileSystem.remove(path.join(source, "links", "current"));
  yield* fileSystem.symlink("targets/new", path.join(source, "links", "current"));
  yield* fileSystem.writeFileString(
    path.join(source, "text", "added.txt"),
    "new alpha\nnew beta\n",
  );
  yield* fileSystem.remove(path.join(source, "text", "deleted.txt"));
  yield* fileSystem.writeFileString(
    path.join(source, "text", "modified.txt"),
    "header\nONE\nTWO\nkeep\nFOUR\ntail\n",
  );
  yield* fileSystem.writeFileString(
    path.join(source, "text", "marker-like.txt"),
    "stable\n++ new header-like\n",
  );
  yield* fileSystem.makeDirectory(path.join(source, "odd", "space b"), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(
    path.join(source, "odd", "space b", "name.txt"),
    "space path\n",
  );
  yield* fileSystem.writeFileString(path.join(source, "odd", "empty b file"), "");
  yield* fileSystem.writeFileString(path.join(source, "odd", "tab\tname.txt"), "tab path\n");
  yield* fileSystem.writeFileString(path.join(source, "odd", "line\nname.txt"), "newline path\n");
  yield* gitExpect(git, ["add", "-A"], { cwd: source });
  yield* gitExpect(
    git,
    ["update-index", "--add", "--cacheinfo", `160000,${baseSha},vendor/module`],
    { cwd: source },
  );
  yield* gitExpect(
    git,
    ["update-index", "--add", "--cacheinfo", `160000,${gitlinkOld},vendor/unchanged`],
    { cwd: source },
  );
  yield* gitExpect(git, ["commit", "-m", "head"], { cwd: source });
  const headSha = decodeCommitSha(yield* gitExpect(git, ["rev-parse", "HEAD"], { cwd: source }));
  yield* gitExpect(git, ["update-ref", "refs/pull/7/head", headSha], {
    cwd: source,
  });
  yield* gitExpect(git, ["switch", "-c", "base-tip", baseSha], { cwd: source });
  yield* fileSystem.writeFileString(path.join(source, "base-only.txt"), "base branch moved\n");
  yield* gitExpect(git, ["add", "base-only.txt"], { cwd: source });
  yield* gitExpect(git, ["commit", "-m", "advance base branch"], { cwd: source });
  const baseTipSha = decodeCommitSha(yield* gitExpect(git, ["rev-parse", "HEAD"], { cwd: source }));
  yield* gitExpect(git, ["switch", "main"], { cwd: source });

  const orderFile = path.join(root, "hostile-order");
  yield* fileSystem.writeFileString(orderFile, "text/*\n");
  const hostileEnvironment = {
    GIT_CONFIG_COUNT: "7",
    GIT_CONFIG_KEY_0: "diff.submodule",
    GIT_CONFIG_VALUE_0: "log",
    GIT_CONFIG_KEY_1: "diff.interHunkContext",
    GIT_CONFIG_VALUE_1: "10",
    GIT_CONFIG_KEY_2: "diff.noprefix",
    GIT_CONFIG_VALUE_2: "true",
    GIT_CONFIG_KEY_3: "color.ui",
    GIT_CONFIG_VALUE_3: "always",
    GIT_CONFIG_KEY_4: "diff.algorithm",
    GIT_CONFIG_VALUE_4: "patience",
    GIT_CONFIG_KEY_5: "diff.orderFile",
    GIT_CONFIG_VALUE_5: orderFile,
    GIT_CONFIG_KEY_6: "diff.external",
    GIT_CONFIG_VALUE_6: path.join(root, "must-not-run"),
  } as const;

  return {
    source,
    pr: decodePrRef({ owner: "octo", repo: "widgets", number: 7 }),
    baseSha,
    baseTipSha,
    headSha,
    baseImage: BASE_IMAGE,
    headImage: HEAD_IMAGE,
    hostileEnvironment,
  } satisfies GitFixture;
});
