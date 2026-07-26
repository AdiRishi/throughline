import type {
  AttentionNote,
  Cluster,
  ClusterId,
  Hint,
  HintAnchor,
  HintId,
  HintKind,
  Hunk,
  HunkId,
  Narrative,
  Overview,
  ResurfacedHunk,
  Weight,
} from "@app/contracts";

import { type PinnedTree, type Violation } from "./coverage.ts";
import { downgradeUnresolvableLinks, type EvidenceLink } from "./evidence.ts";
import { hunkPaths, seedAsHunk, type SeedHunk } from "./hunks.ts";

/**
 * Assembling the artifact from agent output — and the floor that makes "the
 * agent always commits" an invariant of the *system* rather than a hope about
 * the model.
 *
 * Nothing in this module can fail. Every function takes whatever the agent
 * actually returned (including nothing) and produces a structurally valid
 * result plus a list of the deterministic fallbacks it had to stand on. Those
 * fallbacks are recorded in the journey's provenance and logged to the run
 * directory, so a journey that needed the floor says so.
 *
 * The key mechanism: **splits are materialized from a cursor, not trusted.** The
 * agent says how many lines each part covers; this module computes where each
 * part starts by walking the seed's range. A refinement of a partition is then
 * a partition by construction — the agent cannot produce overlapping or gapped
 * sub-ranges even if it tries.
 *
 * @module plan
 */

// ── Stage 1: the plan the agent returns ─────────────────────────────────────

/** Everything below is deliberately loose: it describes untrusted input. */
export interface PlanClusterInput {
  readonly id?: string;
  readonly title?: string;
  readonly weight?: string;
  readonly buildsOn?: ReadonlyArray<string>;
  readonly fileOrder?: ReadonlyArray<string>;
}

export interface PlanAssignmentInput {
  readonly hunkId?: string;
  readonly home?: string;
}

export interface PlanSplitPartInput {
  readonly oldLines?: number;
  readonly newLines?: number;
  readonly home?: string;
}

export interface PlanSplitInput {
  readonly seedId?: string;
  readonly parts?: ReadonlyArray<PlanSplitPartInput>;
}

export interface JourneyPlanInput {
  readonly clusters?: ReadonlyArray<PlanClusterInput>;
  readonly assignments?: ReadonlyArray<PlanAssignmentInput>;
  readonly splits?: ReadonlyArray<PlanSplitInput>;
}

/** A cluster with its structure fixed and its words still to come. */
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
  /** One entry per deterministic fallback taken. Empty is the good case. */
  readonly fallbacks: ReadonlyArray<string>;
}

const UNPLACED_TITLE = "Unplaced changes";

