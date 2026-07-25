import type { Cluster, FileChange, Hunk, HunkId, Journey, SeedHunk } from "@app/contracts";

import {
  type EvidenceViolation,
  type PinnedFileLookup,
  validateNarrativeEvidence,
} from "./evidence.ts";

export interface JourneyViolation {
  readonly code: string;
  readonly message: string;
  readonly seedId?: string;
  readonly hunkId?: string;
  readonly clusterId?: string;
  readonly hintId?: string;
  readonly path?: string;
}

const duplicateValues = (values: readonly string[]): ReadonlySet<string> => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
};

const addEvidenceViolations = (
  target: JourneyViolation[],
  violations: readonly EvidenceViolation[],
  context: { readonly clusterId?: string; readonly hintId?: string },
): void => {
  for (const violation of violations) {
    target.push({
      code: violation.code,
      message: violation.message,
      ...context,
    });
  }
};

const validateSidePartition = (
  seed: SeedHunk,
  refinements: readonly Hunk[],
  side: "old" | "new",
): readonly JourneyViolation[] => {
  const violations: JourneyViolation[] = [];
  const startKey = side === "old" ? "oldStart" : "newStart";
  const linesKey = side === "old" ? "oldLines" : "newLines";
  const expectedStart = seed[startKey];
  const expectedEnd = expectedStart + seed[linesKey];
  const intervals = refinements
    .filter((hunk) => hunk[linesKey] > 0)
    .map((hunk) => ({
      start: hunk[startKey],
      end: hunk[startKey] + hunk[linesKey],
      hunk,
    }))
    .toSorted((left, right) => left.start - right.start || left.end - right.end);

  if (seed[linesKey] === 0) {
    for (const interval of intervals) {
      violations.push({
        code: "split-outside-seed",
        seedId: seed.id,
        hunkId: interval.hunk.id,
        path: seed.path,
        message: `${interval.hunk.id} invents ${side}-side lines for zero-length seed ${seed.id}.`,
      });
    }
    return violations;
  }

  let cursor = expectedStart;
  for (const interval of intervals) {
    if (interval.start < expectedStart || interval.end > expectedEnd) {
      violations.push({
        code: "split-outside-seed",
        seedId: seed.id,
        hunkId: interval.hunk.id,
        path: seed.path,
        message: `${interval.hunk.id} covers ${side} lines ${interval.start}–${interval.end - 1} outside seed ${seed.id}'s ${expectedStart}–${expectedEnd - 1}.`,
      });
    }
    if (interval.start > cursor) {
      violations.push({
        code: "split-gap",
        seedId: seed.id,
        path: seed.path,
        message: `Split of ${seed.id} leaves ${side} lines ${cursor}–${interval.start - 1} uncovered.`,
      });
    } else if (interval.start < cursor) {
      violations.push({
        code: "split-overlap",
        seedId: seed.id,
        hunkId: interval.hunk.id,
        path: seed.path,
        message: `Split of ${seed.id} covers ${side} line ${interval.start} more than once.`,
      });
    }
    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < expectedEnd) {
    violations.push({
      code: "split-gap",
      seedId: seed.id,
      path: seed.path,
      message: `Split of ${seed.id} leaves ${side} lines ${cursor}–${expectedEnd - 1} uncovered.`,
    });
  }

  return violations;
};

