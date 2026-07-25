import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CommitSha,
  FileChange,
  JourneyId,
  PrDetail,
  PrRef,
  SeedHunk,
  type FileChange as FileChangeValue,
  type Journey,
  type PrDetail as PrDetailValue,
  type PrRef as PrRefValue,
  type SeedHunk as SeedHunkValue,
} from "@app/contracts";
import { validateJourney } from "@app/journey/coverage";
import { makePinnedFileLookup } from "@app/journey/evidence";

import * as AnalysisPipeline from "../../src/analysis/AnalysisPipeline.ts";
import * as GitHub from "../../src/github/GitHub.ts";
import { type AnalysisHarness, HarnessRunError } from "../../src/harness/AnalysisHarness.ts";
import * as JourneyStore from "../../src/journeys/JourneyStore.ts";
import * as Workspaces from "../../src/workspace/Workspaces.ts";

const decodePrRef = Schema.decodeUnknownSync(PrRef);
const decodePrDetail = Schema.decodeUnknownSync(Schema.toCodecJson(PrDetail));
const decodeFile = Schema.decodeUnknownSync(FileChange);
const decodeSeed = Schema.decodeUnknownSync(SeedHunk);
const decodeJourneyId = Schema.decodeUnknownSync(JourneyId);
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha);

const pr: PrRefValue = decodePrRef({ owner: "acme", repo: "rocket", number: 17 });
const detail: PrDetailValue = decodePrDetail({
  ref: pr,
  title: "Explain the complete change",
  body: "A complete description.",
  author: { login: "octocat", avatarUrl: null },
  url: "https://github.com/acme/rocket/pull/17",
  state: "open",
  baseRefName: "main",
  headSha: "2222222222222222222222222222222222222222",
  baseSha: "1111111111111111111111111111111111111111",
  updatedAt: "2026-07-25T00:00:00.000Z",
  mergedAt: null,
  changedFiles: 1,
  additions: 1,
  deletions: 1,
  journey: null,
});
const file: FileChangeValue = decodeFile({
  path: "src/core.ts",
  oldPath: null,
  kind: "modified",
  oldMode: "100644",
  newMode: "100644",
  binary: false,
  additions: 1,
  deletions: 1,
});
const seed: SeedHunkValue = decodeSeed({
  id: "s1",
  path: "src/core.ts",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
});
const supportFile: FileChangeValue = decodeFile({
  path: "src/support.ts",
  oldPath: null,
  kind: "modified",
  oldMode: "100644",
  newMode: "100644",
  binary: false,
  additions: 1,
  deletions: 1,
});
const supportSeed: SeedHunkValue = decodeSeed({
  id: "s2",
  path: "src/support.ts",
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
});

const github = GitHub.GitHub.of({
  identity: () => Effect.die("unused"),
  repositories: () => Effect.die("unused"),
  pullRequests: () => Effect.die("unused"),
  openPrs: () => Effect.die("unused"),
  recentlyMergedPrs: () => Effect.die("unused"),
  pr: () => Effect.succeed(detail),
  refreshPrs: () => Effect.die("unused"),
  retry: () => Effect.die("unused"),
  resolveUrl: () => Effect.die("unused"),
  cloneCredentials: () => Effect.die("unused"),
});

interface Fixture {
  readonly prepared: Workspaces.PreparedWorkspace;
  readonly workspaces: Workspaces.Workspaces["Service"];
  readonly operations: Array<string>;
  readonly saved: Array<Journey>;
  readonly store: JourneyStore.JourneyStore["Service"];
}

const makeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "throughline-analysis-",
  });
  const stagingRunDir = path.join(root, "run.staging");
  const finalRunDir = path.join(root, "run");
  const worldDir = path.join(stagingRunDir, "world");
  const repositoryDir = path.join(worldDir, "repository");
  const inputsDir = path.join(worldDir, "inputs");
  const contentDir = path.join(inputsDir, "content");
  yield* fileSystem.makeDirectory(repositoryDir, { recursive: true });
  yield* fileSystem.makeDirectory(contentDir, { recursive: true });
  yield* fileSystem
    .writeFileString(path.join(repositoryDir, "src", "core.ts"), "new\n")
    .pipe(
      Effect.catch(() =>
        fileSystem
          .makeDirectory(path.join(repositoryDir, "src"), { recursive: true })
          .pipe(
            Effect.andThen(
              fileSystem.writeFileString(path.join(repositoryDir, "src", "core.ts"), "new\n"),
            ),
          ),
      ),
    );
  yield* fileSystem.writeFileString(path.join(contentDir, "f000001.old"), "old\n");
  yield* fileSystem.writeFileString(path.join(contentDir, "f000001.new"), "new\n");
  yield* fileSystem.writeFileString(
    path.join(inputsDir, "contents.json"),
    `${JSON.stringify({
      version: 1,
      entries: [
        {
          type: "text",
          path: "src/core.ts",
          oldFile: "f000001.old",
          newFile: "f000001.new",
        },
        {
          type: "image",
          path: "assets/logo.png",
          oldFile: null,
          oldMediaType: null,
          newFile: "f000002.new",
          newMediaType: "image/png",
        },
        {
          type: "binary",
          path: "assets/archive.bin",
          oldSize: 64,
          newSize: 128,
        },
      ],
    })}\n`,
  );

  const prepared: Workspaces.PreparedWorkspace = {
    pr,
    runId: "run-1",
    pullRequest: detail,
    baseSha: detail.baseSha,
    headSha: detail.headSha,
    stagingRunDir,
    finalRunDir,
    worldDir,
    repositoryDir,
    inputsDir,
    files: [file],
    hunks: [seed],
    tree: [file.path],
  };
  const operations: Array<string> = [];
  const saved: Array<Journey> = [];
  const workspaces = Workspaces.Workspaces.of({
    prepare: () => Effect.succeed(prepared),
    finalize: () =>
      Effect.sync(() => {
        operations.push("finalize");
        return {
          pr,
          runId: prepared.runId,
          pullRequest: prepared.pullRequest,
          baseSha: prepared.baseSha,
          headSha: prepared.headSha,
          runDir: finalRunDir,
          inputsDir,
        };
      }),
    abandon: () =>
      Effect.sync(() => {
        operations.push("abandon");
      }),
    reapFailedRuns: () => Effect.succeed([]),
    filePatch: () => Effect.die("unused"),
    fileContent: () => Effect.die("unused"),
    tree: () => Effect.die("unused"),
    pullRequest: () => Effect.die("unused"),
    evictCache: () => Effect.die("unused"),
    removeRun: () =>
      Effect.sync(() => {
        operations.push("remove");
      }),
  });
  const store = JourneyStore.JourneyStore.of({
    listMetadata: Effect.succeed([]),
    listRunReferences: Effect.succeed([]),
    getByPr: () => Effect.succeedNone,
    getById: () => Effect.succeedNone,
    replace: ({ journey }) =>
      Effect.sync(() => {
        operations.push("replace");
        saved.push(journey);
        return Option.none();
      }),
    remove: () => Effect.succeedNone,
    getReadState: () => Effect.succeedNone,
    setDisplayMode: () => Effect.die("unused"),
    setReadMark: () => Effect.die("unused"),
    getLocalPrState: Effect.succeed({
      reviewed: [],
      hidden: [],
      dismissedMerged: [],
    }),
    setReviewed: () => Effect.die("unused"),
    setHidden: () => Effect.die("unused"),
    setDismissedMerged: () => Effect.die("unused"),
    getSettings: Effect.succeed({}),
    setHarness: () => Effect.succeed({}),
  });
  return { prepared, workspaces, operations, saved, store } satisfies Fixture;
});

