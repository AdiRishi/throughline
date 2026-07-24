import { assert, describe, it } from "@effect/vitest";

import type { Hunk, Journey } from "@app/contracts";

import { canonicalizeHunkIds, validateCoverage, validateJourney } from "../src/coverage.ts";
import { makeJourney, pinnedFile, SEEDS } from "./fixtures.ts";

const violationCodes = (violations: ReturnType<typeof validateJourney>): readonly string[] =>
  violations.map((violation) => violation.code);

describe("journey validation", () => {
  it("accepts an exact refinement with earlier-only relationships, resurfacing, evidence, and hints", () => {
    assert.deepEqual(validateJourney(makeJourney(), { seeds: SEEDS, pinnedFile }), []);
  });

  it("reports precise seed locations for gaps, unknown seeds, and changed file-level hunks", () => {
    const base = makeJourney();
    const journey = {
      ...base,
      hunks: base.hunks.map((hunk) => {
        if (hunk.id === "h2") return Object.assign({}, hunk, { oldStart: 12 });
        if (hunk.id === "h3") {
          return Object.assign({}, hunk, { seedId: "s404" as Hunk["seedId"] });
        }
        if (hunk.id === "h4") return Object.assign({}, hunk, { newLines: 1 });
        return hunk;
      }),
    } satisfies Journey;

    const violations = validateJourney(journey, { seeds: SEEDS, pinnedFile });

    assert.includeMembers(
      [...violationCodes(violations)],
      ["split-gap", "split-outside-seed", "seed-missing", "seed-unassigned", "file-level-changed"],
    );
    assert.isTrue(
      violations.some(
        (violation) =>
          violation.code === "split-gap" &&
          violation.seedId === "s1" &&
          violation.path === "src/a.ts",
      ),
    );
  });

  it("rejects non-earlier relationships, inaccurate file order, and invalid resurfacing", () => {
    const base = makeJourney();
    const journey = {
      ...base,
      clusters: base.clusters.map((cluster) => {
        if (cluster.id === "c1") {
          return Object.assign({}, cluster, {
            buildsOn: ["c2" as (typeof cluster.buildsOn)[number]],
          });
        }
        if (cluster.id === "c2") {
          return Object.assign({}, cluster, {
            fileOrder: [],
            resurfaced: [
              {
                hunkId: "h2" as (typeof cluster.resurfaced)[number]["hunkId"],
                note: { markdown: "Invalid same-home resurfacing." },
              },
            ],
          });
        }
        return cluster;
      }),
    } satisfies Journey;

    const codes = violationCodes(validateJourney(journey, { seeds: SEEDS, pinnedFile }));

    assert.includeMembers(
      [...codes],
      [
        "builds-on-not-earlier",
        "resurfaced-at-home",
        "file-order-missing",
        "hint-path-not-in-cluster",
      ],
    );
  });

  it("rejects a phantom cluster even when it only resurfaces an earlier hunk", () => {
    const base = makeJourney();
    const journey = {
      ...base,
      clusters: [
        ...base.clusters,
        {
          id: "c4" as (typeof base.clusters)[number]["id"],
          position: 4,
          title: "Phantom",
          weight: "supporting" as const,
          narrative: { markdown: "No new code." },
          mapEntry: { markdown: "No new code." },
          buildsOn: ["c3" as (typeof base.clusters)[number]["id"]],
          fileOrder: ["src/a.ts" as (typeof base.clusters)[number]["fileOrder"][number]],
          resurfaced: [
            {
              hunkId: "h1" as (typeof base.clusters)[number]["resurfaced"][number]["hunkId"],
              note: { markdown: "Known code." },
            },
          ],
        },
      ],
    } satisfies Journey;

    assert.include(
      violationCodes(validateJourney(journey, { seeds: SEEDS, pinnedFile })),
      "cluster-has-no-home",
    );
  });
});

describe("coverage refinement", () => {
  it("canonicalizes final IDs in deterministic seed and range order", () => {
    const hunks = makeJourney().hunks;
    const scrambled = [
      { ...hunks[3]!, id: "temporary-d" as Hunk["id"] },
      { ...hunks[1]!, id: "temporary-b" as Hunk["id"] },
      { ...hunks[2]!, id: "temporary-c" as Hunk["id"] },
      { ...hunks[0]!, id: "temporary-a" as Hunk["id"] },
    ];

    const canonical = canonicalizeHunkIds(SEEDS, scrambled);

    assert.deepEqual(
      canonical.map((hunk) => [hunk.id, hunk.seedId, hunk.oldStart, hunk.newStart]),
      [
        ["h1", "s1", 10, 10],
        ["h2", "s1", 11, 11],
        ["h3", "s2", 5, 6],
        ["h4", "s3", 0, 0],
      ],
    );
    assert.deepEqual(
      validateCoverage({
        seeds: SEEDS,
        hunks: canonical,
        files: makeJourney().files,
        clusters: makeJourney().clusters,
      }),
      [],
    );
  });

  it("does not let a file-level seed split into multiple final hunks", () => {
    const base = makeJourney();
    const extra = {
      ...base.hunks[3]!,
      id: "h5" as Hunk["id"],
    };

    const violations = validateCoverage({
      seeds: SEEDS,
      hunks: [...base.hunks, extra],
      files: base.files,
      clusters: base.clusters,
    });

    assert.isTrue(
      violations.some(
        (violation) => violation.code === "file-level-split" && violation.seedId === "s3",
      ),
    );
  });
});
