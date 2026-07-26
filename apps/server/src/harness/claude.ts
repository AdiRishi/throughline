/**
 * The Claude adapter.
 *
 * Read-only is enforced by a tool allowlist, not by a sandbox flag: the SDK's
 * own `sandbox` option does *not* restrict the filesystem, so the enforcement
 * that matters is `tools` + `allowedTools` + `disallowedTools` with no `Bash`,
 * no `Write`, no `Edit`.
 *
 * Two non-obvious requirements:
 *
 * - **`settingSources: []` alone does not isolate the session.** Without
 *   `strictMcpConfig: true` the reviewer's own MCP servers stay live inside a
 *   supposedly read-only analysis. Both are set.
 * - **A correction turn needs streaming-input mode.** A `string` prompt gets one
 *   turn and no control methods, so the prompt is an async generator that parks
 *   on a promise between turns. That is what lets the repair ladder come back to
 *   a thread that already has the diff in context.
 *
 * @module harness/claude
 */
import {
  AbortError,
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
  type HarnessActivity,
  type HarnessSession,
  type HarnessProbe,
  type HarnessSessionOptions,
  type HarnessUsage,
} from "./model.ts";

const KIND: HarnessKind = "claude";

/** The read-only set. Everything absent here is absent on purpose. */
const READ_ONLY_TOOLS: ReadonlyArray<string> = ["Read", "Grep", "Glob"];
const FORBIDDEN_TOOLS: ReadonlyArray<string> = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
];

/** Generous but finite: a 40,000-line diff is a lot of reading, not infinite. */
const MAX_TURNS = 120;

function baseOptions(worktree: string, outputSchema: Record<string, unknown>): Options {
  return {
    cwd: worktree,
    tools: [...READ_ONLY_TOOLS],
    allowedTools: [...READ_ONLY_TOOLS],
    disallowedTools: [...FORBIDDEN_TOOLS],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    outputFormat: { type: "json_schema", schema: outputSchema },
    maxTurns: MAX_TURNS,
  };
}

const probe: HarnessAdapter["probe"] = Effect.gen(function* () {
  const version = yield* runProcess("claude", ["--version"], { timeout: "20 seconds" }).pipe(
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
        "Claude Code is not installed. Install it (`npm i -g @anthropic-ai/claude-code`) and sign in, or run `claude setup-token`.",
    };
  }

  // A zero-token probe: open a session whose prompt never yields, ask for the
  // initialization result, and close it. No model turn is spent.
  const account = yield* Effect.tryPromise({
    try: async () => {
      const never = (async function* (): AsyncGenerator<SDKUserMessage> {
        await new Promise<never>(() => {});
      })();
      const session = query({
        prompt: never,
        options: { settingSources: [], strictMcpConfig: true, stderr: () => {} },
      });
      try {
        const init = await session.initializationResult();
        return init.account ?? null;
      } finally {
        session.close();
      }
    },
    catch: (cause) => cause,
  }).pipe(Effect.timeoutOption("25 seconds"), Effect.option);

  const authenticated =
    account._tag === "Some" && account.value._tag === "Some" && account.value.value !== null;

  return {
    installed: true,
    version,
    auth: authenticated ? ("authenticated" as const) : ("unauthenticated" as const),
    detail: authenticated
      ? null
      : "Claude Code is installed but not signed in. Run `claude` once to sign in, or `claude setup-token`.",
  };
});

/**
 * The turn pump. Claude's streaming-input mode wants an async iterable that
 * yields one user message per turn, so this holds a queue of pending prompts and
 * parks between them.
 */
class TurnPump {
  private readonly pending: string[] = [];
  private waiting: ((prompt: string) => void) | null = null;
  private closed = false;
  private sessionId = "";

  push(prompt: string): void {
    const resolve = this.waiting;
    if (resolve !== null) {
      this.waiting = null;
      resolve(prompt);
      return;
    }
    this.pending.push(prompt);
  }

  close(): void {
    this.closed = true;
    const resolve = this.waiting;
    if (resolve !== null) {
      this.waiting = null;
      // Resolving with a sentinel lets the generator return rather than hang.
      resolve("");
    }
  }

  setSessionId(id: string): void {
    this.sessionId = id;
  }

  messages(): AsyncGenerator<SDKUserMessage> {
    const self = this;
    return (async function* () {
      for (;;) {
        if (self.closed) return;
        const next =
          self.pending.shift() ??
          (await new Promise<string>((resolve) => {
            self.waiting = resolve;
          }));
        if (self.closed || next === "") return;
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: next },
          parent_tool_use_id: null,
          session_id: self.sessionId,
        };
      }
    })();
  }
}