const makePipeline = (fixture: Fixture, harness: AnalysisHarness, githubService = github) =>
  AnalysisPipeline.make.pipe(
    Effect.provideService(GitHub.GitHub, githubService),
    Effect.provideService(Workspaces.Workspaces, fixture.workspaces),
    Effect.provideService(JourneyStore.JourneyStore, fixture.store),
  );

const validPlan = {
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
      home: "core",
    },
  ],
};

describe("AnalysisPipeline", () => {
  it.layer(NodeServices.layer)("staged orchestration", (it) => {
    it.effect("accepts file evidence for images and binaries present at the pinned head", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const overviewMarkdown =
          "[Image](tl:file/assets%2Flogo.png) and [archive](tl:file/assets%2Farchive.bin).";
        const harness: AnalysisHarness = {
          kind: "codex",
          detect: Effect.die("unused"),
          run: (task) =>
            Effect.gen(function* () {
              const raw = task.prompt.startsWith("You are planning")
                ? validPlan
                : task.prompt.startsWith("Write the overview")
                  ? {
                      overview: {
                        brief: { markdown: overviewMarkdown },
                        whereToBegin: { markdown: "Begin with the core." },
                      },
                    }
                  : {
                      clusterId: "core",
                      narrative: { markdown: "Narrative." },
                      mapEntry: { markdown: "Map entry." },
                      resurfaced: [],
                      hints: [],
                    };
              const value = yield* task.decode(raw).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessRunError({
                      kind: "codex",
                      reason: "invalid-output",
                      detail: "decode failed",
                      cause,
                    }),
                ),
              );
              return { value, continuation: "continuation" };
            }),
        };
        const pipeline = yield* makePipeline(fixture, harness);

        const result = yield* pipeline.run({
          pr,
          runId: fixture.prepared.runId,
          journeyId: decodeJourneyId("journey-non-text"),
          harness,
          callbacks: {
            onPhase: () => Effect.void,
            onStage: () => Effect.void,
            onHarnessEvent: () => Effect.void,
          },
        });

        assert.strictEqual(result.journey.overview.brief.markdown, overviewMarkdown);
        assert.deepStrictEqual(fixture.operations, ["finalize", "replace"]);
      }),
    );

    it.effect("preserves cross-file resurfacing through narration and final validation", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(
          path.join(fixture.prepared.inputsDir, "content", "f000002.old"),
          "old support\n",
        );
        yield* fileSystem.writeFileString(
          path.join(fixture.prepared.inputsDir, "content", "f000002.new"),
          "new support\n",
        );
        yield* fileSystem.writeFileString(
          path.join(fixture.prepared.inputsDir, "contents.json"),
          `${JSON.stringify({
            version: 1,
            entries: [
              {
                type: "text",
                path: "src/core.ts",
                oldFile: "f000001.old",
                newFile: "f000001.new",
              },
              {
                type: "text",
                path: "src/support.ts",
                oldFile: "f000002.old",
                newFile: "f000002.new",
              },
            ],
          })}\n`,
        );
        const prepared: Workspaces.PreparedWorkspace = {
          ...fixture.prepared,
          files: [file, supportFile],
          hunks: [seed, supportSeed],
          tree: [file.path, supportFile.path],
        };
        const crossFileFixture: Fixture = {
          ...fixture,
          prepared,
          workspaces: Workspaces.Workspaces.of({
            ...fixture.workspaces,
            prepare: () => Effect.succeed(prepared),
          }),
        };
        const harness: AnalysisHarness = {
          kind: "codex",
          detect: Effect.die("unused"),
          run: (task) =>
            Effect.gen(function* () {
              const raw = task.prompt.startsWith("You are planning")
                ? {
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
                        id: "h1",
                        seedId: "s1",
                        path: "src/core.ts",
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        home: "core",
                      },
                      {
                        id: "h2",
                        seedId: "s2",
                        path: "src/support.ts",
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        home: "binding",
                      },
                    ],
                  }
                : task.prompt.startsWith("Write the overview")
                  ? {
                      overview: {
                        brief: { markdown: "A core behavior connected through support." },
                        whereToBegin: { markdown: "Begin with the core." },
                      },
                    }
                  : task.prompt.includes("Target cluster: core")
                    ? {
                        clusterId: "core",
                        narrative: { markdown: "Defines the core behavior." },
                        mapEntry: { markdown: "Establishes the core." },
                        resurfaced: [],
                        hints: [],
                      }
                    : {
                        clusterId: "binding",
                        narrative: {
                          markdown: "Connects support while revisiting the core behavior.",
                        },
                        mapEntry: { markdown: "Binds support to the core." },
                        resurfaced: [
                          {
                            hunkId: "h1",
                            note: { markdown: "The known core behavior from the binding." },
                          },
                        ],
                        hints: [],
                      };
              const value = yield* task.decode(raw).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessRunError({
                      kind: "codex",
                      reason: "invalid-output",
                      detail: "decode failed",
                      cause,
                    }),
                ),
              );
              return { value, continuation: "continuation" };
            }),
        };
        const pipeline = yield* makePipeline(crossFileFixture, harness);

        const result = yield* pipeline.run({
          pr,
          runId: prepared.runId,
          journeyId: decodeJourneyId("journey-cross-file"),
          harness,
          callbacks: {
            onPhase: () => Effect.void,
            onStage: () => Effect.void,
            onHarnessEvent: () => Effect.void,
          },
        });

        const binding = result.journey.clusters[1];
        assert.deepStrictEqual(binding?.fileOrder, [supportFile.path, file.path]);
        assert.deepStrictEqual(
          binding?.resurfaced.map(({ hunkId }) => hunkId),
          ["h1"],
        );
        assert.deepStrictEqual(
          validateJourney(result.journey, {
            seeds: [seed, supportSeed],
            pinnedFile: makePinnedFileLookup(
              new Map([
                ["src/core.ts", { old: "old\n", new: "new\n", headExists: true }],
                [
                  "src/support.ts",
                  { old: "old support\n", new: "new support\n", headExists: true },
                ],
              ]),
            ),
          }),
          [],
        );
        assert.deepStrictEqual(fixture.operations, ["finalize", "replace"]);
      }),
    );

    it.effect(
      "repairs twice, regenerates stage two once, then saves a valid fallback atomically",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeFixture;
          const calls: Array<{
            readonly kind: "plan" | "overview" | "cluster";
            readonly continuation: string | undefined;
          }> = [];
          const harness: AnalysisHarness = {
            kind: "codex",
            detect: Effect.die("unused"),
            run: (task) =>
              Effect.gen(function* () {
                const kind = task.prompt.startsWith("You are planning")
                  ? "plan"
                  : task.prompt.startsWith("Write the overview")
                    ? "overview"
                    : "cluster";
                calls.push({ kind, continuation: task.continuation });
                yield* task.transcript
                  .write({
                    source: "event",
                    contents: `raw-${calls.length}`,
                  })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new HarnessRunError({
                          kind: "codex",
                          reason: "execution",
                          detail: cause.detail,
                          cause,
                        }),
                    ),
                  );
                yield* task.onEvent({
                  type: "activity",
                  action: `Observed ${kind}`,
                  path: `${task.world}/repository/src/core.ts`,
                });
                const raw =
                  kind === "plan"
                    ? validPlan
                    : kind === "overview"
                      ? {
                          overview: {
                            brief: { markdown: "[missing](tl:hunk/h99)" },
                            whereToBegin: { markdown: "Begin here." },
                          },
                        }
                      : {
                          clusterId: "wrong-cluster",
                          narrative: { markdown: "Narrative." },
                          mapEntry: { markdown: "Map entry." },
                          resurfaced: [],
                          hints: [],
                        };
                const value = yield* task.decode(raw).pipe(
                  Effect.mapError(
                    (cause) =>
                      new HarnessRunError({
                        kind: "codex",
                        reason: "invalid-output",
                        detail: "decode failed",
                        cause,
                      }),
                  ),
                );
                return {
                  value,
                  continuation: `token-${calls.length}`,
                  usage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    cachedInputTokens: 3,
                  },
                };
              }),
          };
          const pipeline = yield* makePipeline(fixture, harness);
          const phases: Array<string> = [];
          const result = yield* pipeline.run({
            pr,
            runId: fixture.prepared.runId,
            journeyId: decodeJourneyId("journey-1"),
            harness,
            callbacks: {
              onPhase: (phase) =>
                Effect.sync(() => {
                  phases.push(phase);
                }),
              onStage: (stage) =>
                Effect.sync(() => {
                  phases.push(stage);
                }),
              onHarnessEvent: () => Effect.void,
            },
          });

          assert.deepStrictEqual(fixture.operations, ["finalize", "replace"]);
          assert.deepStrictEqual(phases, [
            "resolving",
            "cloning",
            "diffing",
            "analyzing",
            "planning",
            "narrating",
            "validating",
            "saving",
          ]);
          assert.strictEqual(calls.filter(({ kind }) => kind === "plan").length, 1);
          assert.strictEqual(calls.filter(({ kind }) => kind === "overview").length, 6);
          assert.strictEqual(calls.filter(({ kind }) => kind === "cluster").length, 6);
          assert.deepStrictEqual(
            calls.filter(({ kind }) => kind === "overview").map(({ continuation }) => continuation),
            [undefined, "token-2", "token-3", undefined, "token-5", "token-6"],
          );
          assert.deepStrictEqual(result.journey.provenance.usage, {
            inputTokens: 13,
            outputTokens: 26,
            cachedInputTokens: 39,
          });
          assert.notMatch(result.journey.overview.brief.markdown, /tl:hunk\/h99/u);
          assert.strictEqual(
            result.journey.clusters[0]?.narrative.markdown,
            "Review the changes in **Core behavior** together.",
          );
          assert.deepStrictEqual(
            validateJourney(result.journey, {
              seeds: [seed],
              pinnedFile: makePinnedFileLookup(
                new Map([["src/core.ts", { old: "old\n", new: "new\n", headExists: true }]]),
              ),
            }),
            [],
          );
          assert.strictEqual(fixture.saved[0]?.id, result.journey.id);

          const fallbackLog = yield* FileSystem.FileSystem.pipe(
            Effect.flatMap((fileSystem) =>
              fileSystem.readFileString(`${fixture.prepared.stagingRunDir}/fallbacks.jsonl`),
            ),
          );
          assert.strictEqual(fallbackLog.trim().split("\n").length, 2);
        }),
    );

    it.effect("abandons its prepared workspace after an operational harness failure", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const harness: AnalysisHarness = {
          kind: "codex",
          detect: Effect.die("unused"),
          run: () =>
            Effect.fail(
              new HarnessRunError({
                kind: "codex",
                reason: "execution",
                detail: "Harness crashed.",
              }),
            ),
        };
        const pipeline = yield* makePipeline(fixture, harness);

        const error = yield* pipeline
          .run({
            pr,
            runId: fixture.prepared.runId,
            journeyId: decodeJourneyId("journey-2"),
            harness,
            callbacks: {
              onPhase: () => Effect.void,
              onStage: () => Effect.void,
              onHarnessEvent: () => Effect.void,
            },
          })
          .pipe(Effect.flip);

        assert.strictEqual(error.code, "harness");
        assert.deepStrictEqual(fixture.operations, ["abandon"]);
        assert.deepStrictEqual(fixture.saved, []);
      }),
    );

    it.effect("re-fetches PR detail once after a pinned-head mismatch", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const refreshedDetail: PrDetailValue = {
          ...detail,
          headSha: decodeCommitSha("3333333333333333333333333333333333333333"),
          baseSha: decodeCommitSha("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        };
        let prReads = 0;
        const heads: Array<string> = [];
        let prepareCalls = 0;
        const dynamicGithub = GitHub.GitHub.of({
          ...github,
          pr: () =>
            Effect.sync(() => {
              prReads += 1;
              return prReads === 1 ? detail : refreshedDetail;
            }),
        });
        const retryingWorkspaces = Workspaces.Workspaces.of({
          ...fixture.workspaces,
          prepare: (input) =>
            Effect.suspend(() => {
              prepareCalls += 1;
              heads.push(input.pullRequest.headSha);
              if (prepareCalls === 1) {
                return Effect.fail(
                  new Workspaces.WorkspaceError({
                    reason: "pinned-head-mismatch",
                    detail: "Head moved.",
                  }),
                );
              }
              return Effect.succeed({
                ...fixture.prepared,
                pullRequest: refreshedDetail,
                headSha: refreshedDetail.headSha,
                baseSha: refreshedDetail.baseSha,
              });
            }),
        });
        const retryFixture = { ...fixture, workspaces: retryingWorkspaces };
        const harness: AnalysisHarness = {
          kind: "codex",
          detect: Effect.die("unused"),
          run: (task) =>
            Effect.gen(function* () {
              const raw = task.prompt.startsWith("You are planning")
                ? validPlan
                : task.prompt.startsWith("Write the overview")
                  ? {
                      overview: {
                        brief: { markdown: "A focused change." },
                        whereToBegin: { markdown: "Begin with the core." },
                      },
                    }
                  : {
                      clusterId: "core",
                      narrative: { markdown: "Narrative." },
                      mapEntry: { markdown: "Map entry." },
                      resurfaced: [],
                      hints: [],
                    };
              const value = yield* task.decode(raw).pipe(
                Effect.mapError(
                  (cause) =>
                    new HarnessRunError({
                      kind: "codex",
                      reason: "invalid-output",
                      detail: "decode failed",
                      cause,
                    }),
                ),
              );
              return { value, continuation: "continuation" };
            }),
        };
        const pipeline = yield* makePipeline(retryFixture, harness, dynamicGithub);

        const result = yield* pipeline.run({
          pr,
          runId: fixture.prepared.runId,
          journeyId: decodeJourneyId("journey-3"),
          harness,
          callbacks: {
            onPhase: () => Effect.void,
            onStage: () => Effect.void,
            onHarnessEvent: () => Effect.void,
          },
        });

        assert.strictEqual(prReads, 2);
        assert.deepStrictEqual(heads, [detail.headSha, refreshedDetail.headSha]);
        assert.strictEqual(result.journey.pinned.headSha, refreshedDetail.headSha);
        assert.strictEqual(result.journey.pinned.baseSha, refreshedDetail.baseSha);
      }),
    );

    it.effect("abandons its prepared workspace when the job scope is cancelled", () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const started = yield* Deferred.make<void>();
        const harness: AnalysisHarness = {
          kind: "codex",
          detect: Effect.die("unused"),
          run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        };
        const pipeline = yield* makePipeline(fixture, harness);
        const fiber = yield* Effect.forkChild(
          pipeline.run({
            pr,
            runId: fixture.prepared.runId,
            journeyId: decodeJourneyId("journey-4"),
            harness,
            callbacks: {
              onPhase: () => Effect.void,
              onStage: () => Effect.void,
              onHarnessEvent: () => Effect.void,
            },
          }),
        );
        yield* Deferred.await(started);

        yield* Fiber.interrupt(fiber);

        assert.deepStrictEqual(fixture.operations, ["abandon"]);
        assert.deepStrictEqual(fixture.saved, []);
      }),
    );
  });
});
