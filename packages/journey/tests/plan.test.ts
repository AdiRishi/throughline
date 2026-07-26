import { assert, describe, it } from "@effect/vitest";

import { validateJourney } from "../src/coverage.ts";
import { deriveDiffIndex, type SeedHunk } from "../src/hunks.ts";
import {
  assembleNarration,
  degenerateClusters,
  degeneratePlan,
  firstSentences,
  materializePlan,
} from "../src/plan.ts";
import { hunkId, makeJourney, SAMPLE_DIFF, treeOf } from "./fixtures.ts";

const seed = (overrides: Partial<SeedHunk> & Pick<SeedHunk, "id" | "path">): SeedHunk => ({
  oldStart: 0,
  oldLines: 0,
  newStart: 1,
  newLines: 1,
  fileKind: undefined,
  ...overrides,
});

const seeds: ReadonlyArray<SeedHunk> = [
  seed({
    id: hunkId("h1"),
    path: "src/a.ts",
    oldStart: 10,
    oldLines: 4,
    newStart: 10,
    newLines: 6,
  }),
  seed({ id: hunkId("h2"), path: "src/b.ts", oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }),
  seed({ id: hunkId("h3"), path: "docs/logo.png", fileKind: "binary", newStart: 0, newLines: 0 }),
];

describe("materializePlan", () => {
  it("homes every seed the plan assigns", () => {
    const result = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "First", weight: "core" },
        { id: "c2", title: "Second", weight: "mechanical" },
      ],
      assignments: [
        { hunkId: "h1", home: "c1" },
        { hunkId: "h2", home: "c1" },
        { hunkId: "h3", home: "c2" },
      ],
    });
    assert.deepEqual(result.fallbacks, []);
    assert.deepEqual(
      result.hunks.map((hunk) => [hunk.id, hunk.home]),
      [
        ["h1", "c1"],
        ["h2", "c1"],
        ["h3", "c2"],
      ],
    );
    assert.deepEqual(
      result.clusters.map((cluster) => [cluster.id, cluster.position, cluster.weight]),
      [
        ["c1", 1, "core"],
        ["c2", 2, "mechanical"],
      ],
    );
  });

  it("computes split start lines from a cursor rather than trusting the agent", () => {
    const result = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "First", weight: "core" },
        { id: "c2", title: "Second", weight: "core" },
      ],
      assignments: [
        { hunkId: "h2", home: "c1" },
        { hunkId: "h3", home: "c1" },
      ],
      splits: [
        {
          seedId: "h1",
          parts: [
            { oldLines: 1, newLines: 2, home: "c1" },
            { oldLines: 3, newLines: 4, home: "c2" },
          ],
        },
      ],
    });
    const parts = result.hunks.filter((hunk) => hunk.seedId === "h1");
    assert.deepEqual(
      parts.map((part) => [part.id, part.oldStart, part.oldLines, part.newStart, part.newLines]),
      [
        ["h1.1", 10, 1, 10, 2],
        ["h1.2", 11, 3, 12, 4],
      ],
    );
    assert.deepEqual(result.fallbacks, []);
  });

  it("collapses a split whose line counts do not add up to the seed", () => {
    const result = materializePlan(seeds, {
      clusters: [{ id: "c1", title: "First", weight: "core" }],
      assignments: seeds.map((entry) => ({ hunkId: entry.id, home: "c1" })),
      splits: [
        {
          seedId: "h1",
          parts: [
            { oldLines: 1, newLines: 1, home: "c1" },
            { oldLines: 1, newLines: 1, home: "c1" },
          ],
        },
      ],
    });
    assert.equal(result.hunks.filter((hunk) => hunk.seedId === "h1").length, 1);
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("collapsed an invalid split")));
  });

  it("refuses to split a file-level hunk", () => {
    const result = materializePlan(seeds, {
      clusters: [{ id: "c1", title: "First", weight: "core" }],
      assignments: seeds.map((entry) => ({ hunkId: entry.id, home: "c1" })),
      splits: [
        {
          seedId: "h3",
          parts: [
            { oldLines: 0, newLines: 0, home: "c1" },
            { oldLines: 0, newLines: 0, home: "c1" },
          ],
        },
      ],
    });
    assert.equal(result.hunks.filter((hunk) => hunk.seedId === "h3").length, 1);
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("binary change")));
  });

  it("homes unassigned hunks in a synthesized final cluster", () => {
    const result = materializePlan(seeds, {
      clusters: [{ id: "c1", title: "First", weight: "core" }],
      assignments: [{ hunkId: "h1", home: "c1" }],
    });
    const unplaced = result.clusters.at(-1);
    assert.isDefined(unplaced);
    assert.equal(unplaced.title, "Unplaced changes");
    assert.equal(unplaced.weight, "supporting");
    const homes = new Set(
      result.hunks.filter((hunk) => hunk.id !== "h1").map((hunk) => hunk.home as string),
    );
    assert.deepEqual([...homes], [unplaced.id]);
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("Unplaced changes")));
  });

  it("names the unplaced cluster around an existing id collision", () => {
    const result = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "First", weight: "core" },
        { id: "c2", title: "Second", weight: "core" },
      ],
      assignments: [
        { hunkId: "h1", home: "c1" },
        { hunkId: "h2", home: "c2" },
      ],
    });
    const ids = result.clusters.map((cluster) => cluster.id as string);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ["c1", "c2", "c3"]);
  });

  it("drops a cluster nothing landed in and renumbers the rest", () => {
    const result = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "First", weight: "core" },
        { id: "ghost", title: "Empty", weight: "core" },
        { id: "c3", title: "Third", weight: "core", buildsOn: ["ghost", "c1"] },
      ],
      assignments: [
        { hunkId: "h1", home: "c1" },
        { hunkId: "h2", home: "c3" },
        { hunkId: "h3", home: "c3" },
      ],
    });
    assert.deepEqual(
      result.clusters.map((cluster) => [cluster.id, cluster.position]),
      [
        ["c1", 1],
        ["c3", 2],
      ],
    );
    assert.deepEqual(
      result.clusters[1]?.buildsOn.map((id) => id as string),
      ["c1"],
      "the dropped id is filtered out",
    );
  });

  it("filters a forward buildsOn reference", () => {
    const result = materializePlan(seeds, {
      clusters: [
        { id: "c1", title: "First", weight: "core", buildsOn: ["c2"] },
        { id: "c2", title: "Second", weight: "core" },
      ],
      assignments: [
        { hunkId: "h1", home: "c1" },
        { hunkId: "h2", home: "c2" },
        { hunkId: "h3", home: "c2" },
      ],
    });
    assert.deepEqual(result.clusters[0]?.buildsOn, []);
  });

  it("reconciles fileOrder: keeps valid order, appends what was forgotten, drops ghosts", () => {
    const result = materializePlan(seeds, {
      clusters: [
        {
          id: "c1",
          title: "First",
          weight: "core",
          fileOrder: ["src/b.ts", "does/not/exist.ts"],
        },
      ],
      assignments: seeds.map((entry) => ({ hunkId: entry.id, home: "c1" })),
    });
    assert.deepEqual(result.clusters[0]?.fileOrder, ["src/b.ts", "src/a.ts", "docs/logo.png"]);
  });

  it("ignores an assignment to an unknown cluster and reports it", () => {
    const result = materializePlan(seeds, {
      clusters: [{ id: "c1", title: "First", weight: "core" }],
      assignments: [
        { hunkId: "h1", home: "nope" },
        { hunkId: "h2", home: "c1" },
        { hunkId: "h3", home: "c1" },
      ],
    });
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("unknown cluster nope")));
    assert.equal(result.clusters.length, 2, "h1 lands in the synthesized cluster");
  });

  it("normalizes an unrecognized weight to supporting rather than failing", () => {
    const result = materializePlan(seeds, {
      clusters: [{ id: "c1", title: "First", weight: "CRITICAL" }],
      assignments: seeds.map((entry) => ({ hunkId: entry.id, home: "c1" })),
    });
    assert.equal(result.clusters[0]?.weight, "supporting");
  });

  it("falls all the way back to the degenerate partition on an empty plan", () => {
    const result = materializePlan(seeds, {});
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("top-level directory")));
    assert.isAbove(result.clusters.length, 0);
    assert.equal(result.hunks.length, seeds.length);
  });

  it("produces a journey that passes validation from any garbage input", () => {
    const { seeds: realSeeds, files } = deriveDiffIndex(SAMPLE_DIFF);
    const garbage = {
      clusters: [
        { id: "", title: "no id", weight: "core" },
        { id: "c1", title: "", weight: "core" },
        { id: "c1", title: "dupe", weight: "core" },
      ],
      assignments: [{ hunkId: "h999", home: "c1" }],
      splits: [{ seedId: "h1", parts: [{ oldLines: 99, newLines: 99, home: "c1" }] }],
    };
    const plan = materializePlan(realSeeds, garbage);
    const narration = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree: treeOf({ paths: files.map((file) => file.path) }),
      narrationByCluster: new Map(),
      overview: {},
    });
    const journey = makeJourney({ clusters: narration.clusters, hunks: plan.hunks, files });
    const violations = validateJourney(journey, {
      seeds: realSeeds,
      tree: treeOf({ paths: files.map((file) => file.path) }),
    });
    assert.deepEqual(violations, [], "the floor must always produce a valid journey");
  });
});

