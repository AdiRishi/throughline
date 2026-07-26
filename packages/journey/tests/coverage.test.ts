import { assert, describe, it } from "@effect/vitest";

import type { ClusterId, HintId, Hunk, SeedHunk } from "@app/contracts";

import {
  formatViolations,
  isCovered,
  validateClusters,
  validateNarration,
  validatePartition,
} from "../src/coverage.ts";
import { makeEvidenceContext } from "../src/evidence.ts";
import { cluster, file, hunk, seed } from "./fixtures/journey.ts";

const kinds = (violations: ReadonlyArray<{ readonly kind: string }>) =>
  violations.map((violation) => violation.kind);

describe("validatePartition", () => {
  const seeds: ReadonlyArray<SeedHunk> = [
    seed({ id: "h1", path: "a.ts", oldStart: 10, oldLines: 3, newStart: 10, newLines: 2 }),
    seed({ id: "h2", path: "a.ts", oldStart: 40, oldLines: 0, newStart: 42, newLines: 4 }),
    seed({ id: "h3", path: "logo.png", fileKind: "binary" }),
  ];
  const files = [file("a.ts"), file("logo.png", { binary: true })];
  const clusters = [cluster({ id: "c1", position: 1, fileOrder: ["a.ts", "logo.png"] })];

  it("accepts an unsplit assignment of every seed", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 2,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    assert.isTrue(isCovered(validatePartition({ seeds, files, hunks, clusters })));
  });

  it("accepts a split that tiles both sides of its seed exactly", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1.1",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 1,
      }),
      hunk({
        id: "h1.2",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 12,
        oldLines: 1,
        newStart: 11,
        newLines: 1,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    assert.deepEqual(validatePartition({ seeds, files, hunks, clusters }), []);
  });

  it("reports the exact uncovered line range when a split leaves a gap", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1.1",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 2,
      }),
      hunk({
        id: "h1.2",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 12,
        oldLines: 1,
        newStart: 12,
        newLines: 0,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    const violations = validatePartition({ seeds, files, hunks, clusters });
    assert.include(kinds(violations), "split-does-not-tile-seed");
    assert.isTrue(
      violations.some((violation) => violation.message.includes("leaves lines 11–11 uncovered")),
      violations.map((violation) => violation.message).join(" | "),
    );
  });

  it("catches a split that covers a line twice", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1.1",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 1,
      }),
      hunk({
        id: "h1.2",
        seedId: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 12,
        oldLines: 1,
        newStart: 11,
        newLines: 1,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    const violations = validatePartition({ seeds, files, hunks, clusters });
    assert.isTrue(
      violations.some((violation) => violation.message.includes("covers line 12 twice")),
    );
  });

  it("reports an unassigned seed by name", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 2,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    const violations = validatePartition({ seeds, files, hunks, clusters });
    assert.include(kinds(violations), "hunk-unassigned");
    assert.isTrue(violations.some((violation) => violation.message.includes("h2")));
  });

  it("rejects a home that is not a cluster", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1",
        path: "a.ts",
        home: "c9",
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 2,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    assert.include(
      kinds(validatePartition({ seeds, files, hunks, clusters })),
      "hunk-unknown-home",
    );
  });

  it("refuses to let a file-level hunk be split", () => {
    const hunks: ReadonlyArray<Hunk> = [
      hunk({
        id: "h1",
        path: "a.ts",
        home: "c1",
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 2,
      }),
      hunk({
        id: "h2",
        path: "a.ts",
        home: "c1",
        oldStart: 40,
        oldLines: 0,
        newStart: 42,
        newLines: 4,
      }),
      hunk({ id: "h3.1", seedId: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
      hunk({ id: "h3.2", seedId: "h3", path: "logo.png", home: "c1", fileKind: "binary" }),
    ];
    assert.include(
      kinds(validatePartition({ seeds, files, hunks, clusters })),
      "split-of-file-hunk",
    );
  });

  it("notices a changed file that no hunk mentions", () => {
    const violations = validatePartition({
      seeds: [seeds[0]!],
      files,
      hunks: [
        hunk({
          id: "h1",
          path: "a.ts",
          home: "c1",
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 2,
        }),
      ],
      clusters,
    });
    assert.include(kinds(violations), "file-hunk-missing");
  });
});

