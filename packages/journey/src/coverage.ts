import type { Cluster, ClusterId, Hint, Hunk, HunkId, Journey } from "@app/contracts";

import { extractEvidenceLinks } from "./evidence.ts";
import { hunkPaths, type SeedHunk } from "./hunks.ts";

/**
 * The validators. Every guarantee the vision states about a journey is checked
 * here, as pure functions over values — which is what makes "the guarantees are
 * checked, not prompted" true. The server refuses to persist a journey that
 * fails these; the analysis pipeline feeds the violation list back to the agent
 * verbatim as a correction turn, and stands on a deterministic floor if that
 * still fails.
 *
 * @module coverage
 */

export type ViolationCode =
  // partition
  | "hunk-unknown-home"
  | "hunk-unknown-seed"
  | "hunk-path-mismatch"
  | "hunk-duplicate-id"
  | "seed-unassigned"
  | "seed-split-mismatch"
  | "seed-split-empty-part"
  | "file-level-hunk-split"
  | "line-uncovered"
  | "line-double-covered"
  // clusters
  | "cluster-none"
  | "cluster-duplicate-id"
  | "cluster-position-invalid"
  | "cluster-builds-on-unknown"
  | "cluster-builds-on-forward"
  | "cluster-empty"
  | "cluster-file-order-missing"
  | "cluster-file-order-extra"
  | "cluster-file-order-duplicate"
  // resurfacing
  | "resurfaced-unknown-hunk"
  | "resurfaced-home-is-self"
  | "resurfaced-home-not-earlier"
  | "resurfaced-duplicate"
  // narration
  | "hint-unknown-cluster"
  | "hint-anchor-inverted"
  | "hint-anchor-unknown-file"
  | "hint-anchor-out-of-range"
  | "narrative-empty"
  | "evidence-unresolved-hunk"
  | "evidence-unresolved-file"
  | "evidence-unresolved-symbol";

/**
 * One precise, machine-generated failure. `message` is written to be read by an
 * agent as an instruction ("h17 is unassigned"), because that is exactly what
 * happens to it.
 */
export interface Violation {
  readonly code: ViolationCode;
  readonly message: string;
  readonly clusterId?: ClusterId;
  readonly hunkId?: HunkId;
  readonly path?: string;
}

/** What narration validation needs from the pinned revision to check anchors. */
export interface PinnedTree {
  /** Every path in the head-revision tree. */
  readonly paths: ReadonlySet<string>;
  /** Line counts per changed file, per side, for anchor range checks. */
  readonly lineCounts: ReadonlyMap<string, { readonly old: number; readonly new: number }>;
  /**
   * Whether a symbol occurs textually in a file at the pinned head. Deliberately
   * no language tooling — a substring check keeps the guarantee cheap and
   * unambiguous.
   */
  readonly fileContains: (path: string, symbol: string) => boolean;
}

/**
 * Line-coverage bookkeeping is keyed by (path, side). The separator is NUL for
 * the same reason read marks use it: a path may contain a space or a colon, but
 * never a NUL byte, so the key round-trips unambiguously.
 */
const LINE_KEY_SEPARATOR = "\u0000";

type CoverageSide = "old" | "new" | "file";

function lineKey(path: string, side: CoverageSide): string {
  return `${path}${LINE_KEY_SEPARATOR}${side}`;
}

