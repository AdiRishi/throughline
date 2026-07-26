import type { Cluster, ClusterId, Hunk, SeedHunk } from "@app/contracts";

export type CoverageViolation =
  | { readonly type: "unknown-home"; readonly hunkId: string; readonly clusterId: string }
  | { readonly type: "unknown-seed"; readonly hunkId: string; readonly seedId: string }
  | { readonly type: "file-kind-split"; readonly seedId: string }
  | {
      readonly type: "range-gap";
      readonly seedId: string;
      readonly side: "old" | "new";
      readonly line: number;
    }
  | {
      readonly type: "range-overlap";
      readonly seedId: string;
      readonly side: "old" | "new";
      readonly line: number;
    }
  | { readonly type: "range-invented"; readonly hunkId: string; readonly side: "old" | "new" }
  | { readonly type: "invalid-file-order"; readonly clusterId: string; readonly path: string }
  | { readonly type: "invalid-builds-on"; readonly clusterId: string; readonly targetId: string }
  | { readonly type: "invalid-resurfacing"; readonly clusterId: string; readonly hunkId: string };

function range(start: number, count: number): ReadonlyArray<number> {
  return Array.from({ length: count }, (_, index) => start + index);
}

function validateRange(
  seed: SeedHunk,
  refinements: ReadonlyArray<Hunk>,
  side: "old" | "new",
): ReadonlyArray<CoverageViolation> {
  const start = side === "old" ? seed.oldStart : seed.newStart;
  const lines = side === "old" ? seed.oldLines : seed.newLines;
  const expected = new Set(range(start, lines));
  const counts = new Map<number, number>();
  const violations: Array<CoverageViolation> = [];

  for (const hunk of refinements) {
    const hunkStart = side === "old" ? hunk.oldStart : hunk.newStart;
    const hunkLines = side === "old" ? hunk.oldLines : hunk.newLines;
    for (const line of range(hunkStart, hunkLines)) {
      if (!expected.has(line)) {
        violations.push({ type: "range-invented", hunkId: hunk.id, side });
        break;
      }
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }

  for (const line of expected) {
    const count = counts.get(line) ?? 0;
    if (count === 0) violations.push({ type: "range-gap", seedId: seed.id, side, line });
    if (count > 1) violations.push({ type: "range-overlap", seedId: seed.id, side, line });
  }
  return violations;
}

export function validateCoverage(
  seeds: ReadonlyArray<SeedHunk>,
  hunks: ReadonlyArray<Hunk>,
  clusters: ReadonlyArray<Cluster>,
): ReadonlyArray<CoverageViolation> {
  const violations: Array<CoverageViolation> = [];
  const clusterById = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
  const hunkById = new Map(hunks.map((hunk) => [hunk.id, hunk]));

  for (const hunk of hunks) {
    if (!clusterById.has(hunk.home)) {
      violations.push({ type: "unknown-home", hunkId: hunk.id, clusterId: hunk.home });
    }
    if (!seedById.has(hunk.seedId)) {
      violations.push({ type: "unknown-seed", hunkId: hunk.id, seedId: hunk.seedId });
    }
  }

  for (const seed of seeds) {
    const refinements = hunks.filter((hunk) => hunk.seedId === seed.id);
    if (seed.fileKind !== undefined) {
      if (
        refinements.length !== 1 ||
        refinements[0]?.id !== seed.id ||
        refinements[0].fileKind !== seed.fileKind
      ) {
        violations.push({ type: "file-kind-split", seedId: seed.id });
      }
      continue;
    }
    violations.push(...validateRange(seed, refinements, "old"));
    violations.push(...validateRange(seed, refinements, "new"));
  }

  for (const cluster of clusters) {
    const position = cluster.position;
    for (const targetId of cluster.buildsOn) {
      const target = clusterById.get(targetId);
      if (target === undefined || target.position >= position) {
        violations.push({ type: "invalid-builds-on", clusterId: cluster.id, targetId });
      }
    }

    const expectedPaths = new Set(
      hunks
        .filter(
          (hunk) =>
            hunk.home === cluster.id || cluster.resurfaced.some((item) => item.hunkId === hunk.id),
        )
        .map((hunk) => hunk.path),
    );
    const actualPaths = new Set(cluster.fileOrder);
    for (const path of expectedPaths) {
      if (!actualPaths.has(path)) {
        violations.push({ type: "invalid-file-order", clusterId: cluster.id, path });
      }
    }
    if (actualPaths.size !== cluster.fileOrder.length) {
      violations.push({
        type: "invalid-file-order",
        clusterId: cluster.id,
        path: "duplicate path",
      });
    }

    for (const resurfaced of cluster.resurfaced) {
      const hunk = hunkById.get(resurfaced.hunkId);
      const home = hunk === undefined ? undefined : clusterById.get(hunk.home);
      if (
        hunk === undefined ||
        hunk.home === cluster.id ||
        home === undefined ||
        home.position >= cluster.position
      ) {
        violations.push({
          type: "invalid-resurfacing",
          clusterId: cluster.id,
          hunkId: resurfaced.hunkId,
        });
      }
    }
  }

  return violations;
}

export function completePartition(
  seeds: ReadonlyArray<SeedHunk>,
  clusters: ReadonlyArray<Cluster>,
  proposed: ReadonlyArray<Hunk>,
): { readonly clusters: ReadonlyArray<Cluster>; readonly hunks: ReadonlyArray<Hunk> } {
  const clusterIds = new Set(clusters.map((cluster) => cluster.id));
  const validBySeed = new Map<string, ReadonlyArray<Hunk>>();

  for (const seed of seeds) {
    const refinements = proposed.filter(
      (hunk) => hunk.seedId === seed.id && clusterIds.has(hunk.home),
    );
    const localViolations = validateCoverage([seed], refinements, clusters).filter(
      (violation) =>
        violation.type !== "invalid-file-order" &&
        violation.type !== "invalid-builds-on" &&
        violation.type !== "invalid-resurfacing",
    );
    if (localViolations.length === 0) validBySeed.set(seed.id, refinements);
  }

  let completedClusters = [...clusters];
  let fallback = completedClusters.at(-1);
  if (seeds.some((seed) => !validBySeed.has(seed.id))) {
    const fallbackId = "c-unplaced" as ClusterId;
    fallback = {
      id: fallbackId,
      position: completedClusters.length + 1,
      title: "Unplaced changes",
      weight: "supporting",
      narrative: {
        markdown:
          "These changes could not be placed confidently by the analysis harness, so Throughline kept them together to preserve complete coverage.",
      },
      mapEntry: {
        markdown: "Changes retained by Throughline's deterministic coverage fallback.",
      },
      buildsOn: [],
      fileOrder: [],
      resurfaced: [],
    };
    completedClusters = [...completedClusters, fallback];
  }

  const hunks = seeds.flatMap((seed): ReadonlyArray<Hunk> => {
    const valid = validBySeed.get(seed.id);
    if (valid !== undefined) return valid;
    if (fallback === undefined) return [];
    return [{ ...seed, seedId: seed.id, home: fallback.id }];
  });

  completedClusters = completedClusters.map((cluster) => {
    const paths = hunks
      .filter(
        (hunk) =>
          hunk.home === cluster.id ||
          cluster.resurfaced.some((resurfaced) => resurfaced.hunkId === hunk.id),
      )
      .map((hunk) => hunk.path);
    const allowed = new Set(paths);
    return {
      ...cluster,
      buildsOn: cluster.buildsOn.filter((target) => {
        const targetCluster = completedClusters.find((candidate) => candidate.id === target);
        return targetCluster !== undefined && targetCluster.position < cluster.position;
      }),
      resurfaced: cluster.resurfaced.filter((item) => {
        const hunk = hunks.find((candidate) => candidate.id === item.hunkId);
        const home =
          hunk === undefined
            ? undefined
            : completedClusters.find((candidate) => candidate.id === hunk.home);
        return (
          hunk !== undefined &&
          hunk.home !== cluster.id &&
          (home?.position ?? Infinity) < cluster.position
        );
      }),
      fileOrder: [...cluster.fileOrder.filter((path) => allowed.has(path)), ...paths].filter(
        (path, index, all) => all.indexOf(path) === index,
      ),
    };
  });

  return { clusters: completedClusters, hunks };
}
