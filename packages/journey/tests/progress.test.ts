import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ClusterId, Hunk as HunkSchema, ReadFile } from "@app/contracts";

import { clusterProgress, journeyProgress } from "../src/progress.ts";

const decodeClusterId = Schema.decodeUnknownSync(ClusterId);
const hunks = Schema.decodeUnknownSync(Schema.Array(HunkSchema))([
  {
    id: "h1",
    seedId: "h1",
    path: "src/a.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    home: "c1",
  },
  {
    id: "h2",
    seedId: "h2",
    path: "src/a.ts",
    oldStart: 5,
    oldLines: 1,
    newStart: 5,
    newLines: 1,
    home: "c1",
  },
  {
    id: "h3",
    seedId: "h3",
    path: "src/b.ts",
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: 3,
    home: "c2",
  },
]);

const readState = {
  readFiles: Schema.decodeUnknownSync(Schema.Array(ReadFile))([
    { clusterId: "c1", path: "src/a.ts" },
  ]),
};

describe("progress", () => {
  it("counts every homed hunk in a marked file and counts no resurfacing twice", () => {
    expect(clusterProgress(decodeClusterId("c1"), hunks, readState.readFiles)).toEqual({
      read: 2,
      total: 2,
      ratio: 1,
    });
    expect(journeyProgress(hunks, readState)).toEqual({
      read: 2,
      total: 3,
      ratio: 2 / 3,
    });
  });

  it("treats an empty cluster as complete", () => {
    expect(clusterProgress(decodeClusterId("c3"), hunks, [])).toEqual({
      read: 0,
      total: 0,
      ratio: 1,
    });
  });
});
