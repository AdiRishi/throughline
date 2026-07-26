/**
 * The Claude adapter.
 *
 * The SDK is loaded dynamically and described here by the slice of its surface
 * this adapter actually uses. That is deliberate on two counts: a missing or
 * broken SDK degrades to "unavailable" instead of crashing the server at boot,
 * and the server's typecheck does not inherit the SDK's own type dependencies.
 *
 * Read-only is enforced by construction: a three-tool allowlist with no shell,
 * `permissionMode: "dontAsk"` (fail-closed — anything not pre-approved is
 * denied rather than prompted), and `settingSources: []` so the reviewer's own
 * `CLAUDE.md`, settings, and MCP servers cannot widen it.
 *
 * @module harness/claude
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { HarnessStatus } from "@app/contracts";

import { briefError, succeeded, type Runner } from "../process/Subprocess.ts";
import {
  HarnessError,
  relativize,
  summarize,
  type HarnessAdapter,
  type HarnessAnswer,
  type HarnessAsk,
  type HarnessEvent,
  type HarnessSession,
} from "./AnalysisHarness.ts";

/** The read-only tool set. No Bash, no Write, no Edit — the sandbox is the list. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;

/** A turn that never settles must not be able to wedge a job forever. */
const TURN_TIMEOUT = Duration.minutes(12);

// ── The slice of `@anthropic-ai/claude-agent-sdk` this adapter uses ──────────

interface ClaudeContentBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly text?: string;
}

interface ClaudeMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly model?: string;
  readonly message?: { readonly content?: ReadonlyArray<ClaudeContentBlock> };
  readonly structured_output?: unknown;
  readonly result?: string;
  readonly errors?: ReadonlyArray<string>;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

interface ClaudeQuery extends AsyncIterable<ClaudeMessage> {
  readonly close?: () => void;
  readonly initializationResult?: () => Promise<{
    readonly account?: { readonly email?: string; readonly subscriptionType?: string };
    readonly model?: string;
  }>;
}

interface ClaudeSdk {
  readonly query: (input: {
    readonly prompt: string;
    readonly options: Record<string, unknown>;
  }) => ClaudeQuery;
}

const loadSdk = Effect.tryPromise({
  try: () => import("@anthropic-ai/claude-agent-sdk") as Promise<unknown>,
  catch: (cause) =>
    new HarnessError({
      kind: "claude",
      reason: "unavailable",
      detail: `The Claude Agent SDK could not be loaded: ${String(cause)}`,
    }),
}).pipe(Effect.map((module) => module as ClaudeSdk));

export const makeClaudeAdapter = (runner: Runner): HarnessAdapter => {
  const detect = Effect.gen(function* () {
    const version = yield* runner({
      command: "claude",
      args: ["--version"],
      timeout: Duration.seconds(20),
    }).pipe(Effect.orElseSucceed(() => null));

    if (version === null || !succeeded(version)) {
      return {
        kind: "claude",
        label: "Claude Code",
        installed: false,
        version: null,
        auth: "unknown",
        detail:
          version === null
            ? "The Claude CLI was not found. Install it, then sign in with `claude`."
            : briefError(version),
      } satisfies HarnessStatus;
    }

    // The SDK reveals the signed-in account during initialization without
    // spending a token. Anything short of a clear answer stays "unknown",
    // because refusing to try a harness that would have worked is worse than
    // trying one that will not.
    const auth = yield* probeAuth.pipe(Effect.orElseSucceed(() => "unknown" as const));
    return {
      kind: "claude",
      label: "Claude Code",
      installed: true,
      version: version.stdout.trim().split(" ")[0] ?? null,
      auth,
      detail:
        auth === "unauthenticated" ? "Run `claude` once and sign in, or `claude setup-token`." : "",
    } satisfies HarnessStatus;
  });

  const probeAuth = Effect.gen(function* () {
    const sdk = yield* loadSdk;
    return yield* Effect.tryPromise({
      try: async () => {
        const probe = sdk.query({
          prompt: "ping",
          options: { tools: [], allowedTools: [], settingSources: [], permissionMode: "dontAsk" },
        });
        try {
          const init = await probe.initializationResult?.();
          return init?.account?.email === undefined
            ? ("unknown" as const)
            : ("authenticated" as const);
        } finally {
          probe.close?.();
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () => Effect.succeed("unknown" as const),
      }),
      Effect.orElseSucceed(() => "unauthenticated" as const),
    );
  });

  const session = Effect.fn("harness.claude.session")(function* (input: {
    readonly worktree: string;
    readonly label: string;
  }) {
    const sdk = yield* loadSdk;
    // One conversation per session: a repair turn resumes it rather than
    // re-reading the whole diff.
    const conversation: { id: string | null } = { id: null };

    const ask = (askInput: HarnessAsk): Effect.Effect<HarnessAnswer, HarnessError> =>
      Effect.gen(function* () {
        const controller = new AbortController();
        // Cancellation rides the scope: closing it aborts the turn and the CLI
        // child dies with it. Nothing else has to know how to stop a harness.
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));

        return yield* Effect.tryPromise({
          try: () =>
            runTurn({
              sdk,
              worktree: input.worktree,
              ask: askInput,
              controller,
              resume: conversation.id,
              onSession: (id) => {
                conversation.id = id;
              },
            }),
          catch: (cause) =>
            new HarnessError({
              kind: "claude",
              reason: controller.signal.aborted ? "cancelled" : "crashed",
              detail: String((cause as { message?: string }).message ?? cause),
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: TURN_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new HarnessError({
                  kind: "claude",
                  reason: "crashed",
                  detail: `The harness produced no answer within ${Duration.format(Duration.fromInputUnsafe(TURN_TIMEOUT))}.`,
                }),
              ),
          }),
        );
      }).pipe(Effect.scoped);

    return { ask } satisfies HarnessSession;
  });

  return { kind: "claude", label: "Claude Code", detect, session };
};

