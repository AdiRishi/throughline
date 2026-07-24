// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  CommitSha as CommitShaSchema,
  type CommitSha,
  type FileChange,
  type FileContent,
  type PrRef,
  RepositoryPath,
  type RepositoryPath as RepositoryPathValue,
  type SeedHunk,
} from "@app/contracts";
import { derivePatchFacts, type PatchFacts } from "@app/journey/hunks";

import * as ServerConfig from "../config.ts";
import {
  type ContentManifestDocument,
  type ContentManifestEntry,
  decodeContentManifestDocument,
  decodePatchManifestDocument,
  decodeRunDocument,
  decodeTreeDocument,
  type PatchManifestDocument,
  type PatchManifestEntry,
  type RunDocument,
} from "./artifacts.ts";
import * as GitProcess from "./GitProcess.ts";
import * as CloneAccess from "./WorkspaceCloneAccess.ts";

const SafeSegment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u)).check(
  Schema.makeFilter((value) => value !== "." && value !== ".."),
);
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodeSafeSegment = Schema.decodeUnknownEffect(SafeSegment);
const decodeRepositoryPath = Schema.decodeUnknownEffect(RepositoryPath);
const decodeNonNegativeInteger = Schema.decodeUnknownEffect(NonNegativeInteger);
const isSafeSegment = Schema.is(SafeSegment);
const isCommitSha = Schema.is(CommitShaSchema);

const textDecoder = new TextDecoder();
const strictTextDecoder = new TextDecoder("utf-8", { fatal: true });

const DIFF_OPTIONS = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--default-prefix",
  "--no-indent-heuristic",
  "--diff-algorithm=myers",
  "--unified=0",
  "--inter-hunk-context=0",
  "--find-renames=50%",
  "--binary",
  "--full-index",
  "--submodule=short",
  "--ignore-submodules=none",
  "-l1000",
] as const;

export const DETERMINISTIC_DIFF_OPTIONS: ReadonlyArray<string> = DIFF_OPTIONS;

export interface WorkspaceRunRef {
  readonly pr: PrRef;
  readonly runId: string;
}

export interface PrepareWorkspaceInput extends WorkspaceRunRef {
  readonly baseTipSha: CommitSha;
  readonly headSha: CommitSha;
}

interface PinnedWorkspace extends WorkspaceRunRef {
  readonly baseSha: CommitSha;
  readonly headSha: CommitSha;
}

export interface PreparedWorkspace extends PinnedWorkspace {
  readonly stagingRunDir: string;
  readonly finalRunDir: string;
  readonly worldDir: string;
  readonly repositoryDir: string;
  readonly inputsDir: string;
  readonly files: ReadonlyArray<FileChange>;
  readonly hunks: ReadonlyArray<SeedHunk>;
  readonly tree: ReadonlyArray<RepositoryPathValue>;
}

export interface CommittedWorkspace extends PinnedWorkspace {
  readonly runDir: string;
  readonly inputsDir: string;
}

export class WorkspaceError extends Schema.TaggedErrorClass<WorkspaceError>()("WorkspaceError", {
  reason: Schema.Literals([
    "invalid-input",
    "credentials",
    "git-unavailable",
    "git-failed",
    "io",
    "pinned-head-mismatch",
    "run-exists",
    "artifact-not-found",
    "artifact-corrupt",
  ]),
  detail: Schema.String,
}) {}

export class Workspaces extends Context.Service<
  Workspaces,
  {
    readonly prepare: (
      input: PrepareWorkspaceInput,
    ) => Effect.Effect<PreparedWorkspace, WorkspaceError>;
    readonly finalize: (
      prepared: PreparedWorkspace,
    ) => Effect.Effect<CommittedWorkspace, WorkspaceError>;
    readonly abandon: (prepared: PreparedWorkspace) => Effect.Effect<void, WorkspaceError>;
    readonly reapFailedRuns: (pr: PrRef) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
    readonly filePatch: (
      run: WorkspaceRunRef,
      path: RepositoryPathValue,
    ) => Effect.Effect<string | null, WorkspaceError>;
    readonly fileContent: (
      run: WorkspaceRunRef,
      path: RepositoryPathValue,
    ) => Effect.Effect<FileContent, WorkspaceError>;
    readonly tree: (
      run: WorkspaceRunRef,
    ) => Effect.Effect<ReadonlyArray<RepositoryPathValue>, WorkspaceError>;
    readonly evictCache: (
      maxRepositories: number,
    ) => Effect.Effect<ReadonlyArray<string>, WorkspaceError>;
    readonly removeRun: (run: WorkspaceRunRef) => Effect.Effect<void, WorkspaceError>;
  }
>()("@app/server/workspace/Workspaces") {}

interface RepositoryPaths {
  readonly key: string;
  readonly root: string;
  readonly bare: string;
  readonly accessMarker: string;
}

interface RunPaths {
  readonly repository: RepositoryPaths;
  readonly parent: string;
  readonly staging: string;
  readonly final: string;
  readonly world: string;
  readonly worktree: string;
  readonly inputs: string;
}

interface BlobSide {
  readonly bytes: Uint8Array | null;
  readonly size: number | null;
}

