/**
 * The prompts and output schemas for the two analysis stages.
 *
 * Three principles govern everything here.
 *
 * **The diff does not travel in the prompt.** A 40,000-line diff is written to
 * disk and the instructions point at it by path, so prompt size stays flat no
 * matter how large the pull request is. The agent reads the way agents are good
 * at reading: navigating files in a worktree.
 *
 * **The schema does the constraining, the prose does the explaining.** Anything
 * that can be a structural constraint is one — the output schema is the contract,
 * not the paragraph asking nicely.
 *
 * One hard constraint the schemas obey: **every property must appear in
 * `required`.** OpenAI's structured-output validator rejects a schema with any
 * optional key outright (`'required' is required to be supplied and to be an
 * array including every key in properties`), and the rejection arrives as a 400
 * that costs a whole stage. Optionality is therefore expressed as "an empty
 * array", never as an absent key.
 *
 * **The agent is asked for judgement, never for compliance with a guarantee.**
 * Coverage is not something the model is told to preserve; it is something the
 * validator checks and the materializer makes structurally impossible to break.
 * So the prompt spends its words on what only a reader can supply: what the
 * change *is*, and the order that makes it comprehensible.
 *
 * @module analysis/prompts
 */
import type { Cluster, FileChange, Weight } from "@app/contracts";
import type { SeedHunk } from "@app/journey/hunks";

/** Where the agent finds its inputs, relative to its worktree. */
export const AGENT_INPUT_DIR = ".throughline";

export const AGENT_FILES = {
  patch: `${AGENT_INPUT_DIR}/diff.patch`,
  hunks: `${AGENT_INPUT_DIR}/hunks.json`,
  files: `${AGENT_INPUT_DIR}/files.json`,
} as const;

// ── Stage 1: the journey plan ───────────────────────────────────────────────

