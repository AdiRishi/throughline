import type {
  ClusterId,
  FileChange,
  FileChangeKind,
  Hunk,
  HunkFileKind,
  HunkId,
} from "@app/contracts";

/**
 * Seed-hunk derivation: the deterministic half of the coverage guarantee.
 *
 * Nothing in this module involves an agent. It parses a **zero-context**
 * `git diff` into maximal contiguous runs of changed lines, one seed hunk each,
 * plus one synthetic file-level hunk for every changed file that yields no
 * changed lines. The seeds — and the changed-line set they cover — are computed
 * facts, which is why the agent can only ever fail to *assign* them, never
 * break the partition.
 *
 * @module hunks
 */

/** A parsed `@@ -a,b +c,d @@` header. Zero-length runs are legal on either side. */
export interface HunkRange {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

/** One file's worth of parsed diff, before ids are assigned. */
export interface ParsedFile {
  /** New path; the old path for pure deletions. */
  readonly path: string;
  readonly oldPath: string | undefined;
  readonly kind: FileChangeKind;
  readonly binary: boolean;
  readonly oldMode: string | undefined;
  readonly newMode: string | undefined;
  readonly additions: number;
  readonly deletions: number;
  /** Empty for binary changes, pure renames, and mode-only changes. */
  readonly ranges: ReadonlyArray<HunkRange>;
}

/** A seed hunk: a hunk before an agent has had any say in it. */
export interface SeedHunk {
  readonly id: HunkId;
  readonly path: string;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Set on file-level hunks only. The agent may never split one. */
  readonly fileKind: HunkFileKind | undefined;
}

export interface DiffIndex {
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_HEADER = /^diff --git /;
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

/**
 * Strip git's `a/` or `b/` prefix. Paths containing spaces arrive quoted in the
 * `diff --git` line but unquoted in `---`/`+++`, which is why those two lines
 * are the authority here and the `diff --git` line is only the fallback.
 */
function stripPrefix(raw: string): string {
  const value = unquoteGitPath(raw.trim());
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

/** Git C-quotes paths with unusual bytes: `"src/caf\303\251.ts"`. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char ?? ""));
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      const octal = body.slice(index + 1, index + 4);
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    index += 1;
    switch (next) {
      case "n":
        bytes.push(10);
        break;
      case "t":
        bytes.push(9);
        break;
      case "r":
        bytes.push(13);
        break;
      default:
        bytes.push(...new TextEncoder().encode(next));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface FileAccumulator {
  headerOld: string | undefined;
  headerNew: string | undefined;
  minusPath: string | undefined;
  plusPath: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  copyFrom: string | undefined;
  copyTo: string | undefined;
  isNew: boolean;
  isDeleted: boolean;
  binary: boolean;
  oldMode: string | undefined;
  newMode: string | undefined;
  additions: number;
  deletions: number;
  ranges: HunkRange[];
}

function emptyAccumulator(): FileAccumulator {
  return {
    headerOld: undefined,
    headerNew: undefined,
    minusPath: undefined,
    plusPath: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    copyFrom: undefined,
    copyTo: undefined,
    isNew: false,
    isDeleted: false,
    binary: false,
    oldMode: undefined,
    newMode: undefined,
    additions: 0,
    deletions: 0,
    ranges: [],
  };
}

/**
 * Split a `diff --git a/x b/y` line into its two paths. Ambiguous when a path
 * contains " b/", so quoted forms and the `---`/`+++` lines take precedence.
 */
function parseDiffHeaderPaths(line: string): { old: string | undefined; new: string | undefined } {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const closing = rest.indexOf('" ', 1);
    if (closing !== -1) {
      return {
        old: stripPrefix(rest.slice(0, closing + 1)),
        new: stripPrefix(rest.slice(closing + 2)),
      };
    }
  }
  const marker = rest.indexOf(" b/");
  if (marker === -1) return { old: undefined, new: undefined };
  return { old: stripPrefix(rest.slice(0, marker)), new: stripPrefix(rest.slice(marker + 1)) };
}

/** `100644` → `100` (regular), `120000` → `120` (symlink), `160000` → `160`. */
function gitObjectType(mode: string): string {
  return mode.padStart(6, "0").slice(0, 3);
}

function finalize(accumulator: FileAccumulator): ParsedFile | null {
  const oldPathRaw =
    accumulator.renameFrom ??
    accumulator.copyFrom ??
    (accumulator.minusPath === "/dev/null" ? undefined : accumulator.minusPath) ??
    accumulator.headerOld;
  const newPathRaw =
    accumulator.renameTo ??
    accumulator.copyTo ??
    (accumulator.plusPath === "/dev/null" ? undefined : accumulator.plusPath) ??
    accumulator.headerNew;

  const path = accumulator.isDeleted ? (oldPathRaw ?? newPathRaw) : (newPathRaw ?? oldPathRaw);
  if (path === undefined || path.length === 0) return null;

  const renamed = accumulator.renameFrom !== undefined && accumulator.renameTo !== undefined;
  const copied = accumulator.copyFrom !== undefined && accumulator.copyTo !== undefined;
  // A chmod is still a modification; only a change of git's object *type*
  // (regular file ↔ symlink ↔ submodule) is a type change.
  const typeChanged =
    accumulator.oldMode !== undefined &&
    accumulator.newMode !== undefined &&
    gitObjectType(accumulator.oldMode) !== gitObjectType(accumulator.newMode);

  const kind: FileChangeKind = accumulator.isNew
    ? "added"
    : accumulator.isDeleted
      ? "deleted"
      : renamed
        ? "renamed"
        : copied
          ? "copied"
          : typeChanged
            ? "type-changed"
            : "modified";

  return {
    path,
    oldPath: renamed || copied ? oldPathRaw : undefined,
    kind,
    binary: accumulator.binary,
    oldMode: accumulator.oldMode,
    newMode: accumulator.newMode,
    additions: accumulator.additions,
    deletions: accumulator.deletions,
    ranges: accumulator.ranges,
  };
}

/**
 * Parse a git unified diff. Written against `git diff -M --no-color
 * --unified=0`, but tolerant of any context width — the ranges it reports are
 * whatever the headers say, so a wider patch simply yields wider seeds.
 */
export function parseUnifiedDiff(patch: string): ReadonlyArray<ParsedFile> {
  const files: ParsedFile[] = [];
  let current: FileAccumulator | null = null;

  const push = () => {
    if (current === null) return;
    const parsed = finalize(current);
    if (parsed !== null) files.push(parsed);
    current = null;
  };

  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (DIFF_HEADER.test(line)) {
      push();
      current = emptyAccumulator();
      const paths = parseDiffHeaderPaths(line);
      current.headerOld = paths.old;
      current.headerNew = paths.new;
      continue;
    }
    if (current === null) continue;

    if (line.startsWith("new file mode ")) {
      current.isNew = true;
      current.newMode = line.slice("new file mode ".length).trim();
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true;
      current.oldMode = line.slice("deleted file mode ".length).trim();
      continue;
    }
    if (line.startsWith("old mode ")) {
      current.oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new mode ")) {
      current.newMode = line.slice("new mode ".length).trim();
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.renameFrom = unquoteGitPath(line.slice("rename from ".length).trim());
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.renameTo = unquoteGitPath(line.slice("rename to ".length).trim());
      continue;
    }
    if (line.startsWith("copy from ")) {
      current.copyFrom = unquoteGitPath(line.slice("copy from ".length).trim());
      continue;
    }
    if (line.startsWith("copy to ")) {
      current.copyTo = unquoteGitPath(line.slice("copy to ".length).trim());
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      current.minusPath = stripPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.plusPath = stripPrefix(line.slice(4));
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      const oldStart = Number.parseInt(header[1] ?? "0", 10);
      const oldLines = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
      const newStart = Number.parseInt(header[3] ?? "0", 10);
      const newLines = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
      current.ranges.push({ oldStart, oldLines, newStart, newLines });
      current.additions += newLines;
      current.deletions += oldLines;
      continue;
    }

    // `\ No newline at end of file` is metadata, never a changed line.
    if (line.startsWith("\\")) continue;
    // With a wider context width, body lines still carry no range information —
    // the headers are authoritative — so nothing else needs reading.
  }