interface ImageSide extends BlobSide {
  readonly mediaType: string | null;
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceError = (reason: WorkspaceError["reason"], detail: string): WorkspaceError =>
  new WorkspaceError({ reason, detail });

const fromIo = (operation: string) => (error: unknown) =>
  workspaceError("io", `${operation}: ${detailOf(error)}`);

const parseJson = (raw: string, file: string) =>
  Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (error) =>
      workspaceError("artifact-corrupt", `${file} is not valid JSON: ${detailOf(error)}`),
  });

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const fileKey = (index: number): string => `f${String(index + 1).padStart(6, "0")}`;

const splitPatch = (patch: string): ReadonlyArray<string> => {
  const starts = [...patch.matchAll(/^diff --git /gmu)].map((match) => match.index);
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
};

const imageMediaType = (bytes: Uint8Array): string | null => {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const signature = textDecoder.decode(bytes.slice(0, 6));
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    textDecoder.decode(bytes.slice(0, 4)) === "RIFF" &&
    textDecoder.decode(bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
};

const isText = (bytes: Uint8Array): boolean => {
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) {
      return false;
    }
  }

  try {
    strictTextDecoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitProcess.GitProcess;
  const cloneAccess = yield* CloneAccess.WorkspaceCloneAccess;
  const mutex = yield* Semaphore.make(1);
  const activeRuns = new Map<string, string>();

  const validateSegment = Effect.fn("Workspaces.validateSegment")(function* (
    value: string,
    label: string,
  ) {
    return yield* decodeSafeSegment(value).pipe(
      Effect.mapError(() =>
        workspaceError("invalid-input", `${label} is not a safe path segment.`),
      ),
    );
  });

  const validateRepositoryPath = Effect.fn("Workspaces.validateRepositoryPath")(function* (
    value: string,
  ) {
    return yield* decodeRepositoryPath(value).pipe(
      Effect.mapError(() =>
        workspaceError("invalid-input", `${JSON.stringify(value)} is not a safe repository path.`),
      ),
    );
  });

  const repositoryPaths = Effect.fn("Workspaces.repositoryPaths")(function* (pr: PrRef) {
    const owner = yield* validateSegment(pr.owner, "owner");
    const repo = yield* validateSegment(pr.repo, "repository");
    const root = path.join(config.dataDir, "workspaces", owner, repo);
    return {
      key: `${owner}/${repo}`,
      root,
      bare: path.join(root, "repository.git"),
      accessMarker: path.join(root, ".last-access"),
    } satisfies RepositoryPaths;
  });

  const runPaths = Effect.fn("Workspaces.runPaths")(function* (run: WorkspaceRunRef) {
    const repository = yield* repositoryPaths(run.pr);
    const runId = yield* validateSegment(run.runId, "runId");
    const parent = path.join(
      config.dataDir,
      "runs",
      run.pr.owner,
      run.pr.repo,
      String(run.pr.number),
    );
    const staging = path.join(parent, `.staging-${runId}`);
    const final = path.join(parent, runId);
    const world = path.join(staging, "world");
    return {
      repository,
      parent,
      staging,
      final,
      world,
      worktree: path.join(world, "repository"),
      inputs: path.join(world, "inputs"),
    } satisfies RunPaths;
  });

  const accessFor = Effect.fn("Workspaces.accessFor")(function* (pr: PrRef) {
    return yield* cloneAccess
      .get({ owner: pr.owner, repo: pr.repo })
      .pipe(Effect.mapError((error) => workspaceError("credentials", error.detail)));
  });

  const runGit = Effect.fn("Workspaces.runGit")(function* (
    args: ReadonlyArray<string>,
    options?: {
      readonly cwd?: string | undefined;
      readonly environment?: Readonly<Record<string, string>> | undefined;
    },
  ) {
    return yield* git
      .run({ args, ...options })
      .pipe(
        Effect.mapError((error) =>
          workspaceError(
            error.reason === "unavailable" ? "git-unavailable" : "git-failed",
            error.detail,
          ),
        ),
      );
  });

  const expectGit = Effect.fn("Workspaces.expectGit")(function* (
    args: ReadonlyArray<string>,
    options?: {
      readonly cwd?: string | undefined;
      readonly environment?: Readonly<Record<string, string>> | undefined;
    },
  ) {
    const result = yield* runGit(args, options);
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim();
      return yield* workspaceError(
        "git-failed",
        `git ${args[0] ?? ""} exited with ${result.exitCode}${stderr.length === 0 ? "" : `: ${stderr}`}`,
      );
    }
    return result;
  });

  const touchRepository = (repository: RepositoryPaths) =>
    fileSystem
      .writeFileString(repository.accessMarker, "")
      .pipe(Effect.mapError(fromIo(`touch ${repository.accessMarker}`)));

  const ensureClone = Effect.fn("Workspaces.ensureClone")(function* (
    repository: RepositoryPaths,
    access: CloneAccess.CloneAccess,
  ) {
    const validClone = yield* fileSystem
      .exists(path.join(repository.bare, "HEAD"))
      .pipe(Effect.mapError(fromIo(`inspect ${repository.bare}`)));
    if (validClone) {
      yield* expectGit(
        ["--git-dir", repository.bare, "remote", "set-url", "origin", access.remoteUrl],
        { environment: access.environment },
      );
      yield* touchRepository(repository);
      return;
    }

    yield* fileSystem
      .makeDirectory(repository.root, { recursive: true })
      .pipe(Effect.mapError(fromIo(`create ${repository.root}`)));
    const temporary = path.join(repository.root, ".repository.git.clone");
    yield* fileSystem
      .remove(temporary, { recursive: true, force: true })
      .pipe(Effect.mapError(fromIo(`remove ${temporary}`)));
    yield* fileSystem
      .remove(repository.bare, { recursive: true, force: true })
      .pipe(Effect.mapError(fromIo(`remove ${repository.bare}`)));

    yield* expectGit(
      ["clone", "--bare", "--filter=blob:none", "--no-tags", access.remoteUrl, temporary],
      { environment: access.environment },
    ).pipe(
      Effect.onError(() =>
        fileSystem.remove(temporary, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
    yield* fileSystem
      .rename(temporary, repository.bare)
      .pipe(Effect.mapError(fromIo(`finalize clone ${repository.bare}`)));
    yield* touchRepository(repository);
  });

  const fetchPinnedCommits = Effect.fn("Workspaces.fetchPinnedCommits")(function* (
    input: PrepareWorkspaceInput,
    repository: RepositoryPaths,
    access: CloneAccess.CloneAccess,
  ) {
    const pullRef = `refs/throughline/pulls/${input.pr.number}/head`;
    const baseRef = `refs/throughline/bases/${input.baseTipSha}`;
    yield* expectGit(
      [
        "--git-dir",
        repository.bare,
        "fetch",
        "--no-tags",
        "--force",
        "origin",
        `+refs/pull/${input.pr.number}/head:${pullRef}`,
        `+${input.baseTipSha}:${baseRef}`,
      ],
      { environment: access.environment },
    );

    const resolvedHead = textDecoder
      .decode(
        (yield* expectGit(["--git-dir", repository.bare, "rev-parse", `${pullRef}^{commit}`], {
          environment: access.environment,
        })).stdout,
      )
      .trim()
      .toLowerCase();
    if (resolvedHead !== input.headSha.toLowerCase()) {
      return yield* workspaceError(
        "pinned-head-mismatch",
        `Expected PR head ${input.headSha}, but refs/pull/${input.pr.number}/head resolved to ${resolvedHead}.`,
      );
    }
    const mergeBase = textDecoder
      .decode(
        (yield* expectGit(
          [
            "--git-dir",
            repository.bare,
            "merge-base",
            `${baseRef}^{commit}`,
            `${pullRef}^{commit}`,
          ],
          { environment: access.environment },
        )).stdout,
      )
      .trim()
      .toLowerCase();
    if (!isCommitSha(mergeBase)) {
      return yield* workspaceError(
        "git-failed",
        `git merge-base did not produce a commit SHA: ${JSON.stringify(mergeBase)}`,
      );
    }
    yield* touchRepository(repository);
    return mergeBase;
  });

  const removeWorktree = Effect.fn("Workspaces.removeWorktree")(function* (
    repository: RepositoryPaths,
    worktree: string,
    strict: boolean,
  ) {
    const result = yield* runGit([
      "--git-dir",
      repository.bare,
      "worktree",
      "remove",
      "--force",
      worktree,
    ]);
    if (strict && result.exitCode !== 0) {
      const exists = yield* fileSystem
        .exists(worktree)
        .pipe(Effect.mapError(fromIo(`inspect ${worktree}`)));
      if (exists) {
        const stderr = result.stderr.trim();
        return yield* workspaceError(
          "git-failed",
          `Could not remove worktree ${worktree}${stderr.length === 0 ? "" : `: ${stderr}`}`,
        );
      }
    }
    yield* runGit(["--git-dir", repository.bare, "worktree", "prune", "--expire=now"]).pipe(
      Effect.ignore,
    );
  });

  const reapFailedRunsInternal = Effect.fn("Workspaces.reapFailedRunsInternal")(function* (
    pr: PrRef,
  ) {
    const probe = yield* runPaths({ pr, runId: "probe" });
    const exists = yield* fileSystem
      .exists(probe.parent)
      .pipe(Effect.mapError(fromIo(`inspect ${probe.parent}`)));
    if (!exists) return [] as ReadonlyArray<string>;

    const names = yield* fileSystem
      .readDirectory(probe.parent)
      .pipe(Effect.mapError(fromIo(`list ${probe.parent}`)));
    const reaped: string[] = [];
    for (const name of names.toSorted(comparePaths)) {
      if (!name.startsWith(".staging-")) continue;
      const staging = path.join(probe.parent, name);
      if (activeRuns.has(staging)) continue;
      const worktree = path.join(staging, "world", "repository");
      const bareExists = yield* fileSystem
        .exists(probe.repository.bare)
        .pipe(Effect.mapError(fromIo(`inspect ${probe.repository.bare}`)));
      if (bareExists) {
        yield* removeWorktree(probe.repository, worktree, false);
      }
      yield* fileSystem
        .remove(staging, { recursive: true, force: true })
        .pipe(Effect.mapError(fromIo(`remove ${staging}`)));
      reaped.push(staging);
    }
    return reaped;
  });

  const deriveFacts = (patchText: string) =>
    Effect.try({
      try: () => derivePatchFacts(patchText),
      catch: (error) =>
        workspaceError("invalid-input", `Git produced an unsafe patch: ${detailOf(error)}`),
    });

  const readTree = Effect.fn("Workspaces.readTree")(function* (
    repository: RepositoryPaths,
    headSha: CommitSha,
    environment: Readonly<Record<string, string>> | undefined,
  ) {
    const output = yield* expectGit(
      ["--git-dir", repository.bare, "ls-tree", "-r", "-z", "--name-only", headSha],
      { environment },
    );
    const names = textDecoder
      .decode(output.stdout)
      .split("\0")
      .filter((name) => name.length > 0);
    const decoded: RepositoryPathValue[] = [];
    for (const name of names) {
      decoded.push(yield* validateRepositoryPath(name));
    }
    return decoded.toSorted(comparePaths);
  });

  const readBlob = Effect.fn("Workspaces.readBlob")(function* (
    repository: RepositoryPaths,
    revision: CommitSha,
    repositoryPath: RepositoryPathValue,
    mode: string | null,
    environment: Readonly<Record<string, string>> | undefined,
  ): Effect.fn.Return<BlobSide, WorkspaceError> {
    if (mode === "160000") return { bytes: null, size: null };
    const result = yield* expectGit(
      ["--git-dir", repository.bare, "cat-file", "blob", `${revision}:${repositoryPath}`],
      { environment },
    );
    return { bytes: result.stdout, size: result.stdout.byteLength };
  });

  const materializeContent = Effect.fn("Workspaces.materializeContent")(function* (
    input: PinnedWorkspace,
    repository: RepositoryPaths,
    inputs: string,
    files: ReadonlyArray<FileChange>,
    environment: Readonly<Record<string, string>> | undefined,
  ) {
    const contentDirectory = path.join(inputs, "content");
    yield* fileSystem
      .makeDirectory(contentDirectory, { recursive: true })
      .pipe(Effect.mapError(fromIo(`create ${contentDirectory}`)));
    const entries: ContentManifestEntry[] = [];

    for (const [index, file] of files.entries()) {
      const key = fileKey(index);
      const oldPath = file.kind === "added" ? null : (file.oldPath ?? file.path);
      const newPath = file.kind === "deleted" ? null : file.path;
      const oldSide =
        oldPath === null
          ? null
          : yield* readBlob(repository, input.baseSha, oldPath, file.oldMode, environment);
      const newSide =
        newPath === null
          ? null
          : yield* readBlob(repository, input.headSha, newPath, file.newMode, environment);
      const existing = [oldSide, newSide].filter((side): side is BlobSide => side !== null);
      const imageSides: ReadonlyArray<ImageSide> = existing.map((side) => ({
        ...side,
        mediaType: side.bytes === null ? null : imageMediaType(side.bytes),
      }));
      const allImages =
        imageSides.length > 0 &&
        imageSides.every((side) => side.bytes !== null && side.mediaType !== null);
      const allText =
        existing.length > 0 && existing.every((side) => side.bytes !== null && isText(side.bytes));

      if (allImages) {
        const oldFile = oldSide === null ? null : `${key}.old`;
        const newFile = newSide === null ? null : `${key}.new`;
        if (oldFile !== null && oldSide !== null && oldSide.bytes !== null) {
          yield* fileSystem
            .writeFile(path.join(contentDirectory, oldFile), oldSide.bytes)
            .pipe(Effect.mapError(fromIo(`write ${oldFile}`)));
        }
        if (newFile !== null && newSide !== null && newSide.bytes !== null) {
          yield* fileSystem
            .writeFile(path.join(contentDirectory, newFile), newSide.bytes)
            .pipe(Effect.mapError(fromIo(`write ${newFile}`)));
        }
        entries.push({
          type: "image",
          path: file.path,
          oldFile,
          oldMediaType:
            oldSide?.bytes === undefined || oldSide.bytes === null
              ? null
              : imageMediaType(oldSide.bytes),
          newFile,
          newMediaType:
            newSide?.bytes === undefined || newSide.bytes === null
              ? null
              : imageMediaType(newSide.bytes),
        });
        continue;
      }

      if (allText) {
        const oldFile = oldSide === null ? null : `${key}.old`;
        const newFile = newSide === null ? null : `${key}.new`;
        if (oldFile !== null && oldSide !== null && oldSide.bytes !== null) {
          yield* fileSystem
            .writeFile(path.join(contentDirectory, oldFile), oldSide.bytes)
            .pipe(Effect.mapError(fromIo(`write ${oldFile}`)));
        }
        if (newFile !== null && newSide !== null && newSide.bytes !== null) {
          yield* fileSystem
            .writeFile(path.join(contentDirectory, newFile), newSide.bytes)
            .pipe(Effect.mapError(fromIo(`write ${newFile}`)));
        }
        entries.push({
          type: "text",
          path: file.path,
          oldFile,
          newFile,
        });
        continue;
      }

      entries.push({
        type: "binary",
        path: file.path,
        oldSize: oldSide?.size ?? null,
        newSize: newSide?.size ?? null,
      });
    }

    const document: ContentManifestDocument = { version: 1, entries };
    yield* fileSystem
      .writeFileString(path.join(inputs, "contents.json"), json(document))
      .pipe(Effect.mapError(fromIo("write contents.json")));
  });

  const materialize = Effect.fn("Workspaces.materialize")(function* (
    input: PinnedWorkspace,
    paths: RunPaths,
    access: CloneAccess.CloneAccess,
  ) {
    const orderFile = path.join(paths.inputs, ".diff-order");
    yield* fileSystem
      .writeFileString(orderFile, "")
      .pipe(Effect.mapError(fromIo(`write ${orderFile}`)));
    const diffResult = yield* expectGit(
      [
        "--git-dir",
        paths.repository.bare,
        "-c",
        "color.ui=false",
        "-c",
        "core.quotePath=true",
        "-c",
        "diff.interHunkContext=0",
        "diff",
        ...DIFF_OPTIONS,
        "-O",
        orderFile,
        `${input.baseSha}..${input.headSha}`,
        "--",
      ],
      { environment: access.environment },
    );
    yield* fileSystem
      .remove(orderFile, { force: true })
      .pipe(Effect.mapError(fromIo(`remove ${orderFile}`)));
    const fullPatch = textDecoder.decode(diffResult.stdout);
    const facts = yield* deriveFacts(fullPatch);
    const tree = yield* readTree(paths.repository, input.headSha, access.environment);

    const diffDirectory = path.join(paths.inputs, "diff");
    const byFileDirectory = path.join(diffDirectory, "by-file");
    yield* fileSystem
      .makeDirectory(byFileDirectory, { recursive: true })
      .pipe(Effect.mapError(fromIo(`create ${byFileDirectory}`)));
    yield* fileSystem
      .writeFileString(path.join(diffDirectory, "full.patch"), fullPatch)
      .pipe(Effect.mapError(fromIo("write full.patch")));

    const patches = new Map<string, string>();
    for (const block of splitPatch(fullPatch)) {
      const blockFacts = yield* deriveFacts(block);
      const file = blockFacts.files[0];
      if (blockFacts.files.length !== 1 || file === undefined) {
        return yield* workspaceError(
          "artifact-corrupt",
          "A file patch did not describe exactly one changed file.",
        );
      }
      if (patches.has(file.path)) {
        return yield* workspaceError(
          "artifact-corrupt",
          `Git emitted more than one patch block for ${file.path}.`,
        );
      }
      patches.set(file.path, block);
    }

    const patchEntries: PatchManifestEntry[] = [];
    for (const [index, file] of facts.files.entries()) {
      const block = patches.get(file.path);
      if (block === undefined) {
        return yield* workspaceError(
          "artifact-corrupt",
          `Git did not emit a per-file patch for ${file.path}.`,
        );
      }
      const key = fileKey(index);
      const patchFile = `diff/by-file/${key}.patch`;
      yield* fileSystem
        .writeFileString(path.join(byFileDirectory, `${key}.patch`), block)
        .pipe(Effect.mapError(fromIo(`write ${patchFile}`)));
      patchEntries.push({
        key,
        path: file.path,
        oldPath: file.oldPath,
        patchFile,
      });
    }

    const patchManifest: PatchManifestDocument = {
      version: 1,
      entries: patchEntries,
    };
    const runDocument: RunDocument = {
      version: 1,
      pr: input.pr,
      runId: input.runId,
      baseSha: input.baseSha,
      headSha: input.headSha,
    };
    yield* fileSystem
      .writeFileString(path.join(paths.inputs, "patches.json"), json(patchManifest))
      .pipe(Effect.mapError(fromIo("write patches.json")));
    yield* fileSystem
      .writeFileString(
        path.join(paths.inputs, "files.json"),
        json({ version: 1, files: facts.files }),
      )
      .pipe(Effect.mapError(fromIo("write files.json")));
    yield* fileSystem
      .writeFileString(
        path.join(paths.inputs, "hunks.json"),
        json({ version: 1, hunks: facts.hunks }),
      )
      .pipe(Effect.mapError(fromIo("write hunks.json")));
    yield* fileSystem
      .writeFileString(path.join(paths.inputs, "tree.json"), json({ version: 1, paths: tree }))
      .pipe(Effect.mapError(fromIo("write tree.json")));
    yield* fileSystem
      .writeFileString(path.join(paths.inputs, "run.json"), json(runDocument))
      .pipe(Effect.mapError(fromIo("write run.json")));
    yield* materializeContent(
      input,
      paths.repository,
      paths.inputs,
      facts.files,
      access.environment,
    );

    return { facts, tree } satisfies {
      readonly facts: PatchFacts;
      readonly tree: ReadonlyArray<RepositoryPathValue>;
    };
  });

  const readArtifact = Effect.fn("Workspaces.readArtifact")(function* (
    run: WorkspaceRunRef,
    file: string,
  ) {
    const paths = yield* runPaths(run);
    const artifact = path.join(paths.final, "world", "inputs", file);
    const exists = yield* fileSystem
      .exists(artifact)
      .pipe(Effect.mapError(fromIo(`inspect ${artifact}`)));
    if (!exists) {
      return yield* workspaceError("artifact-not-found", `No artifact exists at ${file}.`);
    }
    return yield* fileSystem
      .readFileString(artifact)
      .pipe(Effect.mapError(fromIo(`read ${artifact}`)));
  });

  const readJsonArtifact = Effect.fn("Workspaces.readJsonArtifact")(function* (
    run: WorkspaceRunRef,
    file: string,
  ) {
    const raw = yield* readArtifact(run, file);
    return yield* parseJson(raw, file);
  });

  const loadPatchManifest = Effect.fn("Workspaces.loadPatchManifest")(function* (
    run: WorkspaceRunRef,
  ) {
    const value = yield* readJsonArtifact(run, "patches.json");
    return yield* decodePatchManifestDocument(value).pipe(
      Effect.mapError((error) =>
        workspaceError("artifact-corrupt", `patches.json: ${error.message}`),
      ),
    );
  });

  const loadContentManifest = Effect.fn("Workspaces.loadContentManifest")(function* (
    run: WorkspaceRunRef,
  ) {
    const value = yield* readJsonArtifact(run, "contents.json");
    return yield* decodeContentManifestDocument(value).pipe(
      Effect.mapError((error) =>
        workspaceError("artifact-corrupt", `contents.json: ${error.message}`),
      ),
    );
  });

  const loadTree = Effect.fn("Workspaces.loadTree")(function* (run: WorkspaceRunRef) {
    const value = yield* readJsonArtifact(run, "tree.json");
    const document = yield* decodeTreeDocument(value).pipe(
      Effect.mapError((error) => workspaceError("artifact-corrupt", `tree.json: ${error.message}`)),
    );
    return document.paths;
  });

  const loadRun = Effect.fn("Workspaces.loadRun")(function* (run: WorkspaceRunRef) {
    const value = yield* readJsonArtifact(run, "run.json");
    return yield* decodeRunDocument(value).pipe(
      Effect.mapError((error) => workspaceError("artifact-corrupt", `run.json: ${error.message}`)),
    );
  });

  const readStoredContent = Effect.fn("Workspaces.readStoredContent")(function* (
    run: WorkspaceRunRef,
    entry: ContentManifestEntry,
  ): Effect.fn.Return<FileContent, WorkspaceError> {
    const paths = yield* runPaths(run);
    const contentDirectory = path.join(paths.final, "world", "inputs", "content");
    if (entry.type === "binary") {
      return {
        type: "binary",
        path: entry.path,
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      };
    }

    const readSide = (file: string | null) =>
      file === null
        ? Effect.succeed(null)
        : fileSystem
            .readFile(path.join(contentDirectory, file))
            .pipe(
              Effect.mapError(fromIo(`read content/${file}`)),
              Effect.map(Option.some),
              Effect.map(Option.getOrNull),
            );
    const oldBytes = yield* readSide(entry.oldFile);
    const newBytes = yield* readSide(entry.newFile);
    if (entry.type === "text") {
      const decodeText = (bytes: Uint8Array, side: string) =>
        Effect.try({
          try: () => strictTextDecoder.decode(bytes),
          catch: (error) =>
            workspaceError(
              "artifact-corrupt",
              `${entry.path} ${side} content is not UTF-8: ${detailOf(error)}`,
            ),
        });
      return {
        type: "text",
        path: entry.path,
        old: oldBytes === null ? null : yield* decodeText(oldBytes, "old"),
        new: newBytes === null ? null : yield* decodeText(newBytes, "new"),
      };
    }
    return {
      type: "image",
      path: entry.path,
      oldMediaType: entry.oldMediaType,
      oldBase64: oldBytes === null ? null : NodeBuffer.Buffer.from(oldBytes).toString("base64"),
      newMediaType: entry.newMediaType,
      newBase64: newBytes === null ? null : NodeBuffer.Buffer.from(newBytes).toString("base64"),
    };
  });

  const ensureCommit = Effect.fn("Workspaces.ensureCommit")(function* (
    runDocument: RunDocument,
    repository: RepositoryPaths,
    access: CloneAccess.CloneAccess,
  ) {
    const present = yield* runGit(
      ["--git-dir", repository.bare, "cat-file", "-e", `${runDocument.headSha}^{commit}`],
      { environment: access.environment },
    );
    if (present.exitCode === 0) return;
    yield* expectGit(
      [
        "--git-dir",
        repository.bare,
        "fetch",
        "--no-tags",
        "--force",
        "origin",
        `+${runDocument.headSha}:refs/throughline/commits/${runDocument.headSha}`,
      ],
      { environment: access.environment },
    );
  });

  const readUnchangedContent = Effect.fn("Workspaces.readUnchangedContent")(function* (
    run: WorkspaceRunRef,
    repositoryPath: RepositoryPathValue,
  ): Effect.fn.Return<FileContent, WorkspaceError> {
    const runDocument = yield* loadRun(run);
    const paths = yield* runPaths(run);
    const access = yield* accessFor(run.pr);
    yield* ensureClone(paths.repository, access);
    yield* ensureCommit(runDocument, paths.repository, access);
    const treeEntry = yield* expectGit(
      [
        "--git-dir",
        paths.repository.bare,
        "ls-tree",
        "-z",
        runDocument.headSha,
        "--",
        repositoryPath,
      ],
      { environment: access.environment },
    );
    const mode = /^([0-9]{6}) /u.exec(textDecoder.decode(treeEntry.stdout))?.[1] ?? null;
    const side = yield* readBlob(
      paths.repository,
      runDocument.headSha,
      repositoryPath,
      mode,
      access.environment,
    );
    yield* touchRepository(paths.repository);
    if (side.bytes === null) {
      return {
        type: "binary",
        path: repositoryPath,
        oldSize: null,
        newSize: null,
      };
    }
    const mediaType = imageMediaType(side.bytes);
    if (mediaType !== null) {
      return {
        type: "image",
        path: repositoryPath,
        oldMediaType: null,
        oldBase64: null,
        newMediaType: mediaType,
        newBase64: NodeBuffer.Buffer.from(side.bytes).toString("base64"),
      };
    }
    if (isText(side.bytes)) {
      return {
        type: "text",
        path: repositoryPath,
        old: null,
        new: strictTextDecoder.decode(side.bytes),
      };
    }
    return {
      type: "binary",
      path: repositoryPath,
      oldSize: null,
      newSize: side.size,
    };
  });

  const prepare = Effect.fn("Workspaces.prepare")(function* (input: PrepareWorkspaceInput) {
    const paths = yield* runPaths(input);
    yield* reapFailedRunsInternal(input.pr);
    const finalExists = yield* fileSystem
      .exists(paths.final)
      .pipe(Effect.mapError(fromIo(`inspect ${paths.final}`)));
    if (finalExists) {
      return yield* workspaceError(
        "run-exists",
        `Run ${input.runId} already exists for ${input.pr.owner}/${input.pr.repo}#${input.pr.number}.`,
      );
    }
    const access = yield* accessFor(input.pr);
    yield* ensureClone(paths.repository, access);
    const baseSha = yield* fetchPinnedCommits(input, paths.repository, access);
    const pinned = {
      pr: input.pr,
      runId: input.runId,
      baseSha,
      headSha: input.headSha,
    } satisfies PinnedWorkspace;
    yield* fileSystem
      .makeDirectory(paths.inputs, { recursive: true })
      .pipe(Effect.mapError(fromIo(`create ${paths.inputs}`)));
    activeRuns.set(paths.staging, paths.repository.key);

    const prepared = yield* Effect.gen(function* () {
      yield* expectGit(
        [
          "--git-dir",
          paths.repository.bare,
          "worktree",
          "add",
          "--detach",
          "--force",
          paths.worktree,
          input.headSha,
        ],
        { environment: access.environment },
      );
      const materialized = yield* materialize(pinned, paths, access);
      return {
        ...pinned,
        stagingRunDir: paths.staging,
        finalRunDir: paths.final,
        worldDir: paths.world,
        repositoryDir: paths.worktree,
        inputsDir: paths.inputs,
        files: materialized.facts.files,
        hunks: materialized.facts.hunks,
        tree: materialized.tree,
      } satisfies PreparedWorkspace;
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          activeRuns.delete(paths.staging);
        }),
      ),
    );

    return prepared;
  });

  const finalize = Effect.fn("Workspaces.finalize")(function* (prepared: PreparedWorkspace) {
    const paths = yield* runPaths(prepared);
    if (
      prepared.stagingRunDir !== paths.staging ||
      prepared.finalRunDir !== paths.final ||
      prepared.repositoryDir !== paths.worktree
    ) {
      return yield* workspaceError(
        "invalid-input",
        "Prepared workspace paths do not belong to the requested run.",
      );
    }
    const finalExists = yield* fileSystem
      .exists(paths.final)
      .pipe(Effect.mapError(fromIo(`inspect ${paths.final}`)));
    if (finalExists) {
      return yield* workspaceError("run-exists", `Run ${prepared.runId} already exists.`);
    }
    yield* removeWorktree(paths.repository, paths.worktree, true);
    yield* fileSystem
      .rename(paths.staging, paths.final)
      .pipe(Effect.mapError(fromIo(`finalize ${paths.final}`)));
    activeRuns.delete(paths.staging);
    return {
      pr: prepared.pr,
      runId: prepared.runId,
      baseSha: prepared.baseSha,
      headSha: prepared.headSha,
      runDir: paths.final,
      inputsDir: path.join(paths.final, "world", "inputs"),
    } satisfies CommittedWorkspace;
  });

  const filePatch = Effect.fn("Workspaces.filePatch")(function* (
    run: WorkspaceRunRef,
    requestedPath: RepositoryPathValue,
  ) {
    const repositoryPath = yield* validateRepositoryPath(requestedPath);
    const manifest = yield* loadPatchManifest(run);
    const entry = manifest.entries.find((candidate) => candidate.path === repositoryPath);
    if (entry === undefined) {
      const tree = yield* loadTree(run);
      if (tree.includes(repositoryPath)) return null;
      return yield* workspaceError("artifact-not-found", `${repositoryPath} does not exist.`);
    }
    return yield* readArtifact(run, entry.patchFile);
  });

  const fileContent = Effect.fn("Workspaces.fileContent")(function* (
    run: WorkspaceRunRef,
    requestedPath: RepositoryPathValue,
  ) {
    const repositoryPath = yield* validateRepositoryPath(requestedPath);
    const manifest = yield* loadContentManifest(run);
    const entry = manifest.entries.find((candidate) => candidate.path === repositoryPath);
    if (entry !== undefined) return yield* readStoredContent(run, entry);

    const tree = yield* loadTree(run);
    if (!tree.includes(repositoryPath)) {
      return yield* workspaceError(
        "artifact-not-found",
        `${repositoryPath} does not exist at the pinned head.`,
      );
    }
    return yield* mutex.withPermit(readUnchangedContent(run, repositoryPath));
  });

  const evictCache = Effect.fn("Workspaces.evictCache")(function* (maxRepositories: number) {
    const maximum = yield* decodeNonNegativeInteger(maxRepositories).pipe(
      Effect.mapError(() =>
        workspaceError("invalid-input", "maxRepositories must be a non-negative integer."),
      ),
    );
    const root = path.join(config.dataDir, "workspaces");
    const rootExists = yield* fileSystem
      .exists(root)
      .pipe(Effect.mapError(fromIo(`inspect ${root}`)));
    if (!rootExists) return [] as ReadonlyArray<string>;
    const owners = yield* fileSystem
      .readDirectory(root)
      .pipe(Effect.mapError(fromIo(`list ${root}`)));
    const candidates: Array<{
      readonly key: string;
      readonly root: string;
      readonly bare: string;
      readonly lastAccess: number;
    }> = [];
    for (const owner of owners) {
      if (!isSafeSegment(owner)) continue;
      const ownerRoot = path.join(root, owner);
      const repositories = yield* fileSystem
        .readDirectory(ownerRoot)
        .pipe(Effect.orElseSucceed(() => []));
      for (const repo of repositories) {
        if (!isSafeSegment(repo)) continue;
        const repositoryRoot = path.join(ownerRoot, repo);
        const bare = path.join(repositoryRoot, "repository.git");
        const exists = yield* fileSystem
          .exists(path.join(bare, "HEAD"))
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) continue;
        const marker = path.join(repositoryRoot, ".last-access");
        const info = yield* fileSystem.stat(marker).pipe(Effect.option);
        const lastAccess = Option.match(info, {
          onNone: () => 0,
          onSome: (value) =>
            Option.match(value.mtime, {
              onNone: () => 0,
              onSome: (date) => date.getTime(),
            }),
        });
        candidates.push({
          key: `${owner}/${repo}`,
          root: repositoryRoot,
          bare,
          lastAccess,
        });
      }
    }
    candidates.sort(
      (left, right) => left.lastAccess - right.lastAccess || comparePaths(left.key, right.key),
    );

    let remaining = candidates.length;
    const evicted: string[] = [];
    const activeRepositories = new Set(activeRuns.values());
    for (const candidate of candidates) {
      if (remaining <= maximum) break;
      if (activeRepositories.has(candidate.key)) continue;
      const worktrees = yield* runGit([
        "--git-dir",
        candidate.bare,
        "worktree",
        "list",
        "--porcelain",
      ]);
      if (worktrees.exitCode === 0) {
        const count = textDecoder
          .decode(worktrees.stdout)
          .split("\n")
          .filter((line) => line.startsWith("worktree ")).length;
        if (count > 1) continue;
      }
      yield* fileSystem
        .remove(candidate.root, { recursive: true, force: true })
        .pipe(Effect.mapError(fromIo(`evict ${candidate.root}`)));
      evicted.push(candidate.key);
      remaining -= 1;
    }
    return evicted;
  });

  return Workspaces.of({
    prepare: (input) => mutex.withPermit(prepare(input)),
    finalize: (prepared) => mutex.withPermit(finalize(prepared)),
    abandon: (prepared) =>
      mutex.withPermit(
        runPaths(prepared).pipe(
          Effect.tap((paths) =>
            Effect.sync(() => {
              activeRuns.delete(paths.staging);
            }),
          ),
          Effect.asVoid,
        ),
      ),
    reapFailedRuns: (pr) => mutex.withPermit(reapFailedRunsInternal(pr)),
    filePatch,
    fileContent,
    tree: loadTree,
    evictCache: (maximum) => mutex.withPermit(evictCache(maximum)),
    removeRun: (run) =>
      mutex.withPermit(
        runPaths(run).pipe(
          Effect.flatMap((paths) =>
            fileSystem
              .remove(paths.final, { recursive: true, force: true })
              .pipe(Effect.mapError(fromIo(`remove ${paths.final}`))),
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(Workspaces, make);
