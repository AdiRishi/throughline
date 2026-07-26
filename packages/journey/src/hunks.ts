/**
 * Seed-hunk derivation: the deterministic half of the coverage guarantee.
 *
 * Everything here is a pure function from git's own output to Throughline's
 * placement units. No agent is involved, which is what makes the seeds — and
 * the changed-line set they cover — computed facts rather than claims.
 *
 * The two inputs are produced by `Workspaces` at ingestion time:
 *  - `git diff --raw -z -M base..head` — the authoritative file list. NUL
 *    separation makes paths unambiguous even when they contain spaces.
 *  - `git diff -U0 -M base..head` — zero-context patch text. With no context
 *    lines, git's own hunks are exactly the maximal contiguous runs of changed
 *    lines, so seed derivation is a parse rather than an analysis.
 *
 * @module hunks
 */
import type { FileChange, FileChangeKind, FileHunkKind, HunkId, SeedHunk } from "@app/contracts";

/** One entry of `git diff --raw -z`. */
export interface RawDiffEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldSha: string;
  readonly newSha: string;
  /** `A` `C` `D` `M` `R` `T` `U` `X`, without the similarity score. */
  readonly status: string;
  readonly score: number | null;
  readonly path: string;
  /** Only set for copies and renames. */
  readonly oldPath: string | null;
}

/** A `@@` header's two ranges, as parsed. Line numbers are 1-based. */
export interface PatchHunkRange {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

/** One `diff --git` section of a patch. */
export interface ParsedPatchFile {
  /** Path from the section header; best-effort when git had to quote it. */
  readonly headerPath: string | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly binary: boolean;
  readonly renamed: boolean;
  readonly copied: boolean;
  readonly added: boolean;
  readonly deleted: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: ReadonlyArray<PatchHunkRange>;
}

export class DiffParseError extends Error {
  override readonly name = "DiffParseError";
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Undo git's C-style path quoting (`"src/\303\251.ts"`). Only applied when the
 * value is actually quoted; `core.quotePath=false` means it usually is not.
 */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const inner = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== "\\") {
      // Non-ASCII should not appear inside a quoted path, but re-encode
      // defensively rather than dropping information.
      for (const byte of new TextEncoder().encode(char ?? "")) bytes.push(byte);
      continue;
    }
    const next = inner[index + 1];
    if (next === undefined) break;
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
      case "b":
        bytes.push(8);
        break;
      case "f":
        bytes.push(12);
        break;
      case "v":
        bytes.push(11);
        break;
      case "a":
        bytes.push(7);
        break;
      case "\\":
        bytes.push(92);
        break;
      case '"':
        bytes.push(34);
        break;
      default: {
        const octal = inner.slice(index, index + 3);
        if (/^[0-7]{3}$/.test(octal)) {
          bytes.push(Number.parseInt(octal, 8));
          index += 2;
        } else {
          bytes.push(next.charCodeAt(0));
        }
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Parse `git diff --raw -z -M`. Tokens alternate: one `:`-prefixed metadata
 * token, then one path (two for copies and renames).
 */
export function parseRawDiff(raw: string): ReadonlyArray<RawDiffEntry> {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const entries: RawDiffEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const meta = tokens[index];
    if (meta === undefined) break;
    if (!meta.startsWith(":")) {
      throw new DiffParseError(`Expected a raw diff metadata token, got "${meta}".`);
    }
    const parts = meta
      .slice(1)
      .split(/\s+/u)
      .filter((part) => part.length > 0);
    const [oldMode, newMode, oldSha, newSha, statusToken] = parts;
    if (
      oldMode === undefined ||
      newMode === undefined ||
      oldSha === undefined ||
      newSha === undefined ||
      statusToken === undefined
    ) {
      throw new DiffParseError(`Malformed raw diff metadata token "${meta}".`);
    }
    const status = statusToken.charAt(0);
    const scoreText = statusToken.slice(1);
    const takesTwoPaths = status === "R" || status === "C";
    const firstPath = tokens[index + 1];
    if (firstPath === undefined) {
      throw new DiffParseError(`Raw diff entry "${meta}" is missing its path.`);
    }
    const secondPath = takesTwoPaths ? tokens[index + 2] : undefined;
    if (takesTwoPaths && secondPath === undefined) {
      throw new DiffParseError(`Raw diff entry "${meta}" is missing its destination path.`);
    }
    entries.push({
      oldMode,
      newMode,
      oldSha,
      newSha,
      status,
      score: scoreText.length > 0 ? Number.parseInt(scoreText, 10) : null,
      path: unquoteGitPath(secondPath ?? firstPath),
      oldPath: takesTwoPaths ? unquoteGitPath(firstPath) : null,
    });
    index += takesTwoPaths ? 3 : 2;
  }
  return entries;
}

function stripDiffPrefix(value: string): string | null {
  const unquoted = unquoteGitPath(value.trim());
  if (unquoted === "/dev/null") return null;
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) return unquoted.slice(2);
  return unquoted;
}