export const validateRefinement = (
  seeds: readonly SeedHunk[],
  hunks: readonly Hunk[],
): readonly JourneyViolation[] => {
  const violations: JourneyViolation[] = [];
  const seedById = new Map(seeds.map((seed) => [seed.id as string, seed]));
  const refinementsBySeed = new Map<string, Hunk[]>();

  for (const duplicate of duplicateValues(seeds.map((seed) => seed.id))) {
    violations.push({
      code: "seed-id-duplicate",
      seedId: duplicate,
      message: `Seed hunk id ${duplicate} appears more than once.`,
    });
  }
  for (const duplicate of duplicateValues(hunks.map((hunk) => hunk.id))) {
    violations.push({
      code: "hunk-id-duplicate",
      hunkId: duplicate,
      message: `Hunk id ${duplicate} appears more than once.`,
    });
  }

  for (const hunk of hunks) {
    const seed = seedById.get(hunk.seedId);
    if (seed === undefined) {
      violations.push({
        code: "seed-missing",
        seedId: hunk.seedId,
        hunkId: hunk.id,
        path: hunk.path,
        message: `${hunk.id} names unknown seed ${hunk.seedId}.`,
      });
      continue;
    }

    const refinements = refinementsBySeed.get(seed.id) ?? [];
    refinements.push(hunk);
    refinementsBySeed.set(seed.id, refinements);

    if (hunk.path !== seed.path) {
      violations.push({
        code: "split-path-mismatch",
        seedId: seed.id,
        hunkId: hunk.id,
        path: hunk.path,
        message: `${hunk.id} changes seed ${seed.id}'s path from ${seed.path} to ${hunk.path}.`,
      });
    }
    if (seed.fileKind === undefined && hunk.fileKind !== undefined) {
      violations.push({
        code: "split-file-kind-invented",
        seedId: seed.id,
        hunkId: hunk.id,
        path: hunk.path,
        message: `${hunk.id} invents file-level kind ${hunk.fileKind} for textual seed ${seed.id}.`,
      });
    }
    if (seed.fileKind === undefined && hunk.oldLines === 0 && hunk.newLines === 0) {
      violations.push({
        code: "split-empty",
        seedId: seed.id,
        hunkId: hunk.id,
        path: hunk.path,
        message: `${hunk.id} covers no changed lines.`,
      });
    }
  }

  for (const seed of seeds) {
    const refinements = refinementsBySeed.get(seed.id) ?? [];
    if (refinements.length === 0) {
      violations.push({
        code: "seed-unassigned",
        seedId: seed.id,
        path: seed.path,
        message: `${seed.id} is unassigned.`,
      });
      continue;
    }

    if (seed.fileKind !== undefined) {
      if (refinements.length !== 1) {
        violations.push({
          code: "file-level-split",
          seedId: seed.id,
          path: seed.path,
          message: `File-level seed ${seed.id} must produce exactly one hunk, not ${refinements.length}.`,
        });
      }
      for (const hunk of refinements) {
        if (
          hunk.fileKind !== seed.fileKind ||
          hunk.oldStart !== 0 ||
          hunk.oldLines !== 0 ||
          hunk.newStart !== 0 ||
          hunk.newLines !== 0
        ) {
          violations.push({
            code: "file-level-changed",
            seedId: seed.id,
            hunkId: hunk.id,
            path: hunk.path,
            message: `${hunk.id} changes file-level seed ${seed.id}; file-level hunks cannot be split or given line ranges.`,
          });
        }
      }
      continue;
    }

    let priorOldStart = seed.oldStart;
    let priorNewStart = seed.newStart;
    for (const hunk of refinements) {
      const oldEnd = seed.oldStart + seed.oldLines;
      const newEnd = seed.newStart + seed.newLines;
      if (
        hunk.oldStart < seed.oldStart ||
        hunk.oldStart > oldEnd ||
        hunk.newStart < seed.newStart ||
        hunk.newStart > newEnd
      ) {
        violations.push({
          code: "split-anchor-outside-seed",
          seedId: seed.id,
          hunkId: hunk.id,
          path: seed.path,
          message: `${hunk.id} has a zero-length-side anchor outside seed ${seed.id}.`,
        });
      }
      if (hunk.oldStart < priorOldStart || hunk.newStart < priorNewStart) {
        violations.push({
          code: "split-crossed",
          seedId: seed.id,
          hunkId: hunk.id,
          path: seed.path,
          message: `${hunk.id} crosses an earlier refinement of seed ${seed.id}.`,
        });
      }
      priorOldStart = hunk.oldStart;
      priorNewStart = hunk.newStart;
    }

    violations.push(...validateSidePartition(seed, refinements, "old"));
    violations.push(...validateSidePartition(seed, refinements, "new"));
  }

  return violations;
};

