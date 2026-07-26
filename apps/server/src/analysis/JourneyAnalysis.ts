import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  type Cluster,
  type ClusterId,
  type HarnessKind,
  type Hint,
  type HintId,
  type Hunk,
  type HunkId,
  type Journey,
  type JourneyId,
  type PullRequestDetail,
  type SeedHunk,
} from "@app/contracts";
import { completePartition, validateCoverage } from "@app/journey/coverage";
import { downgradeInvalidEvidence, validateEvidence } from "@app/journey/evidence";

import { AnalysisHarness, HarnessError, type HarnessResponse } from "../harness/AnalysisHarness.ts";
import type { PreparedWorkspace } from "../workspace/Workspaces.ts";

const PLANNING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clusters"],
  properties: {
    clusters: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "title", "weight", "buildsOn", "fileOrder", "hunks"],
        properties: {
          key: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          weight: { enum: ["core", "supporting", "mechanical"] },
          buildsOn: { type: "array", items: { type: "string" } },
          fileOrder: { type: "array", items: { type: "string" } },
          hunks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "seedId", "oldStart", "oldLines", "newStart", "newLines"],
              properties: {
                id: { type: "string", minLength: 1 },
                seedId: { type: "string", minLength: 1 },
                oldStart: { type: "integer", minimum: 0 },
                oldLines: { type: "integer", minimum: 0 },
                newStart: { type: "integer", minimum: 0 },
                newLines: { type: "integer", minimum: 0 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const OVERVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "whereToBegin", "mapEntries"],
  properties: {
    brief: { type: "string" },
    whereToBegin: { type: "string" },
    mapEntries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "mapEntry"],
        properties: {
          title: { type: "string" },
          mapEntry: { type: "string" },
        },
      },
    },
  },
} as const;

const CLUSTER_NARRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "narrative", "hints", "resurfaced"],
  properties: {
    title: { type: "string" },
    narrative: { type: "string" },
    hints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "side", "startLine", "endLine", "body"],
        properties: {
          kind: {
            enum: ["connection", "complexity", "ripple", "pattern-echo", "behavior", "resurfacing"],
          },
          path: { type: "string" },
          side: { enum: ["old", "new"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          body: { type: "string" },
        },
      },
    },
    resurfaced: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hunkId", "note"],
        properties: {
          hunkId: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

const PlanningOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      weight: Schema.Literals(["core", "supporting", "mechanical"]),
      buildsOn: Schema.Array(Schema.String),
      fileOrder: Schema.Array(Schema.String),
      hunks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          seedId: Schema.String,
          oldStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          oldLines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          newStart: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          newLines: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ),
    }),
  ),
});
const OverviewOutput = Schema.Struct({
  brief: Schema.String,
  whereToBegin: Schema.String,
  mapEntries: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      mapEntry: Schema.String,
    }),
  ),
});
const ClusterNarrationOutput = Schema.Struct({
  title: Schema.String,
  narrative: Schema.String,
  hints: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals([
        "connection",
        "complexity",
        "ripple",
        "pattern-echo",
        "behavior",
        "resurfacing",
      ]),
      path: Schema.String,
      side: Schema.Literals(["old", "new"]),
      startLine: Schema.Int,
      endLine: Schema.Int,
      body: Schema.String,
    }),
  ),
  resurfaced: Schema.Array(
    Schema.Struct({
      hunkId: Schema.String,
      note: Schema.String,
    }),
  ),
});
const decodePlanning = Schema.decodeUnknownEffect(PlanningOutput);
const decodeOverview = Schema.decodeUnknownEffect(OverviewOutput);
const decodeClusterNarration = Schema.decodeUnknownEffect(ClusterNarrationOutput);