describe("validateClusters", () => {
  it("accepts a well-formed journey", () => {
    const hunks = [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ];
    const clusters = [
      cluster({ id: "c1", position: 1, fileOrder: ["a.ts"] }),
      cluster({
        id: "c2",
        position: 2,
        buildsOn: ["c1"],
        fileOrder: ["b.ts", "a.ts"],
        resurfaced: [{ hunkId: "h1", note: "revisited" }],
      }),
    ];
    assert.deepEqual(validateClusters({ clusters, hunks }), []);
  });

  it("rejects gaps and repeats in cluster positions", () => {
    const hunks = [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ];
    const clusters = [
      cluster({ id: "c1", position: 1, fileOrder: ["a.ts"] }),
      cluster({ id: "c2", position: 3, fileOrder: ["b.ts"] }),
    ];
    assert.include(kinds(validateClusters({ clusters, hunks })), "cluster-order-invalid");
  });

  it("rejects building on a later cluster", () => {
    const hunks = [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ];
    const clusters = [
      cluster({ id: "c1", position: 1, buildsOn: ["c2"], fileOrder: ["a.ts"] }),
      cluster({ id: "c2", position: 2, fileOrder: ["b.ts"] }),
    ];
    assert.include(kinds(validateClusters({ clusters, hunks })), "builds-on-forward-reference");
  });

  it("rejects resurfacing a hunk whose home is this very cluster", () => {
    const hunks = [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ];
    const clusters = [
      cluster({
        id: "c1",
        position: 1,
        fileOrder: ["a.ts"],
        resurfaced: [{ hunkId: "h1", note: "n" }],
      }),
      cluster({ id: "c2", position: 2, fileOrder: ["b.ts"] }),
    ];
    assert.include(kinds(validateClusters({ clusters, hunks })), "resurfaced-at-home");
  });

  it("rejects resurfacing forwards — perspective is retrospective", () => {
    const hunks = [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ];
    const clusters = [
      cluster({
        id: "c1",
        position: 1,
        fileOrder: ["a.ts", "b.ts"],
        resurfaced: [{ hunkId: "h2", note: "n" }],
      }),
      cluster({ id: "c2", position: 2, fileOrder: ["b.ts"] }),
    ];
    assert.include(kinds(validateClusters({ clusters, hunks })), "resurfaced-forward-reference");
  });

  it("requires the file order to match exactly what the cluster shows", () => {
    const hunks = [hunk({ id: "h1", path: "a.ts", home: "c1" })];
    const missing = validateClusters({
      clusters: [cluster({ id: "c1", position: 1, fileOrder: [] })],
      hunks,
    });
    assert.include(kinds(missing), "file-order-mismatch");

    const extra = validateClusters({
      clusters: [cluster({ id: "c1", position: 1, fileOrder: ["a.ts", "unrelated.ts"] })],
      hunks,
    });
    assert.include(kinds(extra), "file-order-mismatch");
  });

  it("rejects a cluster that homes nothing", () => {
    const hunks = [hunk({ id: "h1", path: "a.ts", home: "c1" })];
    const clusters = [
      cluster({ id: "c1", position: 1, fileOrder: ["a.ts"] }),
      cluster({ id: "c2", position: 2, fileOrder: [] }),
    ];
    assert.include(kinds(validateClusters({ clusters, hunks })), "cluster-empty");
  });
});

