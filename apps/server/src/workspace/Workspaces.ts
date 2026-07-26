/**
 * Clone workspaces and the materialized run inputs.
 *
 * Git — not the API — moves every repository byte, so nothing here costs GitHub
 * quota. One bare, blobless clone per repository is shared across its pull
 * requests; one worktree per analysis run is the read-only ground the agent
 * walks.
 *
 * PR heads are fetched as `refs/pull/<n>/head` from the *base* repository,
 * never from a fork remote or a branch name. One mechanism covers fork PRs,
 * deleted source branches, and force-pushed heads.
 *
 * Diff materialization happens here, once, at ingestion time. After it,
 * ingestion never consults git again — every later reader is served from the
 * run directory. Journey *reading* returns to the clone for exactly one thing:
 * files outside the changed set.
 *
 * @module workspace/Workspaces
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { FileChange, PrRef, SeedHunk } from "@app/contracts";
import { deriveDiff } from "@app/journey/hunks";

import { AGENT_INPUT_DIR } from "../analysis/prompts.ts";
import * as ServerConfig from "../config.ts";
import { GitHub } from "../github/GitHub.ts";
import { briefError, makeRunner, succeeded, type CommandOutcome } from "../process/Subprocess.ts";

/** An operational fault. Never analytical — the pipeline's own failure channel. */
export class WorkspaceError extends Schema.TaggedErrorClass<WorkspaceError>()("WorkspaceError", {
  step: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.step} failed: ${this.detail}`;
  }
}

/** What one prepared run looks like on disk and in memory. */
export interface PreparedRun {
  readonly runId: string;
  readonly runDir: string;
  readonly worktreePath: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly treePaths: ReadonlyArray<string>;
  /** Line counts per changed path, for hint-anchor validation. */
  readonly lineCounts: ReadonlyMap<string, { readonly old: number; readonly new: number }>;
  /** How many files the worktree holds — the transition's honest "on disk" figure. */
  readonly worktreeFileCount: number;
}

export interface FileRevisions {
  readonly old: string | null;
  readonly new: string | null;
  readonly binary: boolean;
  readonly omitted: boolean;
}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Clone/fetch, add a worktree at the pinned head, materialize the diff.
     * Scoped: the worktree is removed when the run's scope closes, unless the
     * run failed — a failed worktree is kept for debugging and reaped by the
     * next run on the same repository.
     */
    readonly prepare: (input: {
      readonly pr: PrRef;
      readonly runId: string;
      readonly expectedHeadSha: string;
      readonly baseRefName: string;
      readonly onStep: (step: string, detail: string) => Effect.Effect<void>;
    }) => Effect.Effect<PreparedRun, WorkspaceError>;

    /** The standard-context patch for one changed file, from the run directory. */
    readonly filePatch: (runDir: string, path: string) => Effect.Effect<string, WorkspaceError>;

    /**
     * Both revisions of a file. Changed files are served from the run
     * directory; anything else is read from the clone at the pinned head, which
     * is what makes free reading of the whole tree possible.
     */
    readonly fileRevisions: (input: {
      readonly pr: PrRef;
      readonly runDir: string;
      readonly headSha: string;
      readonly path: string;
    }) => Effect.Effect<FileRevisions, WorkspaceError>;

    /** The head-revision path list, from the run directory. */
    readonly tree: (runDir: string) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;

    /** Where a run's artifacts live. Stable across restarts. */
    readonly runDirectory: (pr: PrRef, runId: string) => Effect.Effect<string>;
  }
>()("@app/server/workspace/Workspaces") {}

/** Files above this are not materialized; the UI says so rather than lying. */
const MAX_MATERIALIZED_BYTES = 2 * 1024 * 1024;
const GIT_TIMEOUT = Duration.minutes(10);
const CONTENT_CONCURRENCY = 8;

const TreeIndex = Schema.Struct({
  paths: Schema.Array(Schema.String),
});
const FilesIndex = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      binary: Schema.Boolean,
      omitted: Schema.Boolean,
    }),
  ),
});
const decodeTreeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(TreeIndex));
const decodeFilesIndex = Schema.decodeUnknownSync(Schema.fromJsonString(FilesIndex));

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const github = yield* GitHub;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Captured once, so no method of this service leaks the spawner into its
  // requirements. See `Subprocess.makeRunner`.
  const runner = yield* makeRunner;

  const workspacesRoot = path.join(config.dataDir, "workspaces");
  const runsRoot = path.join(config.dataDir, "runs");

  const repoDir = (pr: PrRef) => path.join(workspacesRoot, pr.owner, pr.repo);
  const cloneDir = (pr: PrRef) => path.join(repoDir(pr), "repo.git");
  const worktreeDir = (pr: PrRef, runId: string) => path.join(repoDir(pr), "worktrees", runId);
  const runDir = (pr: PrRef, runId: string) =>
    path.join(runsRoot, pr.owner, pr.repo, String(pr.number), runId);

  const fail = (step: string) => (outcome: CommandOutcome) =>
    new WorkspaceError({ step, detail: briefError(outcome) });

  /** Run git, failing typed on a non-zero exit. */
  const git = Effect.fn("workspace.git")(function* (
    step: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly cwd?: string;
      readonly timeout?: Duration.Input;
      readonly authenticated?: boolean;
    },
  ) {
    // A credential problem is an operational fault of *this* step, not a
    // GitHub API error: git is about to fail to authenticate, and saying so
    // where it happens keeps the pipeline's one failure channel honest.
    const credentials =
      options?.authenticated === true
        ? yield* github.gitCredentialArgs.pipe(
            Effect.mapError(
              (cause) => new WorkspaceError({ step: "credentials", detail: cause.message }),
            ),
          )
        : [];
    const outcome = yield* runner({
      command: "git",
      args: [
        "-c",
        "core.quotePath=false",
        // Nothing here should ever wait on a terminal.
        "-c",
        "core.askPass=",
        ...credentials,
        ...args,
      ],
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      timeout: options?.timeout ?? GIT_TIMEOUT,
    }).pipe(Effect.mapError((cause) => new WorkspaceError({ step, detail: cause.message })));
    if (!succeeded(outcome)) return yield* fail(step)(outcome);
    return outcome.stdout;
  });

  const ensureClone = Effect.fn("workspace.ensureClone")(function* (pr: PrRef) {
    const directory = cloneDir(pr);
    const exists = yield* fs
      .exists(path.join(directory, "HEAD"))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return directory;

    yield* fs
      .makeDirectory(path.dirname(directory), { recursive: true })
      .pipe(
        Effect.mapError((cause) => new WorkspaceError({ step: "clone", detail: String(cause) })),
      );
    // Blobless: history arrives lazily, so the first ingestion of a large
    // repository is not a full download. Commits still all arrive, which is
    // what merge-base discovery needs.
    yield* git(
      "clone",
      [
        "clone",
        "--bare",
        "--filter=blob:none",
        "--no-tags",
        `https://github.com/${pr.owner}/${pr.repo}.git`,
        directory,
      ],
      { authenticated: true },
    );
    return directory;
  });

  const prepare = Effect.fn("workspace.prepare")(function* (input: {
    readonly pr: PrRef;
    readonly runId: string;
    readonly expectedHeadSha: string;
    readonly baseRefName: string;
    readonly onStep: (step: string, detail: string) => Effect.Effect<void>;
  }) {
    const { pr, runId } = input;
    yield* input.onStep("cloning", `${pr.owner}/${pr.repo}`);
    const clone = yield* ensureClone(pr);

    // Reap any worktree a previous failed run left behind before adding ours.
    yield* git("prune-worktrees", ["worktree", "prune"], { cwd: clone }).pipe(Effect.ignore);

    const prRef = `refs/throughline/pr/${pr.number}`;
    const baseRef = `refs/throughline/base/${pr.number}`;
    yield* git(
      "fetch",
      [
        "fetch",
        "--filter=blob:none",
        "--no-tags",
        "--force",
        "origin",
        `+refs/pull/${pr.number}/head:${prRef}`,
        `+refs/heads/${input.baseRefName}:${baseRef}`,
      ],
      { cwd: clone, authenticated: true },
    );

    let headSha = (yield* git("resolve-head", ["rev-parse", prRef], { cwd: clone })).trim();
    if (headSha !== input.expectedHeadSha) {
      // A force-push moved the ref mid-ingestion. Refetch once and re-pin to
      // whatever is actually there; the journey records what it analyzed.
      yield* git(
        "refetch",
        [
          "fetch",
          "--filter=blob:none",
          "--no-tags",
          "--force",
          "origin",
          `+refs/pull/${pr.number}/head:${prRef}`,
        ],
        { cwd: clone, authenticated: true },
      );
      headSha = (yield* git("resolve-head", ["rev-parse", prRef], { cwd: clone })).trim();
    }

    const baseSha = (yield* git("merge-base", ["merge-base", baseRef, headSha], {
      cwd: clone,
    })).trim();

    const worktree = worktreeDir(pr, runId);
    yield* fs
      .remove(worktree, { recursive: true, force: true })
      .pipe(
        Effect.mapError((cause) => new WorkspaceError({ step: "worktree", detail: String(cause) })),
      );
    yield* git("worktree", ["worktree", "add", "--detach", "--force", worktree, headSha], {
      cwd: clone,
    });

    const directory = runDir(pr, runId);
    yield* fs
      .makeDirectory(path.join(directory, "diff", "by-file"), { recursive: true })
      .pipe(
        Effect.mapError((cause) => new WorkspaceError({ step: "run-dir", detail: String(cause) })),
      );

    yield* input.onStep("diffing", `${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`);

    const range = `${baseSha}..${headSha}`;
    const raw = yield* git("diff-raw", ["diff", "--raw", "-z", "-M", range], { cwd: clone });
    const zeroContext = yield* git("diff-zero", ["diff", "-U0", "-M", range], { cwd: clone });
    const fullPatch = yield* git("diff-full", ["diff", "-M", range], { cwd: clone });

    const derived = yield* Effect.try(() => deriveDiff({ raw, patch: zeroContext })).pipe(
      Effect.mapError(
        (cause) => new WorkspaceError({ step: "derive-hunks", detail: String(cause) }),
      ),
    );

    const treeOutput = yield* git("ls-tree", ["ls-tree", "-r", "-z", "--name-only", headSha], {
      cwd: clone,
    });
    const treePaths = treeOutput.split("\0").filter((entry) => entry.length > 0);

    yield* writeText(path.join(directory, "diff", "full.patch"), fullPatch);
    yield* writeText(path.join(directory, "diff", "zero.patch"), zeroContext);
    yield* writeText(path.join(directory, "diff", "raw.txt"), raw);
    yield* writeText(
      path.join(directory, "tree.json"),
      `${JSON.stringify({ paths: treePaths }, null, 2)}\n`,
    );
    yield* writeText(
      path.join(directory, "hunks.json"),
      `${JSON.stringify({ hunks: derived.seeds }, null, 2)}\n`,
    );

    // Per-file patches and both revisions of every changed file: what the
    // renderer's diff surfaces, context expansion, and just-the-code are served
    // from for the life of the journey.
    const lineCounts = new Map<string, { old: number; new: number }>();
    const materialized: Array<{ path: string; binary: boolean; omitted: boolean }> = [];

    yield* Effect.forEach(
      derived.files,
      (file) =>
        Effect.gen(function* () {
          const perFile = file.binary
            ? ""
            : yield* git("diff-file", ["diff", "-M", range, "--", file.path], { cwd: clone }).pipe(
                Effect.orElseSucceed(() => ""),
              );
          yield* writeText(
            path.join(directory, "diff", "by-file", `${encodePath(file.path)}.patch`),
            perFile,
          );

          const oldSide =
            file.binary || file.changeKind === "added"
              ? null
              : yield* readRevision(clone, baseSha, file.oldPath ?? file.path);
          const newSide =
            file.binary || file.changeKind === "deleted"
              ? null
              : yield* readRevision(clone, headSha, file.path);

          const omitted =
            !file.binary &&
            ((file.changeKind !== "added" && oldSide === null) ||
              (file.changeKind !== "deleted" && newSide === null));

          if (oldSide !== null) {
            yield* writeText(
              path.join(directory, "contents", "old", encodePath(file.path)),
              oldSide,
            );
          }
          if (newSide !== null) {
            yield* writeText(
              path.join(directory, "contents", "new", encodePath(file.path)),
              newSide,
            );
          }
          lineCounts.set(file.path, {
            old: oldSide === null ? 0 : countLines(oldSide),
            new: newSide === null ? 0 : countLines(newSide),
          });
          materialized.push({ path: file.path, binary: file.binary, omitted });
        }),
      { concurrency: CONTENT_CONCURRENCY, discard: true },
    );

    yield* writeText(
      path.join(directory, "files.json"),
      `${JSON.stringify({ files: materialized, changes: derived.files }, null, 2)}\n`,
    );

    // The agent's world is the worktree, and a read-only sandbox is under no
    // obligation to let it read outside that. So the inputs it navigates are
    // written *inside* the checkout; the durable copies above are what the
    // renderer and the honesty trail are served from for the journey's life.
    const agentDir = path.join(worktree, AGENT_INPUT_DIR);
    yield* writeText(path.join(agentDir, "full.patch"), fullPatch);
    yield* writeText(
      path.join(agentDir, "hunks.json"),
      `${JSON.stringify(derived.seeds, null, 2)}\n`,
    );
    yield* writeText(
      path.join(agentDir, "files.json"),
      `${JSON.stringify(derived.files, null, 2)}\n`,
    );

    yield* input.onStep(
      "diffing",
      `${derived.files.length} changed files · ${derived.seeds.length} hunks`,
    );

    return {
      runId,
      runDir: directory,
      worktreePath: worktree,
      headSha,
      baseSha,
      files: derived.files,
      seeds: derived.seeds,
      treePaths,
      lineCounts,
      worktreeFileCount: treePaths.length,
    } satisfies PreparedRun;
  });

  function writeText(target: string, contents: string) {
    return fs.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(target, contents)),
      Effect.mapError((cause) => new WorkspaceError({ step: "write", detail: String(cause) })),
    );
  }

  /** One revision of one file, or null when it is absent, binary, or too big. */
  const readRevision = Effect.fn("workspace.readRevision")(function* (
    clone: string,
    sha: string,
    filePath: string,
  ) {
    const size = yield* runner({
      command: "git",
      args: ["-c", "core.quotePath=false", "cat-file", "-s", `${sha}:${filePath}`],
      cwd: clone,
      timeout: Duration.seconds(30),
    }).pipe(Effect.orElseSucceed(() => null));
    if (size === null || !succeeded(size)) return null;
    if (Number.parseInt(size.stdout.trim(), 10) > MAX_MATERIALIZED_BYTES) return null;

    const outcome = yield* runner({
      command: "git",
      args: ["-c", "core.quotePath=false", "show", `${sha}:${filePath}`],
      cwd: clone,
      timeout: Duration.seconds(60),
    }).pipe(Effect.orElseSucceed(() => null));
    return outcome !== null && succeeded(outcome) ? outcome.stdout : null;
  });

  const readRunText = (target: string) =>
    fs
      .readFileString(target)
      .pipe(
        Effect.mapError(
          (cause) => new WorkspaceError({ step: "read-run-file", detail: String(cause) }),
        ),
      );

  return Workspaces.of({
    prepare,

    filePatch: (directory, filePath) =>
      readRunText(path.join(directory, "diff", "by-file", `${encodePath(filePath)}.patch`)).pipe(
        Effect.orElseSucceed(() => ""),
      ),

    fileRevisions: (input) =>
      Effect.gen(function* () {
        const index = yield* readRunText(path.join(input.runDir, "files.json")).pipe(
          Effect.map((raw) => decodeFilesIndex(raw)),
          Effect.orElseSucceed(() => ({
            files: [] as ReadonlyArray<{ path: string; binary: boolean; omitted: boolean }>,
          })),
        );
        const entry = index.files.find((file) => file.path === input.path);

        if (entry !== undefined) {
          if (entry.binary) {
            return { old: null, new: null, binary: true, omitted: false } satisfies FileRevisions;
          }
          const oldSide = yield* readRunText(
            path.join(input.runDir, "contents", "old", encodePath(input.path)),
          ).pipe(Effect.orElseSucceed(() => null));
          const newSide = yield* readRunText(
            path.join(input.runDir, "contents", "new", encodePath(input.path)),
          ).pipe(Effect.orElseSucceed(() => null));
          return {
            old: oldSide,
            new: newSide,
            binary: false,
            omitted: entry.omitted,
          } satisfies FileRevisions;
        }

        // Outside the changed set: free reading of any file in the tree. The
        // clone is a cache, so re-cloning is always a valid recovery.
        const clone = yield* ensureClone(input.pr);
        const contents = yield* readRevision(clone, input.headSha, input.path);
        return {
          old: null,
          new: contents,
          binary: false,
          omitted: contents === null,
        } satisfies FileRevisions;
      }),

    tree: (directory) =>
      readRunText(path.join(directory, "tree.json")).pipe(
        Effect.map((raw) => decodeTreeIndex(raw).paths),
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
      ),

    runDirectory: (pr, runId) => Effect.succeed(runDir(pr, runId)),
  });
});

export const layer: Layer.Layer<
  Workspaces,
  never,
  | ServerConfig.ServerConfig
  | GitHub
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(Workspaces, make);

/**
 * Repository paths become one flat file name. Encoding rather than nesting
 * keeps the run directory shallow and makes `..` unrepresentable, so a path out
 * of git can never escape the run directory.
 */
export function encodePath(filePath: string): string {
  return encodeURIComponent(filePath);
}

function countLines(contents: string): number {
  if (contents.length === 0) return 0;
  const lines = contents.split("\n").length;
  return contents.endsWith("\n") ? lines - 1 : lines;
}
