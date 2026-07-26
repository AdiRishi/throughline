/**
 * `Workspaces` — everything on disk under the data root.
 *
 * Two responsibilities, one seam:
 *
 * 1. **Clones and worktrees.** One bare, partial clone per repository (shared
 *    across its pull requests), and one worktree per analysis run — the
 *    read-only ground the agent walks. PR heads are always fetched as
 *    `refs/pull/<n>/head` from the base repository, never from a fork remote or
 *    a branch name, which covers fork PRs, deleted source branches, and
 *    force-pushed heads with one mechanism.
 *
 * 2. **Diff materialization.** At ingestion time, everything the pipeline and
 *    the reading surfaces need is written into the run directory. After that
 *    point ingestion never consults git again; journey *reading* consults the
 *    clone for exactly one thing — serving files outside the changed set.
 *
 * @module workspace/Workspaces
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { FileChange, PrRef } from "@app/contracts";
import { deriveDiffIndex, type DiffIndex, type SeedHunk } from "@app/journey/hunks";

import { AGENT_INPUT_DIR } from "../analysis/prompts.ts";
import * as ServerConfig from "../config.ts";
import { git, gitBytes, type GitError } from "./git.ts";
import {
  bareRepo,
  fileContentName,
  perFilePatch,
  repoRoot,
  RUN_FILES,
  runDir,
  worktreeDir,
} from "./paths.ts";

const GITHUB_REMOTE = (ref: Pick<PrRef, "owner" | "repo">) =>
  `https://github.com/${ref.owner}/${ref.repo}.git`;

/** Where a PR head and its base land inside our own ref namespace. */
const prHeadRef = (number: number) => `refs/throughline/pr/${number}`;
const baseRefLocal = (baseRef: string) => `refs/throughline/base/${baseRef}`;

/** The on-disk index that maps a changed file to its artifact names. */
const FileIndexEntry = Schema.Struct({
  index: Schema.Int,
  path: Schema.String,
  oldPath: Schema.NullOr(Schema.String),
  kind: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
  hasOld: Schema.Boolean,
  hasNew: Schema.Boolean,
  oldLineCount: Schema.Int,
  newLineCount: Schema.Int,
  oldBytes: Schema.NullOr(Schema.Int),
  newBytes: Schema.NullOr(Schema.Int),
});
export type FileIndexEntry = typeof FileIndexEntry.Type;

const FileIndexDocument = Schema.Struct({ files: Schema.Array(FileIndexEntry) });
const FileIndexJson = Schema.fromJsonString(FileIndexDocument);
const decodeFileIndex = Schema.decodeUnknownEffect(FileIndexJson);
const encodeFileIndex = Schema.encodeUnknownEffect(FileIndexJson);

const SeedDocument = Schema.Struct({
  hunks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      oldStart: Schema.Int,
      oldLines: Schema.Int,
      newStart: Schema.Int,
      newLines: Schema.Int,
      fileKind: Schema.NullOr(Schema.String),
    }),
  ),
});
const SeedJson = Schema.fromJsonString(SeedDocument);
const encodeSeeds = Schema.encodeUnknownEffect(SeedJson);

const TreeDocument = Schema.Struct({ paths: Schema.Array(Schema.String) });
const TreeJson = Schema.fromJsonString(TreeDocument);
const decodeTree = Schema.decodeUnknownEffect(TreeJson);
const encodeTree = Schema.encodeUnknownEffect(TreeJson);

/** Everything the analysis pipeline needs after materialization. */
export interface PreparedRun {
  readonly runId: string;
  readonly runDir: string;
  readonly worktree: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly index: DiffIndex;
  readonly treePaths: ReadonlyArray<string>;
  readonly lineCounts: ReadonlyMap<string, { readonly old: number; readonly new: number }>;
  readonly filesOnDisk: number;
}

export interface FileArtifacts {
  readonly entry: FileIndexEntry;
  readonly patch: string;
  readonly oldText: string | null;
  readonly newText: string | null;
  readonly oldBytes: Uint8Array | null;
  readonly newBytes: Uint8Array | null;
}

export class WorkspaceMissingError extends Schema.TaggedErrorClass<WorkspaceMissingError>()(
  "WorkspaceMissingError",
  { detail: Schema.String },
) {}

export type WorkspaceError = GitError | WorkspaceMissingError;