describe("validateNarration", () => {
  const context = makeEvidenceContext({
    hunkIds: ["h1", "h2"],
    treePaths: ["a.ts", "b.ts"],
    lineCounts: [
      ["a.ts", { old: 20, new: 24 }],
      ["b.ts", { old: 0, new: 10 }],
    ],
    containsSymbol: (path, symbol) => path === "a.ts" && symbol === "issueToken",
  });

  const base = {
    hunks: [
      hunk({ id: "h1", path: "a.ts", home: "c1" }),
      hunk({ id: "h2", path: "b.ts", home: "c2" }),
    ],
    clusters: [
      cluster({ id: "c1", position: 1, fileOrder: ["a.ts"] }),
      cluster({ id: "c2", position: 2, fileOrder: ["b.ts"] }),
    ],
    overview: {
      brief: { markdown: "See [the token work](tl:hunk/h1)." },
      whereToBegin: { markdown: "Start at 1." },
    },
    hints: [],
  };

  it("accepts resolvable evidence of all three kinds", () => {
    const journey = {
      ...base,
      overview: {
        brief: {
          markdown:
            "It adds [issueToken](tl:symbol/a.ts#issueToken) in [a.ts](tl:file/a.ts), see tl:hunk/h1.",
        },
        whereToBegin: { markdown: "Start at 1." },
      },
    };
    assert.deepEqual(validateNarration(journey, context), []);
  });

  it("rejects a symbol that does not occur in the file", () => {
    const journey = {
      ...base,
      overview: {
        brief: { markdown: "See [mint](tl:symbol/a.ts#mintToken)." },
        whereToBegin: { markdown: "" },
      },
    };
    assert.include(kinds(validateNarration(journey, context)), "evidence-link-unresolvable");
  });

  it("rejects a hunk link with no such hunk", () => {
    const journey = {
      ...base,
      overview: { brief: { markdown: "See tl:hunk/h99." }, whereToBegin: { markdown: "" } },
    };
    assert.include(kinds(validateNarration(journey, context)), "evidence-link-unresolvable");
  });

  it("accepts a hint anchored inside its file", () => {
    const journey = {
      ...base,
      hints: [
        {
          id: "hint1" as HintId,
          clusterId: "c1" as ClusterId,
          kind: "connection" as const,
          anchor: { path: "a.ts", side: "new" as const, startLine: 3, endLine: 8 },
          body: { markdown: "the other half is in tl:file/b.ts" },
        },
      ],
    };
    assert.deepEqual(validateNarration(journey, context), []);
  });

  it("rejects a hint anchored past the end of its file", () => {
    const journey = {
      ...base,
      hints: [
        {
          id: "hint1" as HintId,
          clusterId: "c1" as ClusterId,
          kind: "ripple" as const,
          anchor: { path: "a.ts", side: "new" as const, startLine: 3, endLine: 900 },
          body: { markdown: "" },
        },
      ],
    };
    assert.include(kinds(validateNarration(journey, context)), "hint-anchor-out-of-range");
  });

  it("rejects a hint anchored to a side the file does not have", () => {
    const journey = {
      ...base,
      hints: [
        {
          id: "hint1" as HintId,
          clusterId: "c2" as ClusterId,
          kind: "ripple" as const,
          anchor: { path: "b.ts", side: "old" as const, startLine: 1, endLine: 1 },
          body: { markdown: "" },
        },
      ],
    };
    assert.include(kinds(validateNarration(journey, context)), "hint-anchor-out-of-range");
  });
});

describe("formatViolations", () => {
  it("numbers, deduplicates, and caps the list handed to a repair turn", () => {
    const many = Array.from({ length: 90 }, (_unused, index) => ({
      kind: "hunk-unassigned" as const,
      message: `Seed hunk h${index} is not assigned to any cluster.`,
      path: null,
      hunkId: null,
      clusterId: null,
    }));
    const duplicated = [...many, ...many];
    const formatted = formatViolations(duplicated, { limit: 5 });
    assert.strictEqual(formatted.split("\n").length, 6);
    assert.include(formatted, "1. [hunk-unassigned] Seed hunk h0");
    assert.include(formatted, "…and 85 more of the same kinds.");
  });
});
