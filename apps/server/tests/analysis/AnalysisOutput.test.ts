import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommitSha,
  FileChange,
  JourneyId,
  PrRef,
  SeedHunk,
  type FileChange as FileChangeValue,
  type SeedHunk as SeedHunkValue,
} from "@app/contracts";
import { validateCoverage, validateJourney } from "@app/journey/coverage";
import { makePinnedFileLookup } from "@app/journey/evidence";

import {
  assembleJourney,
  clusterNarrationJsonSchema,
  ClusterNarrationOutput,
  completePlan,
  decodePlanOutput,
  overviewJsonSchema,
  planJsonSchema,
  PlanOutput,
} from "../../src/analysis/AnalysisOutput.ts";

const decodeFile = Schema.decodeUnknownSync(FileChange);
const decodeSeed = Schema.decodeUnknownSync(SeedHunk);
const decodePlan = Schema.decodeUnknownSync(PlanOutput);
const decodeNarration = Schema.decodeUnknownSync(ClusterNarrationOutput);
const decodeJourneyId = Schema.decodeUnknownSync(JourneyId);
const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha);

const files: ReadonlyArray<FileChangeValue> = [
  decodeFile({
    path: "src/core.ts",
    oldPath: null,
    kind: "modified",
    oldMode: "100644",
    newMode: "100644",
    binary: false,
    additions: 1,
    deletions: 1,
  }),
  decodeFile({
    path: "src/support.ts",
    oldPath: null,
    kind: "modified",
    oldMode: "100644",
    newMode: "100644",
    binary: false,
    additions: 1,
    deletions: 1,
  }),
];

const seeds: ReadonlyArray<SeedHunkValue> = [
  decodeSeed({
    id: "s1",
    path: "src/core.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
  }),
  decodeSeed({
    id: "s2",
    path: "src/support.ts",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
  }),
];

describe("analysis deterministic completion", () => {
  it.effect("exposes OpenAI-compatible schemas with matching optional-field decoding", () =>
    Effect.gen(function* () {
      assert.notInclude(
        JSON.stringify([planJsonSchema, overviewJsonSchema, clusterNarrationJsonSchema]),
        '"allOf"',
      );
      const hunkSchema = (
        (planJsonSchema.properties as Record<string, unknown>).hunks as {
          readonly items: {
            readonly required: ReadonlyArray<string>;
          };
        }
      ).items;
      assert.include(hunkSchema.required, "fileKind");

      const decoded = yield* decodePlanOutput({
        clusters: [
          {
            id: "core",
            title: "Core behavior",
            weight: "core",
            buildsOn: [],
            fileOrder: ["src/core.ts"],
          },
        ],
        hunks: [
          {
            id: "h1",
            seedId: "s1",
            path: "src/core.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            fileKind: null,
            home: "core",
          },
        ],
      });

      assert.isFalse("fileKind" in decoded.hunks[0]!);
    }),
  );

  it("keeps valid refinements and places uncovered seeds in an honest final cluster", () => {
    const output = decodePlan({
      clusters: [
        {
          id: "core",
          title: "Core behavior",
          weight: "core",
          buildsOn: [],
          fileOrder: ["src/core.ts"],
        },
      ],
      hunks: [
        {
          id: "h7",
          seedId: "s1",
          path: "src/core.ts",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          home: "core",
        },
      ],
    });

    const completed = completePlan(output, seeds, files);

    assert.deepStrictEqual(
      completed.clusters.map(({ title, weight }) => ({ title, weight })),
      [
        { title: "Core behavior", weight: "core" },
        { title: "Unplaced changes", weight: "supporting" },
      ],
    );
    assert.deepStrictEqual(
      completed.hunks.map(({ id, seedId, home }) => ({ id, seedId, home })),
      [
        { id: "h1", seedId: "s1", home: "core" },
        { id: "h2", seedId: "s2", home: "unplaced" },
      ],
    );
    assert.deepStrictEqual(validateCoverage({ seeds, files, ...completed }), []);
  });

  it("degrades an empty plan to a deterministic per-file journey", () => {
    const completed = completePlan({ clusters: [], hunks: [] }, seeds, files);

    assert.deepStrictEqual(
      completed.clusters.map(({ id, title, position }) => ({ id, title, position })),
      [
        { id: "file-1", title: "src/core.ts", position: 1 },
        { id: "file-2", title: "src/support.ts", position: 2 },
      ],
    );
    assert.deepStrictEqual(validateCoverage({ seeds, files, ...completed }), []);
  });

  it("places foreign resurfaced files after the frozen home-file order", () => {
    const plan = completePlan(
      decodePlan({
        clusters: [
          {
            id: "core",
            title: "Core behavior",
            weight: "core",
            buildsOn: [],
            fileOrder: ["src/core.ts"],
          },
          {
            id: "binding",
            title: "Binding",
            weight: "supporting",
            buildsOn: ["core"],
            fileOrder: ["src/support.ts"],
          },
        ],
        hunks: [
          {
            id: "h7",
            seedId: "s1",
            path: "src/core.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            home: "core",
          },
          {
            id: "h8",
            seedId: "s2",
            path: "src/support.ts",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            home: "binding",
          },
        ],
      }),
      seeds,
      files,
    );
    const journey = assembleJourney({
      id: decodeJourneyId("journey-cross-file"),
      pr: decodePrRef({ owner: "acme", repo: "rocket", number: 17 }),
      headSha: decodeCommitSha("2222222222222222222222222222222222222222"),
      baseSha: decodeCommitSha("1111111111111111111111111111111111111111"),
      analyzedAt: DateTime.makeUnsafe("2026-07-25T00:00:00.000Z"),
      harnessKind: "codex",
      files,
      plan,
      overview: {
        brief: { markdown: "The change connects a foundation to its binding." },
        whereToBegin: { markdown: "Begin with the core behavior." },
      },
      narrations: new Map([
        [
          "binding",
          decodeNarration({
            clusterId: "binding",
            narrative: { markdown: "The binding revisits the core behavior." },
            mapEntry: { markdown: "Connects support to the core." },
            resurfaced: [
              {
                hunkId: "h1",
                note: { markdown: "Known core behavior shown from the binding." },
              },
            ],
            hints: [],
          }),
        ],
      ]),
    });

    assert.deepStrictEqual(journey.clusters[1]?.fileOrder, [files[1]!.path, files[0]!.path]);
    assert.deepStrictEqual(
      validateJourney(journey, {
        seeds,
        pinnedFile: makePinnedFileLookup(
          new Map([
            ["src/core.ts", { old: "old core\n", new: "new core\n", headExists: true }],
            ["src/support.ts", { old: "old support\n", new: "new support\n", headExists: true }],
          ]),
        ),
      }),
      [],
    );
  });
});
