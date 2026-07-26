/**
 * What the harness is asked to produce, and how its answer is read back.
 *
 * The JSON Schemas are written by hand rather than generated. Two reasons, both
 * practical: providers differ in what they accept (`$ref`, `anyOf`, unions), and
 * a hand-written schema can carry `description` fields — which are the cheapest,
 * highest-leverage part of the whole prompt. The Effect schemas beside them are
 * what actually validate the answer.
 *
 * @module analysis/schemas
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// ── Stage 1: the journey plan ───────────────────────────────────────────────

export const PlanOutput = Schema.Struct({
  clusters: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      weight: Schema.String,
      buildsOn: Schema.Array(Schema.String),
      fileOrder: Schema.Array(Schema.String),
    }),
  ),
  homes: Schema.Array(
    Schema.Struct({
      hunkId: Schema.String,
      cluster: Schema.String,
    }),
  ),
  splits: Schema.Array(
    Schema.Struct({
      seedId: Schema.String,
      parts: Schema.Array(
        Schema.Struct({
          oldStart: Schema.Int,
          oldLines: Schema.Int,
          newStart: Schema.Int,
          newLines: Schema.Int,
          cluster: Schema.String,
        }),
      ),
    }),
  ),
});
export type PlanOutput = typeof PlanOutput.Type;

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["clusters", "homes", "splits"],
  properties: {
    clusters: {
      type: "array",
      description:
        "The clusters, in journey order: foundations before what builds on them, parts before the code that binds the parts together.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "weight", "buildsOn", "fileOrder"],
        properties: {
          id: {
            type: "string",
            description: 'A short unique id you choose, e.g. "c1". Used to home hunks.',
          },
          title: {
            type: "string",
            description:
              "What this step of the work is, in a few words. A reviewer should recognise the step from the title alone. Not a file list.",
          },
          weight: {
            type: "string",
            enum: ["core", "supporting", "mechanical"],
            description:
              "core = the substance of the change; supporting = necessary but derivative (tests, wiring, plumbing); mechanical = churn with no decision content (renames, generated code, lockfiles, formatting). This is guidance about attention, never about quality or risk.",
          },
          buildsOn: {
            type: "array",
            items: { type: "string" },
            description: "Ids of EARLIER clusters this one builds on. May be empty.",
          },
          fileOrder: {
            type: "array",
            items: { type: "string" },
            description:
              "Every file this cluster homes a hunk in, in the order the cluster's story wants them read. Never alphabetical.",
          },
        },
      },
    },
    homes: {
      type: "array",
      description:
        "One entry for every seed hunk you are NOT splitting. Every seed hunk must appear exactly once, here or in splits.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hunkId", "cluster"],
        properties: {
          hunkId: { type: "string", description: 'A seed hunk id from hunks.json, e.g. "h12".' },
          cluster: { type: "string", description: "The id of the cluster this hunk belongs to." },
        },
      },
    },
    splits: {
      type: "array",
      description:
        "Optional. Split a seed hunk only when one contiguous run of changed lines genuinely serves two different concerns. The parts must tile the seed hunk exactly: together they cover every one of its old-side and new-side lines, with none covered twice and none left out. File-level hunks (those with a fileKind) can never be split.",
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
              required: ["oldStart", "oldLines", "newStart", "newLines", "cluster"],
              properties: {
                oldStart: { type: "integer" },
                oldLines: { type: "integer" },
                newStart: { type: "integer" },
                newLines: { type: "integer" },
                cluster: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

// ── Stage 2a: one cluster's words ───────────────────────────────────────────

export const ClusterNarrationOutput = Schema.Struct({
  narrative: Schema.String,
  mapEntry: Schema.String,
  resurfaced: Schema.Array(
    Schema.Struct({
      hunkId: Schema.String,
      note: Schema.String,
    }),
  ),
  hints: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      path: Schema.String,
      side: Schema.String,
      startLine: Schema.Int,
      endLine: Schema.Int,
      body: Schema.String,
    }),
  ),
});
export type ClusterNarrationOutput = typeof ClusterNarrationOutput.Type;

const EVIDENCE_NOTE =
  "Markdown. Link every claim to the code that evidences it with a tl: URI — tl:hunk/h12, tl:file/src/auth/token.ts, or tl:symbol/src/auth/token.ts#issueToken (the symbol must occur literally in that file). Write them as Markdown links, e.g. [the guard](tl:file/src/routes/guards.ts). A tl:symbol link that does not resolve is a validation failure, so only link symbols you have actually seen in the file.";

export const CLUSTER_NARRATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["narrative", "mapEntry", "resurfaced", "hints"],
  properties: {
    narrative: {
      type: "string",
      description: `The prose that leads this cluster's page: what this step accomplishes, why it sits at this point in the journey, and how it builds on the clusters before it. Two to five sentences. ${EVIDENCE_NOTE}`,
    },
    mapEntry: {
      type: "string",
      description: `The same account compressed to two or three sentences for the Overview map. It must agree with the narrative — it is the same story, shorter. ${EVIDENCE_NOTE}`,
    },
    resurfaced: {
      type: "array",
      description:
        "Optional. Hunks homed in an EARLIER cluster that this cluster's story needs on screen to show how the parts connect. Never a hunk homed here. Use sparingly — at most two or three, and only when a cross-cutting perspective genuinely needs it.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hunkId", "note"],
        properties: {
          hunkId: { type: "string" },
          note: {
            type: "string",
            description:
              "Why the journey brought this back here, and what to see in it this time. One or two sentences.",
          },
        },
      },
    },
    hints: {
      type: "array",
      description:
        "Scroll-anchored guidance for a reviewer reading this cluster. Zero to six. Every hint aids comprehension; none may judge quality, flag bugs, or suggest changes.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "path", "side", "startLine", "endLine", "body"],
        properties: {
          kind: {
            type: "string",
            enum: ["connection", "complexity", "ripple", "pattern-echo", "behavior", "resurfacing"],
            description:
              "connection = a cross-file or cross-cluster thread; complexity = a plain-words walkthrough of a genuinely dense region; ripple = a fact from the surrounding codebase the diff cannot show; pattern-echo = this region repeats a shape already seen, so it can be walked quickly; behavior = what the change means, stated where the code shows how; resurfacing = why a revisited hunk is back.",
          },
          path: { type: "string", description: "A file path in the repository." },
          side: {
            type: "string",
            enum: ["old", "new"],
            description:
              'Which revision the lines refer to. Prefer "new"; only anchor to "old" when the point is about removed code.',
          },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
          body: { type: "string", description: `One to three sentences. ${EVIDENCE_NOTE}` },
        },
      },
    },
  },
};

// ── Stage 2b: the Overview ──────────────────────────────────────────────────

export const OverviewOutput = Schema.Struct({
  brief: Schema.String,
  whereToBegin: Schema.String,
});
export type OverviewOutput = typeof OverviewOutput.Type;

export const OVERVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["brief", "whereToBegin"],
  properties: {
    brief: {
      type: "string",
      description: `A few sentences: what this pull request builds and why it exists, written from your reconstructed understanding of the code — never a paraphrase of the pull request's own description. ${EVIDENCE_NOTE}`,
    },
    whereToBegin: {
      type: "string",
      description: `A short closing orientation: the recommended entry point (normally cluster 1) and honest guidance about where attention is worth spending — for example which mechanical clusters can be walked quickly. Guidance about attention, never a verdict on the code. ${EVIDENCE_NOTE}`,
    },
  },
};

const decodePlan = Schema.decodeUnknownEffect(PlanOutput);
const decodeClusterNarration = Schema.decodeUnknownEffect(ClusterNarrationOutput);
const decodeOverview = Schema.decodeUnknownEffect(OverviewOutput);

/**
 * Read a harness answer, tolerantly.
 *
 * A model that returns the right shape wrapped in one extra key, or as a JSON
 * string, has still done the work — unwrapping that is cheaper than a repair
 * round trip. A model that returned something else entirely fails here and
 * climbs the ladder.
 */
export const readPlan = (output: unknown) => decodePlan(unwrap(output, "clusters"));
export const readClusterNarration = (output: unknown) =>
  decodeClusterNarration(unwrap(output, "narrative"));
export const readOverview = (output: unknown) => decodeOverview(unwrap(output, "brief"));

function unwrap(output: unknown, expectedKey: string): unknown {
  const parsed = typeof output === "string" ? tryParse(output) : output;
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const record = parsed as Record<string, unknown>;
  if (expectedKey in record) return record;
  const values = Object.values(record);
  if (values.length === 1) return unwrap(values[0], expectedKey);
  return record;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Convenience for logging what a decode rejected without dumping the payload. */
export const describeDecodeFailure = (cause: unknown): Effect.Effect<string> =>
  Effect.succeed(String((cause as { message?: string }).message ?? cause).slice(0, 600));