export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["clusters", "assignments", "splits"],
  properties: {
    clusters: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "weight", "buildsOn", "fileOrder"],
        properties: {
          id: { type: "string", description: "c1, c2, c3 … in journey order" },
          title: {
            type: "string",
            description: "A short noun phrase naming the step. No numbering.",
          },
          weight: { type: "string", enum: ["core", "supporting", "mechanical"] },
          buildsOn: {
            type: "array",
            items: { type: "string" },
            description: "Ids of EARLIER clusters this one builds on. May be empty.",
          },
          fileOrder: {
            type: "array",
            items: { type: "string" },
            description:
              "Every file this cluster homes hunks in, in the order the story wants them read. Never alphabetical.",
          },
        },
      },
    },
    assignments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hunkId", "home"],
        properties: {
          hunkId: { type: "string" },
          home: { type: "string" },
        },
      },
    },
    splits: {
      type: "array",
      description:
        "Split a seed hunk that mixes concerns into consecutive parts. Give each part's line counts; Throughline computes where each part starts. Use an empty array when no hunk needs splitting, which is the common case.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["seedId", "parts"],
        properties: {
          seedId: { type: "string" },
          parts: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["oldLines", "newLines", "home"],
              properties: {
                oldLines: { type: "integer", minimum: 0 },
                newLines: { type: "integer", minimum: 0 },
                home: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

export interface PlanPromptInput {
  readonly prTitle: string;
  readonly prBody: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly files: ReadonlyArray<FileChange>;
  readonly seeds: ReadonlyArray<SeedHunk>;
  readonly additions: number;
  readonly deletions: number;
}

export function planPrompt(input: PlanPromptInput): string {
  const fileCount = input.files.length;
  return `You are reconstructing the development journey behind a pull request.

Throughline turns a large pull request into an ordered story of intentional steps, so a reviewer can follow the development journey instead of scrolling a flat list of file diffs. Your job in this step is the **decomposition**: split the change into clusters, order them for comprehension, and assign every changed hunk to exactly one cluster.

## The change

- Pull request: ${JSON.stringify(input.prTitle)}
- Base branch: ${input.baseRef}, head commit: ${input.headSha}
- ${fileCount} changed file${fileCount === 1 ? "" : "s"}, +${input.additions} −${input.deletions}, ${input.seeds.length} hunks
${input.prBody.trim().length === 0 ? "" : `\nThe author's own description (context only — never restate it as your analysis):\n\n${fence(truncate(input.prBody, 4000))}\n`}
## Your inputs

You are in a checkout of the head commit. Read whatever you need — this is the real codebase, and the code *around* the change is what tells you whether a piece is new foundation or a modification of something load-bearing.

- \`${AGENT_FILES.patch}\` — the complete diff, base..head.
- \`${AGENT_FILES.hunks}\` — every hunk with its id, file, and line ranges. **These ids are the only ids that exist.** A hunk with a \`fileKind\` is a whole-file change (binary, rename, mode) and cannot be split.
- \`${AGENT_FILES.files}\` — every changed file with its change kind and rename mapping.

Start by reading \`${AGENT_FILES.files}\` and \`${AGENT_FILES.hunks}\`, then the patch, then go read the surrounding code for the parts that matter.

## What a good decomposition is

A cluster is one describable step of the work: a set of hunks, possibly spanning many files, that together accomplish a single piece of it. Aim for the decomposition a thoughtful developer would describe if asked "walk me through this change".

- **Cohesion over convenience.** Files in the same directory are not automatically one step; a step is a unit of *intent*. Three unrelated changes in one directory are three clusters.
- **Order for comprehension.** Foundations before the things built on them; the parts before the code that binds the parts together. The order is not chronological and does not have to be — it is the order that makes the change understandable.
- **Reviewable size.** A cluster a reviewer cannot hold in their head is too big; a cluster of one trivial hunk is usually noise. Let the change's real structure decide the count — typically 3–8 clusters, but a genuinely larger change can want more.
- **Every hunk gets exactly one home.** Assign all ${input.seeds.length} of them. If a hunk genuinely belongs nowhere interesting, put it in an honest catch-all cluster (generated code, formatting churn, lockfiles) with weight \`mechanical\` — do not leave it out.

## Weight

Exactly one per cluster. This is guidance about **where attention should go**, never a judgement about quality, risk, or correctness:

- \`core\` — the substance of the change; read closely.
- \`supporting\` — necessary but derivative: tests, wiring, plumbing that follows from the core.
- \`mechanical\` — churn with no decision content: renames, generated code, lockfiles, formatting.

## Splitting a hunk

Only when one hunk genuinely mixes two concerns. Give the parts in order with their line counts; Throughline computes the start lines, so you cannot get the arithmetic wrong. The parts' \`oldLines\` must sum to the seed's \`oldLines\` and the same for \`newLines\`. Never split a hunk that has a \`fileKind\`. Most changes need no splits at all — return an empty array if so.

## Output

Return only the JSON your schema describes. Ids must be \`c1\`, \`c2\`, … in journey order, and \`buildsOn\` may only name clusters that come earlier.`;
}

// ── Stage 2: the words ──────────────────────────────────────────────────────

export const OVERVIEW_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "whereToBegin", "attention"],
  properties: {
    brief: {
      type: "string",
      description:
        "A few sentences of Markdown: what this PR builds and why it exists, written from the code.",
    },
    whereToBegin: {
      type: "string",
      description:
        "A short closing orientation in Markdown: where to start and how to budget attention.",
    },
    attention: {
      type: "array",
      description: "One phrase per cluster, in journey order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["clusterId", "phrase"],
        properties: {
          clusterId: { type: "string" },
          phrase: {
            type: "string",
            description: "Two or three words: 'read closely', 'walk quickly', 'one file matters'.",
          },
        },
      },
    },
  },
};

