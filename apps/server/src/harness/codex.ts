/**
 * The Codex adapter.
 *
 * Read-only is enforced by the sandbox (`sandboxMode: "read-only"`), approvals
 * are off (`approvalPolicy: "never"`), and network access is denied — the agent
 * reads the worktree and nothing else.
 *
 * Two facts about this SDK shape the code and are easy to get wrong:
 *
 * - **`Turn.finalResponse` is a JSON *string*, and a turn can emit several
 *   `agent_message` items, all schema-shaped.** The model's preamble comes back
 *   looking like valid output. The *last* one is the answer; taking the first
 *   silently analyses a sentence instead of a diff.
 * - **There is no file-read event.** `ThreadItem` has no read variant, so reads
 *   surface only as `command_execution` shell strings. Our activity reporting is
 *   therefore honestly coarser for Codex than for Claude: commands, not files.
 *
 * @module harness/codex
 */
import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

import type { HarnessKind } from "@app/contracts";

import { runProcess } from "../process/run.ts";
import {
  HarnessOutputError,
  HarnessRunFailedError,
  HarnessUnavailableError,
  type HarnessAdapter,
  type HarnessSession,
  type HarnessProbe,
  type HarnessSessionOptions,
  type HarnessUsage,
} from "./model.ts";

const KIND: HarnessKind = "codex";

/** Extracts the read target from the shell commands Codex actually runs. */
const READ_COMMAND = /\b(?:cat|bat|head|tail|sed|less)\b[^|;]*?([\w./@-]+\.[\w]+)/;
const SEARCH_COMMAND = /\b(?:rg|grep|ag|ack|find|fd|ls)\b/;

function describeCommand(command: string): string {
  const collapsed = command.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

/**
 * The last `agent_message` is the answer. Anything before it is a preamble the
 * model shaped like the schema, which JSON.parse would happily accept.
 */
function parseAnswer(raw: string, kind: HarnessKind): Effect.Effect<unknown, HarnessOutputError> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.fail(
      new HarnessOutputError({ kind, detail: "Codex returned an empty response.", raw }),
    );
  }
  return Effect.try({
    try: () => JSON.parse(trimmed) as unknown,
    catch: () =>
      new HarnessOutputError({
        kind,
        detail: "Codex's response was not the JSON its output schema required.",
        raw: trimmed.slice(0, 4000),
      }),
  });
}

const probe: HarnessAdapter["probe"] = Effect.gen(function* () {
  const version = yield* runProcess("codex", ["--version"], { timeout: "15 seconds" }).pipe(
    Effect.map((result) =>
      result.exitCode === 0 ? (result.stdout.trim().split("\n")[0] ?? null) : null,
    ),
    Effect.orElseSucceed(() => null),
  );
  if (version === null) {
    return {
      installed: false,
      version: null,
      auth: "missing" as const,
      detail:
        "Codex is not installed. Install the Codex CLI (`npm i -g @openai/codex`) and run `codex login`.",
    };
  }
  // The SDK has no auth API at all; `codex login status` is the only probe, and
  // it answers with an exit code rather than JSON — so read the code, not the text.
  // `codex login status` answers with an exit code, not JSON — read the code.
  const loggedIn = yield* runProcess("codex", ["login", "status"], { timeout: "20 seconds" }).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );
  return {
    installed: true,
    version,
    auth: loggedIn ? ("authenticated" as const) : ("unauthenticated" as const),
    detail: loggedIn ? null : "Codex is installed but not signed in. Run `codex login`.",
  };
});