const validateFiles = (
  seeds: readonly SeedHunk[],
  files: readonly FileChange[],
): readonly JourneyViolation[] => {
  const violations: JourneyViolation[] = [];
  const filePaths = new Set(files.map((file) => file.path as string));

  for (const duplicate of duplicateValues(files.map((file) => file.path))) {
    violations.push({
      code: "file-duplicate",
      path: duplicate,
      message: `Changed file ${duplicate} appears more than once.`,
    });
  }
  for (const seed of seeds) {
    if (!filePaths.has(seed.path)) {
      violations.push({
        code: "seed-file-missing",
        seedId: seed.id,
        path: seed.path,
        message: `${seed.id} names changed file ${seed.path}, which is absent from the journey.`,
      });
    }
  }
  const seededPaths = new Set(seeds.map((seed) => seed.path as string));
  for (const file of files) {
    if (!seededPaths.has(file.path)) {
      violations.push({
        code: "file-uncovered",
        path: file.path,
        message: `Changed file ${file.path} has no seed hunk.`,
      });
      continue;
    }

    const fileSeeds = seeds.filter((seed) => seed.path === file.path);
    const additions = fileSeeds.reduce((total, seed) => total + seed.newLines, 0);
    const deletions = fileSeeds.reduce((total, seed) => total + seed.oldLines, 0);
    if (file.additions !== additions || file.deletions !== deletions) {
      violations.push({
        code: "file-line-count-mismatch",
        path: file.path,
        message: `Changed file ${file.path} records +${file.additions}/-${file.deletions}; its seeds cover +${additions}/-${deletions}.`,
      });
    }

    const fileLevelSeeds = fileSeeds.filter((seed) => seed.fileKind !== undefined);
    if (fileLevelSeeds.length > 0 && fileSeeds.length !== 1) {
      violations.push({
        code: "file-level-seed-mixed",
        path: file.path,
        message: `Changed file ${file.path} mixes a file-level seed with textual seeds.`,
      });
    }
    const hasBinarySeed = fileLevelSeeds.some((seed) => seed.fileKind === "binary");
    if (file.binary !== hasBinarySeed) {
      violations.push({
        code: "file-binary-mismatch",
        path: file.path,
        message: `Changed file ${file.path}'s binary metadata disagrees with its seed hunk.`,
      });
    }
  }

  return violations;
};