export class Workspaces extends Context.Service<
  Workspaces,
  {
    /**
     * Clone or fetch, add a worktree at the pinned head, and materialize every
     * run input. Scoped: the worktree is removed when the scope closes on
     * success and deliberately **kept on failure**, for debugging.
     */
    readonly prepare: (input: {
      readonly ref: PrRef;
      readonly runId: string;
      readonly headSha: string;
      readonly baseRef: string;
    }) => Effect.Effect<PreparedRun, WorkspaceError>;
    /** Release a run's worktree. Safe to call twice. */
    readonly releaseWorktree: (ref: PrRef, runId: string) => Effect.Effect<void>;
    /** Read one changed file's materialized artifacts. */
    readonly fileArtifacts: (
      ref: PrRef,
      runId: string,
      path: string,
    ) => Effect.Effect<FileArtifacts, WorkspaceError>;
    /** The head-revision path list captured at analysis time. */
    readonly treePaths: (
      ref: PrRef,
      runId: string,
    ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
    /**
     * Serve a file *outside* the changed set, from the repository clone —
     * re-fetching if the workspace was evicted. This is the one thing journey
     * reading still needs git for.
     */
    readonly treeFile: (
      ref: PrRef,
      headSha: string,
      path: string,
    ) => Effect.Effect<string, WorkspaceError>;
    /** Write an agent artifact into the run directory (transcripts, prompts). */
    readonly writeRunArtifact: (
      ref: PrRef,
      runId: string,
      name: string,
      contents: string,
    ) => Effect.Effect<void>;
    /** Append a line to the run's fallback log. Every floor taken is recorded. */
    readonly appendFallbacks: (
      ref: PrRef,
      runId: string,
      lines: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    /** LRU eviction of repository clones. Deleting one is always safe. */
    readonly evictIfNeeded: Effect.Effect<void>;
  }
>()("@app/server/workspace/Workspaces") {}

/** Generous: a clone is a cache, and re-cloning is always possible. */
const MAX_CACHED_REPOS = 12;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const dataRoot = config.dataDir;
  const run = <A, E>(
    effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
  ): Effect.Effect<A, E> =>
    Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, spawner);

  const ensureDir = (dir: string) => fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);

  /** Create the bare partial clone if it does not exist, then touch it for LRU. */
  const ensureRepo = Effect.fn("workspace.ensureRepo")(function* (ref: PrRef) {
    const bare = bareRepo(dataRoot, ref);
    const exists = yield* fs
      .exists(path.join(bare, "HEAD"))
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      yield* ensureDir(bare);
      yield* run(git(["init", "--bare", "--quiet", bare], { authenticated: false }));
      yield* run(git(["-C", bare, "remote", "add", "origin", GITHUB_REMOTE(ref)]));
      // A promisor remote with a blob filter: history arrives lazily, so the
      // first ingestion of a large repository is not a full download.
      yield* run(git(["-C", bare, "config", "remote.origin.promisor", "true"]));
      yield* run(git(["-C", bare, "config", "remote.origin.partialclonefilter", "blob:none"]));
      yield* run(git(["-C", bare, "config", "gc.auto", "0"]));
    }
    yield* fs
      .writeFileString(path.join(repoRoot(dataRoot, ref), ".last-used"), String(Date.now()))
      .pipe(Effect.ignore);
    return bare;
  });

  /**
   * Fetch the pinned head and the base branch. The head is fetched by
   * `refs/pull/<n>/head`, which is the one mechanism that covers fork PRs,
   * deleted branches, and force pushes.
   */
  const fetchRefs = Effect.fn("workspace.fetchRefs")(function* (
    bare: string,
    ref: PrRef,
    baseRef: string,
  ) {
    yield* run(
      git([
        "-C",
        bare,
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "--no-tags",
        "--force",
        "origin",
        `+refs/pull/${ref.number}/head:${prHeadRef(ref.number)}`,
      ]),
    );
    yield* run(
      git([
        "-C",
        bare,
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "--no-tags",
        "--force",
        "origin",
        `+refs/heads/${baseRef}:${baseRefLocal(baseRef)}`,
      ]),
    );
  });

  const revParse = (bare: string, rev: string) =>
    run(git(["-C", bare, "rev-parse", rev])).pipe(Effect.map((result) => result.stdout.trim()));

  const prepare: Workspaces["Service"]["prepare"] = Effect.fn("workspace.prepare")(
    function* (input) {
      const { ref, runId, baseRef } = input;
      const bare = yield* ensureRepo(ref);
      yield* fetchRefs(bare, ref, baseRef);

      // The fetched commit must equal the head the API reported. If a force-push
      // moved the ref mid-ingestion, refetch once and re-pin to what git has —
      // the caller re-reads the head from the API before persisting.
      let headSha = yield* revParse(bare, prHeadRef(ref.number));
      if (headSha !== input.headSha) {
        yield* Effect.logInfo("PR head moved during ingestion; refetching", {
          expected: input.headSha,
          found: headSha,
        });
        yield* fetchRefs(bare, ref, baseRef);
        headSha = yield* revParse(bare, prHeadRef(ref.number));
      }

      const baseSha = yield* run(
        git(["-C", bare, "merge-base", baseRefLocal(baseRef), headSha]),
      ).pipe(
        Effect.map((result) => result.stdout.trim()),
        // A base branch with no common ancestor (a rewritten history) still has
        // to yield a journey: fall back to the empty tree so the whole PR reads
        // as additions rather than failing the run.
        Effect.orElseSucceed(() => EMPTY_TREE_SHA),
      );

      const worktree = worktreeDir(dataRoot, ref, runId);
      yield* fs.remove(worktree, { recursive: true, force: true }).pipe(Effect.ignore);
      yield* run(git(["-C", bare, "worktree", "prune"])).pipe(Effect.ignore);
      yield* ensureDir(path.dirname(worktree));
      yield* run(
        git(["-C", bare, "worktree", "add", "--detach", "--force", worktree, headSha], {
          timeout: "15 minutes",
        }),
      );

      const filesOnDisk = yield* countFiles(worktree);
      const materialized = yield* materialize({ ref, runId, bare, baseSha, headSha });
      yield* stageAgentInputs(ref, runId, worktree);

      return {
        runId,
        runDir: runDir(dataRoot, ref, runId),
        worktree,
        headSha,
        baseSha,
        baseRef,
        index: materialized.index,
        treePaths: materialized.treePaths,
        lineCounts: materialized.lineCounts,
        filesOnDisk,
      };
    },
  );

  /**
   * Put the agent's inputs *inside* its worktree, under a dot-directory.
   *
   * The alternative — pointing the agent at the run directory by absolute path —
   * depends on each harness's file-access rules, which differ and are not part of
   * either SDK's contract. A path under the agent's own working directory is
   * unambiguously readable in both, and the worktree is disposable, so writing
   * into it costs nothing. `.git/info/exclude` keeps it out of `git status` for
   * anyone who looks.
   */
  const stageAgentInputs = Effect.fn("workspace.stageAgentInputs")(function* (
    ref: PrRef,
    runId: string,
    worktree: string,
  ) {
    const source = runDir(dataRoot, ref, runId);
    const target = path.join(worktree, AGENT_INPUT_DIR);
    yield* ensureDir(target);

    const copy = (from: string, to: string) =>
      fs.readFileString(path.join(source, from)).pipe(
        Effect.flatMap((contents) => fs.writeFileString(path.join(target, to), contents)),
        Effect.ignore,
      );

    yield* copy(RUN_FILES.contextPatch, "diff.patch");
    yield* copy(RUN_FILES.hunks, "hunks.json");
    yield* copy(RUN_FILES.files, "files.json");

    yield* fs
      .writeFileString(path.join(worktree, ".git", "info", "exclude"), `${AGENT_INPUT_DIR}/\n`)
      .pipe(Effect.ignore);
  });

  /** Write every run input. After this, ingestion never consults git again. */
  const materialize = Effect.fn("workspace.materialize")(function* (input: {
    readonly ref: PrRef;
    readonly runId: string;
    readonly bare: string;
    readonly baseSha: string;
    readonly headSha: string;
  }) {
    const { ref, runId, bare, baseSha, headSha } = input;
    const dir = runDir(dataRoot, ref, runId);
    yield* ensureDir(path.join(dir, "diff", "by-file"));
    yield* ensureDir(path.join(dir, RUN_FILES.contentsDir));
    yield* ensureDir(path.join(dir, RUN_FILES.agentDir));

    const range = `${baseSha}..${headSha}`;
    const zeroContext = yield* run(
      git([
        "-C",
        bare,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--unified=0",
        range,
      ]),
    ).pipe(Effect.map((result) => result.stdout));

    const withContext = yield* run(
      git([
        "-C",
        bare,
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--unified=3",
        range,
      ]),
    ).pipe(Effect.map((result) => result.stdout));

    yield* fs
      .writeFileString(path.join(dir, RUN_FILES.zeroContextPatch), zeroContext)
      .pipe(Effect.orDie);
    yield* fs
      .writeFileString(path.join(dir, RUN_FILES.contextPatch), withContext)
      .pipe(Effect.orDie);

    // Seeds come from the ZERO-context patch: only there is a hunk exactly a
    // maximal contiguous run of changed lines.
    const index = deriveDiffIndex(zeroContext);
    const perFile = splitPatchByFile(withContext);

    const treePaths = yield* run(
      git(["-C", bare, "ls-tree", "-r", "--name-only", "--full-tree", headSha]),
    ).pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .map((line) => unquote(line.trim()))
          .filter((line) => line.length > 0),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

    const lineCounts = new Map<string, { readonly old: number; readonly new: number }>();
    const entries: FileIndexEntry[] = [];

    yield* Effect.forEach(
      index.files,
      (file, position) =>
        Effect.gen(function* () {
          const patch = perFile.get(file.path) ?? perFile.get(file.oldPath ?? "") ?? "";
          yield* fs
            .writeFileString(path.join(dir, perFilePatch(position)), patch)
            .pipe(Effect.orDie);

          const oldPath = file.oldPath ?? file.path;
          const wantsOld = file.kind !== "added";
          const wantsNew = file.kind !== "deleted";

          const stored = yield* storeContents({
            dir,
            bare,
            position,
            file,
            oldPath,
            baseSha,
            headSha,
            wantsOld,
            wantsNew,
          });

          lineCounts.set(file.path, { old: stored.oldLineCount, new: stored.newLineCount });
          entries.push({
            index: position,
            path: file.path,
            oldPath: file.oldPath ?? null,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
            binary: file.binary,
            hasOld: stored.hasOld,
            hasNew: stored.hasNew,
            oldLineCount: stored.oldLineCount,
            newLineCount: stored.newLineCount,
            oldBytes: stored.oldBytes,
            newBytes: stored.newBytes,
          });
        }),
      { concurrency: 8 },
    );

    entries.sort((left, right) => left.index - right.index);

    yield* writeJson(path.join(dir, RUN_FILES.files), encodeFileIndex({ files: entries }));
    yield* writeJson(
      path.join(dir, RUN_FILES.hunks),
      encodeSeeds({
        hunks: index.seeds.map((seed: SeedHunk) => ({
          id: seed.id,
          path: seed.path,
          oldStart: seed.oldStart,
          oldLines: seed.oldLines,
          newStart: seed.newStart,
          newLines: seed.newLines,
          fileKind: seed.fileKind ?? null,
        })),
      }),
    );
    yield* writeJson(path.join(dir, RUN_FILES.tree), encodeTree({ paths: treePaths }));

    return { index, treePaths, lineCounts };
  });

  const storeContents = Effect.fn("workspace.storeContents")(function* (input: {
    readonly dir: string;
    readonly bare: string;
    readonly position: number;
    readonly file: FileChange;
    readonly oldPath: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly wantsOld: boolean;
    readonly wantsNew: boolean;
  }) {
    const write = (side: "old" | "new", rev: string, target: string) =>
      run(gitBytes(["-C", input.bare, "show", `${rev}:${target}`])).pipe(
        Effect.flatMap((bytes) =>
          fs
            .writeFile(path.join(input.dir, fileContentName(input.position, side)), bytes)
            .pipe(Effect.orDie, Effect.as(bytes)),
        ),
        Effect.option,
      );

    const oldBytes = input.wantsOld
      ? yield* write("old", input.baseSha, input.oldPath)
      : Option.none<Uint8Array>();
    const newBytes = input.wantsNew
      ? yield* write("new", input.headSha, input.file.path)
      : Option.none<Uint8Array>();

    const countLines = (bytes: Option.Option<Uint8Array>): number => {
      if (Option.isNone(bytes) || input.file.binary) return 0;
      return decodeLineCount(bytes.value);
    };

    return {
      hasOld: Option.isSome(oldBytes),
      hasNew: Option.isSome(newBytes),
      oldLineCount: countLines(oldBytes),
      newLineCount: countLines(newBytes),
      oldBytes: Option.isSome(oldBytes) ? oldBytes.value.length : null,
      newBytes: Option.isSome(newBytes) ? newBytes.value.length : null,
    };
  });

  const writeJson = (target: string, encoded: Effect.Effect<unknown, unknown>) =>
    encoded.pipe(
      Effect.flatMap((value) => fs.writeFileString(target, `${String(value)}\n`)),
      Effect.orDie,
    );

  const countFiles = (dir: string): Effect.Effect<number> =>
    fs.readDirectory(dir, { recursive: true }).pipe(
      Effect.map((entries) => entries.length),
      Effect.orElseSucceed(() => 0),
    );

  const readFileIndex = Effect.fn("workspace.readFileIndex")(function* (
    ref: PrRef,
    runId: string,
  ): Effect.fn.Return<ReadonlyArray<FileIndexEntry>, WorkspaceError> {
    const target = path.join(runDir(dataRoot, ref, runId), RUN_FILES.files);
    const raw = yield* fs.readFileString(target).pipe(
      Effect.mapError(
        () =>
          new WorkspaceMissingError({
            detail: `This journey's materialized diff is no longer on disk. Reanalyze the pull request to rebuild it.`,
          }),
      ),
    );
    const document = yield* decodeFileIndex(raw).pipe(
      Effect.mapError(
        () => new WorkspaceMissingError({ detail: "This journey's file index could not be read." }),
      ),
    );
    return document.files;
  });

  return {
    prepare,

    releaseWorktree: (ref, runId) =>
      Effect.gen(function* () {
        const worktree = worktreeDir(dataRoot, ref, runId);
        yield* fs.remove(worktree, { recursive: true, force: true }).pipe(Effect.ignore);
        yield* run(git(["-C", bareRepo(dataRoot, ref), "worktree", "prune"])).pipe(Effect.ignore);
      }),

    fileArtifacts: Effect.fn("workspace.fileArtifacts")(function* (ref, runId, target) {
      const files = yield* readFileIndex(ref, runId);
      const entry = files.find((file) => file.path === target || file.oldPath === target);
      if (entry === undefined) {
        return yield* new WorkspaceMissingError({
          detail: `${target} is not a changed file in this journey.`,
        });
      }
      const dir = runDir(dataRoot, ref, runId);
      const patch = yield* fs
        .readFileString(path.join(dir, perFilePatch(entry.index)))
        .pipe(Effect.orElseSucceed(() => ""));

      const readSide = (
        side: "old" | "new",
        present: boolean,
      ): Effect.Effect<Option.Option<Uint8Array>> =>
        present
          ? fs.readFile(path.join(dir, fileContentName(entry.index, side))).pipe(Effect.option)
          : Effect.succeedNone;

      const oldRaw = yield* readSide("old", entry.hasOld);
      const newRaw = yield* readSide("new", entry.hasNew);
      const asText = (bytes: Option.Option<Uint8Array>): string | null =>
        Option.isNone(bytes) || entry.binary ? null : new TextDecoder().decode(bytes.value);

      return {
        entry,
        patch,
        oldText: asText(oldRaw),
        newText: asText(newRaw),
        oldBytes: entry.binary && Option.isSome(oldRaw) ? oldRaw.value : null,
        newBytes: entry.binary && Option.isSome(newRaw) ? newRaw.value : null,
      };
    }),

    treePaths: Effect.fn("workspace.treePaths")(function* (ref, runId) {
      const target = path.join(runDir(dataRoot, ref, runId), RUN_FILES.tree);
      const raw = yield* fs.readFileString(target).pipe(
        Effect.mapError(
          () =>
            new WorkspaceMissingError({
              detail: "This journey's file tree is no longer on disk. Reanalyze to rebuild it.",
            }),
        ),
      );
      const document = yield* decodeTree(raw).pipe(
        Effect.mapError(
          () =>
            new WorkspaceMissingError({ detail: "This journey's file tree could not be read." }),
        ),
      );
      return document.paths;
    }),

    treeFile: Effect.fn("workspace.treeFile")(function* (ref, headSha, target) {
      const bare = yield* ensureRepo(ref);
      const bytes = yield* run(gitBytes(["-C", bare, "show", `${headSha}:${target}`])).pipe(
        Effect.catch(() =>
          // The workspace may have been evicted, or the blob may never have been
          // fetched (partial clone). Re-fetch the head and try once more.
          Effect.gen(function* () {
            yield* run(
              git([
                "-C",
                bare,
                "fetch",
                "--quiet",
                "--no-tags",
                "--force",
                "origin",
                `+refs/pull/${ref.number}/head:${prHeadRef(ref.number)}`,
              ]),
            ).pipe(Effect.ignore);
            return yield* run(gitBytes(["-C", bare, "show", `${headSha}:${target}`]));
          }),
        ),
        Effect.mapError(
          () =>
            new WorkspaceMissingError({
              detail: `${target} is not readable at this journey's pinned revision.`,
            }),
        ),
      );
      return new TextDecoder().decode(bytes);
    }),

    writeRunArtifact: (ref, runId, name, contents) =>
      Effect.gen(function* () {
        const dir = path.join(runDir(dataRoot, ref, runId), RUN_FILES.agentDir);
        yield* ensureDir(dir);
        yield* fs.writeFileString(path.join(dir, name), contents).pipe(Effect.ignore);
      }),

    appendFallbacks: (ref, runId, lines) =>
      Effect.gen(function* () {
        if (lines.length === 0) return;
        const dir = runDir(dataRoot, ref, runId);
        yield* ensureDir(dir);
        const target = path.join(dir, RUN_FILES.fallbacks);
        const existing = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => ""));
        yield* fs
          .writeFileString(target, `${existing}${lines.map((line) => `${line}\n`).join("")}`)
          .pipe(Effect.ignore);
      }),

    evictIfNeeded: Effect.gen(function* () {
      const root = path.join(dataRoot, "workspaces");
      const owners = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed((): string[] => []));
      const repos: Array<{ readonly dir: string; readonly lastUsed: number }> = [];
      for (const owner of owners) {
        const ownerDir = path.join(root, owner);
        const names = yield* fs
          .readDirectory(ownerDir)
          .pipe(Effect.orElseSucceed((): string[] => []));
        for (const name of names) {
          const dir = path.join(ownerDir, name);
          const stamp = yield* fs
            .readFileString(path.join(dir, ".last-used"))
            .pipe(Effect.orElseSucceed(() => "0"));
          repos.push({ dir, lastUsed: Number.parseInt(stamp, 10) || 0 });
        }
      }
      if (repos.length <= MAX_CACHED_REPOS) return;
      const doomed = repos
        .toSorted((left, right) => left.lastUsed - right.lastUsed)
        .slice(0, repos.length - MAX_CACHED_REPOS);
      for (const entry of doomed) {
        yield* Effect.logInfo("Evicting a repository clone", { dir: entry.dir });
        yield* fs.remove(entry.dir, { recursive: true, force: true }).pipe(Effect.ignore);
      }
    }),
  } satisfies Workspaces["Service"];
});

