/**
 * The coverage validator — the vision's guarantee, as a machine check.
 *
 * The rule, formalized: for each changed file, the changed-line set is
 * (removed old-side line numbers) ∪ (added new-side line numbers). A journey is
 * valid iff the hunks' ranges partition that set exactly, every changed file
 * with no changed lines carries exactly one file-level hunk, and every hunk
 * names exactly one existing home cluster.
 *
 * Every function here returns a precise violation list rather than a boolean:
 * those messages are fed verbatim into the harness's repair turn, so they are
 * written to be actionable by a model as well as readable by a person.
 *
 * @module coverage
 */
import type {
  Cluster,
  ClusterId,
  CoverageViolation,
  FileChange,
  Hint,
  Hunk,
  HunkId,
  Journey,
  SeedHunk,
} from "@app/contracts";

import { extractEvidenceLinks, resolveEvidenceLink, type EvidenceContext } from "./evidence.ts";

/** Everything the validators need to know about the world outside the artifact. */
export interface JourneyContext extends EvidenceContext {
  readonly seeds: ReadonlyArray<SeedHunk>;
}

interface Range {
  readonly start: number;
  readonly length: number;
}

function violation(
  kind: CoverageViolation["kind"],
  message: string,
  extra?: {
    readonly path?: string;
    readonly hunkId?: HunkId;
    readonly clusterId?: ClusterId;
  },
): CoverageViolation {
  return {
    kind,
    message,
    path: extra?.path ?? null,
    hunkId: extra?.hunkId ?? null,
    clusterId: extra?.clusterId ?? null,
  };
}

/**
 * Do the parts partition the seed's range exactly? Empty ranges cover nothing
 * and are allowed on either side (a pure insertion has no old lines), so they
 * are dropped before the contiguity walk.
 */
function tilesExactly(seed: Range, parts: ReadonlyArray<Range>): string | null {
  const occupied = parts.filter((part) => part.length > 0).toSorted((a, b) => a.start - b.start);
  if (seed.length === 0) {
    return occupied.length === 0
      ? null
      : `covers lines ${occupied[0]?.start}… where the seed hunk has none`;
  }
  if (occupied.length === 0)
    return `leaves lines ${seed.start}–${seed.start + seed.length - 1} uncovered`;

  let cursor = seed.start;
  for (const part of occupied) {
    if (part.start < cursor) {
      return `covers line ${part.start} twice`;
    }
    if (part.start > cursor) {
      return `leaves lines ${cursor}–${part.start - 1} uncovered`;
    }
    cursor = part.start + part.length;
  }
  const seedEnd = seed.start + seed.length;
  if (cursor < seedEnd) return `leaves lines ${cursor}–${seedEnd - 1} uncovered`;
  if (cursor > seedEnd)
    return `covers lines ${seedEnd}–${cursor - 1}, which the seed hunk does not`;
  return null;
}

/**
 * The partition check proper: seeds in, hunks out, nothing lost or doubled.
 *
 * Because the agent may only *refine* seeds, a valid refinement is still a
 * partition by construction — so what this actually catches is failure to
 * assign, invention, and malformed splits.
 */
