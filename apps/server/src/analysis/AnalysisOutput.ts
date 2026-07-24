import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  ClusterId,
  type Cluster,
  type ClusterId as ClusterIdValue,
  ClusterWeight,
  type FileChange,
  Hint,
  Hunk,
  type Hunk as HunkValue,
  type Journey,
  type JourneyId,
  Narrative,
  Overview,
  RepositoryPath,
  ResurfacedHunk,
  type SeedHunk,
  TrimmedNonEmptyString,
  type CommitSha,
  type HarnessUsage,
  type PrRef,
} from "@app/contracts";
import {
  canonicalizeHunkIds,
  type JourneyViolation,
  validateCoverage,
  validateRefinement,
} from "@app/journey/coverage";

const PlanCluster = Schema.Struct({
  id: ClusterId,
  title: TrimmedNonEmptyString,
  weight: ClusterWeight,
  buildsOn: Schema.Array(ClusterId),
  fileOrder: Schema.Array(RepositoryPath),
});
export type PlanCluster = typeof PlanCluster.Type;

export const PlanOutput = Schema.Struct({
  clusters: Schema.Array(PlanCluster),
  hunks: Schema.Array(Hunk),
});
export type PlanOutput = typeof PlanOutput.Type;

export const OverviewOutput = Schema.Struct({
  overview: Overview,
});
export type OverviewOutput = typeof OverviewOutput.Type;

export const ClusterNarrationOutput = Schema.Struct({
  clusterId: ClusterId,
  narrative: Narrative,
  mapEntry: Narrative,
  resurfaced: Schema.Array(ResurfacedHunk),
  hints: Schema.Array(Hint),
});
export type ClusterNarrationOutput = typeof ClusterNarrationOutput.Type;

export const decodePlanOutput = Schema.decodeUnknownEffect(PlanOutput);
export const decodeOverviewOutput = Schema.decodeUnknownEffect(OverviewOutput);
export const decodeClusterNarrationOutput = Schema.decodeUnknownEffect(ClusterNarrationOutput);

const jsonSchema = (schema: Schema.Top): Readonly<Record<string, unknown>> => {
  const document = Schema.toJsonSchemaDocument(schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { $defs: document.definitions }),
  };
};

export const planJsonSchema = jsonSchema(PlanOutput);
export const overviewJsonSchema = jsonSchema(OverviewOutput);
export const clusterNarrationJsonSchema = jsonSchema(ClusterNarrationOutput);

export interface FrozenPlan {
  readonly clusters: ReadonlyArray<Cluster>;
  readonly hunks: ReadonlyArray<HunkValue>;
}

export const validatePlanOutput = (
  output: PlanOutput,
  seeds: ReadonlyArray<SeedHunk>,
  files: ReadonlyArray<FileChange>,
): ReadonlyArray<JourneyViolation> => {
  const clusters = output.clusters.map((cluster, index) =>
    clusterWithPlaceholders(cluster, index + 1, cluster.fileOrder),
  );
  return validateCoverage({ seeds, files, clusters, hunks: output.hunks });
};

const placeholderNarrative = { markdown: "Analysis pending." } as const;

const unique = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

const clusterWithPlaceholders = (
  cluster: PlanCluster,
  position: number,
  fileOrder: ReadonlyArray<FileChange["path"]>,
): Cluster => ({
  ...cluster,
  position,
  buildsOn: [...cluster.buildsOn],
  fileOrder,
  narrative: placeholderNarrative,
  mapEntry: placeholderNarrative,
  resurfaced: [],
});

const normalizeClusters = (clusters: ReadonlyArray<PlanCluster>): ReadonlyArray<PlanCluster> => {
  const seen = new Set<string>();
  const normalized: PlanCluster[] = [];

  for (const cluster of clusters) {
    if (seen.has(cluster.id)) continue;
    seen.add(cluster.id);
    normalized.push(cluster);
  }

  return normalized;
};

const wholeSeed = (seed: SeedHunk, home: ClusterIdValue): HunkValue => ({
  id: "h1" as HunkValue["id"],
  path: seed.path,
  oldStart: seed.oldStart,
  oldLines: seed.oldLines,
  newStart: seed.newStart,
  newLines: seed.newLines,
  ...(seed.fileKind === undefined ? {} : { fileKind: seed.fileKind }),
  seedId: seed.id,
  home,
});

const deterministicPerFilePlan = (
  seeds: ReadonlyArray<SeedHunk>,
  files: ReadonlyArray<FileChange>,
): FrozenPlan => {
  const clusters: Cluster[] = [];
  const hunks: HunkValue[] = [];

  files.forEach((file, index) => {
    const id = `file-${index + 1}` as ClusterIdValue;
    clusters.push({
      id,
      position: index + 1,
      title: file.path,
      weight: "supporting",
      narrative: placeholderNarrative,
      mapEntry: placeholderNarrative,
      buildsOn: [],
      fileOrder: [file.path],
      resurfaced: [],
    });
    for (const seed of seeds) {
      if (seed.path === file.path) hunks.push(wholeSeed(seed, id));
    }
  });

  return {
    clusters,
    hunks: canonicalizeHunkIds(seeds, hunks),
  };
};

