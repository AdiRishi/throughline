import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  FileChange,
  SeedHunk,
  type FileChange as FileChangeValue,
  type SeedHunk as SeedHunkValue,
} from "@app/contracts";
import { validateCoverage } from "@app/journey/coverage";

import { completePlan, PlanOutput } from "../../src/analysis/AnalysisOutput.ts";

const decodeFile = Schema.decodeUnknownSync(FileChange);
const decodeSeed = Schema.decodeUnknownSync(SeedHunk);
const decodePlan = Schema.decodeUnknownSync(PlanOutput);

const files: ReadonlyArray<FileChangeValue> = [
  decodeFile({
    path: "src/core.ts",
    oldPath: null,
    kind: "modified",
    oldMode: "100644",
    newMode: "100644",
    binary: false,
    additions: 1,
    deletions: 1,
  }),
  decodeFile({
    path: "src/support.ts",
    oldPath: null,
    kind: "modified",
    oldMode: "100644",
    newMode: "100644",
    binary: false,
    additions: 1,
    deletions: 1,
  }),
];

const seeds: ReadonlyArray<SeedHunkValue> = [
  decodeSeed({
    id: "s1",
    path: "src/core.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
  }),
  decodeSeed({
    id: "s2",
    path: "src/support.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
  }),
];

describe("analysis deterministic completion", () => {
  it("keeps valid refinements and places uncovered seeds in an honest final cluster", () => {
    const output = decodePlan({
      clusters: [
        {
          id: "core",
          title: "Core behavior",
          weight: "core",
          buildsOn: [],
          fileOrder: ["src/core.ts"],
        },
      ],
      hunks: [
        {
          id: "h7",
          seedId: "s1",
          path: "src/core.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          home: "core",
        },
      ],
    });

    const completed = completePlan(output, seeds, files);

    assert.deepStrictEqual(
      completed.clusters.map(({ title, weight }) => ({ title, weight })),
      [
        { title: "Core behavior", weight: "core" },
        { title: "Unplaced changes", weight: "supporting" },
      ],
    );
    assert.deepStrictEqual(
      completed.hunks.map(({ id, seedId, home }) => ({ id, seedId, home })),
      [
        { id: "h1", seedId: "s1", home: "core" },
        { id: "h2", seedId: "s2", home: "unplaced" },
      ],
    );
    assert.deepStrictEqual(validateCoverage({ seeds, files, ...completed }), []);
  });

  it("degrades an empty plan to a deterministic per-file journey", () => {
    const completed = completePlan({ clusters: [], hunks: [] }, seeds, files);

    assert.deepStrictEqual(
      completed.clusters.map(({ id, title, position }) => ({ id, title, position })),
      [
        { id: "file-1", title: "src/core.ts", position: 1 },
        { id: "file-2", title: "src/support.ts", position: 2 },
      ],
    );
    assert.deepStrictEqual(validateCoverage({ seeds, files, ...completed }), []);
  });
});