const validateClusterReferences = (
  clusters: readonly Cluster[],
  hunks: readonly Hunk[],
): readonly JourneyViolation[] => {
  const violations: JourneyViolation[] = [];
  const clusterById = new Map(clusters.map((cluster) => [cluster.id as string, cluster]));
  const hunkById = new Map(hunks.map((hunk) => [hunk.id as string, hunk]));
  const positionByCluster = new Map(
    clusters.map((cluster) => [cluster.id as string, cluster.position]),
  );

  for (const duplicate of duplicateValues(clusters.map((cluster) => cluster.id))) {
    violations.push({
      code: "cluster-id-duplicate",
      clusterId: duplicate,
      message: `Cluster id ${duplicate} appears more than once.`,
    });
  }

  clusters.forEach((cluster, index) => {
    if (cluster.position !== index + 1) {
      violations.push({
        code: "cluster-position",
        clusterId: cluster.id,
        message: `Cluster ${cluster.id} has position ${cluster.position}; expected ${index + 1}.`,
      });
    }

    for (const duplicate of duplicateValues(cluster.buildsOn)) {
      violations.push({
        code: "builds-on-duplicate",
        clusterId: cluster.id,
        message: `Cluster ${cluster.id} names ${duplicate} in buildsOn more than once.`,
      });
    }
    for (const dependencyId of cluster.buildsOn) {
      const dependencyPosition = positionByCluster.get(dependencyId);
      if (dependencyPosition === undefined) {
        violations.push({
          code: "builds-on-missing",
          clusterId: cluster.id,
          message: `Cluster ${cluster.id} builds on unknown cluster ${dependencyId}.`,
        });
      } else if (dependencyPosition >= cluster.position) {
        violations.push({
          code: "builds-on-not-earlier",
          clusterId: cluster.id,
          message: `Cluster ${cluster.id} builds on ${dependencyId}, which is not earlier in the journey.`,
        });
      }
    }
  });

  for (const hunk of hunks) {
    if (!clusterById.has(hunk.home)) {
      violations.push({
        code: "hunk-home-missing",
        hunkId: hunk.id,
        clusterId: hunk.home,
        path: hunk.path,
        message: `${hunk.id} names unknown home cluster ${hunk.home}.`,
      });
    }
  }

  for (const cluster of clusters) {
    const resurfacedIds = cluster.resurfaced.map((entry) => entry.hunkId as string);
    for (const duplicate of duplicateValues(resurfacedIds)) {
      violations.push({
        code: "resurfaced-duplicate",
        clusterId: cluster.id,
        hunkId: duplicate,
        message: `Cluster ${cluster.id} resurfaces ${duplicate} more than once.`,
      });
    }

    for (const entry of cluster.resurfaced) {
      const hunk = hunkById.get(entry.hunkId);
      if (hunk === undefined) {
        violations.push({
          code: "resurfaced-hunk-missing",
          clusterId: cluster.id,
          hunkId: entry.hunkId,
          message: `Cluster ${cluster.id} resurfaces unknown hunk ${entry.hunkId}.`,
        });
        continue;
      }
      if (hunk.home === cluster.id) {
        violations.push({
          code: "resurfaced-at-home",
          clusterId: cluster.id,
          hunkId: entry.hunkId,
          path: hunk.path,
          message: `Cluster ${cluster.id} cannot resurface ${entry.hunkId} at its own home.`,
        });
        continue;
      }
      const homePosition = positionByCluster.get(hunk.home);
      if (homePosition === undefined || homePosition >= cluster.position) {
        violations.push({
          code: "resurfaced-not-earlier",
          clusterId: cluster.id,
          hunkId: entry.hunkId,
          path: hunk.path,
          message: `Cluster ${cluster.id} can only resurface a hunk from an earlier home.`,
        });
      }
    }

    const expectedPaths = new Set<string>();
    for (const hunk of hunks) {
      if (hunk.home === cluster.id) expectedPaths.add(hunk.path);
    }
    for (const entry of cluster.resurfaced) {
      const hunk = hunkById.get(entry.hunkId);
      if (hunk !== undefined) expectedPaths.add(hunk.path);
    }
    if (![...hunks].some((hunk) => hunk.home === cluster.id)) {
      violations.push({
        code: "cluster-has-no-home",
        clusterId: cluster.id,
        message: `Cluster ${cluster.id} has no homed hunk.`,
      });
    }
    for (const duplicate of duplicateValues(cluster.fileOrder)) {
      violations.push({
        code: "file-order-duplicate",
        clusterId: cluster.id,
        path: duplicate,
        message: `Cluster ${cluster.id} lists ${duplicate} more than once in fileOrder.`,
      });
    }
    const actualPaths = new Set(cluster.fileOrder as readonly string[]);
    for (const path of expectedPaths) {
      if (!actualPaths.has(path)) {
        violations.push({
          code: "file-order-missing",
          clusterId: cluster.id,
          path,
          message: `Cluster ${cluster.id} omits ${path} from fileOrder.`,
        });
      }
    }
    for (const path of actualPaths) {
      if (!expectedPaths.has(path)) {
        violations.push({
          code: "file-order-unrelated",
          clusterId: cluster.id,
          path,
          message: `Cluster ${cluster.id} lists ${path}, which hosts no homed or resurfaced hunk.`,
        });
      }
    }
  }

  return violations;
};

