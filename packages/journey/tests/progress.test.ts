import { assert, describe, it } from "@effect/vitest";

import {
  computeClusterProgress,
  computeClusterScales,
  computeJourneyProgress,
  markKey,
  toPercent,
} from "../src/progress.ts";
import {
  clusterId,
  hunkId,
  makeCluster,
  makeHunk,
  makeJourney,
  makeReadState,
} from "./fixtures.ts";

const hunks = [
  makeHunk({ id: hunkId("h1"), path: "src/a.ts", home: clusterId("c1") }),
  makeHunk({ id: hunkId("h2"), path: "src/a.ts", home: clusterId("c1") }),
  makeHunk({ id: hunkId("h3"), path: "src/b.ts", home: clusterId("c1") }),
  makeHunk({ id: hunkId("h4"), path: "src/c.ts", home: clusterId("c2") }),
];

const clusters = [
  makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["src/a.ts", "src/b.ts"] }),
  makeCluster({
    id: clusterId("c2"),
    position: 2,
    // c2 also revisits a file whose hunks live in c1.
    fileOrder: ["src/c.ts", "src/a.ts"],
    resurfaced: [{ hunkId: hunkId("h1"), note: { markdown: "Seen from here." } }],
  }),
];

const journey = makeJourney({ clusters, hunks });

describe("computeClusterProgress", () => {
  it("counts hunks, not files, so a dense file weighs more", () => {
    const progress = computeClusterProgress(
      clusters[0]!,
      hunks,
      new Set([markKey(clusterId("c1"), "src/a.ts")]),
    );
    assert.equal(progress.hunksTotal, 3);
    assert.equal(progress.hunksRead, 2);
    assert.equal(progress.filesTotal, 2);
    assert.equal(progress.filesRead, 1);
    assert.isFalse(progress.complete);
  });

  it("treats a resurfaced-only file as needing no mark", () => {
    const progress = computeClusterProgress(
      clusters[1]!,
      hunks,
      new Set([markKey(clusterId("c2"), "src/c.ts")]),
    );
    assert.equal(progress.filesTotal, 1, "only src/c.ts homes hunks here");
    assert.isTrue(progress.complete);
    const resurfacedFile = progress.files.find((file) => file.path === "src/a.ts");
    assert.isDefined(resurfacedFile);
    assert.isTrue(resurfacedFile.resurfacedOnly);
    assert.equal(resurfacedFile.homedHunks, 0);
  });

  it("marking a resurfaced-only file read changes nothing", () => {
    const withMark = computeClusterProgress(
      clusters[1]!,
      hunks,
      new Set([markKey(clusterId("c2"), "src/c.ts"), markKey(clusterId("c2"), "src/a.ts")]),
    );
    const withoutMark = computeClusterProgress(
      clusters[1]!,
      hunks,
      new Set([markKey(clusterId("c2"), "src/c.ts")]),
    );
    assert.equal(withMark.fraction, withoutMark.fraction);
    assert.equal(withMark.hunksRead, withoutMark.hunksRead);
  });

  it("returns files in narrative order", () => {
    const progress = computeClusterProgress(clusters[1]!, hunks, new Set());
    assert.deepEqual(
      progress.files.map((file) => file.path),
      ["src/c.ts", "src/a.ts"],
    );
  });

  it("accounts for a homed file the cluster forgot to list in fileOrder", () => {
    const forgetful = makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["src/a.ts"] });
    const progress = computeClusterProgress(
      forgetful,
      hunks,
      new Set([markKey(clusterId("c1"), "src/a.ts")]),
    );
    assert.equal(progress.hunksTotal, 3, "the denominator must never quietly shrink");
    assert.deepEqual(
      progress.files.map((file) => file.path),
      ["src/a.ts", "src/b.ts"],
    );
  });

  it("a cluster with no homed hunks reads as complete rather than dividing by zero", () => {
    const empty = makeCluster({ id: clusterId("c9"), position: 9 });
    const progress = computeClusterProgress(empty, hunks, new Set());
    assert.equal(progress.fraction, 1);
    assert.isTrue(progress.complete);
  });
});

describe("computeJourneyProgress", () => {
  it("is zero with no read state", () => {
    const progress = computeJourneyProgress(journey, null);
    assert.equal(progress.fraction, 0);
    assert.equal(progress.hunksTotal, 4);
    assert.equal(progress.currentClusterPosition, 1);
    assert.isFalse(progress.complete);
  });

  it("aggregates over hunks so clusters do not weigh equally", () => {
    // Finishing c2 (one hunk) is worth a quarter, not a half.
    const progress = computeJourneyProgress(
      journey,
      makeReadState("j1", [{ clusterId: "c2", path: "src/c.ts" }]),
    );
    assert.equal(progress.hunksRead, 1);
    assert.equal(progress.fraction, 0.25);
    assert.equal(progress.currentClusterPosition, 1, "c1 is still the first incomplete cluster");
  });

  it("reaches 100% exactly when every homed hunk has been acknowledged", () => {
    const progress = computeJourneyProgress(
      journey,
      makeReadState("j1", [
        { clusterId: "c1", path: "src/a.ts" },
        { clusterId: "c1", path: "src/b.ts" },
        { clusterId: "c2", path: "src/c.ts" },
      ]),
    );
    assert.equal(progress.hunksRead, progress.hunksTotal);
    assert.equal(progress.fraction, 1);
    assert.isTrue(progress.complete);
    assert.isNull(progress.currentClusterPosition);
  });

  it("ignores a mark made against a different cluster", () => {
    const progress = computeJourneyProgress(
      journey,
      makeReadState("j1", [{ clusterId: "c2", path: "src/a.ts" }]),
    );
    assert.equal(progress.hunksRead, 0, "src/a.ts is only countable in its home cluster");
  });

  it("orders clusters by position regardless of array order", () => {
    const reversed = makeJourney({ clusters: [clusters[1]!, clusters[0]!], hunks });
    const progress = computeJourneyProgress(reversed, null);
    assert.deepEqual(
      progress.clusters.map((cluster) => cluster.position),
      [1, 2],
    );
  });
});

describe("computeClusterScales", () => {
  it("derives files touched and hunks homed per cluster", () => {
    assert.deepEqual(computeClusterScales(journey), [
      { clusterId: clusterId("c1"), filesTouched: 2, hunksHomed: 3, resurfacedCount: 0 },
      { clusterId: clusterId("c2"), filesTouched: 1, hunksHomed: 1, resurfacedCount: 1 },
    ]);
  });
});

describe("toPercent", () => {
  it("rounds to whole percent", () => {
    assert.equal(toPercent(0), 0);
    assert.equal(toPercent(0.555), 56);
    assert.equal(toPercent(1), 100);
  });
});