function splitLineKey(key: string): readonly [string, CoverageSide] {
  const index = key.lastIndexOf(LINE_KEY_SEPARATOR);
  return [key.slice(0, index), key.slice(index + 1) as CoverageSide];
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

function interval(start: number, lines: number): Interval | null {
  return lines <= 0 ? null : { start, end: start + lines - 1 };
}

// ── The partition ───────────────────────────────────────────────────────────

/**
 * Every structural claim about hunks: ids unique, homes real, seeds real, paths
 * consistent, file-level hunks unsplit, splits tiling their seed exactly, and
 * every seed assigned.
 */
export function validateHunkPartition(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly hunks: ReadonlyArray<Hunk>;
  readonly clusterIds: ReadonlySet<string>;
}): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const seedsById = new Map(input.seeds.map((seed) => [seed.id as string, seed]));
  const seenHunkIds = new Set<string>();
  const bySeed = new Map<string, Hunk[]>();

  for (const hunk of input.hunks) {
    if (seenHunkIds.has(hunk.id)) {
      violations.push({
        code: "hunk-duplicate-id",
        message: `hunk id ${hunk.id} appears more than once`,
        hunkId: hunk.id,
      });
      continue;
    }
    seenHunkIds.add(hunk.id);

    if (!input.clusterIds.has(hunk.home)) {
      violations.push({
        code: "hunk-unknown-home",
        message: `${hunk.id} is homed to ${hunk.home}, which is not a cluster in this journey`,
        hunkId: hunk.id,
      });
    }

    const seed = seedsById.get(hunk.seedId);
    if (seed === undefined) {
      violations.push({
        code: "hunk-unknown-seed",
        message: `${hunk.id} claims to be a split of ${hunk.seedId}, which is not a seed hunk`,
        hunkId: hunk.id,
      });
      continue;
    }
    if (seed.path !== hunk.path) {
      violations.push({
        code: "hunk-path-mismatch",
        message: `${hunk.id} is on ${hunk.path} but its seed ${seed.id} is on ${seed.path}`,
        hunkId: hunk.id,
        path: hunk.path,
      });
    }
    const group = bySeed.get(hunk.seedId);
    if (group === undefined) bySeed.set(hunk.seedId, [hunk]);
    else group.push(hunk);
  }

  for (const seed of input.seeds) {
    const parts = bySeed.get(seed.id) ?? [];
    if (parts.length === 0) {
      violations.push({
        code: "seed-unassigned",
        message: `${seed.id} (${seed.path}${describeSeedRange(seed)}) has no home cluster`,
        hunkId: seed.id,
        path: seed.path,
      });
      continue;
    }
    if (seed.fileKind !== undefined && parts.length > 1) {
      violations.push({
        code: "file-level-hunk-split",
        message: `${seed.id} is a file-level hunk (${seed.fileKind}) on ${seed.path} and may not be split; it was split into ${parts.length} parts`,
        hunkId: seed.id,
        path: seed.path,
      });
      continue;
    }

    const ordered = [...parts].toSorted(
      (left, right) => left.newStart - right.newStart || left.oldStart - right.oldStart,
    );
    let cursorOld = seed.oldStart;
    let cursorNew = seed.newStart;
    for (const part of ordered) {
      if (part.oldLines === 0 && part.newLines === 0 && seed.fileKind === undefined) {
        violations.push({
          code: "seed-split-empty-part",
          message: `${part.id} is an empty split of ${seed.id}; every part must cover at least one line`,
          hunkId: part.id,
          path: part.path,
        });
      }
      if (part.oldLines > 0 && part.oldStart !== cursorOld) {
        violations.push({
          code: "seed-split-mismatch",
          message: `split of ${seed.id} does not tile it: ${part.id} starts at old line ${part.oldStart}, expected ${cursorOld}`,
          hunkId: part.id,
          path: part.path,
        });
      }
      if (part.newLines > 0 && part.newStart !== cursorNew) {
        violations.push({
          code: "seed-split-mismatch",
          message: `split of ${seed.id} does not tile it: ${part.id} starts at new line ${part.newStart}, expected ${cursorNew}`,
          hunkId: part.id,
          path: part.path,
        });
      }
      cursorOld += part.oldLines;
      cursorNew += part.newLines;
    }
    if (cursorOld !== seed.oldStart + seed.oldLines) {
      violations.push({
        code: "seed-split-mismatch",
        message: `split of ${seed.id} covers ${cursorOld - seed.oldStart} old lines but the seed has ${seed.oldLines}`,
        hunkId: seed.id,
        path: seed.path,
      });
    }
    if (cursorNew !== seed.newStart + seed.newLines) {
      violations.push({
        code: "seed-split-mismatch",
        message: `split of ${seed.id} covers ${cursorNew - seed.newStart} new lines but the seed has ${seed.newLines}`,
        hunkId: seed.id,
        path: seed.path,
      });
    }
  }

  return violations;
}

function describeSeedRange(seed: SeedHunk): string {
  if (seed.fileKind !== undefined) return ` — ${seed.fileKind} change`;
  const parts: string[] = [];
  if (seed.oldLines > 0) parts.push(`old ${seed.oldStart}–${seed.oldStart + seed.oldLines - 1}`);
  if (seed.newLines > 0) parts.push(`new ${seed.newStart}–${seed.newStart + seed.newLines - 1}`);
  return parts.length === 0 ? "" : ` ${parts.join(", ")}`;
}

