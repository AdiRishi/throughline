import { assert, describe, it } from "@effect/vitest";

import type { Cluster, ClusterId } from "@app/contracts";

import { validatePartition } from "../src/coverage.ts";
import { deriveDiff } from "../src/hunks.ts";
import {
  degeneratePlan,
  materializePlan,
  validatePlan,
  type JourneyPlan,
  type PlannedCluster,
} from "../src/plan.ts";
import { RAW_DIFF, ZERO_CONTEXT_PATCH } from "./fixtures/diff.ts";
import { file, seed } from "./fixtures/journey.ts";

const seeds = [
  seed({
    id: "h1",
    path: "src/auth/token.ts",
    oldStart: 10,
    oldLines: 4,
    newStart: 10,
    newLines: 4,
  }),
  seed({ id: "h2", path: "src/ui/login.tsx", newStart: 1, newLines: 12 }),
  seed({ id: "h3", path: "logo.png", fileKind: "binary" }),
];
const files = [
  file("src/auth/token.ts"),
  file("src/ui/login.tsx"),
  file("logo.png", { binary: true }),
];

const goodPlan: JourneyPlan = {
  clusters: [
    {
      id: "c1",
      title: "The auth module",
      weight: "core",
      buildsOn: [],
      fileOrder: ["src/auth/token.ts"],
    },
    {
      id: "c2",
      title: "Login UI",
      weight: "core",
      buildsOn: ["c1"],
      fileOrder: ["src/ui/login.tsx", "logo.png"],
    },
  ],
  homes: [
    { hunkId: "h1", cluster: "c1" },
    { hunkId: "h2", cluster: "c2" },
    { hunkId: "h3", cluster: "c2" },
  ],
  splits: [],
};

const kinds = (violations: ReadonlyArray<{ readonly kind: string }>) =>
  violations.map((violation) => violation.kind);

/** A planned cluster, with the empty words stage 2 has not written yet. */
function asCluster(planned: PlannedCluster): Cluster {
  return {
    id: planned.id,
    position: planned.position,
    title: planned.title,
    weight: planned.weight,
    buildsOn: planned.buildsOn,
    fileOrder: planned.fileOrder,
    narrative: { markdown: "" },
    mapEntry: { markdown: "" },
    resurfaced: [],
  };
}

describe("validatePlan", () => {
  it("accepts a plan that assigns every seed to a real cluster", () => {
    assert.deepEqual(validatePlan({ seeds, files, plan: goodPlan }), []);
  });

  it("reports every unassigned seed rather than only the first", () => {
    const violations = validatePlan({
      seeds,
      files,
      plan: { ...goodPlan, homes: [{ hunkId: "h1", cluster: "c1" }] },
    });
    const unassigned = violations.filter((violation) => violation.kind === "hunk-unassigned");
    assert.strictEqual(unassigned.length, 2);
  });

  it("rejects assigning and splitting the same seed", () => {
    const plan: JourneyPlan = {
      ...goodPlan,
      splits: [
        {
          seedId: "h1",
          parts: [
            { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, cluster: "c1" },
            { oldStart: 12, oldLines: 2, newStart: 12, newLines: 2, cluster: "c2" },
          ],
        },
      ],
    };
    assert.include(kinds(validatePlan({ seeds, files, plan })), "line-covered-twice");
  });

  it("rejects a split of a file-level hunk", () => {
    const plan: JourneyPlan = {
      clusters: goodPlan.clusters,
      homes: [
        { hunkId: "h1", cluster: "c1" },
        { hunkId: "h2", cluster: "c2" },
      ],
      splits: [
        {
          seedId: "h3",
          parts: [
            { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, cluster: "c1" },
            { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, cluster: "c2" },
          ],
        },
      ],
    };
    assert.include(kinds(validatePlan({ seeds, files, plan })), "split-of-file-hunk");
  });

  it("rejects a one-part split — that is an assignment", () => {
    const plan: JourneyPlan = {
      clusters: goodPlan.clusters,
      homes: [
        { hunkId: "h2", cluster: "c2" },
        { hunkId: "h3", cluster: "c2" },
      ],
      splits: [
        {
          seedId: "h1",
          parts: [{ oldStart: 10, oldLines: 4, newStart: 10, newLines: 4, cluster: "c1" }],
        },
      ],
    };
    assert.include(kinds(validatePlan({ seeds, files, plan })), "split-does-not-tile-seed");
  });

  it("rejects an empty plan and a cluster nothing lands in", () => {
    assert.include(
      kinds(validatePlan({ seeds, files, plan: { clusters: [], homes: [], splits: [] } })),
      "cluster-order-invalid",
    );
    const idle: JourneyPlan = {
      clusters: [
        ...goodPlan.clusters,
        { id: "c3", title: "Nothing", weight: "mechanical", buildsOn: [], fileOrder: [] },
      ],
      homes: goodPlan.homes,
      splits: [],
    };
    assert.include(kinds(validatePlan({ seeds, files, plan: idle })), "cluster-empty");
  });
});