export function validatePartition(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly files: ReadonlyArray<FileChange>;
  readonly hunks: ReadonlyArray<Hunk>;
  readonly clusters: ReadonlyArray<Cluster>;
}): ReadonlyArray<CoverageViolation> {
  const violations: CoverageViolation[] = [];
  const seedsById = new Map(input.seeds.map((seed) => [seed.id, seed]));
  const clusterIds = new Set(input.clusters.map((cluster) => cluster.id));
  const filePaths = new Set(input.files.map((file) => file.path));

  const seenHunkIds = new Set<string>();
  const bySeed = new Map<HunkId, Hunk[]>();

  for (const hunk of input.hunks) {
    if (seenHunkIds.has(hunk.id)) {
      violations.push(
        violation("unknown-hunk", `Hunk id ${hunk.id} appears more than once.`, {
          hunkId: hunk.id,
        }),
      );
      continue;
    }
    seenHunkIds.add(hunk.id);

    if (!clusterIds.has(hunk.home)) {
      violations.push(
        violation(
          "hunk-unknown-home",
          `Hunk ${hunk.id} is homed to ${hunk.home}, which is not a cluster in this journey.`,
          { hunkId: hunk.id, clusterId: hunk.home, path: hunk.path },
        ),
      );
    }
    if (!filePaths.has(hunk.path)) {
      violations.push(
        violation(
          "unknown-path",
          `Hunk ${hunk.id} names path ${hunk.path}, which this pull request does not change.`,
          {
            hunkId: hunk.id,
            path: hunk.path,
          },
        ),
      );
    }

    const seed = seedsById.get(hunk.seedId);
    if (seed === undefined) {
      violations.push(
        violation(
          "unknown-hunk",
          `Hunk ${hunk.id} claims seed hunk ${hunk.seedId}, which does not exist.`,
          {
            hunkId: hunk.id,
          },
        ),
      );
      continue;
    }
    if (seed.path !== hunk.path) {
      violations.push(
        violation(
          "unknown-path",
          `Hunk ${hunk.id} is on ${hunk.path} but splits seed hunk ${seed.id}, which is on ${seed.path}.`,
          { hunkId: hunk.id, path: hunk.path },
        ),
      );
    }
    const existing = bySeed.get(seed.id);
    if (existing === undefined) bySeed.set(seed.id, [hunk]);
    else existing.push(hunk);
  }

  for (const seed of input.seeds) {
    const parts = bySeed.get(seed.id) ?? [];
    if (parts.length === 0) {
      violations.push(
        violation(
          "hunk-unassigned",
          `Seed hunk ${seed.id} (${seed.path}) is not covered by any hunk.`,
          {
            hunkId: seed.id,
            path: seed.path,
          },
        ),
      );
      continue;
    }
    if (seed.fileKind !== null) {
      if (parts.length > 1) {
        violations.push(
          violation(
            "split-of-file-hunk",
            `Seed hunk ${seed.id} (${seed.path}) is a file-level hunk and may not be split; found ${parts.length} parts.`,
            { hunkId: seed.id, path: seed.path },
          ),
        );
      }
      for (const part of parts) {
        if (part.fileKind !== seed.fileKind) {
          violations.push(
            violation(
              "file-hunk-missing",
              `Hunk ${part.id} must keep the file kind "${seed.fileKind}" of seed hunk ${seed.id}.`,
              { hunkId: part.id, path: seed.path },
            ),
          );
        }
      }
      continue;
    }

    for (const part of parts) {
      if (part.fileKind !== null) {
        violations.push(
          violation(
            "file-hunk-duplicated",
            `Hunk ${part.id} declares file kind "${part.fileKind}" but splits the line-level seed hunk ${seed.id}.`,
            { hunkId: part.id, path: seed.path },
          ),
        );
      }
      if (part.oldLines === 0 && part.newLines === 0) {
        violations.push(
          violation(
            "split-does-not-tile-seed",
            `Hunk ${part.id} covers no lines at all; every split part must cover at least one changed line.`,
            { hunkId: part.id, path: seed.path },
          ),
        );
      }
    }

    const oldProblem = tilesExactly(
      { start: seed.oldStart, length: seed.oldLines },
      parts.map((part) => ({ start: part.oldStart, length: part.oldLines })),
    );
    if (oldProblem !== null) {
      violations.push(
        violation(
          "split-does-not-tile-seed",
          `The split of seed hunk ${seed.id} (${seed.path}, old side) ${oldProblem}.`,
          { hunkId: seed.id, path: seed.path },
        ),
      );
    }
    const newProblem = tilesExactly(
      { start: seed.newStart, length: seed.newLines },
      parts.map((part) => ({ start: part.newStart, length: part.newLines })),
    );
    if (newProblem !== null) {
      violations.push(
        violation(
          "split-does-not-tile-seed",
          `The split of seed hunk ${seed.id} (${seed.path}, new side) ${newProblem}.`,
          { hunkId: seed.id, path: seed.path },
        ),
      );
    }
  }

  // Every changed file must be represented. Seeds guarantee this by
  // construction, but a hunk list that drops a file's only seed would not —
  // so the file-level check is stated directly rather than inferred.
  const coveredPaths = new Set(input.hunks.map((hunk) => hunk.path));
  for (const file of input.files) {
    if (!coveredPaths.has(file.path)) {
      violations.push(
        violation("file-hunk-missing", `Changed file ${file.path} has no hunk in any cluster.`, {
          path: file.path,
        }),
      );
    }
  }

  return violations;
}