/**
 * An independent, line-level verification of the same claim, computed from
 * scratch rather than inferred from the tiling check above. Belt and braces on
 * purpose: this is the property the product's core guarantee is stated in, so
 * it is checked directly and not merely implied.
 */
export function validateLineCoverage(input: {
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly hunks: ReadonlyArray<Hunk>;
}): ReadonlyArray<Violation> {
  const violations: Violation[] = [];

  const expected = new Map<string, Set<number>>();
  const fileLevelSeeds = new Set<string>();
  for (const seed of input.seeds) {
    if (seed.fileKind !== undefined) {
      fileLevelSeeds.add(lineKey(seed.path, "file"));
      continue;
    }
    addRange(expected, lineKey(seed.path, "old"), interval(seed.oldStart, seed.oldLines));
    addRange(expected, lineKey(seed.path, "new"), interval(seed.newStart, seed.newLines));
  }

  const actual = new Map<string, Set<number>>();
  const fileLevelHunks = new Map<string, number>();
  for (const hunk of input.hunks) {
    if (hunk.fileKind !== undefined) {
      const key = lineKey(hunk.path, "file");
      fileLevelHunks.set(key, (fileLevelHunks.get(key) ?? 0) + 1);
      continue;
    }
    for (const side of ["old", "new"] as const) {
      const range =
        side === "old"
          ? interval(hunk.oldStart, hunk.oldLines)
          : interval(hunk.newStart, hunk.newLines);
      if (range === null) continue;
      const key = lineKey(hunk.path, side);
      const set = actual.get(key) ?? new Set<number>();
      for (let line = range.start; line <= range.end; line += 1) {
        if (set.has(line)) {
          violations.push({
            code: "line-double-covered",
            message: `${hunk.path} ${side} line ${line} is covered by more than one hunk (${hunk.id} among them)`,
            hunkId: hunk.id,
            path: hunk.path,
          });
        }
        set.add(line);
      }
      actual.set(key, set);
    }
  }

  for (const [key, lines] of expected) {
    const [path, side] = splitLineKey(key);
    const covered = actual.get(key) ?? new Set<number>();
    const missing = [...lines].filter((line) => !covered.has(line)).toSorted((a, b) => a - b);
    if (missing.length > 0) {
      violations.push({
        code: "line-uncovered",
        message: `${path} ${side} ${formatLineList(missing)} ${missing.length === 1 ? "is" : "are"} not covered by any hunk`,
        path,
      });
    }
  }

  for (const key of fileLevelSeeds) {
    const count = fileLevelHunks.get(key) ?? 0;
    const path = splitLineKey(key)[0];
    if (count === 0) {
      violations.push({
        code: "line-uncovered",
        message: `${path} is a changed file with no changed lines and carries no file-level hunk`,
        path,
      });
    } else if (count > 1) {
      violations.push({
        code: "line-double-covered",
        message: `${path} carries ${count} file-level hunks; exactly one is allowed`,
        path,
      });
    }
  }

  return violations;
}

function addRange(target: Map<string, Set<number>>, key: string, range: Interval | null): void {
  if (range === null) return;
  const set = target.get(key) ?? new Set<number>();
  for (let line = range.start; line <= range.end; line += 1) set.add(line);
  target.set(key, set);
}

/** `12`, `12–14`, or `12–14, 19` — compact enough for a correction turn. */
function formatLineList(lines: ReadonlyArray<number>): string {
  const runs: string[] = [];
  let start = lines[0];
  let previous = lines[0];
  if (start === undefined || previous === undefined) return "no lines";
  for (const line of lines.slice(1)) {
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    runs.push(start === previous ? `line ${start}` : `lines ${start}–${previous}`);
    start = line;
    previous = line;
  }
  runs.push(start === previous ? `line ${start}` : `lines ${start}–${previous}`);
  return runs.join(", ");
}

// ── Clusters ────────────────────────────────────────────────────────────────

