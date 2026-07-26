/**
 * From an agent's plan to a valid partition — including when the plan is bad.
 *
 * `validatePlan` produces the precise violation list the repair turn is fed.
 * `materializePlan` is the pipeline's deterministic completion: it is *total*,
 * turning any plan (including an empty one) into hunks that satisfy the
 * coverage validator, recording every fallback it had to stand on.
 *
 * This is what makes "the agent always commits" an invariant of the system
 * rather than a hope about the model.
 *
 * @module plan
 */
import type {
  ClusterId,
  CoverageViolation,
  FileChange,
  Hunk,
  HunkId,
  SeedHunk,
  Weight,
} from "@app/contracts";

/** Stage 1's output, before any of it is trusted. */
export interface PlanCluster {
  readonly id: string;
  readonly title: string;
  readonly weight: string;
  readonly buildsOn: ReadonlyArray<string>;
  readonly fileOrder: ReadonlyArray<string>;
}

export interface PlanSplitPart {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly cluster: string;
}

export interface PlanSplit {
  readonly seedId: string;
  readonly parts: ReadonlyArray<PlanSplitPart>;
}

export interface JourneyPlan {
  readonly clusters: ReadonlyArray<PlanCluster>;
  /** One entry per seed hunk that is *not* split. */
  readonly homes: ReadonlyArray<{ readonly hunkId: string; readonly cluster: string }>;
  readonly splits: ReadonlyArray<PlanSplit>;
}

/** The plan, made real: clusters without their words yet, and homed hunks. */
export interface PlannedCluster {
  readonly id: ClusterId;
  readonly position: number;
  readonly title: string;
  readonly weight: Weight;
  readonly buildsOn: ReadonlyArray<ClusterId>;
  readonly fileOrder: ReadonlyArray<string>;
}

export interface MaterializedPlan {
  readonly clusters: ReadonlyArray<PlannedCluster>;
  readonly hunks: ReadonlyArray<Hunk>;
  /** Every deterministic completion applied, in order. The honesty trail. */
  readonly fallbacks: ReadonlyArray<string>;
}

const WEIGHTS = new Set<Weight>(["core", "supporting", "mechanical"]);

const UNPLACED_TITLE = "Unplaced changes";

/**
 * The narrative the synthesized cluster carries. It says exactly how it came to
 * exist, because a reviewer who meets this cluster deserves to know that the
 * pipeline placed these hunks, not the analysis.
 */
export const UNPLACED_NARRATIVE =
  "These changes were not placed by the analysis, so the pipeline gathered them here rather than dropping them. " +
  "Coverage is a guarantee, not a best effort: every changed line appears in exactly one cluster, and these are the ones that had no better home. " +
  "Read them as a remainder — related only by having been left over.";

function normalizeWeight(value: string): Weight {
  return WEIGHTS.has(value as Weight) ? (value as Weight) : "supporting";
}

function violation(
  kind: CoverageViolation["kind"],
  message: string,
  extra?: { readonly path?: string; readonly hunkId?: HunkId; readonly clusterId?: ClusterId },
): CoverageViolation {
  return {
    kind,
    message,
    path: extra?.path ?? null,
    hunkId: extra?.hunkId ?? null,
    clusterId: extra?.clusterId ?? null,
  };
}

function tilingProblem(
  seedStart: number,
  seedLength: number,
  parts: ReadonlyArray<{ readonly start: number; readonly length: number }>,
): string | null {
  const occupied = parts.filter((part) => part.length > 0).toSorted((a, b) => a.start - b.start);
  if (seedLength === 0) {
    return occupied.length === 0 ? null : `covers lines the seed hunk does not have`;
  }
  if (occupied.length === 0)
    return `leaves lines ${seedStart}–${seedStart + seedLength - 1} uncovered`;
  let cursor = seedStart;
  for (const part of occupied) {
    if (part.start < cursor) return `covers line ${part.start} twice`;
    if (part.start > cursor) return `leaves lines ${cursor}–${part.start - 1} uncovered`;
    cursor = part.start + part.length;
  }
  const end = seedStart + seedLength;
  if (cursor < end) return `leaves lines ${cursor}–${end - 1} uncovered`;
  if (cursor > end) return `covers lines ${end}–${cursor - 1}, which the seed hunk does not`;
  return null;
}

/**
 * Check a plan against the seeds. This is what the repair turn is shown; it is
 * deliberately exhaustive — a model that gets one violation at a time takes one
 * round trip per mistake.
 */
