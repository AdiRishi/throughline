import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  FileContent,
  FilePatch,
  JourneyFileNotFoundError,
  JourneyTree,
  type FileChange,
  type JourneyId,
  type PrRef,
  type PullRequestDetail,
  type SeedHunk,
  type TreeEntry,
} from "@app/contracts";
import { deriveSeedHunks } from "@app/journey/hunks";

import * as ServerConfig from "../config.ts";
import { GitHub } from "../github/GitHub.ts";
import type { StoredJourney } from "../journeys/JourneyStore.ts";
import { ProcessRunner } from "../process/ProcessRunner.ts";

const UTF8 = new TextDecoder();
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

const FilesJson = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        oldPath: Schema.optionalKey(Schema.String),
        kind: Schema.String,
        additions: Schema.Number,
        deletions: Schema.Number,
      }),
    ),
  ),
);
const HunksJson = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        oldStart: Schema.Number,
        oldLines: Schema.Number,
        newStart: Schema.Number,
        newLines: Schema.Number,
        fileKind: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);
const TreeJson = Schema.fromJsonString(Schema.toCodecJson(JourneyTree));
const encodeFiles = Schema.encodeUnknownEffect(FilesJson);
const encodeHunks = Schema.encodeUnknownEffect(HunksJson);
const encodeTree = Schema.encodeUnknownEffect(TreeJson);
const decodeTree = Schema.decodeUnknownEffect(TreeJson);

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{
  readonly operation: string;
  readonly detail: string;
}> {}

export interface PreparedWorkspace {
  readonly runDir: string;
  readonly worktree: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly tree: JourneyTree;
  readonly cleanup: Effect.Effect<void>;
}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    readonly prepare: (
      detail: PullRequestDetail,
      journeyId: JourneyId,
    ) => Effect.Effect<PreparedWorkspace, WorkspaceError>;
    readonly filePatch: (
      stored: StoredJourney,
      path: string,
    ) => Effect.Effect<FilePatch, JourneyFileNotFoundError>;
    readonly fileContent: (
      stored: StoredJourney,
      path: string,
    ) => Effect.Effect<FileContent, JourneyFileNotFoundError>;
    readonly tree: (stored: StoredJourney) => Effect.Effect<JourneyTree, JourneyFileNotFoundError>;
  }
>()("@app/server/workspace/Workspaces") {}

function artifactKey(path: string): string {
  return Encoding.encodeBase64Url(path);
}

function textOrBase64(bytes: Uint8Array): {
  readonly content: string;
  readonly encoding: "text" | "base64";
} {
  try {
    const content = STRICT_UTF8.decode(bytes);
    return content.includes("\0")
      ? { content: Encoding.encodeBase64(bytes), encoding: "base64" }
      : { content, encoding: "text" };
  } catch {
    return { content: Encoding.encodeBase64(bytes), encoding: "base64" };
  }
}