/** Weight is comprehension guidance; an unrecognized value is not worth failing over. */
function normalizeWeight(value: string | undefined): Weight {
  switch (value?.trim().toLowerCase()) {
    case "core":
      return "core";
    case "mechanical":
      return "mechanical";
    default:
      return "supporting";
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Materialize a stage-1 plan against the deterministic seeds. Always succeeds:
 * unassigned hunks land in a synthesized final cluster, invalid splits collapse
 * back to their seed, empty clusters are dropped, and an unusable plan falls all
 * the way back to the degenerate partition.
 */
export function materializePlan(
  seeds: ReadonlyArray<SeedHunk>,
  plan: JourneyPlanInput,
): MaterializedPlan {
  const fallbacks: string[] = [];
  const seedsById = new Map(seeds.map((seed) => [seed.id as string, seed]));

  // ── clusters ──
  const draft: Array<{ id: string; title: string; weight: Weight; buildsOn: string[] }> = [];
  const seenIds = new Set<string>();
  for (const input of plan.clusters ?? []) {
    if (!isNonEmpty(input.id) || !isNonEmpty(input.title)) {
      fallbacks.push("dropped a planned cluster with no id or title");
      continue;
    }
    const id = input.id.trim();
    if (seenIds.has(id)) {
      fallbacks.push(`dropped a duplicate planned cluster ${id}`);
      continue;
    }
    seenIds.add(id);
    draft.push({
      id,
      title: input.title.trim(),
      weight: normalizeWeight(input.weight),
      buildsOn: [...(input.buildsOn ?? [])].map((value) => value.trim()),
    });
  }

  if (draft.length === 0) {
    fallbacks.push(
      "the plan contained no usable clusters, so the journey fell back to one cluster per top-level directory",
    );
    for (const cluster of degenerateClusters(seeds)) {
      draft.push({ id: cluster.id, title: cluster.title, weight: cluster.weight, buildsOn: [] });
    }
  }

  const clusterIds = new Set(draft.map((cluster) => cluster.id));

  // ── assignments ──
  const assignedHome = new Map<string, string>();
  for (const assignment of plan.assignments ?? []) {
    if (!isNonEmpty(assignment.hunkId) || !isNonEmpty(assignment.home)) continue;
    const hunkId = assignment.hunkId.trim();
    const home = assignment.home.trim();
    if (!seedsById.has(hunkId)) {
      fallbacks.push(`ignored an assignment for ${hunkId}, which is not a seed hunk`);
      continue;
    }
    if (!clusterIds.has(home)) {
      fallbacks.push(`ignored the assignment of ${hunkId} to unknown cluster ${home}`);
      continue;
    }
    assignedHome.set(hunkId, home);
  }

  // ── splits ──
  const hunks: Hunk[] = [];
  const splitSeeds = new Set<string>();
  const unplaced: string[] = [];
  let needsUnplaced = false;

  for (const split of plan.splits ?? []) {
    if (!isNonEmpty(split.seedId)) continue;
    const seedId = split.seedId.trim();
    const seed = seedsById.get(seedId);
    if (seed === undefined) {
      fallbacks.push(`ignored a split of ${seedId}, which is not a seed hunk`);
      continue;
    }
    if (splitSeeds.has(seedId)) {
      fallbacks.push(`ignored a duplicate split of ${seedId}`);
      continue;
    }
    if (seed.fileKind !== undefined) {
      fallbacks.push(
        `collapsed a split of ${seedId} back to the whole hunk: it is a ${seed.fileKind} change with no lines to split`,
      );
      continue;
    }
    const parts = split.parts ?? [];
    if (parts.length < 2) {
      // A "split" into one part is just the seed; silently the same thing.
      continue;
    }

    const oldTotal = parts.reduce((total, part) => total + Math.max(0, part.oldLines ?? 0), 0);
    const newTotal = parts.reduce((total, part) => total + Math.max(0, part.newLines ?? 0), 0);
    const homesValid = parts.every((part) => isNonEmpty(part.home) && clusterIds.has(part.home));
    const partsNonEmpty = parts.every(
      (part) => Math.max(0, part.oldLines ?? 0) + Math.max(0, part.newLines ?? 0) > 0,
    );
    if (oldTotal !== seed.oldLines || newTotal !== seed.newLines || !homesValid || !partsNonEmpty) {
      fallbacks.push(
        `collapsed an invalid split of ${seedId} back to the whole hunk (parts covered ${oldTotal} old / ${newTotal} new lines against ${seed.oldLines} / ${seed.newLines})`,
      );
      continue;
    }

    splitSeeds.add(seedId);
    let cursorOld = seed.oldStart;
    let cursorNew = seed.newStart;
    parts.forEach((part, index) => {
      const oldLines = Math.max(0, part.oldLines ?? 0);
      const newLines = Math.max(0, part.newLines ?? 0);
      hunks.push({
        id: `${seed.id}.${index + 1}` as HunkId,
        path: seed.path,
        oldStart: cursorOld,
        oldLines,
        newStart: cursorNew,
        newLines,
        seedId: seed.id,
        home: (part.home as string).trim() as ClusterId,
      });
      cursorOld += oldLines;
      cursorNew += newLines;
    });
  }

  // ── the rest of the seeds ──
  for (const seed of seeds) {
    if (splitSeeds.has(seed.id)) continue;
    const home = assignedHome.get(seed.id);
    if (home === undefined) {
      needsUnplaced = true;
      unplaced.push(seed.id);
      continue;
    }
    hunks.push(seedAsHunk(seed, home as ClusterId));
  }

  if (needsUnplaced) {
    const unplacedId = nextFreeClusterId(clusterIds);
    draft.push({ id: unplacedId, title: UNPLACED_TITLE, weight: "supporting", buildsOn: [] });
    clusterIds.add(unplacedId);
    fallbacks.push(
      `${unplaced.length} hunk${unplaced.length === 1 ? "" : "s"} the plan left unassigned (${unplaced.slice(0, 12).join(", ")}${unplaced.length > 12 ? ", …" : ""}) were homed to a synthesized final cluster titled "${UNPLACED_TITLE}"`,
    );
    for (const seedId of unplaced) {
      const seed = seedsById.get(seedId);
      if (seed !== undefined) hunks.push(seedAsHunk(seed, unplacedId as ClusterId));
    }
  }

  // ── drop empty clusters, then renumber ──
  const homedCounts = new Map<string, number>();
  for (const hunk of hunks) {
    homedCounts.set(hunk.home, (homedCounts.get(hunk.home) ?? 0) + 1);
  }
  const kept = draft.filter((cluster) => (homedCounts.get(cluster.id) ?? 0) > 0);
  for (const cluster of draft) {
    if ((homedCounts.get(cluster.id) ?? 0) === 0) {
      fallbacks.push(
        `dropped planned cluster ${cluster.id} (${cluster.title}): no hunks landed in it`,
      );
    }
  }
  const keptIds = new Set(kept.map((cluster) => cluster.id));
  const positionsById = new Map(kept.map((cluster, index) => [cluster.id, index + 1]));

  const seedOrder = new Map(seeds.map((seed, index) => [seed.id as string, index]));
  const orderedHunks = [...hunks].toSorted((left, right) => {
    const leftSeed = seedOrder.get(left.seedId) ?? 0;
    const rightSeed = seedOrder.get(right.seedId) ?? 0;
    if (leftSeed !== rightSeed) return leftSeed - rightSeed;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const clusters: PlannedCluster[] = kept.map((cluster, index) => {
    const position = index + 1;
    const homed = orderedHunks.filter((hunk) => hunk.home === cluster.id);
    const required = hunkPaths(homed);
    const requested =
      plan.clusters?.find((entry) => entry.id?.trim() === cluster.id)?.fileOrder ?? [];
    const fileOrder = reconcileFileOrder(requested, required);
    const buildsOn = [...new Set(cluster.buildsOn)]
      .filter((dependency) => {
        if (!keptIds.has(dependency)) return false;
        const dependencyPosition = positionsById.get(dependency);
        return dependencyPosition !== undefined && dependencyPosition < position;
      })
      .map((dependency) => dependency as ClusterId);
    return {
      id: cluster.id as ClusterId,
      position,
      title: cluster.title,
      weight: cluster.weight,
      buildsOn,
      fileOrder,
    };
  });

  return { clusters, hunks: orderedHunks, fallbacks };
}

/** Keep the agent's order where it is valid, then append whatever it forgot. */
function reconcileFileOrder(
  requested: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const requiredSet = new Set(required);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of requested) {
    const trimmed = path.trim();
    if (!requiredSet.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  for (const path of required) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function nextFreeClusterId(taken: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const candidate = `c${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The absolute floor of stage 1: one cluster per top-level directory of the
 * change. Dreadful as a journey, but a *valid* one — complete coverage, visible
 * structure, and a narrative that will say exactly how it came to exist.
 */
export function degenerateClusters(
  seeds: ReadonlyArray<SeedHunk>,
): ReadonlyArray<{ id: string; title: string; weight: Weight; paths: ReadonlyArray<string> }> {
  const groups = new Map<string, string[]>();
  for (const seed of seeds) {
    const segments = seed.path.split("/");
    const key = segments.length > 1 ? (segments[0] ?? "") : "";
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [seed.path]);
    else if (!group.includes(seed.path)) group.push(seed.path);
  }
  return [...groups.keys()]
    .toSorted((left, right) => (left < right ? -1 : 1))
    .map((key, index) => ({
      id: `c${index + 1}`,
      title: key === "" ? "Changes at the repository root" : `Changes in ${key}/`,
      weight: "supporting" as Weight,
      paths: groups.get(key) ?? [],
    }));
}

/** Build a plan input that yields the degenerate partition. Used at the floor. */
export function degeneratePlan(seeds: ReadonlyArray<SeedHunk>): JourneyPlanInput {
  const clusters = degenerateClusters(seeds);
  const homeByPath = new Map<string, string>();
  for (const cluster of clusters) {
    for (const path of cluster.paths) homeByPath.set(path, cluster.id);
  }
  return {
    clusters: clusters.map((cluster) => ({
      id: cluster.id,
      title: cluster.title,
      weight: cluster.weight,
      buildsOn: [],
      fileOrder: cluster.paths,
    })),
    assignments: seeds.map((seed) => ({
      hunkId: seed.id,
      home: homeByPath.get(seed.path) ?? clusters[0]?.id ?? "c1",
    })),
    splits: [],
  };
}

// ── Stage 2: the words ──────────────────────────────────────────────────────

export interface ClusterNarrationInput {
  readonly narrative?: string;
  readonly mapEntry?: string;
  readonly resurfaced?: ReadonlyArray<{ readonly hunkId?: string; readonly note?: string }>;
  readonly hints?: ReadonlyArray<{
    readonly kind?: string;
    readonly path?: string;
    readonly side?: string;
    readonly startLine?: number;
    readonly endLine?: number;
    readonly body?: string;
  }>;
}

export interface OverviewNarrationInput {
  readonly brief?: string;
  readonly whereToBegin?: string;
  readonly attention?: ReadonlyArray<{ readonly clusterId?: string; readonly phrase?: string }>;
}

export interface AssembledNarration {
  readonly clusters: ReadonlyArray<Cluster>;
  readonly hints: ReadonlyArray<Hint>;
  readonly overview: Overview;
  readonly fallbacks: ReadonlyArray<string>;
}

const HINT_KINDS: ReadonlyArray<HintKind> = [
  "connection",
  "complexity",
  "ripple",
  "pattern-echo",
  "behavior",
  "resurfacing",
];

function narrative(markdown: string): Narrative {
  return { markdown };
}

/**
 * Assemble the finished artifact's prose. Every rung of the ladder below the
 * agent lives here: an empty narrative is replaced with an honest synthesized
 * one, an unresolvable evidence link is downgraded to plain text, an invalid
 * hint is dropped (hints are optional aids; coverage is not), and invalid
 * resurfacing is dropped.
 */
export function assembleNarration(input: {
  readonly clusters: ReadonlyArray<PlannedCluster>;
  readonly hunks: ReadonlyArray<Hunk>;
  readonly tree: PinnedTree;
  readonly narrationByCluster: ReadonlyMap<string, ClusterNarrationInput>;
  readonly overview: OverviewNarrationInput;
}): AssembledNarration {
  const fallbacks: string[] = [];
  const hunkIds = new Set(input.hunks.map((hunk) => hunk.id as string));
  const hunksById = new Map(input.hunks.map((hunk) => [hunk.id as string, hunk]));
  const positionsById = new Map(
    input.clusters.map((cluster) => [cluster.id as string, cluster.position]),
  );

  const resolves = (link: EvidenceLink): boolean => {
    switch (link.kind) {
      case "hunk":
        return hunkIds.has(link.hunkId);
      case "file":
        return input.tree.paths.has(link.path);
      case "symbol":
        return input.tree.paths.has(link.path) && input.tree.fileContains(link.path, link.symbol);
    }
  };

  const clean = (markdown: string, where: string): string => {
    const { markdown: cleaned, downgraded } = downgradeUnresolvableLinks(markdown, resolves);
    for (const link of downgraded) {
      fallbacks.push(
        `downgraded the unresolvable evidence link ${link.raw} in ${where} to plain text`,
      );
    }
    return cleaned;
  };

  const hints: Hint[] = [];
  let hintCounter = 0;

  const clusters: Cluster[] = input.clusters.map((planned) => {
    const narration = input.narrationByCluster.get(planned.id) ?? {};

    let narrativeText = (narration.narrative ?? "").trim();
    if (narrativeText.length === 0) {
      narrativeText = synthesizedClusterNarrative(planned, input.hunks);
      fallbacks.push(
        `${planned.id} (${planned.title}) received no narrative from the harness, so a factual one was synthesized`,
      );
    }
    let mapEntryText = (narration.mapEntry ?? "").trim();
    if (mapEntryText.length === 0) {
      mapEntryText = firstSentences(narrativeText, 2);
      fallbacks.push(`${planned.id} received no map entry, so its narrative's opening was used`);
    }

    const resurfaced: ResurfacedHunk[] = [];
    const seenResurfaced = new Set<string>();
    for (const entry of narration.resurfaced ?? []) {
      const hunkId = entry.hunkId?.trim();
      const note = (entry.note ?? "").trim();
      if (hunkId === undefined || hunkId.length === 0 || note.length === 0) continue;
      if (seenResurfaced.has(hunkId)) continue;
      const hunk = hunksById.get(hunkId);
      if (hunk === undefined || hunk.home === planned.id) {
        fallbacks.push(
          `dropped ${planned.id}'s resurfacing of ${hunkId}: it is not a hunk homed to another cluster`,
        );
        continue;
      }
      const homePosition = positionsById.get(hunk.home);
      if (homePosition === undefined || homePosition > planned.position) {
        fallbacks.push(
          `dropped ${planned.id}'s resurfacing of ${hunkId}: its home is not an earlier cluster`,
        );
        continue;
      }
      seenResurfaced.add(hunkId);
      resurfaced.push({
        hunkId: hunkId as HunkId,
        note: narrative(clean(note, `${planned.id}'s resurfacing note`)),
      });
    }

    for (const raw of narration.hints ?? []) {
      const anchor = normalizeAnchor(raw, input.tree);
      const body = (raw.body ?? "").trim();
      if (anchor === null || body.length === 0) {
        fallbacks.push(`dropped a hint on ${planned.id}: its anchor or body was unusable`);
        continue;
      }
      hintCounter += 1;
      hints.push({
        id: `t${hintCounter}` as HintId,
        clusterId: planned.id,
        kind: normalizeHintKind(raw.kind),
        anchor,
        body: narrative(clean(body, `a hint on ${planned.id}`)),
      });
    }

    // Every resurfaced path must be in fileOrder; the planner only knew about
    // homed paths, so widen it here rather than reject valid resurfacing.
    const fileOrder = [...planned.fileOrder];
    for (const entry of resurfaced) {
      const path = hunksById.get(entry.hunkId)?.path;
      if (path !== undefined && !fileOrder.includes(path)) fileOrder.push(path);
    }

    return {
      id: planned.id,
      position: planned.position,
      title: planned.title,
      weight: planned.weight,
      narrative: narrative(clean(narrativeText, `${planned.id}'s narrative`)),
      mapEntry: narrative(clean(mapEntryText, `${planned.id}'s map entry`)),
      buildsOn: planned.buildsOn,
      fileOrder,
      resurfaced,
    };
  });

  let brief = (input.overview.brief ?? "").trim();
  if (brief.length === 0) {
    brief = synthesizedBrief(clusters, input.hunks);
    fallbacks.push("the Overview brief was missing, so a factual one was synthesized");
  }
  let whereToBegin = (input.overview.whereToBegin ?? "").trim();
  if (whereToBegin.length === 0) {
    whereToBegin = synthesizedWhereToBegin(clusters);
    fallbacks.push("the Overview's where-to-begin was missing, so a factual one was synthesized");
  }

  const clusterIds = new Set(clusters.map((cluster) => cluster.id as string));
  const attention: AttentionNote[] = [];
  const seenAttention = new Set<string>();
  for (const entry of input.overview.attention ?? []) {
    const clusterId = entry.clusterId?.trim();
    const phrase = entry.phrase?.trim();
    if (clusterId === undefined || phrase === undefined || phrase.length === 0) continue;
    if (!clusterIds.has(clusterId) || seenAttention.has(clusterId)) continue;
    seenAttention.add(clusterId);
    attention.push({ clusterId: clusterId as ClusterId, phrase });
  }
  for (const cluster of clusters) {
    if (seenAttention.has(cluster.id)) continue;
    attention.push({ clusterId: cluster.id, phrase: defaultAttention(cluster.weight) });
  }
  attention.sort(
    (left, right) =>
      (positionsById.get(left.clusterId) ?? 0) - (positionsById.get(right.clusterId) ?? 0),
  );

  return {
    clusters,
    hints,
    overview: {
      brief: narrative(clean(brief, "the Overview brief")),
      whereToBegin: narrative(clean(whereToBegin, "the Overview's where-to-begin")),
      attention,
    },
    fallbacks,
  };
}

function normalizeHintKind(value: string | undefined): HintKind {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  const found = HINT_KINDS.find((kind) => kind === normalized);
  return found ?? "connection";
}

function normalizeAnchor(
  raw: {
    readonly path?: string;
    readonly side?: string;
    readonly startLine?: number;
    readonly endLine?: number;
  },
  tree: PinnedTree,
): HintAnchor | null {
  const path = raw.path?.trim();
  if (path === undefined || path.length === 0) return null;
  const side = raw.side?.trim().toLowerCase() === "old" ? "old" : "new";
  const start = Math.trunc(raw.startLine ?? 0);
  const end = Math.trunc(raw.endLine ?? start);
  if (start < 1 || end < start) return null;

  const counts = tree.lineCounts.get(path);
  if (counts === undefined) {
    // Not a changed file: a ripple hint may still anchor into the tree, but
    // without a line count there is nothing to bound it against.
    return tree.paths.has(path) ? { path, side, startLine: start, endLine: end } : null;
  }
  const limit = side === "old" ? counts.old : counts.new;
  if (limit === 0 || start > limit) return null;
  return { path, side, startLine: start, endLine: Math.min(end, limit) };
}

function synthesizedClusterNarrative(cluster: PlannedCluster, hunks: ReadonlyArray<Hunk>): string {
  const homed = hunks.filter((hunk) => hunk.home === cluster.id);
  const paths = hunkPaths(homed);
  const fileList = paths
    .slice(0, 6)
    .map((path) => `\`${path}\``)
    .join(", ");
  const more = paths.length > 6 ? `, and ${paths.length - 6} more` : "";
  const title = cluster.title === UNPLACED_TITLE ? "This cluster" : `**${cluster.title}**`;
  return [
    `${title} covers ${homed.length} hunk${homed.length === 1 ? "" : "s"} across ${paths.length} file${paths.length === 1 ? "" : "s"}: ${fileList}${more}.`,
    "",
    "The harness did not return a narrative for this cluster, so this account is generated from the partition itself. Every line here still counts toward coverage; only the prose is missing.",
  ].join("\n");
}

function synthesizedBrief(clusters: ReadonlyArray<Cluster>, hunks: ReadonlyArray<Hunk>): string {
  const paths = hunkPaths(hunks);
  return [
    `This pull request changes ${paths.length} file${paths.length === 1 ? "" : "s"} across ${hunks.length} hunk${hunks.length === 1 ? "" : "s"}, presented here as ${clusters.length} cluster${clusters.length === 1 ? "" : "s"}.`,
    "",
    "The harness did not return an Overview brief, so this one is generated from the partition. The clusters and their coverage are unaffected.",
  ].join("\n");
}

function synthesizedWhereToBegin(clusters: ReadonlyArray<Cluster>): string {
  const first = clusters[0];
  if (first === undefined) return "There is nothing to read in this journey.";
  return `Start at ${first.position} — ${first.title} — and walk the clusters in order. Every hunk has a home, so finishing the last cluster means every changed line was presented and acknowledged.`;
}

function defaultAttention(weight: Weight): string {
  switch (weight) {
    case "core":
      return "read closely";
    case "supporting":
      return "read once";
    case "mechanical":
      return "walk quickly";
  }
}

/** First N sentences, for compressing a narrative into a map entry at the floor. */
export function firstSentences(text: string, count: number): string {
  const matches = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?]+[.!?]+(\s|$)/g);
  if (matches === null) return text.trim();
  return matches.slice(0, count).join("").trim();
}

/** Convenience for callers that want the violation list and the fallbacks together. */
export interface AssemblyOutcome {
  readonly violations: ReadonlyArray<Violation>;
  readonly fallbacks: ReadonlyArray<string>;
}