export function validateClusters(
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  if (clusters.length === 0) {
    return [{ code: "cluster-none", message: "the journey has no clusters" }];
  }

  const positionsById = new Map<string, number>();
  const seen = new Set<string>();
  for (const cluster of clusters) {
    if (seen.has(cluster.id)) {
      violations.push({
        code: "cluster-duplicate-id",
        message: `cluster id ${cluster.id} appears more than once`,
        clusterId: cluster.id,
      });
      continue;
    }
    seen.add(cluster.id);
    positionsById.set(cluster.id, cluster.position);
  }

  const ordered = [...clusters].toSorted((left, right) => left.position - right.position);
  ordered.forEach((cluster, index) => {
    if (cluster.position !== index + 1) {
      violations.push({
        code: "cluster-position-invalid",
        message: `cluster positions must be 1..${clusters.length} with no gaps; ${cluster.id} has position ${cluster.position}`,
        clusterId: cluster.id,
      });
    }
  });

  const homedByCluster = new Map<string, Hunk[]>();
  for (const hunk of hunks) {
    const group = homedByCluster.get(hunk.home);
    if (group === undefined) homedByCluster.set(hunk.home, [hunk]);
    else group.push(hunk);
  }

  for (const cluster of clusters) {
    const homed = homedByCluster.get(cluster.id) ?? [];
    if (homed.length === 0) {
      violations.push({
        code: "cluster-empty",
        message: `${cluster.id} (${cluster.title}) has no hunks homed to it`,
        clusterId: cluster.id,
      });
    }

    const buildsOnSeen = new Set<string>();
    for (const dependency of cluster.buildsOn) {
      const position = positionsById.get(dependency);
      if (position === undefined) {
        violations.push({
          code: "cluster-builds-on-unknown",
          message: `${cluster.id} builds on ${dependency}, which is not a cluster in this journey`,
          clusterId: cluster.id,
        });
        continue;
      }
      if (position >= cluster.position) {
        violations.push({
          code: "cluster-builds-on-forward",
          message: `${cluster.id} (position ${cluster.position}) builds on ${dependency} (position ${position}); a cluster may only build on earlier clusters`,
          clusterId: cluster.id,
        });
      }
      if (buildsOnSeen.has(dependency)) {
        violations.push({
          code: "cluster-builds-on-unknown",
          message: `${cluster.id} lists ${dependency} in buildsOn more than once`,
          clusterId: cluster.id,
        });
      }
      buildsOnSeen.add(dependency);
    }

    violations.push(...validateFileOrder(cluster, homed, hunks));
  }

  return violations;
}

/**
 * `fileOrder` is narrative order and must name every path this cluster shows —
 * homed or resurfaced — exactly once, and nothing else. It is what the reading
 * surface iterates, so a wrong order silently hides code.
 */
function validateFileOrder(
  cluster: Cluster,
  homed: ReadonlyArray<Hunk>,
  allHunks: ReadonlyArray<Hunk>,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const hunksById = new Map(allHunks.map((hunk) => [hunk.id as string, hunk]));

  const required = new Set(hunkPaths(homed));
  for (const entry of cluster.resurfaced) {
    const hunk = hunksById.get(entry.hunkId);
    if (hunk !== undefined) required.add(hunk.path);
  }

  const seen = new Set<string>();
  for (const path of cluster.fileOrder) {
    if (seen.has(path)) {
      violations.push({
        code: "cluster-file-order-duplicate",
        message: `${cluster.id} lists ${path} in fileOrder more than once`,
        clusterId: cluster.id,
        path,
      });
      continue;
    }
    seen.add(path);
    if (!required.has(path)) {
      violations.push({
        code: "cluster-file-order-extra",
        message: `${cluster.id} lists ${path} in fileOrder but no hunk homed or resurfaced there`,
        clusterId: cluster.id,
        path,
      });
    }
  }
  for (const path of required) {
    if (!seen.has(path)) {
      violations.push({
        code: "cluster-file-order-missing",
        message: `${cluster.id} shows hunks in ${path} but fileOrder does not list it`,
        clusterId: cluster.id,
        path,
      });
    }
  }
  return violations;
}

// ── Resurfacing ─────────────────────────────────────────────────────────────

/**
 * Resurfacing is retrospective perspective: a revisited hunk's home must be a
 * *different, earlier* cluster. That rule is what keeps "known code from a new
 * angle" honest — you cannot resurface something the reviewer has not met yet.
 */
