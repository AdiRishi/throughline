import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  type AnalysisTask,
  HarnessRunError,
  type HarnessProgressEvent,
  type HarnessTranscriptEntry,
} from "../../src/harness/AnalysisHarness.ts";
import {
  type ClaudeSdk,
  makeClaudeHarness,
  validateClaudeToolPath,
} from "../../src/harness/ClaudeHarness.ts";
import { HarnessProcess, type HarnessProcessResult } from "../../src/harness/HarnessProcess.ts";

const Output = Schema.Struct({ ok: Schema.Boolean });
type Output = typeof Output.Type;
const decodeOutput = Schema.decodeUnknownEffect(Output);

interface CapturedClaudeCall {
  prompt?: string;
  options?: Options;
  closed: boolean;
}

const processReturning = (
  run: (executable: string, args: ReadonlyArray<string>) => HarnessProcessResult,
): HarnessProcess["Service"] =>
  HarnessProcess.of({
    run: (executable, args) => Effect.succeed(run(executable, args)),
  });

const makeTask = (
  progress: Array<HarnessProgressEvent>,
  transcript: Array<HarnessTranscriptEntry>,
  overrides: Partial<AnalysisTask<Output>> = {},
): AnalysisTask<Output> => ({
  world: "/run/world",
  prompt: "Return the requested narrative.",
  outputSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  decode: decodeOutput,
  onEvent: (event) =>
    Effect.sync(() => {
      progress.push(event);
    }),
  transcript: {
    write: (entry) =>
      Effect.sync(() => {
        transcript.push(entry);
      }),
  },
  ...overrides,
});

const initMessage = {
  type: "system",
  subtype: "init",
  session_id: "session-1",
  tools: ["Read", "Glob", "Grep"],
} as unknown as SDKMessage;

const readMessage = {
  type: "assistant",
  session_id: "session-1",
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Read",
        input: { file_path: "repository/src/auth.ts" },
      },
    ],
  },
} as unknown as SDKMessage;

const resultMessage = (structuredOutput: unknown): SDKMessage =>
  ({
    type: "result",
    subtype: "success",
    session_id: "session-1",
    structured_output: structuredOutput,
    usage: {
      input_tokens: 30,
      output_tokens: 12,
      cache_read_input_tokens: 7,
    },
  }) as unknown as SDKMessage;