const lineCount = (contents: string): number => {
  if (contents.length === 0) return 0;
  const breaks = contents.match(/\n/gu)?.length ?? 0;
  return contents.endsWith("\n") ? breaks : breaks + 1;
};

const validateNarrativesAndHints = (
  journey: Journey,
  pinnedFile: PinnedFileLookup,
): readonly JourneyViolation[] => {
  const violations: JourneyViolation[] = [];
  const hunkIds = new Set(journey.hunks.map((hunk) => hunk.id as string));
  const clusterIds = new Set(journey.clusters.map((cluster) => cluster.id as string));
  const clusterById = new Map(journey.clusters.map((cluster) => [cluster.id as string, cluster]));
  const evidenceInput = { hunkIds, pinnedFile };

  addEvidenceViolations(
    violations,
    validateNarrativeEvidence(journey.overview.brief, evidenceInput),
    {},
  );
  addEvidenceViolations(
    violations,
    validateNarrativeEvidence(journey.overview.whereToBegin, evidenceInput),
    {},
  );
  for (const cluster of journey.clusters) {
    addEvidenceViolations(violations, validateNarrativeEvidence(cluster.narrative, evidenceInput), {
      clusterId: cluster.id,
    });
    addEvidenceViolations(violations, validateNarrativeEvidence(cluster.mapEntry, evidenceInput), {
      clusterId: cluster.id,
    });
    for (const resurfaced of cluster.resurfaced) {
      addEvidenceViolations(violations, validateNarrativeEvidence(resurfaced.note, evidenceInput), {
        clusterId: cluster.id,
      });
    }
  }

  for (const duplicate of duplicateValues(journey.hints.map((hint) => hint.id))) {
    violations.push({
      code: "hint-id-duplicate",
      hintId: duplicate,
      message: `Hint id ${duplicate} appears more than once.`,
    });
  }
  for (const hint of journey.hints) {
    if (!clusterIds.has(hint.clusterId)) {
      violations.push({
        code: "hint-cluster-missing",
        hintId: hint.id,
        clusterId: hint.clusterId,
        path: hint.anchor.path,
        message: `Hint ${hint.id} names unknown cluster ${hint.clusterId}.`,
      });
    }
    const cluster = clusterById.get(hint.clusterId);
    if (cluster !== undefined && !cluster.fileOrder.includes(hint.anchor.path)) {
      violations.push({
        code: "hint-path-not-in-cluster",
        hintId: hint.id,
        clusterId: hint.clusterId,
        path: hint.anchor.path,
        message: `Hint ${hint.id} anchors ${hint.anchor.path}, which is absent from cluster ${hint.clusterId}'s fileOrder.`,
      });
    }
    if (hint.anchor.endLine < hint.anchor.startLine) {
      violations.push({
        code: "hint-anchor-reversed",
        hintId: hint.id,
        clusterId: hint.clusterId,
        path: hint.anchor.path,
        message: `Hint ${hint.id} ends before it starts.`,
      });
    }

    const file = pinnedFile(hint.anchor.path);
    const contents = file?.[hint.anchor.side];
    if (contents === undefined || contents === null) {
      violations.push({
        code: "hint-file-missing",
        hintId: hint.id,
        clusterId: hint.clusterId,
        path: hint.anchor.path,
        message: `Hint ${hint.id} names no ${hint.anchor.side}-side file at ${hint.anchor.path}.`,
      });
    } else {
      const lastLine = lineCount(contents);
      if (hint.anchor.startLine < 1 || hint.anchor.endLine > lastLine) {
        violations.push({
          code: "hint-anchor-out-of-range",
          hintId: hint.id,
          clusterId: hint.clusterId,
          path: hint.anchor.path,
          message: `Hint ${hint.id} anchors lines ${hint.anchor.startLine}–${hint.anchor.endLine}, outside ${hint.anchor.path}'s ${hint.anchor.side}-side range 1–${lastLine}.`,
        });
      }
    }

    addEvidenceViolations(violations, validateNarrativeEvidence(hint.body, evidenceInput), {
      clusterId: hint.clusterId,
      hintId: hint.id,
    });
  }

  return violations;
};

