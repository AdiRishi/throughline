import type { FileChange, FileLevelKind, SeedHunk } from "@app/contracts";

export interface DerivedDiff {
  readonly files: ReadonlyArray<FileChange>;
  readonly hunks: ReadonlyArray<SeedHunk>;
}

interface ParsedFile {
  oldPath: string | undefined;
  path: string;
  kind: FileChange["kind"];
  additions: number;
  deletions: number;
  fileKind: FileLevelKind | undefined;
  hunks: Array<Omit<SeedHunk, "id">>;
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquotePath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) {
    return path;
  }
  return JSON.parse(path) as string;
}

function stripPrefix(path: string): string {
  const value = unquotePath(path);
  return value === "/dev/null" ? value : value.replace(/^[ab]\//, "");
}

function parseDiffPaths(line: string): readonly [string, string] | undefined {
  const match = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
  return match?.[1] !== undefined && match[2] !== undefined
    ? [stripPrefix(match[1]), stripPrefix(match[2])]
    : undefined;
}

function classify(file: ParsedFile, lines: ReadonlyArray<string>): void {
  const text = lines.join("\n");
  if (/^new file mode /m.test(text)) file.kind = "added";
  if (/^deleted file mode /m.test(text)) file.kind = "deleted";
  if (/^rename from /m.test(text)) {
    file.kind = "renamed";
    file.fileKind = "rename";
  }
  if (/^copy from /m.test(text)) file.kind = "copied";
  if (/^(old mode|new mode) /m.test(text) && file.kind === "modified") {
    file.kind = "mode";
    file.fileKind = "mode";
  }
  if (/^(Binary files .* differ|GIT binary patch)$/m.test(text)) {
    file.kind = "binary";
    file.fileKind = "binary";
  }
  if (/^160000 /m.test(text) || /^Subproject commit /m.test(text)) {
    file.kind = "submodule";
    file.fileKind = "submodule";
  }
  if (/^120000 /m.test(text)) {
    file.kind = "symlink";
    file.fileKind = "symlink";
  }
}

function parseFile(lines: ReadonlyArray<string>): ParsedFile | undefined {
  const paths = parseDiffPaths(lines[0] ?? "");
  if (paths === undefined) return undefined;

  const file: ParsedFile = {
    oldPath: paths[0],
    path: paths[1],
    kind: "modified",
    additions: 0,
    deletions: 0,
    fileKind: undefined,
    hunks: [],
  };

  for (const line of lines) {
    if (line.startsWith("rename from ")) file.oldPath = unquotePath(line.slice(12));
    if (line.startsWith("rename to ")) file.path = unquotePath(line.slice(10));
    if (line.startsWith("copy from ")) file.oldPath = unquotePath(line.slice(10));
    if (line.startsWith("copy to ")) file.path = unquotePath(line.slice(8));
    if (line.startsWith("--- ")) file.oldPath = stripPrefix(line.slice(4));
    if (line.startsWith("+++ ")) file.path = stripPrefix(line.slice(4));
  }

  classify(file, lines);
  if (file.oldPath === "/dev/null") file.oldPath = undefined;
  if (file.path === "/dev/null") {
    file.path = file.oldPath ?? paths[0];
    file.oldPath = undefined;
  }

  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header === null) continue;
    const oldStart = Number(header[1]);
    const oldLines = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLines = header[4] === undefined ? 1 : Number(header[4]);
    file.deletions += oldLines;
    file.additions += newLines;
    file.hunks.push({
      path: file.path,
      oldStart,
      oldLines,
      newStart,
      newLines,
    });
  }
  return file;
}

export function deriveSeedHunks(patch: string): DerivedDiff {
  const chunks = patch
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trimEnd().split("\n"))
    .filter((lines) => lines[0]?.startsWith("diff --git "));
  const parsed = chunks.flatMap((lines) => {
    const file = parseFile(lines);
    return file === undefined ? [] : [file];
  });

  let index = 0;
  const hunks: Array<SeedHunk> = [];
  for (const file of parsed) {
    for (const hunk of file.hunks) {
      index += 1;
      hunks.push({ ...hunk, id: `h${index}` as SeedHunk["id"] });
    }
    if (file.hunks.length === 0) {
      index += 1;
      hunks.push({
        id: `h${index}` as SeedHunk["id"],
        path: file.path,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: file.fileKind ?? "empty",
      });
    }
  }

  return {
    files: parsed.map((file): FileChange => {
      const change = {
        path: file.path,
        kind: file.kind,
        additions: file.additions,
        deletions: file.deletions,
      };
      return file.oldPath === undefined || file.oldPath === file.path
        ? change
        : {
            path: file.path,
            oldPath: file.oldPath,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
          };
    }),
    hunks,
  };
}
