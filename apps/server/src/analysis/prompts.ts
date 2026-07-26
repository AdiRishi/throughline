/**
 * What the agent is actually asked.
 *
 * A 40,000-line diff does not travel in a prompt. Ingestion materializes the
 * run inputs into `.throughline/` inside the worktree and these prompts point
 * at them by path, so prompt size stays flat no matter how large the pull
 * request is and the agent navigates the diff the way agents are good at it.
 *
 * The vocabulary here is `CONTEXT.md`'s, deliberately: the agent is told the
 * domain's words so the prose it writes already speaks the product's language.
 *
 * @module analysis/prompts
 */
import type { Cluster, FileChange, PrDetail, SeedHunk } from "@app/contracts";

/** Where run inputs live inside the worktree the agent walks. */
export const AGENT_INPUT_DIR = ".throughline";

const SHARED_PREAMBLE = `You are reconstructing the development journey behind a pull request, for a system called Throughline.

The reviewer is about to read this change. Your job is not to review it, summarize it, or judge it — it is to recover the intelligible ordering that makes it comprehensible: the sequence of steps a thoughtful developer would describe if you asked them "walk me through this change".

You are in a read-only checkout of the pull request's head revision. Everything you need is on disk:

- \`${AGENT_INPUT_DIR}/full.patch\` — the complete diff of this pull request.
- \`${AGENT_INPUT_DIR}/hunks.json\` — the seed hunks: every changed line in the pull request, already partitioned. Each entry has an id, a path, old/new line ranges, and — for changed files with no changed lines — a \`fileKind\`.
- \`${AGENT_INPUT_DIR}/files.json\` — every changed file with its change kind and rename provenance.

The rest of the checkout is the codebase the change lands in. Read it. Whether a piece of the change is new foundation or a modification of something load-bearing is only visible in the code *around* it.

Vocabulary, used exactly:

- A **journey** is the ordered sequence of clusters that partitions this pull request.
- A **cluster** is one describable step of the work: a set of hunks, possibly spanning many files, that together accomplish a single piece of the work.
- A **hunk** is the atomic unit of placement — one contiguous run of changed lines.
- A hunk's **home** is the one cluster it is placed in.
- **Weight** is a cluster's attention classification: core, supporting, or mechanical. It guides how much comprehension effort a cluster deserves. It never expresses risk, severity, or quality.`;

export function planPrompt(input: {
  readonly pr: PrDetail;
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
}): string {
  const scale = `${input.files.length} changed files, ${input.seeds.length} seed hunks, +${totalAdditions(input.files)} −${totalDeletions(input.files)}.`;
  return `${SHARED_PREAMBLE}

## The pull request

${input.pr.summary.title}

Opened by ${input.pr.summary.authorLogin}. ${scale}

The author's own description is below. Treat it as a hint about intent, never as the answer — your journey must come from the code.

<pr-description>
${truncate(input.pr.body, 4000)}
</pr-description>

## Your task

Produce the journey **plan**: the clusters, their order, and where every seed hunk lives.

Rules that are checked mechanically, so getting them right saves a round trip:

1. **Every seed hunk in \`hunks.json\` must appear exactly once** — either in \`homes\`, or as a \`splits\` entry. Not both. Not neither. There are ${input.seeds.length} of them.
2. **Every cluster must home at least one hunk.** A cluster nothing lands in is dropped.
3. **\`buildsOn\` may only name earlier clusters.** The journey reads forward.
4. **\`fileOrder\` must list exactly the files this cluster homes hunks in** — each once, in the order the story wants them read.
5. **Splits must tile their seed exactly.** Only split when one contiguous run genuinely serves two concerns; most changes need no splits at all. A hunk with a \`fileKind\` can never be split.

What makes a good journey:

- **Order for comprehension.** Foundations before the things built on them; parts before the code that binds the parts together. The reader should never need a later cluster to understand an earlier one.
- **Cluster by what the work *is*, not by directory.** Files that share a folder often belong to different steps; files far apart often belong to the same one.
- **Each cluster should be small enough to hold in your head** and internally cohesive. On a change this size, somewhere between three and eight clusters is usually right — but let the change decide, not the number.
- **Be honest about mechanical work.** Generated code, lockfiles, and formatting churn are a real part of the change and must be covered — give them their own cluster and mark it mechanical rather than scattering them.
- **Commit.** There is no "too tangled to decompose". A messy change gets an honest journey through a messy change.`;
}