/** Cluster-shape rules: ordering, relationships, file order, resurfacing. */
export function validateClusters(input: {
  readonly clusters: ReadonlyArray<Cluster>;
  readonly hunks: ReadonlyArray<Hunk>;
}): ReadonlyArray<CoverageViolation> {
  const violations: CoverageViolation[] = [];
  const byId = new Map(input.clusters.map((cluster) => [cluster.id, cluster]));
  const hunksById = new Map(input.hunks.map((hunk) => [hunk.id, hunk]));

  if (byId.size !== input.clusters.length) {
    violations.push(violation("cluster-order-invalid", "Two clusters share an id."));
  }

  const positions = input.clusters.map((cluster) => cluster.position).toSorted((a, b) => a - b);
  const expected = input.clusters.map((_, index) => index + 1);
  if (
    positions.length !== expected.length ||
    positions.some((value, index) => value !== expected[index])
  ) {
    violations.push(
      violation(
        "cluster-order-invalid",
        `Cluster positions must be 1…${input.clusters.length} with no gaps or repeats; got ${positions.join(", ")}.`,
      ),
    );
  }

  const homedByCluster = new Map<ClusterId, Hunk[]>();
  for (const hunk of input.hunks) {
    const existing = homedByCluster.get(hunk.home);
    if (existing === undefined) homedByCluster.set(hunk.home, [hunk]);
    else existing.push(hunk);
  }

  for (const cluster of input.clusters) {
    const homed = homedByCluster.get(cluster.id) ?? [];
    if (homed.length === 0) {
      violations.push(
        violation("cluster-empty", `Cluster ${cluster.id} ("${cluster.title}") homes no hunks.`, {
          clusterId: cluster.id,
        }),
      );
    }

    for (const dependency of cluster.buildsOn) {
      const target = byId.get(dependency);
      if (target === undefined) {
        violations.push(
          violation(
            "builds-on-unknown-cluster",
            `Cluster ${cluster.id} builds on ${dependency}, which does not exist.`,
            {
              clusterId: cluster.id,
            },
          ),
        );
        continue;
      }
      if (target.position >= cluster.position) {
        violations.push(
          violation(
            "builds-on-forward-reference",
            `Cluster ${cluster.id} (position ${cluster.position}) builds on ${dependency} (position ${target.position}); a cluster may only build on earlier ones.`,
            { clusterId: cluster.id },
          ),
        );
      }
    }

    const resurfacedPaths: string[] = [];
    const seenResurfaced = new Set<string>();
    for (const entry of cluster.resurfaced) {
      if (seenResurfaced.has(entry.hunkId)) {
        violations.push(
          violation(
            "resurfaced-unknown-hunk",
            `Cluster ${cluster.id} resurfaces ${entry.hunkId} twice.`,
            {
              clusterId: cluster.id,
              hunkId: entry.hunkId,
            },
          ),
        );
        continue;
      }
      seenResurfaced.add(entry.hunkId);
      const hunk = hunksById.get(entry.hunkId);
      if (hunk === undefined) {
        violations.push(
          violation(
            "resurfaced-unknown-hunk",
            `Cluster ${cluster.id} resurfaces ${entry.hunkId}, which is not a hunk in this journey.`,
            {
              clusterId: cluster.id,
              hunkId: entry.hunkId,
            },
          ),
        );
        continue;
      }
      if (hunk.home === cluster.id) {
        violations.push(
          violation(
            "resurfaced-at-home",
            `Cluster ${cluster.id} resurfaces ${entry.hunkId}, but this cluster is its home.`,
            {
              clusterId: cluster.id,
              hunkId: entry.hunkId,
            },
          ),
        );
        continue;
      }
      const home = byId.get(hunk.home);
      if (home !== undefined && home.position > cluster.position) {
        violations.push(
          violation(
            "resurfaced-forward-reference",
            `Cluster ${cluster.id} (position ${cluster.position}) resurfaces ${entry.hunkId}, whose home ${home.id} comes later (position ${home.position}). Resurfacing is retrospective.`,
            { clusterId: cluster.id, hunkId: entry.hunkId },
          ),
        );
        continue;
      }
      resurfacedPaths.push(hunk.path);
    }

    const wanted = new Set<string>([...homed.map((hunk) => hunk.path), ...resurfacedPaths]);
    const seenOrder = new Set<string>();
    for (const path of cluster.fileOrder) {
      if (seenOrder.has(path)) {
        violations.push(
          violation(
            "file-order-mismatch",
            `Cluster ${cluster.id} lists ${path} twice in its file order.`,
            {
              clusterId: cluster.id,
              path,
            },
          ),
        );
        continue;
      }
      seenOrder.add(path);
      if (!wanted.has(path)) {
        violations.push(
          violation(
            "file-order-mismatch",
            `Cluster ${cluster.id} lists ${path} in its file order, but no hunk it homes or resurfaces is in that file.`,
            { clusterId: cluster.id, path },
          ),
        );
      }
    }
    for (const path of wanted) {
      if (!seenOrder.has(path)) {
        violations.push(
          violation(
            "file-order-mismatch",
            `Cluster ${cluster.id} is missing ${path} from its file order.`,
            {
              clusterId: cluster.id,
              path,
            },
          ),
        );
      }
    }
  }

  return violations;
}

/**
 * Referential integrity of the words: every `tl:` link resolves, every hint
 * belongs to a real cluster and anchors inside its file at the pinned revision.
 */