export const layer = Layer.effect(Workspaces, make);

// ── Pure helpers ────────────────────────────────────────────────────────────

/** git's empty tree object — the base when a PR shares no ancestor with its target. */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Split a multi-file patch into per-file chunks, keyed by the new path (and the
 * old path, so a rename resolves from either side). Splitting on the `diff --git`
 * boundary is exactly how `@pierre/diffs` splits patches, so the chunks it
 * receives are the chunks git wrote.
 */
export function splitPatchByFile(patch: string): ReadonlyMap<string, string> {
  const chunks = patch.split(/(?=^diff --git )/m).filter((chunk) => chunk.startsWith("diff --git"));
  const result = new Map<string, string>();
  for (const chunk of chunks) {
    const parsed = deriveDiffIndex(chunk);
    const file = parsed.files[0];
    if (file === undefined) continue;
    result.set(file.path, chunk);
    if (file.oldPath !== undefined) result.set(file.oldPath, chunk);
  }
  return result;
}

/** How many lines a blob has, counting a trailing newline as a terminator. */
export function decodeLineCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === 10) count += 1;
  // A file not ending in a newline still has that last partial line.
  return bytes[bytes.length - 1] === 10 ? count : count + 1;
}

/** `git ls-tree` quotes unusual paths the same way `diff --git` does. */
function unquote(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value;
  }
}