export function clusterNarrationPrompt(input: {
  readonly pr: PrDetail;
  readonly cluster: {
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly weight: string;
    readonly buildsOn: ReadonlyArray<string>;
    readonly fileOrder: ReadonlyArray<string>;
  };
  readonly allClusters: ReadonlyArray<{
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly weight: string;
  }>;
  readonly hunkLines: ReadonlyArray<string>;
  readonly earlierHunkLines: ReadonlyArray<string>;
}): string {
  const map = input.allClusters
    .map((cluster) => `${cluster.position}. ${cluster.title} (${cluster.id}, ${cluster.weight})`)
    .join("\n");

  return `${SHARED_PREAMBLE}

## The plan is fixed

The journey has already been decomposed. Do not re-litigate it; write the words for one cluster of it.

${map}

## Your cluster

**${input.cluster.position}. ${input.cluster.title}** — id \`${input.cluster.id}\`, weight ${input.cluster.weight}${
    input.cluster.buildsOn.length > 0 ? `, builds on ${input.cluster.buildsOn.join(", ")}` : ""
  }.

Files, in the order the journey wants them read:
${input.cluster.fileOrder.map((path) => `- ${path}`).join("\n")}

Hunks this cluster homes:
${input.hunkLines.join("\n")}

${
  input.earlierHunkLines.length === 0
    ? "There are no earlier clusters, so nothing can be resurfaced here."
    : `Hunks homed in EARLIER clusters, which you may resurface if this cluster's story needs one on screen:
${input.earlierHunkLines.join("\n")}`
}

Read the diff for these files and the code around them, then write:

- **narrative** — what this step accomplishes, why it sits at this point in the journey, and how it builds on the clusters before it.
- **mapEntry** — the same, compressed to two or three sentences for the Overview map.
- **resurfaced** — optional, and usually empty.
- **hints** — zero to six pieces of scroll-anchored guidance, each anchored to real line numbers in a real file.

Hold to these:

- **Every claim links to its evidence.** Prose that cannot be checked against code does not ship. Only link a \`tl:symbol\` you have actually read in that file.
- **Comprehension, never judgement.** No "this looks wrong", no severity, no suggestions. You are helping someone understand the change, not reviewing it.
- **Anchors must be real.** A hint's \`startLine\`/\`endLine\` must exist in that file at the revision you name. An anchor may cover unchanged lines — ripple context legitimately points at code the diff did not touch.
- **Say what the code does, not what the file is called.** "Registers the guard the router consults before every protected route" beats "changes to router.tsx".`;
}

export function overviewPrompt(input: {
  readonly pr: PrDetail;
  readonly clusters: ReadonlyArray<Cluster>;
}): string {
  const map = input.clusters
    .map(
      (cluster) =>
        `${cluster.position}. **${cluster.title}** (${cluster.weight})\n   ${cluster.mapEntry.markdown}`,
    )
    .join("\n\n");

  return `${SHARED_PREAMBLE}

## The journey is written

${map}

## Your task

Write the Overview — the page every journey opens on. It is a first-class artifact, not a restatement of the pull request's description, and its job is orientation: after reading it, the reviewer should be able to say what the change builds and name its parts, before reading a single diff closely.

Two fields:

- **brief** — a few sentences on what this pull request builds and why it exists, written from your reconstructed understanding of the code.
- **whereToBegin** — a short closing orientation: where to start, and honest guidance about attention.

The map above is rendered separately, so do not repeat it. Say the thing the map cannot: the shape of the change as a whole.

For reference only, the author's own description:

<pr-description>
${truncate(input.pr.body, 2000)}
</pr-description>`;
}

/**
 * The repair turn. Precise, machine-generated violations go back to the same
 * thread — most failures are near-misses, and telling the model exactly what is
 * wrong fixes them far more cheaply than starting over.
 */
export function repairPrompt(input: {
  readonly violations: string;
  readonly round: number;
}): string {
  return `Your previous answer did not satisfy the rules. These are the exact problems found by the checker:

${input.violations}

Fix every one of them and return the complete corrected answer in the same shape. Change only what the problems require — everything not listed above was accepted.${
    input.round > 1
      ? "\n\nThis is the last correction round. If a problem is genuinely impossible to satisfy, prefer an answer that satisfies the coverage rules over one that reads better."
      : ""
  }`;
}

export function hunkLine(seed: SeedHunk): string {
  if (seed.fileKind !== null) {
    return `- ${seed.id} — ${seed.path} (${seed.fileKind} change; no changed lines)`;
  }
  const oldPart =
    seed.oldLines === 0 ? "—" : `${seed.oldStart}–${seed.oldStart + seed.oldLines - 1}`;
  const newPart =
    seed.newLines === 0 ? "—" : `${seed.newStart}–${seed.newStart + seed.newLines - 1}`;
  return `- ${seed.id} — ${seed.path} (old ${oldPart}, new ${newPart})`;
}

function totalAdditions(files: ReadonlyArray<FileChange>): number {
  return files.reduce((sum, file) => sum + file.additions, 0);
}

function totalDeletions(files: ReadonlyArray<FileChange>): number {
  return files.reduce((sum, file) => sum + file.deletions, 0);
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(no description)";
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…(truncated)`;
}