describe("materializePlan", () => {
  it("produces a partition the coverage validator accepts", () => {
    const materialized = materializePlan({ seeds, files, plan: goodPlan });
    assert.deepEqual(materialized.fallbacks, []);
    assert.deepEqual(
      validatePartition({
        seeds,
        files,
        hunks: materialized.hunks,
        clusters: materialized.clusters.map(asCluster),
      }),
      [],
    );
  });

  it("materializes a valid split into ordered parts that keep their seed", () => {
    const plan: JourneyPlan = {
      clusters: goodPlan.clusters,
      homes: [
        { hunkId: "h2", cluster: "c2" },
        { hunkId: "h3", cluster: "c2" },
      ],
      splits: [
        {
          seedId: "h1",
          parts: [
            { oldStart: 12, oldLines: 2, newStart: 12, newLines: 2, cluster: "c2" },
            { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, cluster: "c1" },
          ],
        },
      ],
    };
    const materialized = materializePlan({ seeds, files, plan });
    const parts = materialized.hunks.filter((hunk) => hunk.seedId === "h1");
    assert.deepEqual(
      parts.map((part) => `${part.id}@${part.newStart}->${part.home}`),
      ["h1.1@10->c1", "h1.2@12->c2"],
    );
    assert.deepEqual(materialized.fallbacks, []);
  });

  it("collapses an invalid split back to its seed and says so", () => {
    const plan: JourneyPlan = {
      clusters: goodPlan.clusters,
      homes: [
        { hunkId: "h1", cluster: "c1" },
        { hunkId: "h2", cluster: "c2" },
        { hunkId: "h3", cluster: "c2" },
      ],
      splits: [
        {
          seedId: "h1",
          parts: [
            { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, cluster: "c1" },
            { oldStart: 13, oldLines: 1, newStart: 13, newLines: 1, cluster: "c2" },
          ],
        },
      ],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.strictEqual(materialized.hunks.filter((hunk) => hunk.seedId === "h1").length, 1);
    assert.isTrue(materialized.fallbacks.some((note) => note.includes("collapsed it back")));
  });

  it("gathers unassigned hunks into a synthesized final cluster rather than dropping them", () => {
    const plan: JourneyPlan = {
      clusters: [goodPlan.clusters[0]!],
      homes: [{ hunkId: "h1", cluster: "c1" }],
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    const unplaced = materialized.clusters.at(-1)!;
    assert.strictEqual(unplaced.title, "Unplaced changes");
    assert.strictEqual(unplaced.position, materialized.clusters.length);
    assert.deepEqual(
      materialized.hunks.filter((hunk) => hunk.home === unplaced.id).map((hunk) => hunk.id),
      ["h2", "h3"],
    );
    assert.strictEqual(materialized.fallbacks.length, 2);
  });

  it("drops clusters nothing lands in and re-densifies the positions", () => {
    const plan: JourneyPlan = {
      clusters: [
        { id: "c0", title: "Ghost", weight: "core", buildsOn: [], fileOrder: [] },
        ...goodPlan.clusters,
      ],
      homes: goodPlan.homes,
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.deepEqual(
      materialized.clusters.map((cluster) => `${cluster.position}:${cluster.id}`),
      ["1:c1", "2:c2"],
    );
    assert.isTrue(materialized.fallbacks.some((note) => note.includes("homed no hunks")));
  });

  it("drops buildsOn references that point forward or nowhere", () => {
    const plan: JourneyPlan = {
      clusters: [
        {
          id: "c1",
          title: "One",
          weight: "core",
          buildsOn: ["c2", "cX"],
          fileOrder: ["src/auth/token.ts"],
        },
        {
          id: "c2",
          title: "Two",
          weight: "core",
          buildsOn: ["c1"],
          fileOrder: ["src/ui/login.tsx", "logo.png"],
        },
      ],
      homes: goodPlan.homes,
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.deepEqual(materialized.clusters[0]!.buildsOn, []);
    assert.deepEqual(materialized.clusters[1]!.buildsOn, ["c1" as ClusterId]);
  });

  it("normalizes an unknown weight instead of failing", () => {
    const plan: JourneyPlan = {
      clusters: [
        {
          id: "c1",
          title: "One",
          weight: "critical",
          buildsOn: [],
          fileOrder: ["src/auth/token.ts"],
        },
        ...goodPlan.clusters.slice(1),
      ],
      homes: goodPlan.homes,
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.strictEqual(materialized.clusters[0]!.weight, "supporting");
  });

  it("repairs a file order that is missing or over-specified", () => {
    const plan: JourneyPlan = {
      clusters: [
        { id: "c1", title: "One", weight: "core", buildsOn: [], fileOrder: ["nope.ts"] },
        { id: "c2", title: "Two", weight: "core", buildsOn: [], fileOrder: ["logo.png"] },
      ],
      homes: goodPlan.homes,
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.deepEqual(materialized.clusters[0]!.fileOrder, ["src/auth/token.ts"]);
    assert.deepEqual(materialized.clusters[1]!.fileOrder, ["logo.png", "src/ui/login.tsx"]);
  });

  it("turns a completely empty plan into one honest cluster", () => {
    const materialized = materializePlan({
      seeds,
      files,
      plan: { clusters: [], homes: [], splits: [] },
    });
    assert.strictEqual(materialized.clusters.length, 1);
    assert.strictEqual(materialized.clusters[0]!.title, "Unplaced changes");
    assert.strictEqual(materialized.hunks.length, seeds.length);
  });

  it("never collides with a cluster the plan already called c-unplaced", () => {
    const plan: JourneyPlan = {
      clusters: [
        {
          id: "c-unplaced",
          title: "Deliberate",
          weight: "core",
          buildsOn: [],
          fileOrder: ["src/auth/token.ts"],
        },
      ],
      homes: [{ hunkId: "h1", cluster: "c-unplaced" }],
      splits: [],
    };
    const materialized = materializePlan({ seeds, files, plan });
    assert.deepEqual(
      materialized.clusters.map((cluster) => cluster.id),
      ["c-unplaced", "c-unplaced-2"],
    );
  });
});

describe("degeneratePlan", () => {
  const derived = deriveDiff({ raw: RAW_DIFF, patch: ZERO_CONTEXT_PATCH });

  it("groups by directory and covers every seed", () => {
    const plan = degeneratePlan(derived);
    const assigned = new Set(plan.homes.map((home) => home.hunkId));
    for (const seedHunk of derived.seeds) {
      assert.isTrue(assigned.has(seedHunk.id), `${seedHunk.id} unassigned`);
    }
    assert.deepEqual(validatePlan({ ...derived, plan }), []);
  });

  it("materializes into a journey the coverage validator accepts, with no fallbacks", () => {
    const materialized = materializePlan({ ...derived, plan: degeneratePlan(derived) });
    assert.deepEqual(materialized.fallbacks, []);
    assert.deepEqual(
      validatePartition({
        seeds: derived.seeds,
        files: derived.files,
        hunks: materialized.hunks,
        clusters: materialized.clusters.map(asCluster),
      }),
      [],
    );
  });
});