async function runTurn(input: {
  readonly sdk: ClaudeSdk;
  readonly worktree: string;
  readonly ask: HarnessAsk;
  readonly controller: AbortController;
  readonly resume: string | null;
  readonly onSession: (id: string) => void;
}): Promise<HarnessAnswer> {
  const query = input.sdk.query({
    prompt: input.ask.prompt,
    options: {
      cwd: input.worktree,
      abortController: input.controller,
      tools: [...READ_ONLY_TOOLS],
      allowedTools: [...READ_ONLY_TOOLS],
      permissionMode: "dontAsk",
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: false,
      outputFormat: { type: "json_schema", schema: input.ask.outputSchema },
      ...(input.resume === null ? {} : { resume: input.resume }),
    },
  });

  let model: string | null = null;
  let usage: HarnessAnswer["usage"] = null;
  let output: unknown;
  let failure: string | null = null;

  for await (const message of query) {
    if (message.session_id !== undefined) input.onSession(message.session_id);
    if (message.model !== undefined) model = message.model;

    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        const event = toEvent(block, input.worktree);
        if (event !== null) input.ask.onEvent(event);
      }
      continue;
    }
    if (message.type === "result") {
      if (message.usage !== undefined) {
        usage = {
          inputTokens: message.usage.input_tokens ?? 0,
          outputTokens: message.usage.output_tokens ?? 0,
        };
      }
      if (message.subtype === "success") {
        output = message.structured_output ?? parseLoose(message.result);
      } else {
        failure = (message.errors ?? []).join("; ") || (message.subtype ?? "unknown failure");
      }
    }
  }

  if (failure !== null) {
    throw new HarnessError({ kind: "claude", reason: "crashed", detail: failure });
  }
  if (output === undefined) {
    throw new HarnessError({
      kind: "claude",
      reason: "no-output",
      detail: "The run finished without producing structured output.",
    });
  }
  return { output, model, usage };
}

function parseLoose(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a Claude tool call into an observed action. Only the read-only
 * tools exist, so this covers everything the harness can actually do.
 */
function toEvent(block: ClaudeContentBlock, worktree: string): HarnessEvent | null {
  if (block.type === "thinking") {
    return { verb: "think", detail: "thinking", path: null, pattern: null };
  }
  if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
    return { verb: "say", detail: summarize(block.text), path: null, pattern: null };
  }
  if (block.type !== "tool_use") return null;

  const input = block.input ?? {};
  const filePath = typeof input["file_path"] === "string" ? input["file_path"] : null;
  const pattern = typeof input["pattern"] === "string" ? input["pattern"] : null;

  switch (block.name) {
    case "Read":
      return filePath === null
        ? null
        : {
            verb: "read",
            detail: relativize(worktree, filePath),
            path: relativize(worktree, filePath),
            pattern: null,
          };
    case "Grep":
      return {
        verb: "search",
        detail: pattern ?? "searching",
        path: null,
        pattern,
      };
    case "Glob":
      return {
        verb: "search",
        detail: typeof input["pattern"] === "string" ? input["pattern"] : "listing files",
        path: null,
        pattern: null,
      };
    default:
      return { verb: "run", detail: block.name ?? "tool", path: null, pattern: null };
  }
}
