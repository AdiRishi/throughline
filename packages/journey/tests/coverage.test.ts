import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  Cluster as ClusterSchema,
  Hunk as HunkSchema,
  SeedHunk as SeedHunkSchema,
} from "@app/contracts";

import { completePartition, validateCoverage } from "../src/coverage.ts";

const decodeCluster = Schema.decodeUnknownSync(ClusterSchema);
const decodeHunk = Schema.decodeUnknownSync(HunkSchema);
const decodeHunks = Schema.decodeUnknownSync(Schema.Array(HunkSchema));
const decodeSeed = Schema.decodeUnknownSync(SeedHunkSchema);

const cluster = decodeCluster({
  id: "c1",
  position: 1,
  title: "Authentication boundary",
  weight: "core",
  narrative: { markdown: "Narrative." },
  mapEntry: { markdown: "Map." },
  buildsOn: [],
  fileOrder: ["src/auth.ts"],
  resurfaced: [],
});

const seed = decodeSeed({
  id: "h1",
  path: "src/auth.ts",
  oldStart: 10,
  oldLines: 2,
  newStart: 10,
  newLines: 4,
});

describe("validateCoverage", () => {
  it("accepts refinements that exactly tile both changed-line sets", () => {
    const hunks = decodeHunks([
      {
        id: "h1a",
        seedId: "h1",
        path: "src/auth.ts",
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
        home: "c1",
      },
      {
        id: "h1b",
        seedId: "h1",
        path: "src/auth.ts",
        oldStart: 11,
        oldLines: 1,
        newStart: 12,
        newLines: 2,
        home: "c1",
      },
    ]);

    expect(validateCoverage([seed], hunks, [cluster])).toEqual([]);
  });

  it("reports gaps, overlaps, invented ranges, and unknown homes precisely", () => {
    const hunks = decodeHunks([
      {
        id: "h1a",
        seedId: "h1",
        path: "src/auth.ts",
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
        home: "missing",
      },
      {
        id: "h1b",
        seedId: "h1",
        path: "src/auth.ts",
        oldStart: 10,
        oldLines: 1,
        newStart: 14,
        newLines: 1,
        home: "c1",
      },
    ]);

    expect(validateCoverage([seed], hunks, [cluster])).toEqual(
      expect.arrayContaining([
        { type: "unknown-home", hunkId: "h1a", clusterId: "missing" },
        { type: "range-overlap", seedId: "h1", side: "old", line: 10 },
        { type: "range-gap", seedId: "h1", side: "old", line: 11 },
        { type: "range-gap", seedId: "h1", side: "new", line: 12 },
        { type: "range-invented", hunkId: "h1b", side: "new" },
      ]),
    );
  });

  it("rejects resurfacing a hunk before or inside its home cluster", () => {
    const later = decodeCluster({
      ...cluster,
      id: "c2",
      position: 2,
      title: "Call sites",
      buildsOn: ["c1"],
      resurfaced: [{ hunkId: "h1", note: { markdown: "Seen again." } }],
    });
    const homed = decodeHunk({
      ...seed,
      seedId: seed.id,
      home: "c1",
    });
    expect(validateCoverage([seed], [homed], [cluster, later])).toEqual([]);

    const invalid = decodeCluster({ ...cluster, resurfaced: later.resurfaced });
    expect(validateCoverage([seed], [homed], [invalid])).toContainEqual({
      type: "invalid-resurfacing",
      clusterId: "c1",
      hunkId: "h1",
    });
  });
});

describe("completePartition", () => {
  it("collapses invalid refinements and homes them in an honest fallback cluster", () => {
    const incomplete = decodeHunks([
      {
        id: "h1a",
        seedId: "h1",
        path: "src/auth.ts",
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        home: "c1",
      },
    ]);

    const completed = completePartition([seed], [cluster], incomplete);

    expect(completed.clusters.at(-1)).toMatchObject({
      id: "c-unplaced",
      title: "Unplaced changes",
      fileOrder: ["src/auth.ts"],
    });
    expect(completed.hunks).toEqual([{ ...seed, seedId: "h1", home: "c-unplaced" }]);
    expect(validateCoverage([seed], completed.hunks, completed.clusters)).toEqual([]);
  });
});