export function validateNarration(
  journey: Pick<Journey, "clusters" | "overview" | "hints" | "hunks">,
  context: EvidenceContext,
): ReadonlyArray<CoverageViolation> {
  const violations: CoverageViolation[] = [];
  const clusterIds = new Set(journey.clusters.map((cluster) => cluster.id));

  const checkProse = (markdown: string, where: string, clusterId: ClusterId | null) => {
    for (const link of extractEvidenceLinks(markdown)) {
      if (!resolveEvidenceLink(link, context)) {
        violations.push(
          violation(
            "evidence-link-unresolvable",
            `${where} links to ${link.raw}, which does not resolve against this journey at the pinned revision.`,
            clusterId === null ? {} : { clusterId },
          ),
        );
      }
    }
  };

  checkProse(journey.overview.brief.markdown, "The Overview's brief", null);
  checkProse(journey.overview.whereToBegin.markdown, "The Overview's where-to-begin", null);
  for (const cluster of journey.clusters) {
    checkProse(cluster.narrative.markdown, `Cluster ${cluster.id}'s narrative`, cluster.id);
    checkProse(cluster.mapEntry.markdown, `Cluster ${cluster.id}'s map entry`, cluster.id);
    for (const entry of cluster.resurfaced) {
      checkProse(
        entry.note.markdown,
        `Cluster ${cluster.id}'s resurfacing note for ${entry.hunkId}`,
        cluster.id,
      );
    }
  }

  for (const hint of journey.hints) {
    if (!clusterIds.has(hint.clusterId)) {
      violations.push(
        violation(
          "hint-unknown-cluster",
          `Hint ${hint.id} belongs to ${hint.clusterId}, which is not a cluster in this journey.`,
          {
            clusterId: hint.clusterId,
          },
        ),
      );
      continue;
    }
    checkProse(hint.body.markdown, `Hint ${hint.id}`, hint.clusterId);
    const problem = hintAnchorProblem(hint, context);
    if (problem !== null) {
      violations.push(
        violation("hint-anchor-out-of-range", `Hint ${hint.id} ${problem}.`, {
          clusterId: hint.clusterId,
          path: hint.anchor.path,
        }),
      );
    }
  }

  return violations;
}

function hintAnchorProblem(hint: Hint, context: EvidenceContext): string | null {
  const { anchor } = hint;
  if (anchor.startLine > anchor.endLine) {
    return `anchors to lines ${anchor.startLine}–${anchor.endLine}, which is backwards`;
  }
  const counts = context.lineCounts.get(anchor.path);
  if (counts === undefined) {
    return `anchors to ${anchor.path}, which does not exist at the pinned revision`;
  }
  const available = anchor.side === "old" ? counts.old : counts.new;
  if (available === 0) {
    return `anchors to the ${anchor.side} side of ${anchor.path}, which has no ${anchor.side} revision`;
  }
  if (anchor.endLine > available) {
    return `anchors to line ${anchor.endLine} of ${anchor.path}, which has ${available} lines on the ${anchor.side} side`;
  }
  return null;
}

/** Every check, in one call. Used by the pipeline before anything is persisted. */
export function validateJourney(
  journey: Pick<Journey, "clusters" | "hunks" | "files" | "hints" | "overview">,
  context: JourneyContext,
): ReadonlyArray<CoverageViolation> {
  return [
    ...validatePartition({
      seeds: context.seeds,
      files: journey.files,
      hunks: journey.hunks,
      clusters: journey.clusters,
    }),
    ...validateClusters({ clusters: journey.clusters, hunks: journey.hunks }),
    ...validateNarration(journey, context),
  ];
}

/** True when the journey is safe to persist. */
export function isCovered(violations: ReadonlyArray<CoverageViolation>): boolean {
  return violations.length === 0;
}

/**
 * The violation list as the harness sees it in a repair turn: numbered,
 * deduplicated, and capped so a catastrophic first attempt cannot produce a
 * correction prompt larger than the diff itself.
 */
export function formatViolations(
  violations: ReadonlyArray<CoverageViolation>,
  options?: { readonly limit?: number },
): string {
  const limit = options?.limit ?? 60;
  const seen = new Set<string>();
  const unique = violations.filter((item) => {
    if (seen.has(item.message)) return false;
    seen.add(item.message);
    return true;
  });
  const shown = unique.slice(0, limit);
  const lines = shown.map((item, index) => `${index + 1}. [${item.kind}] ${item.message}`);
  if (unique.length > shown.length) {
    lines.push(`…and ${unique.length - shown.length} more of the same kinds.`);
  }
  return lines.join("\n");
}