export function validateResurfacing(
  clusters: ReadonlyArray<Cluster>,
  hunks: ReadonlyArray<Hunk>,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const hunksById = new Map(hunks.map((hunk) => [hunk.id as string, hunk]));
  const positionsById = new Map(
    clusters.map((cluster) => [cluster.id as string, cluster.position]),
  );

  for (const cluster of clusters) {
    const seen = new Set<string>();
    for (const entry of cluster.resurfaced) {
      if (seen.has(entry.hunkId)) {
        violations.push({
          code: "resurfaced-duplicate",
          message: `${cluster.id} resurfaces ${entry.hunkId} more than once`,
          clusterId: cluster.id,
          hunkId: entry.hunkId,
        });
        continue;
      }
      seen.add(entry.hunkId);

      const hunk = hunksById.get(entry.hunkId);
      if (hunk === undefined) {
        violations.push({
          code: "resurfaced-unknown-hunk",
          message: `${cluster.id} resurfaces ${entry.hunkId}, which is not a hunk in this journey`,
          clusterId: cluster.id,
          hunkId: entry.hunkId,
        });
        continue;
      }
      if (hunk.home === cluster.id) {
        violations.push({
          code: "resurfaced-home-is-self",
          message: `${cluster.id} resurfaces ${entry.hunkId}, but ${cluster.id} is its home — a hunk cannot be resurfaced where it lives`,
          clusterId: cluster.id,
          hunkId: entry.hunkId,
        });
        continue;
      }
      const homePosition = positionsById.get(hunk.home);
      if (homePosition !== undefined && homePosition > cluster.position) {
        violations.push({
          code: "resurfaced-home-not-earlier",
          message: `${cluster.id} (position ${cluster.position}) resurfaces ${entry.hunkId}, whose home ${hunk.home} is at position ${homePosition}; resurfacing only looks backward`,
          clusterId: cluster.id,
          hunkId: entry.hunkId,
        });
      }
      if (entry.note.markdown.trim().length === 0) {
        violations.push({
          code: "narrative-empty",
          message: `${cluster.id} resurfaces ${entry.hunkId} with an empty note; say what to see in it this time`,
          clusterId: cluster.id,
          hunkId: entry.hunkId,
        });
      }
    }
  }
  return violations;
}

// ── Narration ───────────────────────────────────────────────────────────────

export function validateHints(
  hints: ReadonlyArray<Hint>,
  clusters: ReadonlyArray<Cluster>,
  tree: PinnedTree,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const clusterIds = new Set(clusters.map((cluster) => cluster.id as string));

  for (const hint of hints) {
    if (!clusterIds.has(hint.clusterId)) {
      violations.push({
        code: "hint-unknown-cluster",
        message: `hint ${hint.id} rides ${hint.clusterId}, which is not a cluster in this journey`,
        clusterId: hint.clusterId,
      });
    }
    if (hint.anchor.endLine < hint.anchor.startLine) {
      violations.push({
        code: "hint-anchor-inverted",
        message: `hint ${hint.id} anchors to ${hint.anchor.path} lines ${hint.anchor.startLine}–${hint.anchor.endLine}, which runs backwards`,
        path: hint.anchor.path,
      });
      continue;
    }
    const counts = tree.lineCounts.get(hint.anchor.path);
    if (counts === undefined) {
      if (!tree.paths.has(hint.anchor.path)) {
        violations.push({
          code: "hint-anchor-unknown-file",
          message: `hint ${hint.id} anchors to ${hint.anchor.path}, which is not in the pinned revision`,
          path: hint.anchor.path,
        });
      }
      continue;
    }
    const limit = hint.anchor.side === "old" ? counts.old : counts.new;
    if (limit === 0 || hint.anchor.endLine > limit) {
      violations.push({
        code: "hint-anchor-out-of-range",
        message: `hint ${hint.id} anchors to ${hint.anchor.path} ${hint.anchor.side} lines ${hint.anchor.startLine}–${hint.anchor.endLine}, but that side has ${limit} lines`,
        path: hint.anchor.path,
      });
    }
    if (hint.body.markdown.trim().length === 0) {
      violations.push({
        code: "narrative-empty",
        message: `hint ${hint.id} has an empty body`,
      });
    }
  }
  return violations;
}

/**
 * Evidence resolution. Per the vision, prose that cannot be checked against
 * code is not allowed to exist in the product, so every `tl:` link in every
 * narrative is resolved here against the artifact and the pinned tree.
 */
