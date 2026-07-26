import { assert, describe, it } from "@effect/vitest";

import {
  formatViolations,
  validateClusters,
  validateEvidence,
  validateHints,
  validateHunkPartition,
  validateJourney,
  validateLineCoverage,
  validateResurfacing,
  type Violation,
} from "../src/coverage.ts";
import { deriveDiffIndex, type SeedHunk } from "../src/hunks.ts";
import { materializePlan } from "../src/plan.ts";
import {
  clusterId,
  hunkId,
  makeCluster,
  makeHunk,
  makeJourney,
  SAMPLE_DIFF,
  treeOf,
} from "./fixtures.ts";

const codes = (violations: ReadonlyArray<Violation>) => violations.map((entry) => entry.code);

const seed = (overrides: Partial<SeedHunk> & Pick<SeedHunk, "id" | "path">): SeedHunk => ({
  oldStart: 0,
  oldLines: 0,
  newStart: 1,
  newLines: 1,
  fileKind: undefined,
  ...overrides,
});

describe("validateHunkPartition", () => {
  const seeds = [
    seed({ id: hunkId("h1"), path: "a.ts", oldStart: 10, oldLines: 4, newStart: 10, newLines: 6 }),
    seed({ id: hunkId("h2"), path: "b.ts", fileKind: "binary", newStart: 0, newLines: 0 }),
  ];
  const clusterIds = new Set(["c1", "c2"]);

  it("accepts a partition where every seed is homed unsplit", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.deepEqual(validateHunkPartition({ seeds, hunks, clusterIds }), []);
  });

  it("accepts a split that tiles its seed exactly", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1.1"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
      }),
      makeHunk({
        id: hunkId("h1.2"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c2"),
        oldStart: 11,
        oldLines: 3,
        newStart: 12,
        newLines: 4,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.deepEqual(validateHunkPartition({ seeds, hunks, clusterIds }), []);
  });

  it("rejects a split that leaves lines uncovered", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1.1"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    const violations = validateHunkPartition({ seeds, hunks, clusterIds });
    assert.include(codes(violations), "seed-split-mismatch");
  });

  it("rejects an unassigned seed by name", () => {
    const violations = validateHunkPartition({ seeds, hunks: [], clusterIds });
    assert.deepEqual(codes(violations), ["seed-unassigned", "seed-unassigned"]);
    assert.include(violations[0]?.message ?? "", "h1");
  });

  it("rejects a home that is not a cluster", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1"),
        path: "a.ts",
        home: clusterId("nope"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.include(codes(validateHunkPartition({ seeds, hunks, clusterIds })), "hunk-unknown-home");
  });

  it("refuses to let a file-level hunk be split", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h2.1"),
        seedId: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c1"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
      makeHunk({
        id: hunkId("h2.2"),
        seedId: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.include(
      codes(validateHunkPartition({ seeds, hunks, clusterIds })),
      "file-level-hunk-split",
    );
  });

  it("rejects a hunk whose path disagrees with its seed", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1"),
        path: "elsewhere.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.include(
      codes(validateHunkPartition({ seeds, hunks, clusterIds })),
      "hunk-path-mismatch",
    );
  });

  it("rejects a duplicate hunk id", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c2"),
        oldStart: 10,
        oldLines: 4,
        newStart: 10,
        newLines: 6,
      }),
      makeHunk({
        id: hunkId("h2"),
        path: "b.ts",
        home: clusterId("c2"),
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.include(codes(validateHunkPartition({ seeds, hunks, clusterIds })), "hunk-duplicate-id");
  });
});