const open = (
  options: HarnessSessionOptions,
): Effect.Effect<HarnessSession, HarnessUnavailableError, Scope.Scope> =>
  Effect.gen(function* () {
    const controller = new AbortController();
    const pump = new TurnPump();
    const usage = yield* Ref.make<HarnessUsage>({});
    const transcript = yield* Ref.make<string[]>([]);
    const filesRead = new Set<string>();
    // The model name arrives in the first `system/init` message. A plain box
    // (rather than a Ref) keeps the session's `model` field a synchronous read.
    const modelBox: { current: string | undefined } = { current: undefined };

    const session: Query = yield* Effect.try({
      try: () =>
        query({
          prompt: pump.messages(),
          options: {
            ...baseOptions(options.worktree, options.outputSchema),
            abortController: controller,
            stderr: (line) => {
              void Effect.runPromise(
                Ref.update(transcript, (lines) => [...lines, `[stderr] ${line}`]),
              );
            },
          },
        }),
      catch: (cause) =>
        new HarnessUnavailableError({
          kind: KIND,
          detail: `Claude could not be started: ${String(cause)}`,
        }),
    });

    // Scope-owned lifecycle: the finalizer aborts and closes, so cancelling an
    // ingestion job kills the subprocess with it.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        pump.close();
        controller.abort();
        try {
          session.close();
        } catch {
          // Already closed; nothing to do.
        }
      }),
    );

    /**
     * Drain messages until this turn's `result`. The generator is shared across
     * turns, so each call consumes exactly one turn's worth of messages.
     */
    const awaitTurn = (): Effect.Effect<unknown, HarnessRunFailedError | HarnessOutputError> =>
      Effect.tryPromise({
        try: async () => {
          for (;;) {
            const next = await session.next();
            if (next.done === true) {
              throw new HarnessRunFailedError({
                kind: KIND,
                detail: "Claude closed the session before returning a result.",
              });
            }
            const message = next.value as SDKMessage;
            await Effect.runPromise(
              Ref.update(transcript, (lines) => [...lines, JSON.stringify(message)]),
            );
            observe(message, options, filesRead, pump, modelBox);

            if (message.type !== "result") continue;
            if (message.subtype !== "success") {
              throw new HarnessRunFailedError({
                kind: KIND,
                detail: `Claude did not finish this turn (${message.subtype}): ${message.errors.join("; ")}`,
              });
            }
            await Effect.runPromise(
              Ref.update(usage, (current) => ({
                inputTokens: (current.inputTokens ?? 0) + (message.usage.input_tokens ?? 0),
                outputTokens: (current.outputTokens ?? 0) + (message.usage.output_tokens ?? 0),
                cachedInputTokens:
                  (current.cachedInputTokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0),
              })),
            );
            if (message.structured_output === undefined) {
              throw new HarnessOutputError({
                kind: KIND,
                detail: "Claude returned no structured output for this turn.",
                raw: message.result.slice(0, 4000),
              });
            }
            return message.structured_output;
          }
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          cause instanceof HarnessRunFailedError || cause instanceof HarnessOutputError
            ? Effect.fail(cause)
            : Effect.fail(toRunFailure(cause)),
        ),
      );

    const turn = (prompt: string) =>
      Effect.gen(function* () {
        pump.push(prompt);
        return yield* awaitTurn();
      });

    return {
      kind: KIND,
      get model() {
        return modelBox.current;
      },
      ask: (prompt) => turn(prompt).pipe(Effect.withSpan("harness.claude.ask")),
      correct: (prompt) => turn(prompt).pipe(Effect.withSpan("harness.claude.correct")),
      usage: Ref.get(usage),
      transcript: Ref.get(transcript).pipe(Effect.map((lines) => lines.join("\n"))),
    } satisfies HarnessSession;
  });

/**
 * Derive activity from what is genuinely observable. Claude reports tool calls,
 * so reads and searches are real facts here: a `Read` names its file, a
 * `Grep`/`Glob` names its pattern. Nothing is inferred beyond that.
 */
function observe(
  message: SDKMessage,
  options: HarnessSessionOptions,
  filesRead: Set<string>,
  pump: TurnPump,
  modelBox: { current: string | undefined },
): void {
  if (message.type === "system" && message.subtype === "init") {
    pump.setSessionId(message.session_id);
    modelBox.current = message.model;
    return;
  }
  if (message.type !== "assistant") return;

  for (const block of message.message.content) {
    if (block.type !== "tool_use") continue;
    const activity = describeToolUse(block.name, block.input, filesRead);
    if (activity !== null) options.onActivity(activity);
  }
}

function describeToolUse(
  name: string,
  input: unknown,
  filesRead: Set<string>,
): HarnessActivity | null {
  const fields = (input ?? {}) as Record<string, unknown>;
  const asString = (key: string): string | null =>
    typeof fields[key] === "string" ? (fields[key] as string) : null;

  switch (name) {
    case "Read": {
      const path = asString("file_path") ?? asString("path");
      if (path === null) return null;
      filesRead.add(path);
      return { kind: "read", path };
    }
    case "Grep": {
      const pattern = asString("pattern") ?? "";
      const where = asString("path");
      return {
        kind: "search",
        detail: where === null ? `searching for ${pattern}` : `searching ${where} for ${pattern}`,
      };
    }
    case "Glob": {
      const pattern = asString("pattern") ?? "";
      return { kind: "search", detail: `listing ${pattern}` };
    }
    default:
      return { kind: "command", detail: name };
  }
}

function toRunFailure(cause: unknown): HarnessRunFailedError {
  if (cause instanceof AbortError) {
    return new HarnessRunFailedError({ kind: KIND, detail: "The analysis was cancelled." });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new HarnessRunFailedError({ kind: KIND, detail: message });
}

export const claudeAdapter: HarnessAdapter = {
  kind: KIND,
  label: "Claude Code",
  probe,
  open,
};

/** Kept for symmetry with the Codex adapter's tests. */
export const internals = { describeToolUse, TurnPump } as const;