/**
 * Best-effort path recovery from a `diff --git a/X b/Y` line. Ambiguous only
 * when a path contains " b/" *and* the two sides differ; the raw diff list is
 * the authority, so this exists for cross-checking and for sections (binary,
 * mode-only) that carry no `---`/`+++` lines.
 */
function parseDiffGitHeader(line: string): string | null {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const closing = rest.indexOf('" ', 1);
    if (closing === -1) return null;
    return stripDiffPrefix(rest.slice(0, closing + 1));
  }
  const candidates: number[] = [];
  for (let index = rest.indexOf(" b/"); index !== -1; index = rest.indexOf(" b/", index + 1)) {
    candidates.push(index);
  }
  for (const index of candidates) {
    const left = stripDiffPrefix(rest.slice(0, index));
    const right = stripDiffPrefix(rest.slice(index + 1));
    if (left !== null && left === right) return left;
  }
  const last = candidates.at(-1);
  return last === undefined ? stripDiffPrefix(rest) : stripDiffPrefix(rest.slice(last + 1));
}

/**
 * Parse a unified patch into per-file sections. Written for zero-context
 * patches (seed derivation) but tolerant of context lines, so the same parser
 * can read the display patches in tests.
 */
export function parseGitPatch(patch: string): ReadonlyArray<ParsedPatchFile> {
  const lines = patch.split("\n");
  const files: ParsedPatchFile[] = [];

  let current: {
    headerPath: string | null;
    oldPath: string | null;
    newPath: string | null;
    oldMode: string | null;
    newMode: string | null;
    binary: boolean;
    renamed: boolean;
    copied: boolean;
    added: boolean;
    deleted: boolean;
    additions: number;
    deletions: number;
    hunks: PatchHunkRange[];
    sawMinusHeader: boolean;
    sawPlusHeader: boolean;
  } | null = null;
  let inHunk = false;

  const flush = () => {
    if (current === null) return;
    files.push({
      headerPath: current.headerPath,
      oldPath: current.oldPath,
      newPath: current.newPath,
      oldMode: current.oldMode,
      newMode: current.newMode,
      binary: current.binary,
      renamed: current.renamed,
      copied: current.copied,
      added: current.added,
      deleted: current.deleted,
      additions: current.additions,
      deletions: current.deletions,
      hunks: current.hunks,
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      inHunk = false;
      current = {
        headerPath: parseDiffGitHeader(line),
        oldPath: null,
        newPath: null,
        oldMode: null,
        newMode: null,
        binary: false,
        renamed: false,
        copied: false,
        added: false,
        deleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
        sawMinusHeader: false,
        sawPlusHeader: false,
      };
      continue;
    }
    if (current === null) continue;

    if (!inHunk) {
      if (line.startsWith("old mode ")) {
        current.oldMode = line.slice("old mode ".length).trim();
        continue;
      }
      if (line.startsWith("new mode ")) {
        current.newMode = line.slice("new mode ".length).trim();
        continue;
      }
      if (line.startsWith("new file mode ")) {
        current.added = true;
        current.newMode = line.slice("new file mode ".length).trim();
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        current.deleted = true;
        current.oldMode = line.slice("deleted file mode ".length).trim();
        continue;
      }
      if (line.startsWith("rename from ")) {
        current.renamed = true;
        current.oldPath = unquoteGitPath(line.slice("rename from ".length).trim());
        continue;
      }
      if (line.startsWith("rename to ")) {
        current.renamed = true;
        current.newPath = unquoteGitPath(line.slice("rename to ".length).trim());
        continue;
      }
      if (line.startsWith("copy from ")) {
        current.copied = true;
        current.oldPath = unquoteGitPath(line.slice("copy from ".length).trim());
        continue;
      }
      if (line.startsWith("copy to ")) {
        current.copied = true;
        current.newPath = unquoteGitPath(line.slice("copy to ".length).trim());
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        current.binary = true;
        continue;
      }
      if (line.startsWith("index ")) {
        // `index abc..def 100644` — the trailing mode is the unchanged mode.
        const mode = line.trim().split(" ")[1];
        if (mode !== undefined && /^\d{6}$/.test(mode)) {
          current.oldMode ??= mode;
          current.newMode ??= mode;
        }
        continue;
      }
    }

    if (line.startsWith("--- ") && !current.sawMinusHeader && !inHunk) {
      current.sawMinusHeader = true;
      const parsed = stripDiffPrefix(line.slice(4));
      if (parsed !== null) current.oldPath ??= parsed;
      continue;
    }
    if (line.startsWith("+++ ") && !current.sawPlusHeader && !inHunk) {
      current.sawPlusHeader = true;
      const parsed = stripDiffPrefix(line.slice(4));
      if (parsed !== null) current.newPath ??= parsed;
      continue;
    }

    const header = HUNK_HEADER.exec(line);
    if (header !== null) {
      inHunk = true;
      const oldStart = Number.parseInt(header[1] ?? "0", 10);
      const oldLines = header[2] === undefined ? 1 : Number.parseInt(header[2], 10);
      const newStart = Number.parseInt(header[3] ?? "0", 10);
      const newLines = header[4] === undefined ? 1 : Number.parseInt(header[4], 10);
      current.hunks.push({ oldStart, oldLines, newStart, newLines });
      continue;
    }

    if (inHunk) {
      if (line.startsWith("+")) current.additions += 1;
      else if (line.startsWith("-")) current.deletions += 1;
    }
  }
  flush();
  return files;
}

function classifyChangeKind(entry: RawDiffEntry): FileChangeKind {
  switch (entry.status) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

/**
 * Why a changed file yielded no changed lines. Ordered most-specific first so a
 * renamed binary reports as binary rather than as a rename.
 */
function classifyFileHunkKind(
  file: FileChange,
  section: ParsedPatchFile | undefined,
): FileHunkKind {
  if (file.binary || section?.binary === true) return "binary";
  const oldMode = file.oldMode;
  const newMode = file.newMode;
  if (oldMode === "160000" || newMode === "160000") return "submodule";
  if (oldMode === "120000" || newMode === "120000") return "symlink";
  if (oldMode !== null && newMode !== null && oldMode !== newMode) return "mode";
  if (file.changeKind === "renamed" || file.changeKind === "copied") return "rename";
  return "empty";
}

/**
 * Match patch sections to raw entries. Both come from the same diff queue in
 * the same order, so position is exact when the counts agree; path matching is
 * the fallback for the case where they do not.
 */
function matchSections(
  entries: ReadonlyArray<RawDiffEntry>,
  sections: ReadonlyArray<ParsedPatchFile>,
): ReadonlyArray<ParsedPatchFile | undefined> {
  if (entries.length === sections.length) return sections;
  const byPath = new Map<string, ParsedPatchFile>();
  for (const section of sections) {
    const key = section.newPath ?? section.oldPath ?? section.headerPath;
    if (key !== null && key !== undefined) byPath.set(key, section);
  }
  return entries.map((entry) => byPath.get(entry.path) ?? byPath.get(entry.oldPath ?? ""));
}

export interface DerivedDiff {
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
}

/**
 * The whole deterministic derivation: every changed file, and the seed hunks
 * that cover every changed line plus one file-level hunk for every changed
 * file that has none.
 *
 * Ids are `h1…hN`, dense and ordered by (path, position) — a stable, readable
 * identity the agent can reason about and the validator can check.
 */
export function deriveDiff(input: { readonly raw: string; readonly patch: string }): DerivedDiff {
  const entries = parseRawDiff(input.raw);
  const sections = parseGitPatch(input.patch);
  const matched = matchSections(entries, sections);

  const withSections = entries
    .map((entry, index) => ({ entry, section: matched[index] }))
    .toSorted((left, right) => (left.entry.path < right.entry.path ? -1 : 1));

  const files: FileChange[] = [];
  const seeds: SeedHunk[] = [];
  let nextId = 1;
  const mint = (): HunkId => `h${nextId++}` as HunkId;

  for (const { entry, section } of withSections) {
    const binary = section?.binary ?? false;
    const changeKind = classifyChangeKind(entry);
    const file: FileChange = {
      path: entry.path,
      oldPath: entry.oldPath ?? (changeKind === "deleted" ? entry.path : null),
      changeKind,
      binary,
      additions: section?.additions ?? 0,
      deletions: section?.deletions ?? 0,
      oldMode: entry.oldMode === "000000" ? null : entry.oldMode,
      newMode: entry.newMode === "000000" ? null : entry.newMode,
    };
    files.push(file);

    const hunks = section?.hunks ?? [];
    if (hunks.length === 0) {
      seeds.push({
        id: mint(),
        path: file.path,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: classifyFileHunkKind(file, section),
      });
      continue;
    }
    for (const hunk of hunks) {
      seeds.push({
        id: mint(),
        path: file.path,
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        fileKind: null,
      });
    }
  }

  return { files, seeds };
}

/** Total changed lines a seed covers — the scale figure the Overview derives from. */
export function seedChangedLines(seed: SeedHunk): number {
  return seed.oldLines + seed.newLines;
}

/** Group any hunk-like values by path, preserving input order within a path. */
export function groupByPath<T extends { readonly path: string }>(
  items: ReadonlyArray<T>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const existing = grouped.get(item.path);
    if (existing === undefined) grouped.set(item.path, [item]);
    else existing.push(item);
  }
  return grouped;
}