describe("validateLineCoverage", () => {
  const seeds = [
    seed({ id: hunkId("h1"), path: "a.ts", oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 }),
  ];

  it("names the exact uncovered lines", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1.1"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
      }),
    ];
    const violations = validateLineCoverage({ seeds, hunks });
    const messages = violations.map((entry) => entry.message);
    assert.isTrue(messages.some((message) => message.includes("lines 2–3")));
  });

  it("catches a line covered twice", () => {
    const hunks = [
      makeHunk({
        id: hunkId("h1.1"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c1"),
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
      }),
      makeHunk({
        id: hunkId("h1.2"),
        seedId: hunkId("h1"),
        path: "a.ts",
        home: clusterId("c2"),
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
      }),
    ];
    assert.include(codes(validateLineCoverage({ seeds, hunks })), "line-double-covered");
  });

  it("requires exactly one file-level hunk per file-level seed", () => {
    const fileSeeds = [
      seed({
        id: hunkId("h1"),
        path: "logo.png",
        fileKind: "binary",
        newStart: 0,
        newLines: 0,
      }),
    ];
    assert.include(codes(validateLineCoverage({ seeds: fileSeeds, hunks: [] })), "line-uncovered");
  });

  it("passes for a real diff materialized through the planner", () => {
    const { seeds: realSeeds } = deriveDiffIndex(SAMPLE_DIFF);
    const plan = materializePlan(realSeeds, {
      clusters: [{ id: "c1", title: "Everything", weight: "core" }],
      assignments: realSeeds.map((entry) => ({ hunkId: entry.id, home: "c1" })),
    });
    assert.deepEqual(validateLineCoverage({ seeds: realSeeds, hunks: plan.hunks }), []);
  });
});

describe("validateClusters", () => {
  it("accepts a well-formed sequence", () => {
    const hunks = [
      makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") }),
      makeHunk({ id: hunkId("h2"), path: "b.ts", home: clusterId("c2") }),
    ];
    const clusters = [
      makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] }),
      makeCluster({
        id: clusterId("c2"),
        position: 2,
        fileOrder: ["b.ts"],
        buildsOn: [clusterId("c1")],
      }),
    ];
    assert.deepEqual(validateClusters(clusters, hunks), []);
  });

  it("rejects an empty journey", () => {
    assert.deepEqual(codes(validateClusters([], [])), ["cluster-none"]);
  });

  it("rejects a gap in positions", () => {
    const hunks = [makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") })];
    const clusters = [makeCluster({ id: clusterId("c1"), position: 2, fileOrder: ["a.ts"] })];
    assert.include(codes(validateClusters(clusters, hunks)), "cluster-position-invalid");
  });

  it("rejects building on a later cluster", () => {
    const hunks = [
      makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") }),
      makeHunk({ id: hunkId("h2"), path: "b.ts", home: clusterId("c2") }),
    ];
    const clusters = [
      makeCluster({
        id: clusterId("c1"),
        position: 1,
        fileOrder: ["a.ts"],
        buildsOn: [clusterId("c2")],
      }),
      makeCluster({ id: clusterId("c2"), position: 2, fileOrder: ["b.ts"] }),
    ];
    assert.include(codes(validateClusters(clusters, hunks)), "cluster-builds-on-forward");
  });

  it("rejects a cluster with nothing homed to it", () => {
    const hunks = [makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") })];
    const clusters = [
      makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] }),
      makeCluster({ id: clusterId("c2"), position: 2 }),
    ];
    assert.include(codes(validateClusters(clusters, hunks)), "cluster-empty");
  });

  it("rejects a fileOrder that omits a file it shows", () => {
    const hunks = [
      makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") }),
      makeHunk({ id: hunkId("h2"), path: "b.ts", home: clusterId("c1") }),
    ];
    const clusters = [makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] })];
    assert.include(codes(validateClusters(clusters, hunks)), "cluster-file-order-missing");
  });

  it("rejects a fileOrder that lists a file it does not show", () => {
    const hunks = [makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") })];
    const clusters = [
      makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts", "ghost.ts"] }),
    ];
    assert.include(codes(validateClusters(clusters, hunks)), "cluster-file-order-extra");
  });
});

