import { assert, describe, it } from "@effect/vitest";

import type { ClusterId, JourneyId } from "@app/contracts";

import {
  clusterFractions,
  clusterScale,
  computeJourneyProgress,
  overallFraction,
} from "../src/progress.ts";
import { cluster, hunk } from "./fixtures/journey.ts";

const journey = {
  id: "j1" as JourneyId,
  clusters: [
    cluster({ id: "c1", position: 1, fileOrder: ["a.ts", "b.ts"] }),
    cluster({ id: "c2", position: 2, fileOrder: ["b.ts", "c.ts"] }),
  ],
  hunks: [
    hunk({ id: "h1", path: "a.ts", home: "c1", newStart: 1, newLines: 5 }),
    hunk({ id: "h2", path: "a.ts", home: "c1", newStart: 20, newLines: 3 }),
    hunk({ id: "h3", path: "b.ts", home: "c1", newStart: 1, newLines: 2 }),
    hunk({ id: "h4", path: "b.ts", home: "c2", newStart: 50, newLines: 1 }),
    hunk({ id: "h5", path: "c.ts", home: "c2", newStart: 1, newLines: 9 }),
  ],
};

const marks = (...pairs: ReadonlyArray<readonly [string, string]>) => ({
  readFiles: pairs.map(([clusterId, path]) => ({ clusterId: clusterId as ClusterId, path })),
});

describe("computeJourneyProgress", () => {
  it("starts at zero with no read state at all", () => {
    const progress = computeJourneyProgress(journey, null);
    assert.strictEqual(progress.hunksRead, 0);
    assert.strictEqual(progress.hunksHomed, 5);
    assert.strictEqual(progress.filesTotal, 3);
    assert.strictEqual(progress.filesRead, 0);
    assert.strictEqual(progress.currentClusterPosition, 1);
    assert.isFalse(progress.complete);
  });

  it("marks every homed hunk in a file when that file is read in that cluster", () => {
    const progress = computeJourneyProgress(journey, marks(["c1", "a.ts"]));
    const first = progress.clusters[0]!;
    assert.strictEqual(first.hunksRead, 2);
    assert.strictEqual(first.filesRead, 1);
    assert.strictEqual(first.filesTotal, 2);
    assert.isFalse(first.complete);
  });

  it("counts a file as read for the journey only when every cluster that homes it is read", () => {
    // b.ts is homed in both clusters; reading it in c1 alone must not count it.
    const partial = computeJourneyProgress(journey, marks(["c1", "b.ts"]));
    assert.strictEqual(partial.filesRead, 0);

    const both = computeJourneyProgress(journey, marks(["c1", "b.ts"], ["c2", "b.ts"]));
    assert.strictEqual(both.filesRead, 1);
  });

  it("advances the current cluster as earlier ones complete", () => {
    const progress = computeJourneyProgress(journey, marks(["c1", "a.ts"], ["c1", "b.ts"]));
    assert.isTrue(progress.clusters[0]!.complete);
    assert.strictEqual(progress.currentClusterPosition, 2);
  });

  it("finishes the journey only when every cluster is complete", () => {
    const progress = computeJourneyProgress(
      journey,
      marks(["c1", "a.ts"], ["c1", "b.ts"], ["c2", "b.ts"], ["c2", "c.ts"]),
    );
    assert.isTrue(progress.complete);
    assert.isNull(progress.currentClusterPosition);
    assert.strictEqual(progress.hunksRead, progress.hunksHomed);
    assert.strictEqual(progress.filesRead, progress.filesTotal);
  });

  it("ignores marks that name a cluster/file pair the journey does not have", () => {
    const progress = computeJourneyProgress(journey, marks(["c2", "a.ts"], ["c9", "zzz.ts"]));
    assert.strictEqual(progress.hunksRead, 0);
  });

  it("reports the headline fraction in hunks and the tangible count in files", () => {
    const progress = computeJourneyProgress(journey, marks(["c1", "a.ts"], ["c1", "b.ts"]));
    assert.strictEqual(progress.hunksRead, 3);
    assert.strictEqual(overallFraction(progress), 3 / 5);
    assert.deepEqual(clusterFractions(progress), [1, 0]);
  });

  it("treats a journey with no clusters as incomplete rather than finished", () => {
    const empty = computeJourneyProgress({ id: "j1" as JourneyId, clusters: [], hunks: [] }, null);
    assert.isFalse(empty.complete);
  });
});

describe("clusterScale", () => {
  it("derives files touched, hunks homed, and changed lines", () => {
    const scale = clusterScale(journey.clusters[0]!, journey.hunks);
    assert.deepEqual(scale, { filesTouched: 2, hunksHomed: 3, changedLines: 10 });
  });

  it("counts resurfaced hunks nowhere but home", () => {
    const withResurfacing = cluster({
      id: "c2",
      position: 2,
      fileOrder: ["b.ts", "c.ts", "a.ts"],
      resurfaced: [{ hunkId: "h1", note: "revisited" }],
    });
    assert.strictEqual(clusterScale(withResurfacing, journey.hunks).hunksHomed, 2);
  });
});
