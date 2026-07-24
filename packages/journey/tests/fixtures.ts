import type { Journey, SeedHunk } from "@app/contracts";

import type { PinnedFileLookup } from "../src/evidence.ts";

export const SEEDS = [
  {
    id: "s1",
    path: "src/a.ts",
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 3,
  },
  {
    id: "s2",
    path: "src/b.ts",
    oldStart: 5,
    oldLines: 0,
    newStart: 6,
    newLines: 2,
  },
  {
    id: "s3",
    path: "asset.bin",
    oldStart: 0,
    oldLines: 0,
    newStart: 0,
    newLines: 0,
    fileKind: "binary",
  },
] as unknown as readonly SeedHunk[];

const lines = (count: number, special?: Readonly<Record<number, string>>): string =>
  Array.from({ length: count }, (_, index) => special?.[index + 1] ?? `line ${index + 1}`).join(
    "\n",
  );

const PINNED_FILES = new Map([
  [
    "src/a.ts",
    {
      old: lines(20),
      new: lines(21, { 10: "export const alpha = 1" }),
    },
  ],
  [
    "src/b.ts",
    {
      old: lines(8),
      new: lines(10, { 6: "alpha()", 7: "beta()" }),
    },
  ],
  ["asset.bin", { old: null, new: null }],
]);

export const pinnedFile: PinnedFileLookup = (path) => PINNED_FILES.get(path);

export const makeJourney = (): Journey =>
  ({
    formatVersion: 1,
    id: "journey-1",
    pr: { owner: "owner", repo: "repo", number: 42 },
    pinned: {
      headSha: "2222222222222222222222222222222222222222",
      baseSha: "1111111111111111111111111111111111111111",
      analyzedAt: "2026-07-25T00:00:00.000Z",
    },
    provenance: { harnessKind: "codex" },
    overview: {
      brief: { markdown: "The change starts at [alpha](tl:hunk/h1)." },
      whereToBegin: { markdown: "Begin with the foundation." },
    },
    clusters: [
      {
        id: "c1",
        position: 1,
        title: "Foundation",
        weight: "core",
        narrative: {
          markdown: "Defines [alpha](tl:symbol/src%2Fa.ts#alpha).",
        },
        mapEntry: { markdown: "Changes [the module](tl:file/src%2Fa.ts)." },
        buildsOn: [],
        fileOrder: ["src/a.ts"],
        resurfaced: [],
      },
      {
        id: "c2",
        position: 2,
        title: "Binding",
        weight: "supporting",
        narrative: { markdown: "Calls [alpha](tl:hunk/h1)." },
        mapEntry: { markdown: "Binds the two modules." },
        buildsOn: ["c1"],
        fileOrder: ["src/a.ts", "src/b.ts"],
        resurfaced: [
          {
            hunkId: "h1",
            note: { markdown: "Resurfaces [alpha](tl:hunk/h1) at its call site." },
          },
        ],
      },
      {
        id: "c3",
        position: 3,
        title: "Asset",
        weight: "mechanical",
        narrative: { markdown: "Updates the binary artifact." },
        mapEntry: { markdown: "Carries the generated artifact." },
        buildsOn: ["c2"],
        fileOrder: ["asset.bin"],
        resurfaced: [],
      },
    ],
    hunks: [
      {
        id: "h1",
        path: "src/a.ts",
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        seedId: "s1",
        home: "c1",
      },
      {
        id: "h2",
        path: "src/a.ts",
        oldStart: 11,
        oldLines: 1,
        newStart: 11,
        newLines: 2,
        seedId: "s1",
        home: "c2",
      },
      {
        id: "h3",
        path: "src/b.ts",
        oldStart: 5,
        oldLines: 0,
        newStart: 6,
        newLines: 2,
        seedId: "s2",
        home: "c2",
      },
      {
        id: "h4",
        path: "asset.bin",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "binary",
        seedId: "s3",
        home: "c3",
      },
    ],
    files: [
      {
        path: "src/a.ts",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: false,
        additions: 3,
        deletions: 2,
      },
      {
        path: "src/b.ts",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: false,
        additions: 2,
        deletions: 0,
      },
      {
        path: "asset.bin",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: true,
        additions: 0,
        deletions: 0,
      },
    ],
    hints: [
      {
        id: "hint-1",
        clusterId: "c2",
        kind: "connection",
        anchor: { path: "src/b.ts", side: "new", startLine: 6, endLine: 7 },
        body: { markdown: "This calls [alpha](tl:symbol/src%2Fa.ts#alpha)." },
      },
    ],
  }) as unknown as Journey;
