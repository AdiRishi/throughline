import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  type Cluster,
  type ClusterId,
  type FileChange,
  type HarnessKind,
  type Hint,
  type Hunk,
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
        required: ["title", "weight", "seedIds"],
        properties: {
          title: { type: "string", minLength: 1 },
          weight: { enum: ["core", "supporting", "mechanical"] },
          seedIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const NARRATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "whereToBegin", "clusters"],
  properties: {
    brief: { type: "string" },
    whereToBegin: { type: "string" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "narrative", "mapEntry"],
        properties: {
          title: { type: "string" },
          narrative: { type: "string" },
          mapEntry: { type: "string" },
        },
      },
    },
  },
} as const;

const PlanningOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      weight: Schema.Literals(["core", "supporting", "mechanical"]),
      seedIds: Schema.Array(Schema.String),
    }),
  ),
});
const NarrationOutput = Schema.Struct({
  brief: Schema.String,
  whereToBegin: Schema.String,
  clusters: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      narrative: Schema.String,
      mapEntry: Schema.String,
    }),
  ),
});
const decodePlanning = Schema.decodeUnknownEffect(PlanningOutput);
const decodeNarration = Schema.decodeUnknownEffect(NarrationOutput);

export interface AnalyzeInput {
  readonly journeyId: JourneyId;
  readonly detail: PullRequestDetail;
  readonly workspace: PreparedWorkspace;
  readonly harness: HarnessKind;
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

Every seed hunk below must appear exactly once in seedIds. Group by reviewer intent and dependency, not merely by directory. Order clusters so foundations precede consumers. Prefer 3–8 clusters; use fewer for small changes. Titles must be concrete and concise.

Seed hunks:
${conciseSeeds(seeds)}`;
}

function narrationPrompt(
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
  return `Write the review journey for this pull request after exploring relevant code read-only.

PR: ${detail.title}
Description:
${detail.body}

Return one cluster narration for each title in exactly this order. Explain behavior, motivation, and review risks rather than restating diffs. Use markdown evidence links such as [changed code](tl:hunk/HUNK_ID) and [file](tl:file/path). Do not invent IDs, files, symbols, or behavior.

Journey plan:
${plan}`;
}

function deterministicPlan(seeds: ReadonlyArray<SeedHunk>): ReadonlyArray<{
  title: string;
  weight: "core" | "supporting" | "mechanical";
  seedIds: string[];
}> {
  const groups = new Map<string, Array<string>>();
  for (const seed of seeds) {
    const [top = seed.path] = seed.path.split("/");
    const current = groups.get(top) ?? [];
    current.push(seed.id);
    groups.set(top, current);
  }
  return [...groups].map(([scope, seedIds]) => ({
    title: scope.includes(".") ? `Update ${scope}` : `Update ${scope} area`,
    weight: seeds
      .filter((seed) => seedIds.includes(seed.id))
      .every((seed) => seed.fileKind !== undefined)
      ? "mechanical"
      : "core",
    seedIds,
  }));
}

function materializePlan(
  seeds: ReadonlyArray<SeedHunk>,
  planned: ReadonlyArray<{
    readonly title: string;
    readonly weight: "core" | "supporting" | "mechanical";
    readonly seedIds: ReadonlyArray<string>;
  }>,
): { readonly clusters: ReadonlyArray<Cluster>; readonly hunks: ReadonlyArray<Hunk> } {
  const seen = new Set<string>();
  const clusters = planned.flatMap((item, index): ReadonlyArray<Cluster> => {
    const validSeeds = item.seedIds.filter(
      (seedId) => seeds.some((seed) => seed.id === seedId) && !seen.has(seedId),
    );
    validSeeds.forEach((seedId) => seen.add(seedId));
    if (validSeeds.length === 0) return [];
    const id = `c-${index + 1}` as ClusterId;
    const paths = seeds
      .filter((seed) => validSeeds.includes(seed.id))
      .map((seed) => seed.path)
      .filter((path, pathIndex, all) => all.indexOf(path) === pathIndex);
    return [
      {
        id,
        position: index + 1,
        title: item.title.trim() || `Change group ${index + 1}`,
        weight: item.weight,
        narrative: { markdown: "" },
        mapEntry: { markdown: "" },
        buildsOn: index === 0 ? [] : [`c-${index}` as ClusterId],
        fileOrder: paths,
        resurfaced: [],
      },
    ];
  });
  const proposed = seeds.flatMap((seed): ReadonlyArray<Hunk> => {
    const cluster = clusters.find((_, index) => planned[index]?.seedIds.includes(seed.id));
    return cluster === undefined ? [] : [{ ...seed, seedId: seed.id, home: cluster.id }];
  });
  return completePartition(seeds, clusters, proposed);
}

function fallbackNarration(
  detail: PullRequestDetail,
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
) {
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
      };
    }),
  };
}

function withNarration(
  clusters: ReadonlyArray<Cluster>,
  narration: {
    readonly clusters: ReadonlyArray<{
      readonly title: string;
      readonly narrative: string;
      readonly mapEntry: string;
    }>;
  },
): ReadonlyArray<Cluster> {
  return clusters.map((cluster, index) => {
    const text = narration.clusters[index];
    return {
      ...cluster,
      narrative: { markdown: text?.narrative.trim() || cluster.narrative.markdown },
      mapEntry: { markdown: text?.mapEntry.trim() || cluster.mapEntry.markdown },
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

export const make = Effect.gen(function* () {
  const harness = yield* AnalysisHarness;
  return JourneyAnalysis.of({
    analyze: (input) =>
      Effect.gen(function* () {
        const responses: Array<HarnessResponse> = [];
        const planningResult = yield* harness
          .run({
            kind: input.harness,
            cwd: input.workspace.worktree,
            prompt: planningPrompt(input.detail, input.workspace.seeds),
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

        const planned =
          planningResult._tag === "Some"
            ? planningResult.value.output.clusters
            : deterministicPlan(input.workspace.seeds);
        if (planningResult._tag === "Some") responses.push(planningResult.value.response);

        let partition = materializePlan(input.workspace.seeds, planned);
        if (
          validateCoverage(input.workspace.seeds, partition.hunks, partition.clusters).length > 0
        ) {
          partition = materializePlan(
            input.workspace.seeds,
            deterministicPlan(input.workspace.seeds),
          );
        }

        const narrationResult = yield* harness
          .run({
            kind: input.harness,
            cwd: input.workspace.worktree,
            prompt: narrationPrompt(input.detail, partition.clusters, partition.hunks),
            outputSchema: NARRATION_SCHEMA,
          })
          .pipe(
            Effect.flatMap((response) =>
              decodeNarration(response.output).pipe(
                Effect.map((output) => ({ output, response })),
                Effect.mapError(
                  () =>
                    new HarnessError({
                      kind: input.harness,
                      detail: "The narration output did not match the required structure.",
                    }),
                ),
              ),
            ),
            Effect.option,
          );

        const fallback = fallbackNarration(input.detail, partition.clusters, partition.hunks);
        const narration =
          narrationResult._tag === "Some" &&
          narrationResult.value.output.clusters.length === partition.clusters.length
            ? narrationResult.value.output
            : fallback;
        if (narrationResult._tag === "Some") responses.push(narrationResult.value.response);

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
          clusters: withNarration(partition.clusters, narration),
          hunks: partition.hunks,
          files: input.workspace.files,
          hints: [] as ReadonlyArray<Hint>,
        };

        const changedContents = new Map<string, string>();
        const invalid = new Set(validateEvidence(journey, changedContents));
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
                clusters: withNarration(partition.clusters, narration),
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
