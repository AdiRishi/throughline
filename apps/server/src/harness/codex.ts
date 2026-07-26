/**
 * The Codex adapter.
 *
 * Read-only is enforced by the sandbox: `sandboxMode: "read-only"` overrides
 * whatever the reviewer's own `config.toml` says, `approvalPolicy: "never"`
 * means no prompt can ever block the run, and network access is off.
 *
 * Two behaviours of this SDK shape the code and are worth knowing before
 * changing it:
 *
 *  - **Structured output is an unvalidated string.** `finalResponse` is text,
 *    and Codex has been observed emitting a premature, wrong agent message
 *    mid-turn before the real one. So the stream is consumed directly and the
 *    *last* agent message wins.
 *  - **There are no file-read events.** Under the read-only sandbox everything
 *    the agent does arrives as a shell command, so the activity feed is
 *    recovered from the command line itself. What cannot be recovered is not
 *    invented.
 *
 * @module harness/codex
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { HarnessStatus } from "@app/contracts";

import { briefError, succeeded, type Runner } from "../process/Subprocess.ts";
import {
  HarnessError,
  summarize,
  type HarnessAdapter,
  type HarnessAnswer,
  type HarnessAsk,
  type HarnessEvent,
  type HarnessSession,
} from "./AnalysisHarness.ts";

// ── The slice of `@openai/codex-sdk` this adapter uses ──────────────────────

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
  readonly command?: string;
  readonly query?: string;
}

interface CodexEvent {
  readonly type: string;
  readonly thread_id?: string;
  readonly item?: CodexItem;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly error?: { readonly message?: string };
  readonly message?: string;
}

interface CodexThread {
  readonly id?: string | null;
  readonly runStreamed: (
    prompt: string,
    options: Record<string, unknown>,
  ) => Promise<{ readonly events: AsyncIterable<CodexEvent> }>;
}

/** A turn that never settles must not be able to wedge a job forever. */
const TURN_TIMEOUT = Duration.minutes(12);

interface CodexClient {
  readonly startThread: (options: Record<string, unknown>) => CodexThread;
  readonly resumeThread: (id: string, options: Record<string, unknown>) => CodexThread;
}

interface CodexSdk {
  readonly Codex: new (options?: Record<string, unknown>) => CodexClient;
}

const loadSdk = Effect.tryPromise({
  try: () => import("@openai/codex-sdk") as Promise<unknown>,
  catch: (cause) =>
    new HarnessError({
      kind: "codex",
      reason: "unavailable",
      detail: `The Codex SDK could not be loaded: ${String(cause)}`,
    }),
}).pipe(Effect.map((module) => module as CodexSdk));

/** Everything a Codex thread needs to be read-only and unattended. */
const THREAD_OPTIONS = (worktree: string) => ({
  workingDirectory: worktree,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  networkAccessEnabled: false,
  webSearchMode: "disabled",
});