export const CLUSTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "mapEntry", "resurfaced", "hints"],
  properties: {
    narrative: {
      type: "string",
      description:
        "Markdown. What this step accomplishes, why it sits here, how it builds on earlier clusters.",
    },
    mapEntry: {
      type: "string",
      description: "Two to three sentences: the same account, compressed for the Overview map.",
    },
    resurfaced: {
      type: "array",
      description:
        "Hunks homed in EARLIER clusters worth revisiting here to show a connection. Use an empty array when there is nothing worth revisiting, which is the common case.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hunkId", "note"],
        properties: {
          hunkId: { type: "string" },
          note: {
            type: "string",
            description: "Why the journey brings it back here, and what to see in it this time.",
          },
        },
      },
    },
    hints: {
      type: "array",
      description:
        "Scroll-anchored guidance beside specific regions of code. Use an empty array when the code needs none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "side", "startLine", "endLine", "body"],
        properties: {
          kind: {
            type: "string",
            enum: ["connection", "complexity", "ripple", "pattern-echo", "behavior", "resurfacing"],
          },
          path: { type: "string" },
          side: { type: "string", enum: ["old", "new"] },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          body: { type: "string", description: "One or two sentences of Markdown." },
        },
      },
    },
  },
};

const EVIDENCE_RULES = `## Evidence links

Every claim links to what proves it. Inside Markdown, use these link targets:

- \`tl:hunk/h12\` — a hunk in this journey.
- \`tl:file/src/auth/token.ts\` — a file at the head revision.
- \`tl:symbol/src/auth/token.ts#issueToken\` — a symbol. This resolves only if the text \`issueToken\` literally occurs in that file at the head revision, so quote the identifier exactly as it appears.

Write them as ordinary Markdown links — \`[the session store](tl:file/src/auth/session.ts)\` — or bare in prose. A link that does not resolve is stripped, and the loss is recorded, so do not guess at paths or spellings.

Prose that cannot be checked against code is not allowed to exist in this product. Anchor your claims.`;

const VOICE_RULES = `## Voice

- Explain, never judge. You are describing what the change *is* and how to read it — not whether it is good, risky, or correct. No severity, no concerns, no recommendations about the code.
- Write for an engineer who will read every line themselves. Your prose is a lens over the diff, never a replacement for it.
- Be specific and short. Name the real modules, functions, and files. Avoid "various", "several improvements", "refactoring".
- Never restate the author's own PR description as your analysis.`;

export interface OverviewPromptInput {
  readonly prTitle: string;
  readonly clusters: ReadonlyArray<{
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly weight: Weight;
    readonly filesTouched: number;
    readonly hunksHomed: number;
  }>;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export function overviewPrompt(input: OverviewPromptInput): string {
  return `Write the Overview for the journey you just decomposed.

The Overview is where every reading of this pull request starts. Its job is orientation: after reading it, the reviewer should be able to say what the change builds and name its parts, before reading a single diff closely. It is a good map, not an essay — density comes from structure, not from length.

## The journey you produced

${input.clusters
  .map(
    (cluster) =>
      `${cluster.position}. **${cluster.title}** — ${cluster.weight}, ${cluster.filesTouched} file${cluster.filesTouched === 1 ? "" : "s"}, ${cluster.hunksHomed} hunk${cluster.hunksHomed === 1 ? "" : "s"} (\`${cluster.id}\`)`,
  )
  .join("\n")}

The whole change: ${input.fileCount} files, +${input.additions} −${input.deletions}.

## What to write

**\`brief\`** — a few sentences on what this PR builds and why it exists, written from your reconstructed understanding of the code. Name the real parts. This is the sentence a reviewer repeats to a colleague.

**\`whereToBegin\`** — a short closing orientation: the recommended entry point (normally cluster 1), and honest guidance about attention — which clusters reward close reading and which can be walked quickly. Guidance about attention, never a verdict on quality.

**\`attention\`** — one two-or-three-word phrase per cluster, in order, for the strip under \`whereToBegin\`: "read closely", "one file matters", "walk quickly", "minutes".

Refer to clusters by their number in prose ("the boundary between 1 and 2 is the architecture of the feature").

${EVIDENCE_RULES}

${VOICE_RULES}`;
}

export interface ClusterPromptInput {
  readonly cluster: {
    readonly id: string;
    readonly position: number;
    readonly title: string;
    readonly weight: Weight;
    readonly fileOrder: ReadonlyArray<string>;
  };
  readonly total: number;
  readonly hunks: ReadonlyArray<{
    readonly id: string;
    readonly path: string;
    readonly newStart: number;
    readonly newLines: number;
    readonly oldStart: number;
    readonly oldLines: number;
    readonly fileKind: string | undefined;
  }>;
  readonly earlier: ReadonlyArray<Pick<Cluster, "id" | "position" | "title">>;
  readonly earlierHunkIds: ReadonlyArray<string>;
}