describe("validateResurfacing", () => {
  const hunks = [
    makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") }),
    makeHunk({ id: hunkId("h2"), path: "b.ts", home: clusterId("c2") }),
  ];

  it("accepts revisiting an earlier cluster's hunk with a note", () => {
    const clusters = [
      makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] }),
      makeCluster({
        id: clusterId("c2"),
        position: 2,
        fileOrder: ["b.ts", "a.ts"],
        resurfaced: [{ hunkId: hunkId("h1"), note: { markdown: "Why it comes back." } }],
      }),
    ];
    assert.deepEqual(validateResurfacing(clusters, hunks), []);
  });

  it("rejects resurfacing a hunk that lives here", () => {
    const clusters = [
      makeCluster({
        id: clusterId("c1"),
        position: 1,
        fileOrder: ["a.ts"],
        resurfaced: [{ hunkId: hunkId("h1"), note: { markdown: "note" } }],
      }),
    ];
    assert.include(codes(validateResurfacing(clusters, hunks)), "resurfaced-home-is-self");
  });

  it("rejects resurfacing forward in the journey", () => {
    const clusters = [
      makeCluster({
        id: clusterId("c1"),
        position: 1,
        fileOrder: ["a.ts", "b.ts"],
        resurfaced: [{ hunkId: hunkId("h2"), note: { markdown: "note" } }],
      }),
      makeCluster({ id: clusterId("c2"), position: 2, fileOrder: ["b.ts"] }),
    ];
    assert.include(codes(validateResurfacing(clusters, hunks)), "resurfaced-home-not-earlier");
  });

  it("rejects an unknown resurfaced hunk", () => {
    const clusters = [
      makeCluster({
        id: clusterId("c1"),
        position: 1,
        fileOrder: ["a.ts"],
        resurfaced: [{ hunkId: hunkId("h99"), note: { markdown: "note" } }],
      }),
    ];
    assert.include(codes(validateResurfacing(clusters, hunks)), "resurfaced-unknown-hunk");
  });

  it("rejects an empty resurfacing note", () => {
    const clusters = [
      makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] }),
      makeCluster({
        id: clusterId("c2"),
        position: 2,
        fileOrder: ["b.ts", "a.ts"],
        resurfaced: [{ hunkId: hunkId("h1"), note: { markdown: "  " } }],
      }),
    ];
    assert.include(codes(validateResurfacing(clusters, hunks)), "narrative-empty");
  });
});

describe("validateHints", () => {
  const clusters = [makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] })];
  const tree = treeOf({ lineCounts: { "a.ts": { old: 10, new: 12 } } });

  const hint = (overrides: Record<string, unknown>) =>
    ({
      id: "t1",
      clusterId: clusterId("c1"),
      kind: "connection",
      anchor: { path: "a.ts", side: "new", startLine: 1, endLine: 2 },
      body: { markdown: "A connection." },
      ...overrides,
    }) as Parameters<typeof validateHints>[0][number];

  it("accepts an in-range anchor", () => {
    assert.deepEqual(validateHints([hint({})], clusters, tree), []);
  });

  it("accepts an anchor on unchanged lines within the file", () => {
    assert.deepEqual(
      validateHints(
        [hint({ anchor: { path: "a.ts", side: "new", startLine: 11, endLine: 12 } })],
        clusters,
        tree,
      ),
      [],
    );
  });

  it("rejects an anchor past the end of its side", () => {
    assert.include(
      codes(
        validateHints(
          [hint({ anchor: { path: "a.ts", side: "old", startLine: 9, endLine: 20 } })],
          clusters,
          tree,
        ),
      ),
      "hint-anchor-out-of-range",
    );
  });

  it("rejects a backwards anchor", () => {
    assert.include(
      codes(
        validateHints(
          [hint({ anchor: { path: "a.ts", side: "new", startLine: 5, endLine: 2 } })],
          clusters,
          tree,
        ),
      ),
      "hint-anchor-inverted",
    );
  });

  it("rejects an anchor into a file that is not in the pinned revision", () => {
    assert.include(
      codes(
        validateHints(
          [hint({ anchor: { path: "ghost.ts", side: "new", startLine: 1, endLine: 1 } })],
          clusters,
          tree,
        ),
      ),
      "hint-anchor-unknown-file",
    );
  });

  it("rejects a hint riding an unknown cluster", () => {
    assert.include(
      codes(validateHints([hint({ clusterId: clusterId("c9") })], clusters, tree)),
      "hint-unknown-cluster",
    );
  });
});