export const makeCodexAdapter = (runner: Runner): HarnessAdapter => {
  const detect = Effect.gen(function* () {
    const version = yield* runner({
      command: "codex",
      args: ["--version"],
      timeout: Duration.seconds(20),
    }).pipe(Effect.orElseSucceed(() => null));

    if (version === null || !succeeded(version)) {
      return {
        kind: "codex",
        label: "Codex",
        installed: false,
        version: null,
        auth: "unknown",
        detail:
          version === null
            ? "The Codex CLI was not found. Install it, then sign in with `codex login`."
            : briefError(version),
      } satisfies HarnessStatus;
    }

    // The SDK has no detection API, and a bad login costs ~40s of retries
    // before it says so. `codex login status` answers in milliseconds — and
    // writes to stderr, which is why the outcome rather than stdout is read.
    const login = yield* runner({
      command: "codex",
      args: ["login", "status"],
      timeout: Duration.seconds(20),
    }).pipe(Effect.orElseSucceed(() => null));

    const authenticated = login !== null && succeeded(login);
    return {
      kind: "codex",
      label: "Codex",
      installed: true,
      version: version.stdout.trim().split(" ").at(-1) ?? null,
      auth: authenticated ? "authenticated" : "unauthenticated",
      detail: authenticated ? "" : "Run `codex login` to sign in.",
    } satisfies HarnessStatus;
  });

  const session = Effect.fn("harness.codex.session")(function* (input: {
    readonly worktree: string;
    readonly label: string;
  }) {
    const sdk = yield* loadSdk;
    const client = new sdk.Codex();
    // A `Thread` models ONE turn: calling `runStreamed` on it twice spawns
    // nothing and never settles. Continuing the conversation — which is what
    // every repair round is — means resuming it by id.
    const conversation: { id: string | null } = { id: null };

    const ask = (askInput: HarnessAsk): Effect.Effect<HarnessAnswer, HarnessError> =>
      Effect.gen(function* () {
        const controller = new AbortController();
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

        return yield* Effect.tryPromise({
          try: () => {
            const options = THREAD_OPTIONS(input.worktree);
            const thread =
              conversation.id === null
                ? client.startThread(options)
                : client.resumeThread(conversation.id, options);
            return runTurn({
              thread,
              ask: askInput,
              controller,
              onThread: (id) => {
                conversation.id = id;
              },
            });
          },
          catch: (cause) =>
            new HarnessError({
              kind: "codex",
              reason: controller.signal.aborted ? "cancelled" : "crashed",
              detail: String((cause as { message?: string }).message ?? cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: TURN_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new HarnessError({
                  kind: "codex",
                  reason: "crashed",
                  detail: `The harness produced no answer within ${Duration.format(Duration.fromInputUnsafe(TURN_TIMEOUT))}.`,
                }),
              ),
          }),
        );
      }).pipe(Effect.scoped);

    return { ask } satisfies HarnessSession;
  });

  return { kind: "codex", label: "Codex", detect, session };
};

async function runTurn(input: {
  readonly thread: CodexThread;
  readonly ask: HarnessAsk;
  readonly controller: AbortController;
  readonly onThread: (id: string) => void;
}): Promise<HarnessAnswer> {
  const { events } = await input.thread.runStreamed(input.ask.prompt, {
    outputSchema: input.ask.outputSchema,
    signal: input.controller.signal,
  });

  let usage: HarnessAnswer["usage"] = null;
  let lastMessage: string | null = null;
  let failure: string | null = null;

  for await (const event of events) {
    if (typeof event.thread_id === "string") input.onThread(event.thread_id);
    if (event.type === "turn.completed" && event.usage !== undefined) {
      usage = {
        inputTokens: event.usage.input_tokens ?? 0,
        outputTokens: event.usage.output_tokens ?? 0,
      };
      continue;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      failure = event.error?.message ?? event.message ?? "the turn failed";
      continue;
    }
    const item = event.item;
    if (item === undefined) continue;

    if (item.type === "agent_message" && event.type === "item.completed") {
      // The last one wins: Codex has been observed emitting a premature,
      // wrong agent message before doing any work.
      lastMessage = item.text ?? lastMessage;
      continue;
    }
    for (const observed of toEvents(item)) input.ask.onEvent(observed);
  }

  if (failure !== null) {
    throw new HarnessError({ kind: "codex", reason: "crashed", detail: failure });
  }
  if (lastMessage === null) {
    throw new HarnessError({
      kind: "codex",
      reason: "no-output",
      detail: "The run finished without producing a final message.",
    });
  }

  let output: unknown;
  try {
    output = JSON.parse(lastMessage) as unknown;
  } catch {
    throw new HarnessError({
      kind: "codex",
      reason: "no-output",
      detail: "The final message was not the JSON the output schema asked for.",
    });
  }
  return { output, model: null, usage };
}

/**
 * Shell commands are all Codex gives us under a read-only sandbox, so the
 * activity feed is recovered from the command line itself. Only shapes we can
 * read confidently become a "read" or a "search"; everything else stays a plain
 * "run", because inventing detail here would be inventing progress.
 */
const SEARCH_TOOLS = new Set(["rg", "grep", "ag", "ack"]);
const READ_TOOLS = new Set(["cat", "head", "tail", "less", "bat", "sed", "nl", "wc"]);
/**
 * Codex does not hand us `rg …`; it hands us `/bin/zsh -lc "…"` with the real
 * work quoted inside, and that inner script is usually several commands joined
 * by `&&` or `;`. Both layers have to come off before any of it can be read.
 */
const SHELL_TOOLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const SEPARATORS = ["&&", "||", ";", "|", "\n"];
/**
 * Flags that mean the command has no search pattern at all. `rg --files` lists
 * the tree; calling its glob filter "what the agent searched for" would be an
 * invented claim, and the feed does not make those.
 */
const NO_PATTERN_FLAGS = new Set(["--files", "-h", "--help", "--version"]);
/** Flags that swallow the token after them, so it is never the search pattern. */
const VALUE_FLAGS = new Set([
  "-g",
  "-e",
  "-t",
  "-T",
  "-m",
  "-A",
  "-B",
  "-C",
  "--glob",
  "--type",
  "--type-not",
  "--max-count",
]);

/** Split a shell-ish command into tokens, honouring simple quoting. */
export function tokenizeCommand(command: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

/**
 * Peel `zsh -lc "…"` down to the script it was told to run.
 *
 * Deliberately done on the raw string rather than on tokens: a real script is
 * full of its own quoting (`rg -g '"'!node_modules'"'`), and tokenizing first
 * would make "is this one argument?" unanswerable and leave the wrapper on.
 * Everything after the `-c`-bearing flag is the script, minus one layer of
 * quotes if the whole of it is wrapped in them.
 */
const SHELL_WRAPPER = new RegExp(
  `^\\s*(?:\\S*/)?(?:${[...SHELL_TOOLS].join("|")})\\s+-[a-z]*c\\s+([\\s\\S]+)$`,
  "u",
);

function unwrapShell(command: string): string {
  const wrapper = SHELL_WRAPPER.exec(command);
  if (wrapper === null) return command;
  const script = (wrapper[1] ?? "").trim();
  const quoted = /^(['"])([\s\S]*)\1$/u.exec(script);
  if (quoted === undefined || quoted === null) return script;
  const [, fence = "", inner = ""] = quoted;
  // Inside a double-quoted argument the shell has already resolved `\"` to a
  // quote; leaving the backslashes in would put them in front of the reviewer,
  // in a feed that is supposed to show what the agent searched for.
  return fence === '"' ? inner.replaceAll('\\"', '"').replaceAll("\\\\", "\\") : inner;
}

/**
 * Split a script into the commands it actually runs, honouring quoting so a
 * `;` inside `sed -n '1,20p; 40p'` is not mistaken for a separator.
 */
export function splitSegments(script: string): ReadonlyArray<string> {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < script.length; index += 1) {
    const character = script[index] as string;
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => script.startsWith(candidate, index));
    if (separator !== undefined) {
      segments.push(current);
      current = "";
      index += separator.length - 1;
      continue;
    }
    current += character;
  }
  segments.push(current);

  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
}

/** What one command in a script was for, as far as it can be read honestly. */
function describeSegment(segment: string): HarnessEvent {
  const tokens = tokenizeCommand(segment);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const tool = token.split("/").at(-1) ?? token;

    if (SEARCH_TOOLS.has(tool)) {
      const rest = tokens.slice(index + 1);
      const pattern = rest.some((token) => NO_PATTERN_FLAGS.has(token)) ? null : firstOperand(rest);
      if (pattern !== null) {
        return { verb: "search", detail: pattern, path: null, pattern };
      }
    }
    if (READ_TOOLS.has(tool)) {
      const operand = firstOperand(tokens.slice(index + 1), (value) => value.includes("."));
      if (operand !== null) {
        return { verb: "read", detail: operand, path: operand, pattern: null };
      }
    }
  }
  return { verb: "run", detail: summarize(segment, 90), path: null, pattern: null };
}

/**
 * What a command was *for*, as far as it can be read honestly — one event per
 * command the agent actually ran, because one Codex `command_execution` is
 * routinely a whole script.
 *
 * Exported for its tests: this is the only place the progress feed's honesty
 * can actually be checked, since everything downstream just renders it.
 */
export function describeCommand(command: string): ReadonlyArray<HarnessEvent> {
  const segments = splitSegments(unwrapShell(command));
  if (segments.length === 0) {
    return [{ verb: "run", detail: summarize(command, 90), path: null, pattern: null }];
  }
  return segments.map(describeSegment);
}

/** The first token that is neither a flag nor a flag's value. */
function firstOperand(
  tokens: ReadonlyArray<string>,
  accept: (value: string) => boolean = () => true,
): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length === 0) continue;
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    if (["|", "&&", ";", "||"].includes(token)) return null;
    if (accept(token)) return token;
  }
  return null;
}

function toEvents(item: CodexItem): ReadonlyArray<HarnessEvent> {
  if (item.type === "reasoning") {
    return [{ verb: "think", detail: "thinking", path: null, pattern: null }];
  }
  if (item.type === "web_search" && typeof item.query === "string") {
    return [{ verb: "search", detail: item.query, path: null, pattern: null }];
  }
  if (item.type !== "command_execution" || typeof item.command !== "string") return [];
  return describeCommand(item.command);
}