function repositoryPath(path: Path.Path, dataDir: string, pr: PrRef): string {
  return path.join(dataDir, "workspaces", pr.owner, pr.repo, "repository.git");
}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const github = yield* GitHub;
  const runner = yield* ProcessRunner;

  const runGit = (
    args: ReadonlyArray<string>,
    options?: { readonly cwd?: string; readonly authenticated?: boolean },
  ): Effect.Effect<Uint8Array, WorkspaceError> =>
    Effect.gen(function* () {
      const token = options?.authenticated === true ? yield* github.cloneToken : undefined;
      const env =
        token === undefined
          ? undefined
          : {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Encoding.encodeBase64(`x-access-token:${token}`)}`,
            };
      const result = yield* runner.run("git", args, {
        ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(env === undefined ? {} : { env }),
      });
      return result.stdout;
    }).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({
            operation: `git ${args[0] ?? ""}`.trim(),
            detail: "detail" in error ? error.detail : error.stderr || String(error.cause ?? error),
          }),
      ),
    );

  const readTree = (runDir: string, journeyId: JourneyId) =>
    fileSystem.readFileString(path.join(runDir, "tree.json")).pipe(
      Effect.flatMap(decodeTree),
      Effect.mapError(
        () =>
          new JourneyFileNotFoundError({
            journeyId,
            path: "tree",
          }),
      ),
    );

  const readRevision = (
    stored: StoredJourney,
    requestedPath: string,
    side: "old" | "new",
  ): Effect.Effect<Option.Option<Uint8Array>, JourneyFileNotFoundError> =>
    Effect.gen(function* () {
      const key = artifactKey(requestedPath);
      const materializedPath = path.join(stored.runDir, "content", `${key}.${side}`);
      const materialized = yield* fileSystem.readFile(materializedPath).pipe(Effect.option);
      if (Option.isSome(materialized)) return materialized;

      const tree = yield* readTree(stored.runDir, stored.journey.id);
      if (!tree.entries.some((entry) => entry.path === requestedPath)) {
        return yield* new JourneyFileNotFoundError({
          journeyId: stored.journey.id,
          path: requestedPath,
        });
      }
      const repository = repositoryPath(path, config.dataDir, stored.journey.pr);
      const sha = side === "new" ? stored.journey.pinned.headSha : stored.journey.pinned.baseSha;
      return yield* runGit(["--git-dir", repository, "show", `${sha}:${requestedPath}`]).pipe(
        Effect.option,
        Effect.mapError(
          () =>
            new JourneyFileNotFoundError({
              journeyId: stored.journey.id,
              path: requestedPath,
            }),
        ),
      );
    });

  return Workspaces.of({
    prepare: (detail, journeyId) =>
      Effect.gen(function* () {
        const repository = repositoryPath(path, config.dataDir, detail.ref);
        const repositoryRoot = path.dirname(repository);
        const runDir = path.join(
          config.dataDir,
          "runs",
          detail.ref.owner,
          detail.ref.repo,
          String(detail.ref.number),
          journeyId,
        );
        const worktree = path.join(runDir, "worktree");
        const diffDir = path.join(runDir, "diff");
        const patchDir = path.join(diffDir, "by-file");
        const contentDir = path.join(runDir, "content");
        yield* fileSystem.makeDirectory(repositoryRoot, { recursive: true });
        yield* fileSystem.makeDirectory(patchDir, { recursive: true });
        yield* fileSystem.makeDirectory(contentDir, { recursive: true });

        const repositoryExists = yield* fileSystem.exists(repository);
        if (!repositoryExists) {
          yield* runGit(
            ["clone", "--bare", "--filter=blob:none", detail.repositoryUrl, repository],
            { authenticated: true },
          );
        }

        const headRef = `refs/throughline/pr/${detail.ref.number}`;
        const baseRef = `refs/throughline/base/${detail.baseBranch}`;
        yield* runGit(
          [
            "--git-dir",
            repository,
            "fetch",
            "--force",
            "origin",
            `+refs/pull/${detail.ref.number}/head:${headRef}`,
            `+refs/heads/${detail.baseBranch}:${baseRef}`,
          ],
          { authenticated: true },
        );
        const fetchedHead = UTF8.decode(
          yield* runGit(["--git-dir", repository, "rev-parse", headRef]),
        ).trim();
        if (fetchedHead !== detail.headSha) {
          return yield* new WorkspaceError({
            operation: "pin pull request head",
            detail: `The pull request moved during ingestion (${detail.headSha.slice(0, 8)} → ${fetchedHead.slice(0, 8)}). Retry against the new head.`,
          });
        }
        const baseSha = UTF8.decode(
          yield* runGit(["--git-dir", repository, "merge-base", baseRef, fetchedHead]),
        ).trim();

        yield* runGit(["--git-dir", repository, "worktree", "prune"]);
        yield* runGit([
          "--git-dir",
          repository,
          "worktree",
          "add",
          "--detach",
          worktree,
          fetchedHead,
        ]);

        const diffArgs = [
          "--git-dir",
          repository,
          "diff",
          "--no-ext-diff",
          "--binary",
          "--find-renames",
          "--full-index",
          `${baseSha}..${fetchedHead}`,
        ] as const;
        const fullPatchBytes = yield* runGit(diffArgs);
        const zeroPatchBytes = yield* runGit([
          ...diffArgs.slice(0, -1),
          "--unified=0",
          diffArgs.at(-1) as string,
        ]);
        const fullPatch = UTF8.decode(fullPatchBytes);
        const zeroPatch = UTF8.decode(zeroPatchBytes);
        const derived = deriveSeedHunks(zeroPatch);

        yield* fileSystem.writeFile(path.join(diffDir, "full.patch"), fullPatchBytes);
        yield* fileSystem.writeFile(path.join(diffDir, "zero.patch"), zeroPatchBytes);

        for (const file of derived.files) {
          const key = artifactKey(file.path);
          const filePatch = yield* runGit([...diffArgs, "--", file.path]);
          yield* fileSystem.writeFile(path.join(patchDir, `${key}.patch`), filePatch);

          const oldPath = file.oldPath ?? file.path;
          const oldContent = yield* runGit([
            "--git-dir",
            repository,
            "show",
            `${baseSha}:${oldPath}`,
          ]).pipe(Effect.option);
          if (Option.isSome(oldContent)) {
            yield* fileSystem.writeFile(path.join(contentDir, `${key}.old`), oldContent.value);
          }
          const newContent = yield* runGit([
            "--git-dir",
            repository,
            "show",
            `${fetchedHead}:${file.path}`,
          ]).pipe(Effect.option);
          if (Option.isSome(newContent)) {
            yield* fileSystem.writeFile(path.join(contentDir, `${key}.new`), newContent.value);
          }
        }

        const treeOutput = UTF8.decode(
          yield* runGit(["--git-dir", repository, "ls-tree", "-rz", "--full-tree", fetchedHead]),
        );
        const entries = treeOutput.split("\0").flatMap((row): ReadonlyArray<TreeEntry> => {
          if (row === "") return [];
          const match = /^(\d+) (blob|commit) [0-9a-f]+\t(.+)$/.exec(row);
          if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
            return [];
          }
          return [
            {
              path: match[3],
              kind:
                match[2] === "commit" ? "submodule" : match[1] === "120000" ? "symlink" : "file",
            },
          ];
        });
        const tree: JourneyTree = { journeyId, entries };

        yield* Effect.all(
          [
            encodeFiles(derived.files).pipe(
              Effect.flatMap((json) =>
                fileSystem.writeFileString(path.join(runDir, "files.json"), `${json}\n`),
              ),
            ),
            encodeHunks(derived.hunks).pipe(
              Effect.flatMap((json) =>
                fileSystem.writeFileString(path.join(runDir, "hunks.json"), `${json}\n`),
              ),
            ),
            encodeTree(tree).pipe(
              Effect.flatMap((json) =>
                fileSystem.writeFileString(path.join(runDir, "tree.json"), `${json}\n`),
              ),
            ),
          ],
          { concurrency: 3 },
        ).pipe(Effect.orDie);

        return {
          runDir,
          worktree,
          headSha: fetchedHead,
          baseSha,
          files: derived.files,
          seeds: derived.hunks,
          tree,
          cleanup: runGit([
            "--git-dir",
            repository,
            "worktree",
            "remove",
            "--force",
            worktree,
          ]).pipe(Effect.ignore),
        };
      }).pipe(
        Effect.mapError((error) =>
          error instanceof WorkspaceError
            ? error
            : new WorkspaceError({
                operation: "prepare workspace",
                detail: String(error),
              }),
        ),
        Effect.withSpan("workspace.prepare"),
      ),
    filePatch: (stored, requestedPath) =>
      readTree(stored.runDir, stored.journey.id).pipe(
        Effect.flatMap((tree) =>
          tree.entries.some((entry) => entry.path === requestedPath)
            ? fileSystem
                .readFileString(
                  path.join(
                    stored.runDir,
                    "diff",
                    "by-file",
                    `${artifactKey(requestedPath)}.patch`,
                  ),
                )
                .pipe(
                  Effect.orElseSucceed(() => ""),
                  Effect.map(
                    (patch): FilePatch => ({
                      journeyId: stored.journey.id,
                      path: requestedPath,
                      patch,
                    }),
                  ),
                )
            : new JourneyFileNotFoundError({
                journeyId: stored.journey.id,
                path: requestedPath,
              }),
        ),
      ),
    fileContent: (stored, requestedPath) =>
      Effect.gen(function* () {
        const oldBytes = yield* readRevision(stored, requestedPath, "old");
        const newBytes = yield* readRevision(stored, requestedPath, "new");
        const old = Option.map(oldBytes, textOrBase64);
        const current = Option.map(newBytes, textOrBase64);
        return {
          journeyId: stored.journey.id,
          path: requestedPath,
          oldContent: Option.match(old, { onNone: () => null, onSome: (_) => _.content }),
          newContent: Option.match(current, { onNone: () => null, onSome: (_) => _.content }),
          oldEncoding: Option.match(old, { onNone: () => "text", onSome: (_) => _.encoding }),
          newEncoding: Option.match(current, {
            onNone: () => "text",
            onSome: (_) => _.encoding,
          }),
        } satisfies FileContent;
      }).pipe(Effect.withSpan("workspace.fileContent")),
    tree: (stored) => readTree(stored.runDir, stored.journey.id),
  });
});

export const layer = Layer.effect(Workspaces, make);