export function validatePlan(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly files: ReadonlyArray<FileChange>;
  readonly plan: JourneyPlan;
}): ReadonlyArray<CoverageViolation> {
  const violations: CoverageViolation[] = [];
  const { plan, seeds } = input;

  const clusterIds = new Set<string>();
  const positionById = new Map<string, number>();
  plan.clusters.forEach((cluster, index) => {
    if (cluster.id.trim().length === 0) {
      violations.push(
        violation("cluster-order-invalid", `Cluster at position ${index + 1} has an empty id.`),
      );
      return;
    }
    if (clusterIds.has(cluster.id)) {
      violations.push(
        violation("cluster-order-invalid", `Cluster id ${cluster.id} is used more than once.`),
      );
      return;
    }
    clusterIds.add(cluster.id);
    positionById.set(cluster.id, index + 1);
    if (cluster.title.trim().length === 0) {
      violations.push(
        violation("cluster-order-invalid", `Cluster ${cluster.id} has an empty title.`, {
          clusterId: cluster.id as ClusterId,
        }),
      );
    }
    if (!WEIGHTS.has(cluster.weight as Weight)) {
      violations.push(
        violation(
          "cluster-order-invalid",
          `Cluster ${cluster.id} has weight "${cluster.weight}"; it must be core, supporting, or mechanical.`,
          { clusterId: cluster.id as ClusterId },
        ),
      );
    }
  });

  if (plan.clusters.length === 0) {
    violations.push(violation("cluster-order-invalid", "The plan contains no clusters."));
  }

  for (const cluster of plan.clusters) {
    const position = positionById.get(cluster.id);
    for (const dependency of cluster.buildsOn) {
      const target = positionById.get(dependency);
      if (target === undefined) {
        violations.push(
          violation(
            "builds-on-unknown-cluster",
            `Cluster ${cluster.id} builds on ${dependency}, which is not in the plan.`,
            {
              clusterId: cluster.id as ClusterId,
            },
          ),
        );
      } else if (position !== undefined && target >= position) {
        violations.push(
          violation(
            "builds-on-forward-reference",
            `Cluster ${cluster.id} (position ${position}) builds on ${dependency} (position ${target}); a cluster may only build on earlier ones.`,
            { clusterId: cluster.id as ClusterId },
          ),
        );
      }
    }
  }

  const seedsById = new Map(seeds.map((seed) => [seed.id as string, seed]));
  const covered = new Map<string, number>();

  for (const split of plan.splits) {
    const seed = seedsById.get(split.seedId);
    if (seed === undefined) {
      violations.push(
        violation("unknown-hunk", `The plan splits ${split.seedId}, which is not a seed hunk.`),
      );
      continue;
    }
    covered.set(split.seedId, (covered.get(split.seedId) ?? 0) + 1);
    if (seed.fileKind !== null) {
      violations.push(
        violation(
          "split-of-file-hunk",
          `Seed hunk ${seed.id} (${seed.path}) is a file-level hunk and may not be split.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
      continue;
    }
    if (split.parts.length < 2) {
      violations.push(
        violation(
          "split-does-not-tile-seed",
          `The split of seed hunk ${seed.id} has ${split.parts.length} part(s); a split needs at least two. Assign it as a whole instead.`,
          { hunkId: seed.id, path: seed.path },
        ),
      );
    }
    for (const part of split.parts) {
      if (!clusterIds.has(part.cluster)) {
        violations.push(
          violation(
            "hunk-unknown-home",
            `A part of seed hunk ${seed.id} is homed to ${part.cluster}, which is not a cluster in the plan.`,
            {
              hunkId: seed.id,
              path: seed.path,
            },
          ),
        );
      }
      if (part.oldLines === 0 && part.newLines === 0) {
        violations.push(
          violation(
            "split-does-not-tile-seed",
            `A part of seed hunk ${seed.id} covers no lines at all.`,
            {
              hunkId: seed.id,
              path: seed.path,
            },
          ),
        );
      }
    }
    const oldProblem = tilingProblem(
      seed.oldStart,
      seed.oldLines,
      split.parts.map((part) => ({ start: part.oldStart, length: part.oldLines })),
    );
    if (oldProblem !== null) {
      violations.push(
        violation(
          "split-does-not-tile-seed",
          `The split of seed hunk ${seed.id} (${seed.path}, old side) ${oldProblem}.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
    }
    const newProblem = tilingProblem(
      seed.newStart,
      seed.newLines,
      split.parts.map((part) => ({ start: part.newStart, length: part.newLines })),
    );
    if (newProblem !== null) {
      violations.push(
        violation(
          "split-does-not-tile-seed",
          `The split of seed hunk ${seed.id} (${seed.path}, new side) ${newProblem}.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
    }
  }

  for (const home of plan.homes) {
    const seed = seedsById.get(home.hunkId);
    if (seed === undefined) {
      violations.push(
        violation("unknown-hunk", `The plan assigns ${home.hunkId}, which is not a seed hunk.`),
      );
      continue;
    }
    covered.set(home.hunkId, (covered.get(home.hunkId) ?? 0) + 1);
    if (!clusterIds.has(home.cluster)) {
      violations.push(
        violation(
          "hunk-unknown-home",
          `Seed hunk ${seed.id} is homed to ${home.cluster}, which is not a cluster in the plan.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
    }
  }

  for (const seed of seeds) {
    const count = covered.get(seed.id) ?? 0;
    if (count === 0) {
      violations.push(
        violation(
          "hunk-unassigned",
          `Seed hunk ${seed.id} (${seed.path}) is not assigned to any cluster.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
    } else if (count > 1) {
      violations.push(
        violation(
          "line-covered-twice",
          `Seed hunk ${seed.id} (${seed.path}) is both assigned and split; choose one.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
    }
  }

  const usedClusters = new Set<string>([
    ...plan.homes.map((home) => home.cluster),
    ...plan.splits.flatMap((split) => split.parts.map((part) => part.cluster)),
  ]);
  for (const cluster of plan.clusters) {
    if (!usedClusters.has(cluster.id)) {
      violations.push(
        violation(
          "cluster-empty",
          `Cluster ${cluster.id} ("${cluster.title}") is assigned no hunks.`,
          {
            clusterId: cluster.id as ClusterId,
          },
        ),
      );
    }
  }

  return violations;
}

/**
 * Total: any plan in, a valid partition out.
 *
 * Each rung of the floor is applied independently — a malformed split does not
 * cost the plan its cluster assignments, and an unknown home costs one seed its
 * placement rather than the whole journey its structure.
 */
export function materializePlan(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly files: ReadonlyArray<FileChange>;
  readonly plan: JourneyPlan;
}): MaterializedPlan {
  const fallbacks: string[] = [];
  const seedOrder = new Map(input.seeds.map((seed, index) => [seed.id as string, index]));

  const accepted: { id: string; title: string; weight: Weight; buildsOn: ReadonlyArray<string> }[] =
    [];
  const acceptedIds = new Set<string>();
  for (const cluster of input.plan.clusters) {
    const id = cluster.id.trim();
    if (id.length === 0 || acceptedIds.has(id)) {
      fallbacks.push(`Dropped a cluster with an unusable id ("${cluster.id}").`);
      continue;
    }
    acceptedIds.add(id);
    const title = cluster.title.trim();
    if (!WEIGHTS.has(cluster.weight as Weight)) {
      fallbacks.push(`Cluster ${id} had weight "${cluster.weight}"; recorded it as supporting.`);
    }
    accepted.push({
      id,
      title: title.length > 0 ? title : `Cluster ${accepted.length + 1}`,
      weight: normalizeWeight(cluster.weight),
      buildsOn: cluster.buildsOn,
    });
  }

  const splitsBySeed = new Map(input.plan.splits.map((split) => [split.seedId, split]));
  const homesBySeed = new Map(input.plan.homes.map((home) => [home.hunkId, home.cluster]));

  const UNPLACED_ID = pickUnplacedId(acceptedIds);
  let usedUnplaced = false;
  const hunks: Hunk[] = [];

  for (const seed of input.seeds) {
    const split = splitsBySeed.get(seed.id);
    const homed = homesBySeed.get(seed.id);

    if (split !== undefined && seed.fileKind === null && split.parts.length >= 2) {
      const partsValid =
        split.parts.every((part) => acceptedIds.has(part.cluster)) &&
        split.parts.every((part) => part.oldLines > 0 || part.newLines > 0) &&
        tilingProblem(
          seed.oldStart,
          seed.oldLines,
          split.parts.map((part) => ({ start: part.oldStart, length: part.oldLines })),
        ) === null &&
        tilingProblem(
          seed.newStart,
          seed.newLines,
          split.parts.map((part) => ({ start: part.newStart, length: part.newLines })),
        ) === null;

      if (partsValid) {
        split.parts
          .toSorted(
            (left, right) => left.newStart - right.newStart || left.oldStart - right.oldStart,
          )
          .forEach((part, index) => {
            hunks.push({
              id: `${seed.id}.${index + 1}` as HunkId,
              path: seed.path,
              oldStart: part.oldStart,
              oldLines: part.oldLines,
              newStart: part.newStart,
              newLines: part.newLines,
              fileKind: null,
              seedId: seed.id,
              home: part.cluster as ClusterId,
            });
          });
        continue;
      }
      fallbacks.push(
        `The split of seed hunk ${seed.id} (${seed.path}) was invalid; collapsed it back to one hunk.`,
      );
    } else if (split !== undefined) {
      fallbacks.push(`Ignored an unusable split of seed hunk ${seed.id} (${seed.path}).`);
    }

    const home = homed !== undefined && acceptedIds.has(homed) ? homed : null;
    if (home === null) {
      usedUnplaced = true;
      fallbacks.push(
        homed === undefined
          ? `Seed hunk ${seed.id} (${seed.path}) was unassigned; homed it to "${UNPLACED_TITLE}".`
          : `Seed hunk ${seed.id} (${seed.path}) named an unknown cluster "${homed}"; homed it to "${UNPLACED_TITLE}".`,
      );
    }
    hunks.push({
      id: seed.id,
      path: seed.path,
      oldStart: seed.oldStart,
      oldLines: seed.oldLines,
      newStart: seed.newStart,
      newLines: seed.newLines,
      fileKind: seed.fileKind,
      seedId: seed.id,
      home: (home ?? UNPLACED_ID) as ClusterId,
    });
  }

  const ordered = accepted.filter((cluster) => hunks.some((hunk) => hunk.home === cluster.id));
  for (const cluster of accepted) {
    if (!ordered.includes(cluster)) {
      fallbacks.push(
        `Dropped cluster ${cluster.id} ("${cluster.title}") because it homed no hunks.`,
      );
    }
  }
  if (usedUnplaced) {
    ordered.push({ id: UNPLACED_ID, title: UNPLACED_TITLE, weight: "supporting", buildsOn: [] });
  }

  const positionById = new Map(ordered.map((cluster, index) => [cluster.id, index + 1]));
  const fileOrderByCluster = new Map<string, ReadonlyArray<string>>(
    input.plan.clusters.map((cluster) => [cluster.id.trim(), cluster.fileOrder]),
  );

  const clusters: PlannedCluster[] = ordered.map((cluster, index) => {
    const position = index + 1;
    const buildsOn = cluster.buildsOn.filter((dependency) => {
      const target = positionById.get(dependency);
      return target !== undefined && target < position;
    });
    if (buildsOn.length !== cluster.buildsOn.length) {
      fallbacks.push(
        `Cluster ${cluster.id} referenced clusters it cannot build on; kept only the earlier ones.`,
      );
    }
    const homedPaths = new Set(
      hunks.filter((hunk) => hunk.home === cluster.id).map((hunk) => hunk.path),
    );
    const proposed = fileOrderByCluster.get(cluster.id) ?? [];
    const fileOrder: string[] = [];
    for (const path of proposed) {
      if (homedPaths.has(path) && !fileOrder.includes(path)) fileOrder.push(path);
    }
    const missing = [...homedPaths]
      .filter((path) => !fileOrder.includes(path))
      .toSorted((left, right) => firstSeedIndex(left) - firstSeedIndex(right));
    fileOrder.push(...missing);
    return {
      id: cluster.id as ClusterId,
      position,
      title: cluster.title,
      weight: cluster.weight,
      buildsOn: buildsOn.map((dependency) => dependency as ClusterId),
      fileOrder,
    };
  });

  return { clusters, hunks, fallbacks };

  function firstSeedIndex(path: string): number {
    let best = Number.MAX_SAFE_INTEGER;
    for (const seed of input.seeds) {
      if (seed.path !== path) continue;
      const index = seedOrder.get(seed.id) ?? Number.MAX_SAFE_INTEGER;
      if (index < best) best = index;
    }
    return best;
  }
}

function pickUnplacedId(taken: ReadonlySet<string>): string {
  let candidate = "c-unplaced";
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `c-unplaced-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * The absolute floor: a plan built without any agent output at all — one
 * cluster per top-level directory of the change, in path order.
 *
 * Dreadful, but valid, visible, and honest: it never pretends to be a story.
 */
export function degeneratePlan(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly files: ReadonlyArray<FileChange>;
}): JourneyPlan {
  const groupOf = (path: string): string => {
    const parts = path.split("/");
    if (parts.length === 1) return "(repository root)";
    if (parts.length === 2) return parts[0] ?? "(repository root)";
    return `${parts[0]}/${parts[1]}`;
  };

  const groups = new Map<string, { paths: Set<string>; seeds: SeedHunk[] }>();
  for (const seed of input.seeds) {
    const key = groupOf(seed.path);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { paths: new Set([seed.path]), seeds: [seed] });
    } else {
      existing.paths.add(seed.path);
      existing.seeds.push(seed);
    }
  }

  const keys = [...groups.keys()].toSorted();
  const clusters: PlanCluster[] = keys.map((key, index) => ({
    id: `c${index + 1}`,
    title: key,
    weight: "supporting",
    buildsOn: [],
    fileOrder: [...(groups.get(key)?.paths ?? [])].toSorted(),
  }));
  const homes = keys.flatMap((key, index) =>
    (groups.get(key)?.seeds ?? []).map((seed) => ({
      hunkId: seed.id as string,
      cluster: `c${index + 1}`,
    })),
  );

  return { clusters, homes, splits: [] };
}