export const validateCoverage = (input: {
  readonly seeds: readonly SeedHunk[];
  readonly hunks: readonly Hunk[];
  readonly files: readonly FileChange[];
  readonly clusters: readonly Cluster[];
}): readonly JourneyViolation[] => [
  ...validateRefinement(input.seeds, input.hunks),
  ...validateFiles(input.seeds, input.files),
  ...validateClusterReferences(input.clusters, input.hunks),
];

export const canonicalizeHunkIds = (
  seeds: readonly SeedHunk[],
  hunks: readonly Hunk[],
): readonly Hunk[] => {
  const seedPosition = new Map(seeds.map((seed, index) => [seed.id as string, index]));
  return [...hunks]
    .toSorted((left, right) => {
      const seedDifference =
        (seedPosition.get(left.seedId) ?? Number.MAX_SAFE_INTEGER) -
        (seedPosition.get(right.seedId) ?? Number.MAX_SAFE_INTEGER);
      if (seedDifference !== 0) return seedDifference;
      return (
        left.oldStart - right.oldStart ||
        left.newStart - right.newStart ||
        left.oldLines - right.oldLines ||
        left.newLines - right.newLines ||
        (left.home < right.home ? -1 : left.home > right.home ? 1 : 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      );
    })
    .map((hunk, index) => Object.assign({}, hunk, { id: `h${index + 1}` as HunkId }));
};

export const validateJourneyStructure = (
  journey: Journey,
  seeds: readonly SeedHunk[],
): readonly JourneyViolation[] =>
  validateCoverage({
    seeds,
    hunks: journey.hunks,
    files: journey.files,
    clusters: journey.clusters,
  });

export const validateJourneyReferences = (
  journey: Journey,
  pinnedFile: PinnedFileLookup,
): readonly JourneyViolation[] => validateNarrativesAndHints(journey, pinnedFile);

export const validateJourney = (
  journey: Journey,
  input: {
    readonly seeds: readonly SeedHunk[];
    readonly pinnedFile: PinnedFileLookup;
  },
): readonly JourneyViolation[] => {
  const violations = [
    ...validateCoverage({
      seeds: input.seeds,
      hunks: journey.hunks,
      files: journey.files,
      clusters: journey.clusters,
    }),
    ...validateNarrativesAndHints(journey, input.pinnedFile),
  ];

  const canonicalHunks = canonicalizeHunkIds(input.seeds, journey.hunks);
  journey.hunks.forEach((hunk, index) => {
    const expectedId = `h${index + 1}`;
    if (hunk.id !== expectedId) {
      violations.push({
        code: "hunk-id-not-dense",
        hunkId: hunk.id,
        path: hunk.path,
        message: `Journey hunk ${hunk.id} is at position ${index + 1}; expected id ${expectedId}.`,
      });
    }
    const canonical = canonicalHunks[index];
    if (
      canonical !== undefined &&
      (hunk.seedId !== canonical.seedId ||
        hunk.path !== canonical.path ||
        hunk.oldStart !== canonical.oldStart ||
        hunk.oldLines !== canonical.oldLines ||
        hunk.newStart !== canonical.newStart ||
        hunk.newLines !== canonical.newLines ||
        hunk.home !== canonical.home)
    ) {
      violations.push({
        code: "hunk-order-not-canonical",
        hunkId: hunk.id,
        path: hunk.path,
        message: `Journey hunk ${hunk.id} is not in deterministic seed and range order.`,
      });
    }
  });

  return violations;
};

export const isJourneyValid = (
  journey: Journey,
  input: {
    readonly seeds: readonly SeedHunk[];
    readonly pinnedFile: PinnedFileLookup;
  },
): boolean => validateJourney(journey, input).length === 0;
