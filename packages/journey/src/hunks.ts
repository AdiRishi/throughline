import type { FileChange, FileLevelHunkKind, SeedHunk, SeedHunkId } from "@app/contracts";

import { repositoryPath } from "./repositoryPath.ts";

export interface PatchFacts {
  readonly files: readonly FileChange[];
  readonly hunks: readonly SeedHunk[];
}

interface ChangedRun {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly order: number;
}

interface ParsedFile {
  readonly path: string;
  readonly oldPath: string | null;
  readonly kind: FileChange["kind"];
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly binary: boolean;
  readonly runs: readonly ChangedRun[];
  readonly fileKind: FileLevelHunkKind | null;
  readonly order: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const appendUtf8 = (bytes: number[], value: string): void => {
  bytes.push(...textEncoder.encode(value));
};

const decodeQuotedGitPath = (value: string): string => {
  const bytes: number[] = [];

  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      appendUtf8(bytes, character);
      continue;
    }

    index += 1;
    const escaped = value[index]!;
    const simpleEscape: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    const simple = simpleEscape[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }

    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) {
        index += 1;
        octal += value[index]!;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    appendUtf8(bytes, escaped);
  }

  return textDecoder.decode(Uint8Array.from(bytes));
};

const decodeGitPath = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') ? decodeQuotedGitPath(value) : value;

const stripDiffPrefix = (path: string): string =>
  path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;

const tokenizeGitHeader = (value: string): readonly string[] => {
  const tokens: string[] = [];
  let index = 0;

  while (index < value.length) {
    while (value[index] === " ") index += 1;
    if (index >= value.length) break;

    if (value[index] === '"') {
      let end = index + 1;
      while (end < value.length) {
        if (value[end] === "\\") {
          end += 2;
          continue;
        }
        if (value[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      tokens.push(value.slice(index, end));
      index = end;
      continue;
    }

    const end = value.indexOf(" ", index);
    if (end === -1) {
      tokens.push(value.slice(index));
      break;
    }
    tokens.push(value.slice(index, end));
    index = end + 1;
  }

  return tokens;
};

const parseDiffHeaderPaths = (line: string): readonly [string, string] => {
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) {
    const tokens = tokenizeGitHeader(value);
    return [
      stripDiffPrefix(decodeGitPath(tokens[0] ?? "")),
      stripDiffPrefix(decodeGitPath(tokens[1] ?? "")),
    ];
  }

  for (let separator = value.indexOf(" b/"); separator !== -1; ) {
    const oldPath = stripDiffPrefix(value.slice(0, separator));
    const newPath = stripDiffPrefix(value.slice(separator + 1));
    if (oldPath === newPath) return [oldPath, newPath];
    separator = value.indexOf(" b/", separator + 1);
  }

  const separator = value.lastIndexOf(" b/");
  if (separator === -1) return ["", ""];
  return [stripDiffPrefix(value.slice(0, separator)), stripDiffPrefix(value.slice(separator + 1))];
};

const parseMarkerPath = (line: string): string | null => {
  const raw = line.slice(4).split("\t", 1)[0]!;
  if (raw === "/dev/null") return null;
  return stripDiffPrefix(decodeGitPath(raw));
};

const parseMetadataPath = (line: string, prefix: string): string =>
  decodeGitPath(line.slice(prefix.length));

const parseChangedRuns = (lines: readonly string[]): readonly ChangedRun[] => {
  const runs: ChangedRun[] = [];
  let order = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index]!);
    if (header === null) continue;

    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    let precededByContext = false;
    let run:
      | {
          oldStart: number;
          oldLines: number;
          newStart: number;
          newLines: number;
        }
      | undefined;

    const flush = (): void => {
      if (run === undefined) return;
      runs.push({ ...run, order });
      order += 1;
      run = undefined;
    };

    index += 1;
    for (; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.startsWith("@@ ")) {
        index -= 1;
        break;
      }
      if (line.startsWith("\\ No newline at end of file")) continue;

      const prefix = line[0];
      if (prefix === "-" || prefix === "+") {
        run ??= {
          oldStart: prefix === "+" && precededByContext ? Math.max(0, oldLine - 1) : oldLine,
          oldLines: 0,
          newStart: prefix === "-" && precededByContext ? Math.max(0, newLine - 1) : newLine,
          newLines: 0,
        };
        if (prefix === "-") {
          if (run.newLines > 0 && run.oldLines === 0) run.oldStart = oldLine;
          run.oldLines += 1;
          oldLine += 1;
        } else {
          if (run.oldLines > 0 && run.newLines === 0) run.newStart = newLine;
          run.newLines += 1;
          newLine += 1;
        }
        continue;
      }

      flush();
      if (prefix === " ") {
        oldLine += 1;
        newLine += 1;
        precededByContext = true;
        continue;
      }
      index -= 1;
      break;
    }

    flush();
  }

  return runs;
};