export interface AnalyzeInput {
  readonly journeyId: JourneyId;
  readonly detail: PullRequestDetail;
  readonly workspace: PreparedWorkspace;
  readonly harness: HarnessKind;
  readonly onStage: (stage: "narrating", recent: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class JourneyAnalysis extends Context.Service<
  JourneyAnalysis,
  {
    readonly analyze: (input: AnalyzeInput) => Effect.Effect<Journey, never>;
  }
>()("@app/server/analysis/JourneyAnalysis") {}

function conciseSeeds(seeds: ReadonlyArray<SeedHunk>): string {
  return seeds
    .map(
      (seed) =>
        `${seed.id} ${seed.path} old:${seed.oldStart}+${seed.oldLines} new:${seed.newStart}+${seed.newLines}${seed.fileKind === undefined ? "" : ` ${seed.fileKind}`}`,
    )
    .join("\n");
}

function planningPrompt(detail: PullRequestDetail, seeds: ReadonlyArray<SeedHunk>): string {
  return `You are structuring a pull request for a human reviewer. Explore the repository read-only.

PR: ${detail.title}
Description:
${detail.body}

Group changed ranges by reviewer intent and dependency, not merely by directory. Order clusters so foundations precede consumers. Give every cluster a short unique key; buildsOn may reference only earlier keys. fileOrder must list every file owned by the cluster in the best reading order.

Every seed hunk must be covered exactly once. Usually copy it into one output hunk with the same id and ranges. Split a seed only when separate contiguous subranges genuinely belong to distinct reviewer intents; split ranges must exactly tile both the old and new changed-line ranges without gaps, overlap, or invented lines. A file-level seed ending in binary, rename, mode, symlink, submodule, or empty may never be split. Output hunk ids must be unique. Prefer 3–8 clusters; use fewer for small changes. Titles must be concrete and concise.

Seed hunks:
${conciseSeeds(seeds)}`;
}

function overviewPrompt(
  detail: PullRequestDetail,
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
): string {
  const plan = clusters
    .map((cluster) => {
      const owned = hunks.filter((hunk) => hunk.home === cluster.id);
      return `${cluster.title}\n${owned.map((hunk) => `- ${hunk.id} ${hunk.path}`).join("\n")}`;
    })
    .join("\n\n");
  return `Write the overview for this pull request after exploring relevant code read-only.

PR: ${detail.title}
Description:
${detail.body}

Return one concise map entry for each title in exactly this order, plus a pull-request brief and where-to-begin recommendation. Explain reviewer intent and dependency order rather than restating file names. Every behavioral claim must use markdown evidence links such as [changed code](tl:hunk/HUNK_ID) and [file](tl:file/path). Do not invent IDs, files, symbols, line numbers, or behavior.

Journey plan:
${plan}`;
}

function clusterNarrationPrompt(
  detail: PullRequestDetail,
  cluster: Cluster,
  hunks: ReadonlyArray<Hunk>,
  earlierClusters: ReadonlyArray<Cluster>,
): string {
  const owned = hunks.filter((hunk) => hunk.home === cluster.id);
  const earlier = hunks.filter((hunk) =>
    earlierClusters.some((candidate) => candidate.id === hunk.home),
  );
  return `Write the narration for one frozen review-journey cluster after exploring relevant code read-only.

PR: ${detail.title}
Description:
${detail.body}

Cluster: ${cluster.title}
Weight: ${cluster.weight}
Owned hunks:
${owned.map((hunk) => `- ${hunk.id} ${hunk.path} old:${hunk.oldStart}+${hunk.oldLines} new:${hunk.newStart}+${hunk.newLines}`).join("\n")}

Earlier hunks eligible to resurface:
${earlier.map((hunk) => `- ${hunk.id} ${hunk.path}`).join("\n") || "- none"}

Explain the behavior, motivation, connections, and review risks as a coherent reading guide rather than restating the diff. Every behavioral claim must use markdown evidence links such as [changed code](tl:hunk/HUNK_ID) and [file](tl:file/path). Add only useful comprehension hints anchored to exact old or new line ranges in this cluster's files; zero hints is better than generic advice. Hints explain connections, behavior, complexity, ripples, repeated patterns, or resurfacing—never quality judgments. Resurface only an earlier hunk that is genuinely needed for comprehension, with a short note. Do not invent IDs, files, symbols, line numbers, or behavior. Return the exact cluster title.`;
}

type PlannedCluster = (typeof PlanningOutput.Type)["clusters"][number];

function deterministicPlan(seeds: ReadonlyArray<SeedHunk>): ReadonlyArray<PlannedCluster> {
  const groups = new Map<string, Array<SeedHunk>>();
  for (const seed of seeds) {
    const [top = seed.path] = seed.path.split("/");
    const current = groups.get(top) ?? [];
    current.push(seed);
    groups.set(top, current);
  }
  return [...groups].map(([scope, group], index) => ({
    key: `group-${index + 1}`,
    title: scope.includes(".") ? `Update ${scope}` : `Update ${scope} area`,
    weight: group.every((seed) => seed.fileKind !== undefined) ? "mechanical" : "core",
    buildsOn: index === 0 ? [] : [`group-${index}`],
    fileOrder: group
      .map((seed) => seed.path)
      .filter((path, pathIndex, paths) => paths.indexOf(path) === pathIndex),
    hunks: group.map((seed) => ({
      id: seed.id,
      seedId: seed.id,
      oldStart: seed.oldStart,
      oldLines: seed.oldLines,
      newStart: seed.newStart,
      newLines: seed.newLines,
    })),
  }));
}

function proposedPlan(
  seeds: ReadonlyArray<SeedHunk>,
  planned: ReadonlyArray<PlannedCluster>,
): { readonly clusters: ReadonlyArray<Cluster>; readonly hunks: ReadonlyArray<Hunk> } {
  const included = planned.filter((item) =>
    item.hunks.some((hunk) => seeds.some((seed) => seed.id === hunk.seedId)),
  );
  const clusterIdByKey = new Map(
    included.map((item, index) => [item.key, `c-${index + 1}` as ClusterId]),
  );
  const clusters = included.map((item, index): Cluster => {
    const id = `c-${index + 1}` as ClusterId;
    return {
      id,
      position: index + 1,
      title: item.title.trim() || `Change group ${index + 1}`,
      weight: item.weight,
      narrative: { markdown: "" },
      mapEntry: { markdown: "" },
      buildsOn: item.buildsOn.flatMap((key) => {
        const target = clusterIdByKey.get(key);
        return target === undefined ? [] : [target];
      }),
      fileOrder: item.fileOrder,
      resurfaced: [],
    };
  });
  const hunks = included.flatMap((item, index) => {
    const home = clusters[index]?.id;
    if (home === undefined) return [];
    return item.hunks.flatMap((proposed): ReadonlyArray<Hunk> => {
      const seed = seeds.find((candidate) => candidate.id === proposed.seedId);
      if (seed === undefined) return [];
      return [
        {
          id: proposed.id as HunkId,
          seedId: seed.id,
          path: seed.path,
          oldStart: proposed.oldStart,
          oldLines: proposed.oldLines,
          newStart: proposed.newStart,
          newLines: proposed.newLines,
          ...(seed.fileKind === undefined ? {} : { fileKind: seed.fileKind }),
          home,
        },
      ];
    });
  });
  return { clusters, hunks };
}

function materializePlan(
  seeds: ReadonlyArray<SeedHunk>,
  planned: ReadonlyArray<PlannedCluster>,
): { readonly clusters: ReadonlyArray<Cluster>; readonly hunks: ReadonlyArray<Hunk> } {
  const proposed = proposedPlan(seeds, planned);
  return completePartition(seeds, proposed.clusters, proposed.hunks);
}

interface MaterializedNarration {
  readonly brief: string;
  readonly whereToBegin: string;
  readonly clusters: ReadonlyArray<{
    readonly title: string;
    readonly narrative: string;
    readonly mapEntry: string;
    readonly hints: ReadonlyArray<(typeof ClusterNarrationOutput.Type)["hints"][number]>;
    readonly resurfaced: ReadonlyArray<{ readonly hunkId: string; readonly note: string }>;
  }>;
}

function fallbackNarration(
  detail: PullRequestDetail,
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
): MaterializedNarration {
  return {
    brief: `${detail.title} changes ${detail.changedFiles} files with ${detail.additions} additions and ${detail.deletions} deletions. The journey orders the changes by their role in the implementation.`,
    whereToBegin:
      clusters[0] === undefined
        ? "There are no textual changes to review."
        : `Begin with **${clusters[0].title}**, then follow the journey in order.`,
    clusters: clusters.map((cluster) => {
      const owned = hunks.filter((hunk) => hunk.home === cluster.id);
      const links = owned
        .slice(0, 4)
        .map((hunk) => `[${hunk.path}](tl:hunk/${hunk.id})`)
        .join(", ");
      return {
        title: cluster.title,
        narrative: `Review ${links || "the file-level changes"} as one cohesive part of the pull request.`,
        mapEntry: `Covers ${cluster.fileOrder.length} ${cluster.fileOrder.length === 1 ? "file" : "files"} in this part of the change.`,
        hints: [],
        resurfaced: [],
      };
    }),
  };
}

function withNarration(
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
  narration: MaterializedNarration,
): ReadonlyArray<Cluster> {
  return clusters.map((cluster, index) => {
    const text = narration.clusters[index];
    const validResurfaced =
      text?.resurfaced.flatMap((item) => {
        const hunk = hunks.find((candidate) => candidate.id === item.hunkId);
        const home =
          hunk === undefined ? undefined : clusters.find((candidate) => candidate.id === hunk.home);
        return hunk !== undefined &&
          home !== undefined &&
          home.position < cluster.position &&
          item.note.trim() !== ""
          ? [{ hunkId: hunk.id, note: { markdown: item.note } }]
          : [];
      }) ?? [];
    return {
      ...cluster,
      narrative: { markdown: text?.narrative.trim() || cluster.narrative.markdown },
      mapEntry: { markdown: text?.mapEntry.trim() || cluster.mapEntry.markdown },
      resurfaced: validResurfaced,
      fileOrder: [
        ...cluster.fileOrder,
        ...validResurfaced.flatMap((item) => {
          const hunk = hunks.find((candidate) => candidate.id === item.hunkId);
          return hunk === undefined ? [] : [hunk.path];
        }),
      ].filter((path, pathIndex, paths) => paths.indexOf(path) === pathIndex),
    };
  });
}

function mergeUsage(responses: ReadonlyArray<HarnessResponse>) {
  const inputTokens = responses.reduce(
    (sum, response) => sum + (response.usage?.inputTokens ?? 0),
    0,
  );
  const outputTokens = responses.reduce(
    (sum, response) => sum + (response.usage?.outputTokens ?? 0),
    0,
  );
  return inputTokens === 0 && outputTokens === 0 ? undefined : { inputTokens, outputTokens };
}

function planningIssues(
  seeds: ReadonlyArray<SeedHunk>,
  planned: ReadonlyArray<PlannedCluster>,
): ReadonlyArray<string> {
  const expected = new Set(seeds.map((seed) => seed.id as string));
  const clusterKeys = new Set<string>();
  const hunkIds = new Set<string>();
  const issues = planned.flatMap((cluster, index) => {
    const local: Array<string> = [];
    if (clusterKeys.has(cluster.key)) local.push(`duplicate cluster key ${cluster.key}`);
    clusterKeys.add(cluster.key);
    for (const target of cluster.buildsOn) {
      if (!planned.slice(0, index).some((candidate) => candidate.key === target)) {
        local.push(`cluster ${cluster.key} builds on unknown or later cluster ${target}`);
      }
    }
    for (const hunk of cluster.hunks) {
      if (!expected.has(hunk.seedId)) local.push(`unknown seed ${hunk.seedId}`);
      if (hunkIds.has(hunk.id)) local.push(`duplicate output hunk ${hunk.id}`);
      hunkIds.add(hunk.id);
    }
    return local;
  });
  const proposed = proposedPlan(seeds, planned);
  return [
    ...issues,
    ...validateCoverage(seeds, proposed.hunks, proposed.clusters).map((issue) =>
      JSON.stringify(issue),
    ),
  ];
}

function materializeHints(
  journeyId: JourneyId,
  clusters: ReadonlyArray<Cluster>,
  narration: MaterializedNarration,
  textContents: ReadonlyMap<string, string>,
): ReadonlyArray<Hint> {
  return clusters.flatMap((cluster, clusterIndex) => {
    const narrated = narration.clusters[clusterIndex];
    if (narrated === undefined) return [];
    return narrated.hints.flatMap((hint, hintIndex): ReadonlyArray<Hint> => {
      const lineCount = textContents.get(hint.path)?.split("\n").length;
      if (
        !cluster.fileOrder.includes(hint.path) ||
        lineCount === undefined ||
        hint.startLine < 1 ||
        hint.endLine < hint.startLine ||
        hint.endLine > lineCount ||
        hint.body.trim() === ""
      ) {
        return [];
      }
      return [
        {
          id: `${journeyId}:hint:${clusterIndex + 1}:${hintIndex + 1}` as HintId,
          clusterId: cluster.id,
          kind: hint.kind,
          anchor: {
            path: hint.path,
            side: hint.side,
            startLine: hint.startLine,
            endLine: hint.endLine,
          },
          body: { markdown: hint.body },
        },
      ];
    });
  });
}

export const make = Effect.gen(function* () {
  const harness = yield* AnalysisHarness;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return JourneyAnalysis.of({
    analyze: (input) =>
      Effect.gen(function* () {
        const responses: Array<HarnessResponse> = [];
        const transcriptDir = path.join(input.workspace.runDir, "analysis");
        yield* fileSystem.makeDirectory(transcriptDir, { recursive: true });
        const persistTranscript = (name: string, response: HarnessResponse) =>
          fileSystem.writeFileString(
            path.join(transcriptDir, `${name}.jsonl`),
            response.transcript,
          );
        const runPlanning = (prompt: string) =>
          harness
            .run({
              kind: input.harness,
              cwd: input.workspace.worktree,
              prompt,
              outputSchema: PLANNING_SCHEMA,
            })
            .pipe(
              Effect.flatMap((response) =>
                decodePlanning(response.output).pipe(
                  Effect.map((output) => ({ output, response })),
                  Effect.mapError(
                    () =>
                      new HarnessError({
                        kind: input.harness,
                        detail: "The planning output did not match the required structure.",
                      }),
                  ),
                ),
              ),
              Effect.option,
            );

        const basePlanningPrompt = planningPrompt(input.detail, input.workspace.seeds);
        let planningResult = yield* runPlanning(basePlanningPrompt);
        let issues =
          planningResult._tag === "Some"
            ? planningIssues(input.workspace.seeds, planningResult.value.output.clusters)
            : ["planning output did not match the schema"];
        if (planningResult._tag === "Some") {
          responses.push(planningResult.value.response);
          yield* persistTranscript("planning-1", planningResult.value.response);
        }
        for (let repair = 1; repair <= 2 && issues.length > 0; repair += 1) {
          const repaired = yield* runPlanning(
            `${basePlanningPrompt}

Your previous plan failed deterministic validation:
${issues.map((issue) => `- ${issue}`).join("\n")}

Return the entire corrected plan. Do not explain the repair.`,
          );
          if (repaired._tag === "Some") {
            responses.push(repaired.value.response);
            yield* persistTranscript(`planning-repair-${repair}`, repaired.value.response);
            planningResult = repaired;
            issues = planningIssues(input.workspace.seeds, repaired.value.output.clusters);
          } else {
            issues = ["repair output did not match the schema"];
          }
        }

        const planned =
          planningResult._tag === "Some" && issues.length === 0
            ? planningResult.value.output.clusters
            : deterministicPlan(input.workspace.seeds);
        let partition = materializePlan(input.workspace.seeds, planned);
        const coverageIssues = validateCoverage(
          input.workspace.seeds,
          partition.hunks,
          partition.clusters,
        );
        if (coverageIssues.length > 0) {
          partition = materializePlan(
            input.workspace.seeds,
            deterministicPlan(input.workspace.seeds),
          );
        }

        yield* input.onStage(
          "narrating",
          partition.clusters.slice(0, 5).map((cluster) => cluster.title),
        );
        const fallback = fallbackNarration(input.detail, partition.clusters, partition.hunks);
        const runOverview = harness
          .run({
            kind: input.harness,
            cwd: input.workspace.worktree,
            prompt: overviewPrompt(input.detail, partition.clusters, partition.hunks),
            outputSchema: OVERVIEW_SCHEMA,
          })
          .pipe(
            Effect.flatMap((response) =>
              decodeOverview(response.output).pipe(
                Effect.map((output) => ({ output, response })),
                Effect.mapError(
                  () =>
                    new HarnessError({
                      kind: input.harness,
                      detail: "The overview output did not match the required structure.",
                    }),
                ),
              ),
            ),
            Effect.option,
          );
        const overviewResult = yield* runOverview;
        if (overviewResult._tag === "Some") {
          responses.push(overviewResult.value.response);
          yield* persistTranscript("overview", overviewResult.value.response);
        }

        const clusterResults = yield* Effect.forEach(
          partition.clusters,
          (cluster, index) =>
            Effect.gen(function* () {
              yield* input.onStage(
                "narrating",
                partition.clusters
                  .slice(Math.max(0, index - 3), index + 1)
                  .map((candidate) => candidate.title),
              );
              const prompt = clusterNarrationPrompt(
                input.detail,
                cluster,
                partition.hunks,
                partition.clusters.slice(0, index),
              );
              const runCluster = harness
                .run({
                  kind: input.harness,
                  cwd: input.workspace.worktree,
                  prompt,
                  outputSchema: CLUSTER_NARRATION_SCHEMA,
                })
                .pipe(
                  Effect.flatMap((response) =>
                    decodeClusterNarration(response.output).pipe(
                      Effect.map((output) => ({ output, response })),
                      Effect.mapError(
                        () =>
                          new HarnessError({
                            kind: input.harness,
                            detail: `The narration for ${cluster.title} did not match the required structure.`,
                          }),
                      ),
                    ),
                  ),
                  Effect.option,
                );
              const first = yield* runCluster;
              const result = first._tag === "Some" ? first : yield* runCluster;
              if (result._tag === "Some") {
                responses.push(result.value.response);
                yield* persistTranscript(
                  `cluster-${String(index + 1).padStart(2, "0")}`,
                  result.value.response,
                );
              }
              return result;
            }),
          { concurrency: 1 },
        );

        const overview =
          overviewResult._tag === "Some" &&
          overviewResult.value.output.mapEntries.length === partition.clusters.length
            ? overviewResult.value.output
            : {
                brief: fallback.brief,
                whereToBegin: fallback.whereToBegin,
                mapEntries: fallback.clusters.map((cluster) => ({
                  title: cluster.title,
                  mapEntry: cluster.mapEntry,
                })),
              };
        const narration: MaterializedNarration = {
          brief: overview.brief,
          whereToBegin: overview.whereToBegin,
          clusters: partition.clusters.map((cluster, index) => {
            const fallbackCluster = fallback.clusters[index] as NonNullable<
              (typeof fallback.clusters)[number]
            >;
            const result = clusterResults[index];
            const narrated =
              result?._tag === "Some" && result.value.output.title === cluster.title
                ? result.value.output
                : fallbackCluster;
            return {
              title: cluster.title,
              narrative: narrated.narrative,
              mapEntry: overview.mapEntries[index]?.mapEntry ?? fallbackCluster.mapEntry,
              hints: narrated.hints,
              resurfaced: narrated.resurfaced,
            };
          }),
        };

        const analyzedAt = yield* DateTime.now;
        const usage = mergeUsage(responses);
        const model = responses.at(-1)?.model;
        const journey: Journey = {
          formatVersion: 1,
          id: input.journeyId,
          pr: input.detail.ref,
          prMetadata: {
            title: input.detail.title,
            body: input.detail.body,
            url: input.detail.url,
            author: input.detail.author.login,
            baseBranch: input.detail.baseBranch,
            headBranch: input.detail.headBranch,
          },
          pinned: {
            headSha: input.workspace.headSha,
            baseSha: input.workspace.baseSha,
            analyzedAt,
          },
          provenance: {
            harnessKind: input.harness,
            ...(model === undefined ? {} : { model }),
            ...(usage === undefined ? {} : { usage }),
          },
          overview: {
            brief: { markdown: narration.brief },
            whereToBegin: { markdown: narration.whereToBegin },
          },
          clusters: withNarration(partition.clusters, partition.hunks, narration),
          hunks: partition.hunks,
          files: input.workspace.files,
          hints: materializeHints(
            input.journeyId,
            partition.clusters,
            narration,
            input.workspace.textContents,
          ),
        };

        const invalid = new Set(validateEvidence(journey, input.workspace.textContents));
        if (invalid.size === 0) return journey;
        const clean = (markdown: string) => downgradeInvalidEvidence(markdown, invalid);
        return {
          ...journey,
          overview: {
            brief: { markdown: clean(journey.overview.brief.markdown) },
            whereToBegin: { markdown: clean(journey.overview.whereToBegin.markdown) },
          },
          clusters: journey.clusters.map((cluster) => ({
            ...cluster,
            narrative: { markdown: clean(cluster.narrative.markdown) },
            mapEntry: { markdown: clean(cluster.mapEntry.markdown) },
          })),
          hints: journey.hints.map((hint) => ({
            ...hint,
            body: { markdown: clean(hint.body.markdown) },
          })),
        };
      }).pipe(
        Effect.catchCause(() => {
          const partition = materializePlan(
            input.workspace.seeds,
            deterministicPlan(input.workspace.seeds),
          );
          return DateTime.now.pipe(
            Effect.map((analyzedAt): Journey => {
              const narration = fallbackNarration(
                input.detail,
                partition.clusters,
                partition.hunks,
              );
              return {
                formatVersion: 1,
                id: input.journeyId,
                pr: input.detail.ref,
                prMetadata: {
                  title: input.detail.title,
                  body: input.detail.body,
                  url: input.detail.url,
                  author: input.detail.author.login,
                  baseBranch: input.detail.baseBranch,
                  headBranch: input.detail.headBranch,
                },
                pinned: {
                  headSha: input.workspace.headSha,
                  baseSha: input.workspace.baseSha,
                  analyzedAt,
                },
                provenance: { harnessKind: input.harness },
                overview: {
                  brief: { markdown: narration.brief },
                  whereToBegin: { markdown: narration.whereToBegin },
                },
                clusters: withNarration(partition.clusters, partition.hunks, narration),
                hunks: partition.hunks,
                files: input.workspace.files,
                hints: [],
              };
            }),
          );
        }),
      ),
  });
});

export const layer = Layer.effect(JourneyAnalysis, make);
