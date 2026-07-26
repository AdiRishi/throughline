/**
 * The `AnalysisHarness` seam.
 *
 * Throughline ships no model. Analysis runs on the reviewer's **own** local
 * agent harnesses, riding their existing logins. The interface here is
 * deliberately tiny — detect, run-with-schema, cancel-via-scope — because
 * everything harness-specific (subprocess supervision, protocol, streaming,
 * auth) must be implementation behind it. Adding a harness never touches the
 * pipeline.
 *
 * One refinement over the sketch in the technical docs: `run` is expressed as a
 * short-lived **session** rather than a single call, because the pipeline's
 * repair ladder needs a *correction turn on the same thread*. Both SDKs support
 * resuming a thread, so the seam exposes it rather than forcing the pipeline to
 * re-establish context on every rung.
 *
 * @module harness/model
 */
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { HarnessKind } from "@app/contracts";

/**
 * What the transition UI renders. Every event here is *observed* — derived from
 * the harness's own event stream — never invented. Kinds map onto what the two
 * SDKs actually report: Claude emits tool calls (so reads and searches are
 * visible); Codex reports shell commands only, so its activity is honestly
 * coarser.
 */
export type HarnessActivity =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "search"; readonly detail: string }
  | { readonly kind: "command"; readonly detail: string }
  | { readonly kind: "step"; readonly detail: string };

export interface HarnessUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
}

/** A harness refused to start: not installed, not authenticated, no such kind. */
export class HarnessUnavailableError extends Data.TaggedError("HarnessUnavailableError")<{
  readonly kind: HarnessKind | null;
  readonly detail: string;
}> {}

/**
 * The harness ran and failed *operationally* — it crashed, the login expired,
 * the process died. This is never an analytical failure: "too tangled to
 * decompose" is not an outcome the pipeline accepts from a model, and it is not
 * representable here either.
 */
export class HarnessRunFailedError extends Data.TaggedError("HarnessRunFailedError")<{
  readonly kind: HarnessKind;
  readonly detail: string;
}> {}

/** The harness returned something that was not the JSON the schema demanded. */
export class HarnessOutputError extends Data.TaggedError("HarnessOutputError")<{
  readonly kind: HarnessKind;
  readonly detail: string;
  readonly raw: string;
}> {}

export type HarnessError = HarnessUnavailableError | HarnessRunFailedError | HarnessOutputError;

/**
 * One structured-output conversation. `ask` starts it; `correct` continues the
 * *same* thread, which is what makes the repair loop cheap — the agent already
 * has the diff in context.
 */
export interface HarnessSession {
  readonly kind: HarnessKind;
  readonly model: string | undefined;
  /** The first turn. Returns the parsed JSON the schema constrained. */
  readonly ask: (prompt: string) => Effect.Effect<unknown, HarnessError>;
  /** A correction turn on the same thread, with the violation list. */
  readonly correct: (prompt: string) => Effect.Effect<unknown, HarnessError>;
  /** Tokens observed so far, summed across turns. Honesty, not UI. */
  readonly usage: Effect.Effect<HarnessUsage>;
  /** The harness's own transcript, for the run directory's honesty trail. */
  readonly transcript: Effect.Effect<string>;
}

/** What a detection probe reports. */
export interface HarnessProbe {
  readonly installed: boolean;
  readonly version: string | null;
  readonly auth: "authenticated" | "unauthenticated" | "unknown" | "missing";
  readonly detail: string | null;
}

export interface HarnessSessionOptions {
  /** The agent's whole world: an absolute path to the run's worktree. */
  readonly worktree: string;
  /** JSON Schema the result must satisfy. */
  readonly outputSchema: Record<string, unknown>;
  /** Observed progress, pushed as it happens. */
  readonly onActivity: (activity: HarnessActivity) => void;
  /** A short label for the transcript file (`plan`, `narrate-c3`). */
  readonly label: string;
}

/**
 * Read-only is enforced, not requested: Codex runs under
 * `sandboxMode: "read-only"`; Claude gets a read-only tool allowlist with no
 * shell and no write tools. A harness that cannot enforce read-only cannot be a
 * v1 adapter — which is why this flag is part of the adapter contract rather
 * than a caller's option.
 */
export interface HarnessAdapter {
  readonly kind: HarnessKind;
  readonly label: string;
  /** Install + auth state, cheap enough to run on every settings visit. */
  readonly probe: Effect.Effect<HarnessProbe, never, ChildProcessSpawner.ChildProcessSpawner>;
  /**
   * Open a session. Closing the enclosing scope kills the subprocess — which is
   * how ingestion cancellation reaches the agent. Only *unavailability* can fail
   * an open; a run that starts and then breaks fails through the session.
   */
  readonly open: (
    options: HarnessSessionOptions,
  ) => Effect.Effect<HarnessSession, HarnessUnavailableError, Scope.Scope>;
}
