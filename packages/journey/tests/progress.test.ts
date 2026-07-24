import { assert, describe, it } from "@effect/vitest";

import type { Journey, ReadState } from "@app/contracts";

import { deriveProgress } from "../src/progress.ts";

const makeProgressJourney = (): Journey =>
  ({
    id: "journey-progress",
    clusters: [
      { id: "c1", resurfaced: [] },
      { id: "c2", resurfaced: [{ hunkId: "h1" }] },
    ],
    hunks: [
      { id: "h1", home: "c1", path: "a.ts" },
      { id: "h2", home: "c1", path: "a.ts" },
      { id: "h3", home: "c1", path: "a.ts" },
      { id: "h4", home: "c1", path: "b.bin", fileKind: "binary" },
      { id: "h5", home: "c2", path: "a.ts" },
      { id: "h6", home: "c2", path: "a.ts" },
    ],
  }) as unknown as Journey;

const readState = (readFiles: ReadState["readFiles"], journeyId = "journey-progress"): ReadState =>
  ({
    journeyId,
    readFiles,
    displayMode: "inline",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }) as unknown as ReadState;

describe("deriveProgress", () => {
  it("weights progress by homed hunks while marks remain cluster-path specific", () => {
    const journey = makeProgressJourney();
    const c1A = {
      clusterId: "c1",
      path: "a.ts",
    } as ReadState["readFiles"][number];
    const c2A = {
      clusterId: "c2",
      path: "a.ts",
    } as ReadState["readFiles"][number];
    const c1Binary = {
      clusterId: "c1",
      path: "b.bin",
    } as ReadState["readFiles"][number];

    const afterFirstFile = deriveProgress(journey, readState([c1A]));
    assert.deepInclude(afterFirstFile.journey, {
      readHunks: 3,
      totalHunks: 6,
      fraction: 0.5,
      markedFiles: 1,
      clusterFiles: 3,
      complete: false,
    });
    assert.deepInclude(afterFirstFile.clusters[0]!, {
      readHunks: 3,
      totalHunks: 4,
      fraction: 0.75,
    });
    assert.deepInclude(afterFirstFile.clusters[1]!, {
      readHunks: 0,
      totalHunks: 2,
      fraction: 0,
    });

    const afterSamePathOtherCluster = deriveProgress(journey, readState([c1A, c2A]));
    assert.strictEqual(afterSamePathOtherCluster.journey.readHunks, 5);
    assert.strictEqual(afterSamePathOtherCluster.clusters[1]!.readHunks, 2);

    const complete = deriveProgress(journey, readState([c1A, c2A, c1Binary]));
    assert.deepInclude(complete.journey, {
      readHunks: 6,
      totalHunks: 6,
      fraction: 1,
      complete: true,
    });
  });

  it("ignores duplicate, unknown, and wrong-journey marks", () => {
    const journey = makeProgressJourney();
    const valid = {
      clusterId: "c1",
      path: "a.ts",
    } as ReadState["readFiles"][number];
    const unknown = {
      clusterId: "c404",
      path: "a.ts",
    } as ReadState["readFiles"][number];

    assert.strictEqual(
      deriveProgress(journey, readState([valid, valid, unknown])).journey.readHunks,
      3,
    );
    assert.deepInclude(deriveProgress(journey, readState([valid], "different-journey")).journey, {
      readHunks: 0,
      markedFiles: 0,
      fraction: 0,
      complete: false,
    });
  });

  it("aggregates hunk totals instead of averaging cluster percentages", () => {
    const journey = {
      ...makeProgressJourney(),
      hunks: [
        { id: "h1", home: "c1", path: "small.ts" },
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `h${index + 2}`,
          home: "c2",
          path: `large-${index}.ts`,
        })),
      ],
    } as unknown as Journey;
    const mark = {
      clusterId: "c1",
      path: "small.ts",
    } as ReadState["readFiles"][number];

    const result = deriveProgress(journey, readState([mark]));

    assert.strictEqual(result.clusters[0]!.fraction, 1);
    assert.strictEqual(result.clusters[1]!.fraction, 0);
    assert.strictEqual(result.journey.fraction, 0.1);
  });
});