describe("degenerateClusters", () => {
  it("groups by top-level directory, sorted, with a root bucket", () => {
    const { seeds: realSeeds } = deriveDiffIndex(SAMPLE_DIFF);
    const groups = degenerateClusters(realSeeds);
    assert.deepEqual(
      groups.map((group) => group.title),
      ["Changes in docs/", "Changes in scripts/", "Changes in src/"],
    );
  });

  it("puts root-level files in their own bucket first", () => {
    const rootSeeds = [seed({ id: hunkId("h1"), path: "README.md" })];
    assert.deepEqual(
      degenerateClusters(rootSeeds).map((group) => group.title),
      ["Changes at the repository root"],
    );
  });
});

describe("degeneratePlan", () => {
  it("assigns every seed a home", () => {
    const { seeds: realSeeds } = deriveDiffIndex(SAMPLE_DIFF);
    const plan = degeneratePlan(realSeeds);
    const result = materializePlan(realSeeds, plan);
    assert.deepEqual(result.fallbacks, []);
    assert.equal(result.hunks.length, realSeeds.length);
  });
});

describe("assembleNarration", () => {
  const plan = materializePlan(seeds, {
    clusters: [
      { id: "c1", title: "First", weight: "core", fileOrder: ["src/a.ts"] },
      { id: "c2", title: "Second", weight: "supporting" },
    ],
    assignments: [
      { hunkId: "h1", home: "c1" },
      { hunkId: "h2", home: "c2" },
      { hunkId: "h3", home: "c2" },
    ],
  });
  const tree = treeOf({
    paths: ["src/a.ts", "src/b.ts", "docs/logo.png"],
    lineCounts: { "src/a.ts": { old: 20, new: 22 }, "src/b.ts": { old: 0, new: 2 } },
    symbols: { "src/a.ts": ["issueToken"] },
  });

  it("carries through good narration untouched", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map([
        [
          "c1",
          {
            narrative: "It builds [the token path](tl:symbol/src/a.ts#issueToken).",
            mapEntry: "Token issuance.",
          },
        ],
      ]),
      overview: { brief: "A brief.", whereToBegin: "Start at 1." },
    });
    assert.deepEqual(
      result.fallbacks.filter((entry) => entry.includes("c1")),
      [],
    );
    assert.equal(
      result.clusters[0]?.narrative.markdown,
      "It builds [the token path](tl:symbol/src/a.ts#issueToken).",
    );
  });

  it("synthesizes an honest narrative when the harness returned none", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map(),
      overview: {},
    });
    assert.include(result.clusters[0]?.narrative.markdown ?? "", "did not return a narrative");
    assert.include(result.clusters[0]?.narrative.markdown ?? "", "still counts toward coverage");
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("no narrative")));
  });

  it("downgrades an unresolvable evidence link to plain text and records the loss", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map([
        ["c1", { narrative: "See [the ghost](tl:file/ghost.ts).", mapEntry: "x." }],
      ]),
      overview: { brief: "b", whereToBegin: "w" },
    });
    assert.equal(result.clusters[0]?.narrative.markdown, "See the ghost.");
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("tl:file/ghost.ts")));
  });

  it("drops an out-of-range hint rather than failing the journey", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map([
        [
          "c1",
          {
            narrative: "n",
            mapEntry: "m",
            hints: [
              {
                kind: "connection",
                path: "src/a.ts",
                side: "new",
                startLine: 1,
                endLine: 2,
                body: "ok",
              },
              {
                kind: "ripple",
                path: "ghost.ts",
                side: "new",
                startLine: 1,
                endLine: 1,
                body: "bad",
              },
            ],
          },
        ],
      ]),
      overview: { brief: "b", whereToBegin: "w" },
    });
    assert.equal(result.hints.length, 1);
    assert.equal(result.hints[0]?.anchor.path, "src/a.ts");
    assert.isTrue(result.fallbacks.some((entry) => entry.includes("dropped a hint")));
  });

  it("clamps a hint's end line to the file rather than dropping it", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map([
        [
          "c1",
          {
            narrative: "n",
            mapEntry: "m",
            hints: [
              {
                kind: "complexity",
                path: "src/a.ts",
                side: "new",
                startLine: 20,
                endLine: 99,
                body: "ok",
              },
            ],
          },
        ],
      ]),
      overview: { brief: "b", whereToBegin: "w" },
    });
    assert.equal(result.hints[0]?.anchor.endLine, 22);
  });

  it("drops resurfacing whose home is not an earlier cluster", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map([
        ["c1", { narrative: "n", mapEntry: "m", resurfaced: [{ hunkId: "h2", note: "later" }] }],
        ["c2", { narrative: "n", mapEntry: "m", resurfaced: [{ hunkId: "h1", note: "earlier" }] }],
      ]),
      overview: { brief: "b", whereToBegin: "w" },
    });
    assert.deepEqual(result.clusters[0]?.resurfaced, []);
    assert.equal(result.clusters[1]?.resurfaced.length, 1);
    assert.include(
      result.clusters[1]?.fileOrder ?? [],
      "src/a.ts",
      "fileOrder widens for a revisit",
    );
  });

  it("fills attention for every cluster from its weight when the harness gave none", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map(),
      overview: {},
    });
    assert.deepEqual(
      result.overview.attention.map((note) => [note.clusterId, note.phrase]),
      [
        ["c1", "read closely"],
        ["c2", "read once"],
      ],
    );
  });

  it("keeps the harness's attention phrases and drops unknown clusters", () => {
    const result = assembleNarration({
      clusters: plan.clusters,
      hunks: plan.hunks,
      tree,
      narrationByCluster: new Map(),
      overview: {
        brief: "b",
        whereToBegin: "w",
        attention: [
          { clusterId: "c2", phrase: "minutes" },
          { clusterId: "ghost", phrase: "nope" },
        ],
      },
    });
    assert.deepEqual(
      result.overview.attention.map((note) => [note.clusterId, note.phrase]),
      [
        ["c1", "read closely"],
        ["c2", "minutes"],
      ],
    );
  });
});

describe("firstSentences", () => {
  it("takes the requested number of sentences", () => {
    assert.equal(firstSentences("One. Two. Three.", 2), "One. Two.");
  });

  it("returns the whole text when there is no sentence break", () => {
    assert.equal(firstSentences("No punctuation here", 2), "No punctuation here");
  });
});