describe("validateEvidence", () => {
  const journey = makeJourney({
    clusters: [makeCluster({ id: clusterId("c1"), position: 1, fileOrder: ["a.ts"] })],
    hunks: [makeHunk({ id: hunkId("h1"), path: "a.ts", home: clusterId("c1") })],
  });
  const tree = treeOf({
    paths: ["a.ts"],
    lineCounts: { "a.ts": { old: 10, new: 12 } },
    symbols: { "a.ts": ["issueToken"] },
  });

  it("accepts links that resolve", () => {
    const withEvidence = makeJourney({
      ...journey,
      clusters: [
        makeCluster({
          id: clusterId("c1"),
          position: 1,
          fileOrder: ["a.ts"],
          narrative: {
            markdown:
              "The [guard](tl:file/a.ts) calls [issueToken](tl:symbol/a.ts#issueToken) in tl:hunk/h1.",
          },
        }),
      ],
    });
    assert.deepEqual(validateEvidence(withEvidence, tree), []);
  });

  it("rejects a hunk link that names no hunk", () => {
    const bad = makeJourney({
      ...journey,
      clusters: [
        makeCluster({
          id: clusterId("c1"),
          position: 1,
          fileOrder: ["a.ts"],
          narrative: { markdown: "See tl:hunk/h404." },
        }),
      ],
    });
    assert.include(codes(validateEvidence(bad, tree)), "evidence-unresolved-hunk");
  });

  it("rejects a symbol link whose text does not occur in the file", () => {
    const bad = makeJourney({
      ...journey,
      clusters: [
        makeCluster({
          id: clusterId("c1"),
          position: 1,
          fileOrder: ["a.ts"],
          narrative: { markdown: "See [x](tl:symbol/a.ts#neverWritten)." },
        }),
      ],
    });
    assert.include(codes(validateEvidence(bad, tree)), "evidence-unresolved-symbol");
  });

  it("rejects an empty narrative", () => {
    const bad = makeJourney({
      ...journey,
      clusters: [
        makeCluster({
          id: clusterId("c1"),
          position: 1,
          fileOrder: ["a.ts"],
          narrative: { markdown: "" },
        }),
      ],
    });
    assert.include(codes(validateEvidence(bad, tree)), "narrative-empty");
  });
});

describe("validateJourney", () => {
  it("accepts an end-to-end journey built from a real diff", () => {
    const { seeds } = deriveDiffIndex(SAMPLE_DIFF);
    const plan = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "The auth module", weight: "core" },
        { id: "c2", title: "Everything else", weight: "supporting" },
      ],
      assignments: seeds.map((entry, index) => ({
        hunkId: entry.id,
        home: index === 0 ? "c1" : "c2",
      })),
    });
    const journey = makeJourney({
      clusters: plan.clusters.map((cluster) =>
        makeCluster({ ...cluster, fileOrder: cluster.fileOrder }),
      ),
      hunks: plan.hunks,
    });
    const tree = treeOf({ paths: [...new Set(plan.hunks.map((hunk) => hunk.path))] });
    assert.deepEqual(validateJourney(journey, { seeds, tree }), []);
  });
});

describe("formatViolations", () => {
  it("numbers messages and truncates honestly", () => {
    const many: Violation[] = Array.from({ length: 5 }, (_unused, index) => ({
      code: "seed-unassigned",
      message: `h${index + 1} has no home cluster`,
    }));
    const text = formatViolations(many, 2);
    assert.include(text, "1. h1 has no home cluster");
    assert.include(text, "and 3 more");
  });
});