const deriveFileOrder = (
  clusterId: ClusterIdValue,
  hunks: ReadonlyArray<HunkValue>,
  preferred: ReadonlyArray<FileChange["path"]>,
): ReadonlyArray<FileChange["path"]> => {
  const homed = new Map(
    hunks
      .filter((hunk) => hunk.home === clusterId)
      .map((hunk) => [hunk.path as string, hunk.path] as const),
  );
  const ordered = preferred.filter((path) => homed.delete(path));
  return [
    ...ordered,
    ...[...homed.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, path]) => path),
  ];
};

export const completePlan = (
  output: PlanOutput | undefined,
  seeds: ReadonlyArray<SeedHunk>,
  files: ReadonlyArray<FileChange>,
): FrozenPlan => {
  const initialClusters = normalizeClusters(output?.clusters ?? []);
  if (initialClusters.length === 0) return deterministicPerFilePlan(seeds, files);

  const clusterIds = new Set(initialClusters.map((cluster) => cluster.id as string));
  const candidateHunks = output?.hunks ?? [];
  const accepted: HunkValue[] = [];
  const unassigned: SeedHunk[] = [];

  for (const seed of seeds) {
    const refinements = candidateHunks.filter(
      (hunk) => hunk.seedId === seed.id && clusterIds.has(hunk.home),
    );
    if (refinements.length > 0 && validateRefinement([seed], refinements).length === 0) {
      accepted.push(...refinements);
    } else {
      unassigned.push(seed);
    }
  }

  let unplacedId = "unplaced";
  for (let suffix = 2; clusterIds.has(unplacedId); suffix += 1) {
    unplacedId = `unplaced-${suffix}`;
  }
  const expandedClusters =
    unassigned.length === 0
      ? initialClusters
      : [
          ...initialClusters,
          {
            id: unplacedId as ClusterIdValue,
            title: "Unplaced changes",
            weight: "supporting" as const,
            buildsOn: [],
            fileOrder: unique(unassigned.map((seed) => seed.path)),
          },
        ];
  const fallbackHome =
    expandedClusters[expandedClusters.length - 1]?.id ?? ("unplaced" as ClusterIdValue);
  accepted.push(...unassigned.map((seed) => wholeSeed(seed, fallbackHome)));

  const usedHomes = new Set(accepted.map((hunk) => hunk.home as string));
  const retained = expandedClusters.filter((cluster) => usedHomes.has(cluster.id));
  const retainedIds = new Set(retained.map((cluster) => cluster.id as string));
  const canonicalHunks = canonicalizeHunkIds(seeds, accepted);
  const clusters = retained.map((cluster, index) => {
    const earlier = new Set(retained.slice(0, index).map((entry) => entry.id as string));
    const buildsOn = unique(cluster.buildsOn).filter(
      (id) => retainedIds.has(id) && earlier.has(id),
    );
    return clusterWithPlaceholders(
      { ...cluster, buildsOn },
      index + 1,
      deriveFileOrder(cluster.id, canonicalHunks, cluster.fileOrder),
    );
  });

  const completed = { clusters, hunks: canonicalHunks };
  return validateCoverage({ seeds, files, ...completed }).length === 0
    ? completed
    : deterministicPerFilePlan(seeds, files);
};

export const fallbackOverview = (clusters: ReadonlyArray<Cluster>): Overview => ({
  brief: {
    markdown:
      clusters.length === 0
        ? "This pull request contains no changed files."
        : `This pull request is organized into ${clusters.length} review ${clusters.length === 1 ? "cluster" : "clusters"}.`,
  },
  whereToBegin: {
    markdown:
      clusters[0] === undefined
        ? "There are no changes to review."
        : `Begin with **${clusters[0].title}** and continue in journey order.`,
  },
});

export const fallbackClusterNarration = (cluster: Cluster): ClusterNarrationOutput => ({
  clusterId: cluster.id,
  narrative: {
    markdown:
      cluster.title === "Unplaced changes"
        ? "These changes could not be placed confidently after structured repair, so they remain together here without inferred relationships."
        : `Review the changes in **${cluster.title}** together.`,
  },
  mapEntry: {
    markdown: `${cluster.title} groups the related changed hunks assigned to this cluster.`,
  },
  resurfaced: [],
  hints: [],
});

export interface JourneyInput {
  readonly id: JourneyId;
  readonly pr: PrRef;
  readonly headSha: CommitSha;
  readonly baseSha: CommitSha;
  readonly analyzedAt: DateTime.Utc;
  readonly harnessKind: string;
  readonly usage?: HarnessUsage;
  readonly files: ReadonlyArray<FileChange>;
  readonly plan: FrozenPlan;
  readonly overview: Overview;
  readonly narrations: ReadonlyMap<string, ClusterNarrationOutput>;
}

export const assembleJourney = (input: JourneyInput): Journey => ({
  formatVersion: 1,
  id: input.id,
  pr: input.pr,
  pinned: {
    headSha: input.headSha,
    baseSha: input.baseSha,
    analyzedAt: input.analyzedAt,
  },
  provenance: {
    harnessKind: input.harnessKind,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
  },
  overview: input.overview,
  clusters: input.plan.clusters.map((cluster) => {
    const narration = input.narrations.get(cluster.id);
    return narration === undefined
      ? cluster
      : {
          ...cluster,
          narrative: narration.narrative,
          mapEntry: narration.mapEntry,
          resurfaced: narration.resurfaced,
        };
  }),
  hunks: input.plan.hunks,
  files: input.files,
  hints: input.plan.clusters.flatMap((cluster) => input.narrations.get(cluster.id)?.hints ?? []),
});
