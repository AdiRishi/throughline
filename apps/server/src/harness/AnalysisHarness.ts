/**
 * The seam the reviewer's own agent harnesses plug into.
 *
 * Throughline ships no model. Analysis runs on the reviewer's local harnesses,
 * riding their existing logins. The whole interface is: detect, open a session
 * in a worktree, ask for structured output, cancel by closing the scope.
 * Everything harness-specific — subprocess supervision, protocol, streaming,
 * auth — lives behind it, which is what lets a third adapter land without the
 * pipeline noticing.
 *
 * Read-only is enforced, not requested: Codex runs under `sandboxMode:
 * "read-only"`, Claude under a read-only tool allowlist with no shell. A
 * harness that cannot enforce read-only cannot be a v1 adapter.
 *
 * @module harness/AnalysisHarness
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { HarnessKind, HarnessStatus } from "@app/contracts";

import type { Runner } from "../process/Subprocess.ts";

/** An operational fault of the harness — never an analytical verdict. */
export class HarnessError extends Schema.TaggedErrorClass<HarnessError>()("HarnessError", {
  kind: Schema.String,
  reason: Schema.Literals(["unavailable", "unauthenticated", "crashed", "no-output", "cancelled"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `${this.kind} harness ${this.reason}: ${this.detail}`;
  }
}

/**
 * One observed action, normalized across harnesses.
 *
 * The transition UI's counters are derived from these and nothing else, which
 * is what makes the narration honest by construction rather than by intention.
 */
export interface HarnessEvent {
  readonly verb: "read" | "search" | "run" | "think" | "say" | "note";
  /** Human-readable, already trimmed for display. */
  readonly detail: string;
  /** Set when the action names a file in the worktree. */
  readonly path: string | null;
  /** Set when the action searched for something. */
  readonly pattern: string | null;
}

export interface HarnessAsk {
  readonly prompt: string;
  /** JSON Schema the result must satisfy. */
  readonly outputSchema: Record<string, unknown>;
  /**
   * Called synchronously as actions are observed. Deliberately a plain
   * function rather than an Effect: events arrive from inside an SDK's async
   * iterator, and running an Effect per event there would mean an escape from
   * the runtime on the hottest path in the pipeline. Callers buffer and
   * publish on their own schedule, which also coalesces the feed for the UI.
   */
  readonly onEvent: (event: HarnessEvent) => void;
}

export interface HarnessAnswer {
  /** The parsed structured output. Validation against the schema is the caller's. */
  readonly output: unknown;
  readonly model: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/**
 * A conversation with one harness, in one worktree.
 *
 * Repair turns are additional `ask`s on the same session: both SDKs resume
 * threads, so a correction costs one turn rather than a whole re-read of the
 * diff.
 */
export interface HarnessSession {
  readonly ask: (input: HarnessAsk) => Effect.Effect<HarnessAnswer, HarnessError>;
}

export interface HarnessAdapter {
  readonly kind: HarnessKind;
  readonly label: string;
  readonly detect: Effect.Effect<HarnessStatus>;
  /** Scoped: closing the scope cancels any in-flight turn and kills the child. */
  readonly session: (input: {
    readonly worktree: string;
    readonly label: string;
  }) => Effect.Effect<HarnessSession, HarnessError, never>;
}

export class AnalysisHarness extends Context.Service<
  AnalysisHarness,
  {
    readonly adapters: ReadonlyArray<HarnessAdapter>;
    readonly statuses: Effect.Effect<ReadonlyArray<HarnessStatus>>;
    /**
     * The reviewer's explicit choice if it is usable, else the first
     * authenticated adapter in preference order. Null when nothing is usable —
     * a door-level parked state, like a signed-out `gh`.
     */
    readonly select: (preferred: HarnessKind | null) => Effect.Effect<HarnessAdapter | null>;
  }
>()("@app/server/harness/AnalysisHarness") {}

/** Preference order when the reviewer has not chosen: Codex, then Claude. */
const PREFERENCE: ReadonlyArray<HarnessKind> = ["codex", "claude"];

export const makeWith = (adapters: ReadonlyArray<HarnessAdapter>) =>
  Effect.sync(() =>
    AnalysisHarness.of({
      adapters,
      statuses: Effect.forEach(adapters, (adapter) => adapter.detect, { concurrency: 2 }),
      select: (preferred) =>
        Effect.gen(function* () {
          const statuses = yield* Effect.forEach(adapters, (adapter) => adapter.detect, {
            concurrency: 2,
          });
          const usable = (kind: HarnessKind) => {
            const status = statuses.find((entry) => entry.kind === kind);
            // "unknown" is honest — some harnesses only reveal auth by running.
            // Treating it as usable is right: the alternative is refusing to
            // try a harness that would have worked.
            return status !== undefined && status.installed && status.auth !== "unauthenticated";
          };

          if (preferred !== null && usable(preferred)) {
            return adapters.find((adapter) => adapter.kind === preferred) ?? null;
          }
          for (const kind of PREFERENCE) {
            if (usable(kind)) return adapters.find((adapter) => adapter.kind === kind) ?? null;
          }
          return null;
        }),
    }),
  );

export const layerWith =
  (
    build: (runner: Runner) => ReadonlyArray<HarnessAdapter>,
  ): ((runner: Runner) => Layer.Layer<AnalysisHarness>) =>
  (runner) =>
    Layer.effect(AnalysisHarness, makeWith(build(runner)));

/** Trim a value to something a single line of UI can hold without wrapping. */
export function summarize(value: string, limit = 120): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Worktree-relative, so the activity feed reads like the project, not the disk. */
export function relativize(worktree: string, filePath: string): string {
  if (!filePath.startsWith(worktree)) return filePath;
  return filePath.slice(worktree.length).replace(/^[/\\]+/u, "");
}