export function clusterPrompt(input: ClusterPromptInput): string {
  const { cluster } = input;
  return `Write the narrative for cluster ${cluster.position} of ${input.total}: **${cluster.title}** (\`${cluster.id}\`, weight \`${cluster.weight}\`).

The plan is fixed. Do not re-decompose anything — describe what this step is.

## This cluster's hunks

${input.hunks
  .map(
    (hunk) =>
      `- \`${hunk.id}\` — ${hunk.path}${
        hunk.fileKind === undefined
          ? ` (new ${hunk.newLines === 0 ? "—" : `${hunk.newStart}–${hunk.newStart + hunk.newLines - 1}`}, old ${hunk.oldLines === 0 ? "—" : `${hunk.oldStart}–${hunk.oldStart + hunk.oldLines - 1}`})`
          : ` (${hunk.fileKind} change)`
      }`,
  )
  .join("\n")}

Files, in the order the cluster reads them: ${cluster.fileOrder.map((path) => `\`${path}\``).join(", ")}

${
  input.earlier.length === 0
    ? "This is the first cluster; nothing comes before it."
    : `## Clusters the reviewer has already read

${input.earlier.map((entry) => `${entry.position}. ${entry.title} (\`${entry.id}\`)`).join("\n")}`
}

## What to write

**\`narrative\`** — leads the cluster page, so it is the first thing the reviewer reads. State what this step accomplishes, why it sits at this point in the journey, and how it builds on the clusters before it. Two short paragraphs at most.

**\`mapEntry\`** — the same account compressed to two or three sentences, for the Overview map. The map and the territory must agree.

**\`resurfaced\`** — usually an empty array. Some understanding is cross-cutting: how two earlier parts *interact* is not a fact about either alone. If seeing a specific earlier hunk beside this code would show a connection the reviewer would otherwise miss, name it and say what to see in it this time. Only hunks homed in earlier clusters qualify${input.earlierHunkIds.length === 0 ? " (there are none yet)" : `: ${input.earlierHunkIds.slice(0, 40).join(", ")}${input.earlierHunkIds.length > 40 ? ", …" : ""}`}.

**\`hints\`** — optional, zero to about four. Each is one thing a thoughtful colleague would murmur while reading over the reviewer's shoulder, anchored to the exact lines it is about:

- \`connection\` — "this registration implements the interface added in cluster 1; its other half is in AuthService.ts".
- \`complexity\` — plain words for a genuinely dense region: the invariant a loop maintains, what a gnarly type actually says, the order things happen in an async flow.
- \`ripple\` — a fact from the surrounding codebase the diff cannot show: "this function has twelve call sites; this change alters the behaviour of two".
- \`pattern-echo\` — "the same transformation as the previous three files", so the reviewer knows they can move quickly.
- \`behavior\` — what the change *means*: "errors on this path used to be swallowed; they now surface as typed failures".

Anchor lines are 1-based line numbers in the file at the revision you name (\`new\` for the head revision, \`old\` for the base). A hint may point at unchanged lines — ripple context legitimately does. A hint that does not fit its file is dropped, so check your numbers against the file you read.

${EVIDENCE_RULES}

${VOICE_RULES}`;
}

// ── The repair turn ─────────────────────────────────────────────────────────

/**
 * The correction turn. Violations arrive verbatim from the pure validators, so
 * the feedback is precise and machine-generated rather than a vague "try again"
 * — which is why most repairs land on the first round.
 */
export function repairPrompt(violations: string, stage: "plan" | "narration"): string {
  return `Your previous answer did not satisfy Throughline's ${stage === "plan" ? "partition" : "narration"} rules. Every item below was produced by a checker, not by a person, so each one is exact:

${violations}

Fix exactly these problems and return the complete JSON again — not a patch, the whole answer. Keep everything that was already correct.`;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… (truncated)`;
}

function fence(text: string): string {
  return ["```", text, "```"].join("\n");
}