const open = (
  options: HarnessSessionOptions,
): Effect.Effect<HarnessSession, HarnessUnavailableError, Scope.Scope> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    // Scope-owned lifecycle: closing the scope aborts the turn, which kills the
    // subprocess. Cancellation needs no separate plumbing.
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

    const usage = yield* Ref.make<HarnessUsage>({});
    const transcript = yield* Ref.make<string[]>([]);

    const thread: Thread = yield* Effect.try({
      try: () =>
        new Codex().startThread({
          workingDirectory: options.worktree,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          skipGitRepoCheck: true,
          networkAccessEnabled: false,
          webSearchMode: "disabled",
        }),
      catch: (cause) =>
        new HarnessUnavailableError({
          kind: KIND,
          detail: `Codex could not be started: ${String(cause)}`,
        }),
    });

    const record = (line: string) => Ref.update(transcript, (lines) => [...lines, line]);

    /**
     * One turn, streamed. Streaming (rather than `run`) is deliberate twice
     * over: it is the only way to observe activity, and `run()` throws away the
     * structured failure on `turn.failed`.
     */
    const turn = (prompt: string) =>
      Effect.gen(function* () {
        const started = yield* Effect.tryPromise({
          try: () =>
            thread.runStreamed(prompt, {
              outputSchema: options.outputSchema,
              signal: controller.signal,
            }),
          catch: (cause) => toRunFailure(cause),
        });

        const messages: string[] = [];
        yield* Effect.tryPromise({
          try: async () => {
            for await (const event of started.events as AsyncGenerator<ThreadEvent>) {
              handleEvent(event, messages, options, record);
              if (event.type === "turn.completed") {
                await Effect.runPromise(
                  Ref.update(usage, (current) => ({
                    inputTokens: (current.inputTokens ?? 0) + event.usage.input_tokens,
                    outputTokens: (current.outputTokens ?? 0) + event.usage.output_tokens,
                    cachedInputTokens:
                      (current.cachedInputTokens ?? 0) + event.usage.cached_input_tokens,
                  })),
                );
              }
              if (event.type === "turn.failed") {
                throw new Error(event.error.message);
              }
              if (event.type === "error") {
                throw new Error(event.message);
              }
            }
          },
          catch: (cause) => toRunFailure(cause),
        });

        const answer = messages.at(-1) ?? "";
        return yield* parseAnswer(answer, KIND);
      });

    return {
      kind: KIND,
      model: undefined,
      ask: (prompt) => turn(prompt).pipe(Effect.withSpan("harness.codex.ask")),
      correct: (prompt) => turn(prompt).pipe(Effect.withSpan("harness.codex.correct")),
      usage: Ref.get(usage),
      transcript: Ref.get(transcript).pipe(Effect.map((lines) => lines.join("\n"))),
    } satisfies HarnessSession;
  });

/**
 * `item.completed` with `type: "error"` is **not** terminal — a skills or
 * context-budget warning arrives that way. Only `turn.failed` and the top-level
 * `error` event are fatal, and those are handled by the caller above.
 */
function handleEvent(
  event: ThreadEvent,
  messages: string[],
  options: HarnessSessionOptions,
  record: (line: string) => Effect.Effect<void>,
): void {
  switch (event.type) {
    case "item.started":
      if (event.item.type === "command_execution") {
        const described = describeCommand(event.item.command);
        const read = READ_COMMAND.exec(event.item.command);
        if (read?.[1] !== undefined) {
          options.onActivity({ kind: "read", path: read[1] });
        } else if (SEARCH_COMMAND.test(event.item.command)) {
          options.onActivity({ kind: "search", detail: described });
        } else {
          options.onActivity({ kind: "command", detail: described });
        }
      }
      break;
    case "item.completed":
      if (event.item.type === "agent_message") {
        messages.push(event.item.text);
      }
      if (event.item.type === "reasoning") {
        options.onActivity({ kind: "step", detail: firstSentence(event.item.text) });
      }
      if (event.item.type === "error") {
        void Effect.runPromise(record(`[non-fatal] ${event.item.message}`));
      }
      break;
    default:
      break;
  }
  void Effect.runPromise(record(JSON.stringify(event)));
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const stop = cleaned.search(/[.!?]\s/);
  const sentence = stop === -1 ? cleaned : cleaned.slice(0, stop + 1);
  return sentence.length > 140 ? `${sentence.slice(0, 137)}…` : sentence;
}

function toRunFailure(cause: unknown): HarnessRunFailedError {
  const message = cause instanceof Error ? cause.message : String(cause);
  // Codex only discovers an expired login after a network round trip, and
  // reports it as a bare 401 — translate it into something actionable.
  const detail = /401|unauthor/i.test(message)
    ? "Codex rejected the request as unauthenticated. Run `codex login` and retry."
    : message;
  return new HarnessRunFailedError({ kind: KIND, detail });
}

export const codexAdapter: HarnessAdapter = {
  kind: KIND,
  label: "Codex",
  probe,
  open,
};