export function validateEvidence(
  journey: Pick<Journey, "clusters" | "hunks" | "hints" | "overview">,
  tree: PinnedTree,
): ReadonlyArray<Violation> {
  const violations: Violation[] = [];
  const hunkIds = new Set(journey.hunks.map((hunk) => hunk.id as string));

  const check = (markdown: string, where: string, clusterId?: ClusterId) => {
    for (const link of extractEvidenceLinks(markdown)) {
      switch (link.kind) {
        case "hunk":
          if (!hunkIds.has(link.hunkId)) {
            violations.push({
              code: "evidence-unresolved-hunk",
              message: `${where} links to ${link.raw}, but ${link.hunkId} is not a hunk in this journey`,
              ...(clusterId === undefined ? {} : { clusterId }),
            });
          }
          break;
        case "file":
          if (!tree.paths.has(link.path)) {
            violations.push({
              code: "evidence-unresolved-file",
              message: `${where} links to ${link.raw}, but ${link.path} is not in the pinned revision`,
              ...(clusterId === undefined ? {} : { clusterId }),
              path: link.path,
            });
          }
          break;
        case "symbol":
          if (!tree.paths.has(link.path)) {
            violations.push({
              code: "evidence-unresolved-symbol",
              message: `${where} links to ${link.raw}, but ${link.path} is not in the pinned revision`,
              ...(clusterId === undefined ? {} : { clusterId }),
              path: link.path,
            });
            break;
          }
          if (!tree.fileContains(link.path, link.symbol)) {
            violations.push({
              code: "evidence-unresolved-symbol",
              message: `${where} links to ${link.raw}, but the text "${link.symbol}" does not occur in ${link.path} at the pinned head`,
              ...(clusterId === undefined ? {} : { clusterId }),
              path: link.path,
            });
          }
          break;
      }
    }
  };

  check(journey.overview.brief.markdown, "the Overview brief");
  check(journey.overview.whereToBegin.markdown, "the Overview's where-to-begin");
  for (const cluster of journey.clusters) {
    if (cluster.narrative.markdown.trim().length === 0) {
      violations.push({
        code: "narrative-empty",
        message: `${cluster.id} (${cluster.title}) has an empty narrative`,
        clusterId: cluster.id,
      });
    }
    if (cluster.mapEntry.markdown.trim().length === 0) {
      violations.push({
        code: "narrative-empty",
        message: `${cluster.id} (${cluster.title}) has an empty map entry`,
        clusterId: cluster.id,
      });
    }
    check(cluster.narrative.markdown, `${cluster.id}'s narrative`, cluster.id);
    check(cluster.mapEntry.markdown, `${cluster.id}'s map entry`, cluster.id);
    for (const entry of cluster.resurfaced) {
      check(
        entry.note.markdown,
        `${cluster.id}'s resurfacing note for ${entry.hunkId}`,
        cluster.id,
      );
    }
  }
  for (const hint of journey.hints) {
    check(hint.body.markdown, `hint ${hint.id}`, hint.clusterId);
  }

  return violations;
}

/**
 * Everything, in one call: the check the server runs before it will persist. An
 * empty result is the only thing that gets written to disk.
 */
export function validateJourney(
  journey: Pick<Journey, "clusters" | "hunks" | "hints" | "overview">,
  input: { readonly seeds: ReadonlyArray<SeedHunk>; readonly tree: PinnedTree },
): ReadonlyArray<Violation> {
  const clusterIds = new Set(journey.clusters.map((cluster) => cluster.id as string));
  return [
    ...validateHunkPartition({ seeds: input.seeds, hunks: journey.hunks, clusterIds }),
    ...validateLineCoverage({ seeds: input.seeds, hunks: journey.hunks }),
    ...validateClusters(journey.clusters, journey.hunks),
    ...validateResurfacing(journey.clusters, journey.hunks),
    ...validateHints(journey.hints, journey.clusters, input.tree),
    ...validateEvidence(journey, input.tree),
  ];
}

/** Render violations as the numbered instruction list a repair turn receives. */
export function formatViolations(violations: ReadonlyArray<Violation>, limit = 60): string {
  const shown = violations.slice(0, limit);
  const lines = shown.map((violation, index) => `${index + 1}. ${violation.message}`);
  if (violations.length > shown.length) {
    lines.push(`… and ${violations.length - shown.length} more of the same kind`);
  }
  return lines.join("\n");
}
