import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { HarnessKind, HarnessStatus, HarnessUsage } from "@app/contracts";

export class HarnessError extends Data.TaggedError("HarnessError")<{
  readonly kind: HarnessKind;
  readonly detail: string;
}> {}

export interface HarnessRequest {
  readonly kind: HarnessKind;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: unknown;
}

export interface HarnessResponse {
  readonly output: unknown;
  readonly usage?: HarnessUsage;
  readonly model?: string;
}

export class AnalysisHarness extends Context.Service<
  AnalysisHarness,
  {
    readonly statuses: Effect.Effect<ReadonlyArray<HarnessStatus>>;
    readonly run: (request: HarnessRequest) => Effect.Effect<HarnessResponse, HarnessError>;
  }
>()("@app/server/harness/AnalysisHarness") {}

function parseJson(kind: HarnessKind, value: string): Effect.Effect<unknown, HarnessError> {
  return Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) =>
      new HarnessError({
        kind,
        detail: `The analysis harness returned invalid structured output: ${String(cause)}`,
      }),
  });
}

function runCodex(request: HarnessRequest): Effect.Effect<HarnessResponse, HarnessError> {
  return Effect.tryPromise({
    try: async () => {
      const { Codex } = await import("@openai/codex-sdk");
      const thread = new Codex().startThread({
        workingDirectory: request.cwd,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        skipGitRepoCheck: false,
      });
      const result = await thread.run(request.prompt, { outputSchema: request.outputSchema });
      return {
        response: result.finalResponse,
        usage:
          result.usage === null
            ? undefined
            : {
                inputTokens: result.usage.input_tokens,
                outputTokens: result.usage.output_tokens,
              },
      };
    },
    catch: (cause) =>
      new HarnessError({
        kind: "codex",
        detail: `Codex could not analyze the pull request: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap(({ response, usage }) =>
      parseJson("codex", response).pipe(
        Effect.map((output) => ({
          output,
          ...(usage === undefined ? {} : { usage }),
        })),
      ),
    ),
  );
}

function runClaude(request: HarnessRequest): Effect.Effect<HarnessResponse, HarnessError> {
  return Effect.tryPromise({
    try: async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const conversation = query({
        prompt: request.prompt,
        options: {
          cwd: request.cwd,
          permissionMode: "plan",
          tools: ["Read", "Grep", "Glob"],
          maxTurns: 24,
          outputFormat: {
            type: "json_schema",
            schema: request.outputSchema as Record<string, unknown>,
          },
          settingSources: [],
        },
      });
      for await (const message of conversation) {
        if (message.type !== "result") continue;
        if (message.subtype !== "success") {
          throw new Error(message.errors.join("; "));
        }
        const model = Object.keys(message.modelUsage)[0];
        return {
          output:
            message.structured_output ??
            (message.result.trim() === "" ? {} : (JSON.parse(message.result) as unknown)),
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          },
          ...(model === undefined ? {} : { model }),
        };
      }
      throw new Error("Claude ended without a result.");
    },
    catch: (cause) =>
      new HarnessError({
        kind: "claude",
        detail: `Claude could not analyze the pull request: ${String(cause)}`,
      }),
  });
}

export const make = Effect.succeed(
  AnalysisHarness.of({
    statuses: Effect.succeed([
      {
        kind: "codex",
        installed: true,
        auth: "unknown",
        setupInstructions:
          "Codex uses your existing Codex authentication. Run codex login if analysis reports an authentication error.",
      },
      {
        kind: "claude",
        installed: true,
        auth: "unknown",
        setupInstructions:
          "Claude uses your existing Claude Code authentication. Run claude auth login if analysis reports an authentication error.",
      },
    ]),
    run: (request) => (request.kind === "codex" ? runCodex(request) : runClaude(request)),
  }),
);

export const layer = Layer.effect(AnalysisHarness, make);