const sdkReturning = (
  capture: CapturedClaudeCall,
  messages: ReadonlyArray<SDKMessage>,
): ClaudeSdk => ({
  query: ({ prompt, options }) => {
    capture.prompt = prompt;
    capture.options = options;
    options.stderr?.("stderr exactly\n");
    return {
      close: () => {
        capture.closed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
    };
  },
});

describe("ClaudeHarness", () => {
  it.effect("detects unauthenticated and unavailable installations without failing", () =>
    Effect.gen(function* () {
      const process = processReturning((_executable, args) =>
        args[0] === "--version"
          ? { exitCode: 0, stdout: "2.1.218 (Claude Code)\n", stderr: "" }
          : {
              exitCode: 0,
              stdout: '{"loggedIn":false,"authMethod":"none"}\n',
              stderr: "",
            },
      );
      const installed = makeClaudeHarness({
        process,
        resolveBinary: () => "/bin/claude",
      });
      assert.deepStrictEqual(yield* installed.detect, {
        kind: "claude",
        installed: true,
        version: "2.1.218",
        auth: "unauthenticated",
      });

      const unavailable = makeClaudeHarness({
        process,
        resolveBinary: () => undefined,
      });
      assert.deepStrictEqual(yield* unavailable.detect, {
        kind: "claude",
        installed: false,
        version: null,
        auth: "unknown",
      });
    }),
  );

  it.effect("isolates Claude to read-only tools and resumes with structured output", () =>
    Effect.gen(function* () {
      const capture: CapturedClaudeCall = { closed: false };
      const progress: Array<HarnessProgressEvent> = [];
      const transcript: Array<HarnessTranscriptEntry> = [];
      const harness = makeClaudeHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/claude",
        canonicalizePath: async (path) => path,
        sdk: sdkReturning(capture, [initMessage, readMessage, resultMessage({ ok: true })]),
      });

      const result = yield* harness
        .run(
          makeTask(progress, transcript, {
            continuation: "session-before-repair",
          }),
        )
        .pipe(Effect.scoped);

      assert.deepStrictEqual(result, {
        value: { ok: true },
        continuation: "session-1",
        usage: {
          inputTokens: 30,
          outputTokens: 12,
          cachedInputTokens: 7,
        },
      });
      assert.strictEqual(capture.prompt, "Return the requested narrative.");
      assert.deepStrictEqual(capture.options?.tools, ["Read", "Glob", "Grep"]);
      assert.deepStrictEqual(capture.options?.allowedTools, ["Read", "Glob", "Grep"]);
      assert.strictEqual(capture.options?.permissionMode, "dontAsk");
      assert.deepStrictEqual(capture.options?.settingSources, []);
      assert.strictEqual(capture.options?.strictMcpConfig, true);
      assert.deepStrictEqual(capture.options?.mcpServers, {});
      assert.deepStrictEqual(capture.options?.plugins, []);
      assert.deepStrictEqual(capture.options?.skills, []);
      assert.deepStrictEqual(capture.options?.agents, {});
      assert.deepStrictEqual(capture.options?.additionalDirectories, []);
      assert.strictEqual(capture.options?.pathToClaudeCodeExecutable, "/bundled/claude");
      assert.strictEqual(capture.options?.resume, "session-before-repair");
      assert.isFalse("env" in (capture.options ?? {}));
      assert.isFalse("settings" in (capture.options ?? {}));
      assert.instanceOf(capture.options?.abortController, AbortController);
      assert.deepStrictEqual(capture.options?.outputFormat, {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      });
      assert.isTrue(capture.closed);
      assert.deepStrictEqual(progress, [
        { type: "started" },
        {
          type: "activity",
          action: "Read",
          path: "repository/src/auth.ts",
        },
        { type: "completed" },
      ]);
      assert.isTrue(
        progress.every((event) => event.type !== "activity" || event.counters === undefined),
      );
      assert.deepStrictEqual(transcript.at(0), {
        source: "stderr",
        contents: "stderr exactly\n",
      });
      assert.lengthOf(transcript, 4);
    }),
  );

  it.effect("fails closed for escaped, symlinked, or unknown tool paths", () =>
    Effect.gen(function* () {
      const capture: CapturedClaudeCall = { closed: false };
      const harness = makeClaudeHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/claude",
        canonicalizePath: async (path) =>
          path.endsWith("/repository/link") ? "/outside/secret" : path,
        sdk: sdkReturning(capture, [initMessage, resultMessage({ ok: true })]),
      });
      yield* harness.run(makeTask([], [])).pipe(Effect.scoped);

      const gate = capture.options?.canUseTool;
      assert.isFunction(gate);
      if (gate === undefined) {
        return;
      }
      const permissionOptions = {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        requestId: "request-1",
      };
      const decision = (result: PermissionResult | null) => result?.behavior;
      const gateDecision = (toolName: string, input: Record<string, unknown>) =>
        Effect.promise(() => gate(toolName, input, permissionOptions)).pipe(Effect.map(decision));

      assert.strictEqual(
        yield* gateDecision("Read", {
          file_path: "repository/src/auth.ts",
        }),
        "allow",
      );
      assert.strictEqual(yield* gateDecision("Read", { file_path: "../../secret" }), "deny");
      assert.strictEqual(yield* gateDecision("Read", { file_path: "repository/link" }), "deny");
      assert.strictEqual(yield* gateDecision("Bash", { command: "pwd" }), "deny");
      assert.strictEqual(yield* gateDecision("Glob", { pattern: "../**/*" }), "deny");
      assert.strictEqual(yield* gateDecision("Glob", { pattern: "repository/link/**/*" }), "deny");
      assert.strictEqual(
        yield* gateDecision("Grep", {
          pattern: "secret",
          glob: "repository/link/**/*.ts",
        }),
        "deny",
      );
    }),
  );

  it.effect("surfaces schema decode failures after the successful SDK result", () =>
    Effect.gen(function* () {
      const progress: Array<HarnessProgressEvent> = [];
      const harness = makeClaudeHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/claude",
        canonicalizePath: async (path) => path,
        sdk: sdkReturning({ closed: false }, [initMessage, resultMessage({ ok: "yes" })]),
      });

      const error = yield* harness.run(makeTask(progress, [])).pipe(Effect.scoped, Effect.flip);

      assert.instanceOf(error, HarnessRunError);
      assert.strictEqual(error.reason, "invalid-output");
      assert.strictEqual(progress.at(-1)?.type, "failed");
      assert.isFalse(progress.some((event) => event.type === "completed"));
    }),
  );

  it.effect("aborts and closes the SDK stream when the owning scope closes", () =>
    Effect.gen(function* () {
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const capture: CapturedClaudeCall = { closed: false };
      let aborted = false;
      const sdk: ClaudeSdk = {
        query: ({ options }) => {
          capture.options = options;
          return {
            close: () => {
              capture.closed = true;
            },
            async *[Symbol.asyncIterator]() {
              yield initMessage;
              await new Promise<void>((_resolve, reject) => {
                markStarted?.();
                options.abortController?.signal.addEventListener(
                  "abort",
                  () => {
                    aborted = true;
                    reject(new Error("aborted"));
                  },
                  { once: true },
                );
              });
            },
          };
        },
      };
      const harness = makeClaudeHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/claude",
        canonicalizePath: async (path) => path,
        sdk,
      });
      const scope = yield* Scope.make();
      const fiber = yield* harness
        .run(makeTask([], []))
        .pipe(Scope.provide(scope), Effect.forkChild);

      yield* Effect.promise(() => started);
      yield* Scope.close(scope, Exit.void);
      yield* Fiber.await(fiber);

      assert.isTrue(aborted);
      assert.isTrue(capture.options?.abortController?.signal.aborted);
      assert.isTrue(capture.closed);
    }),
  );
});

describe("validateClaudeToolPath", () => {
  it("requires canonical paths to remain under the canonical world", async () => {
    assert.isTrue(
      await validateClaudeToolPath(
        "/run/world",
        "/canonical/world",
        "Grep",
        { pattern: "authenticate", path: "repository" },
        async (path) => path.replace("/run/world", "/canonical/world"),
      ),
    );
    assert.isFalse(
      await validateClaudeToolPath(
        "/run/world",
        "/canonical/world",
        "Read",
        { file_path: "repository/link" },
        async () => "/outside/secret",
      ),
    );
  });
});