const fileLevelKind = (input: {
  readonly binary: boolean;
  readonly renamed: boolean;
  readonly oldMode: string | null;
  readonly newMode: string | null;
}): FileLevelHunkKind => {
  if (input.oldMode === "160000" || input.newMode === "160000") return "submodule";
  if (input.oldMode === "120000" || input.newMode === "120000") return "symlink";
  if (input.binary) return "binary";
  if (input.renamed) return "rename";
  if (input.oldMode !== null && input.newMode !== null && input.oldMode !== input.newMode) {
    return "mode";
  }
  return "empty";
};

const parseFile = (lines: readonly string[], order: number): ParsedFile => {
  const headerPaths = parseDiffHeaderPaths(lines[0]!);
  let headerOldPath = headerPaths[0];
  let headerNewPath = headerPaths[1];
  let oldPathFromMarker: string | null | undefined;
  let newPathFromMarker: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let oldMode: string | null = null;
  let newMode: string | null = null;
  let added = false;
  let deleted = false;
  let binary = false;

  for (const line of lines) {
    if (line.startsWith("@@ ")) break;
    if (line.startsWith("rename from ")) {
      renameFrom = parseMetadataPath(line, "rename from ");
    } else if (line.startsWith("rename to ")) {
      renameTo = parseMetadataPath(line, "rename to ");
    } else if (line.startsWith("new file mode ")) {
      added = true;
      newMode = line.slice("new file mode ".length);
    } else if (line.startsWith("deleted file mode ")) {
      deleted = true;
      oldMode = line.slice("deleted file mode ".length);
    } else if (line.startsWith("old mode ")) {
      oldMode = line.slice("old mode ".length);
    } else if (line.startsWith("new mode ")) {
      newMode = line.slice("new mode ".length);
    } else if (line.startsWith("index ")) {
      const mode = / (\d{6})$/u.exec(line)?.[1];
      if (mode !== undefined) {
        oldMode ??= mode;
        newMode ??= mode;
      }
    } else if (line.startsWith("--- ")) {
      oldPathFromMarker = parseMarkerPath(line);
    } else if (line.startsWith("+++ ")) {
      newPathFromMarker = parseMarkerPath(line);
    } else if (line.startsWith("Binary files ")) {
      binary = true;
    } else if (line === "GIT binary patch") {
      binary = true;
      break;
    }
  }

  headerOldPath = renameFrom ?? oldPathFromMarker ?? headerOldPath;
  headerNewPath = renameTo ?? newPathFromMarker ?? headerNewPath;
  const renamed = renameFrom !== undefined || renameTo !== undefined;
  const kind: FileChange["kind"] = added
    ? "added"
    : deleted
      ? "deleted"
      : renamed
        ? "renamed"
        : "modified";
  const path = deleted ? headerOldPath : headerNewPath;
  const semanticFileKind =
    oldMode === "160000" || newMode === "160000"
      ? "submodule"
      : oldMode === "120000" || newMode === "120000"
        ? "symlink"
        : null;
  const runs = semanticFileKind === null ? parseChangedRuns(lines) : [];

  return {
    path,
    oldPath: renamed ? headerOldPath : null,
    kind,
    oldMode,
    newMode,
    binary,
    runs,
    fileKind:
      semanticFileKind ??
      (runs.length === 0 ? fileLevelKind({ binary, renamed, oldMode, newMode }) : null),
    order,
  };
};

const splitFileBlocks = (patch: string): readonly (readonly string[])[] => {
  const blocks: string[][] = [];

  for (const line of patch.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      blocks.push([line]);
      continue;
    }
    blocks.at(-1)?.push(line);
  }

  return blocks;
};

export const derivePatchFacts = (patch: string): PatchFacts => {
  const parsedFiles = splitFileBlocks(patch)
    .map(parseFile)
    .toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : left.order - right.order,
    );
  const files: FileChange[] = [];
  const hunks: SeedHunk[] = [];

  for (const file of parsedFiles) {
    const additions = file.runs.reduce((total, run) => total + run.newLines, 0);
    const deletions = file.runs.reduce((total, run) => total + run.oldLines, 0);
    files.push({
      path: repositoryPath(file.path),
      oldPath: file.oldPath === null ? null : repositoryPath(file.oldPath),
      kind: file.kind,
      oldMode: file.oldMode,
      newMode: file.newMode,
      binary: file.binary,
      additions,
      deletions,
    });

    if (file.fileKind !== null) {
      const id = `s${hunks.length + 1}` as SeedHunkId;
      hunks.push({
        id,
        path: repositoryPath(file.path),
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: file.fileKind,
      });
      continue;
    }

    for (const run of file.runs) {
      const id = `s${hunks.length + 1}` as SeedHunkId;
      hunks.push({
        id,
        path: repositoryPath(file.path),
        oldStart: run.oldStart,
        oldLines: run.oldLines,
        newStart: run.newStart,
        newLines: run.newLines,
      });
    }
  }

  return { files, hunks };
};

export const deriveSeedHunks = (patch: string): readonly SeedHunk[] =>
  derivePatchFacts(patch).hunks;