  push();
  return files;
}

/**
 * Why a changed file with no changed lines is still placeable. Priority is
 * deliberate: a binary file whose mode also changed is a binary change first.
 */
function fileLevelKind(file: ParsedFile): HunkFileKind {
  if (file.binary) return "binary";
  if (file.newMode === SYMLINK_MODE || file.oldMode === SYMLINK_MODE) return "symlink";
  if (file.newMode === SUBMODULE_MODE || file.oldMode === SUBMODULE_MODE) return "submodule";
  if (file.kind === "renamed" || file.kind === "copied") return "rename";
  if (file.oldMode !== undefined && file.newMode !== undefined && file.oldMode !== file.newMode) {
    return "mode";
  }
  return "empty";
}

function toFileChange(file: ParsedFile): FileChange {
  return {
    path: file.path,
    ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
    kind: file.kind,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    ...(file.oldMode === undefined ? {} : { oldMode: file.oldMode }),
    ...(file.newMode === undefined ? {} : { newMode: file.newMode }),
  };
}

/**
 * Assign dense, ordered ids to every seed. Files are sorted by path and hunks
 * by position within a file, so the same diff always yields the same ids — the
 * property that lets a run directory, an agent's answer, and a persisted
 * journey all refer to `h12` and mean the same lines.
 */
export function indexDiff(parsed: ReadonlyArray<ParsedFile>): DiffIndex {
  const ordered = [...parsed].toSorted((left, right) => (left.path < right.path ? -1 : 1));
  const seeds: SeedHunk[] = [];
  let counter = 0;
  const nextId = (): HunkId => {
    counter += 1;
    return `h${counter}` as HunkId;
  };

  for (const file of ordered) {
    if (file.ranges.length === 0) {
      seeds.push({
        id: nextId(),
        path: file.path,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: fileLevelKind(file),
      });
      continue;
    }
    const ranges = [...file.ranges].toSorted(
      (left, right) => left.newStart - right.newStart || left.oldStart - right.oldStart,
    );
    for (const range of ranges) {
      seeds.push({
        id: nextId(),
        path: file.path,
        oldStart: range.oldStart,
        oldLines: range.oldLines,
        newStart: range.newStart,
        newLines: range.newLines,
        fileKind: undefined,
      });
    }
  }

  return { files: ordered.map(toFileChange), seeds };
}

/** Parse + index in one step: patch text in, the deterministic facts out. */
export function deriveDiffIndex(patch: string): DiffIndex {
  return indexDiff(parseUnifiedDiff(patch));
}

/** Promote a seed to a homed hunk with no refinement. Used by the floor. */
export function seedAsHunk(seed: SeedHunk, home: ClusterId): Hunk {
  return {
    id: seed.id,
    path: seed.path,
    oldStart: seed.oldStart,
    oldLines: seed.oldLines,
    newStart: seed.newStart,
    newLines: seed.newLines,
    ...(seed.fileKind === undefined ? {} : { fileKind: seed.fileKind }),
    seedId: seed.id,
    home,
  };
}

/** True when this hunk stands for a whole file rather than a run of lines. */
export function isFileLevelHunk(hunk: Pick<Hunk, "fileKind">): boolean {
  return hunk.fileKind !== undefined;
}

/** Distinct paths touched by a set of hunks, in first-seen order. */
export function hunkPaths(hunks: ReadonlyArray<Pick<Hunk, "path">>): ReadonlyArray<string> {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const hunk of hunks) {
    if (seen.has(hunk.path)) continue;
    seen.add(hunk.path);
    paths.push(hunk.path);
  }
  return paths;
}
