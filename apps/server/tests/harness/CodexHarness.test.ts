import { assert, describe, it } from "@effect/vitest";
import type { CodexOptions, ThreadEvent, ThreadOptions, TurnOptions } from "@openai/codex-sdk";
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
import { type CodexSdkFactory, makeCodexHarness } from "../../src/harness/CodexHarness.ts";
import { HarnessProcess, type HarnessProcessResult } from "../../src/harness/HarnessProcess.ts";

const Output = Schema.Struct({ ok: Schema.Boolean });
type Output = typeof Output.Type;
const decodeOutput = Schema.decodeUnknownEffect(Output);

interface CapturedCodexCall {
  clientOptions?: CodexOptions;
  threadOptions?: ThreadOptions;
  resumed?: string;
  prompt?: string;
  turnOptions?: TurnOptions;
}

const processReturning = (
  run: (executable: string, args: ReadonlyArray<string>) => HarnessProcessResult,
): HarnessProcess["Service"] =>
  HarnessProcess.of({
    run: (executable, args) => Effect.succeed(run(executable, args)),
  });

const eventStream = (events: ReadonlyArray<ThreadEvent>): AsyncIterable<ThreadEvent> => ({
  async *[Symbol.asyncIterator]() {
    yield* events;
  },
});

const sdkReturning = (
  capture: CapturedCodexCall,
  events: (options: TurnOptions) => AsyncIterable<ThreadEvent>,
): CodexSdkFactory => ({
  create: (options) => {
    capture.clientOptions = options;
    const thread = {
      id: "thread-from-instance",
      runStreamed: async (prompt: string, turnOptions: TurnOptions) => {
        capture.prompt = prompt;
        capture.turnOptions = turnOptions;
        return { events: events(turnOptions) };
      },
    };
    return {
      startThread: (threadOptions) => {
        capture.threadOptions = threadOptions;
        return thread;
      },
      resumeThread: (id, threadOptions) => {
        capture.resumed = id;
        capture.threadOptions = threadOptions;
        return thread;
      },
    };
  },
});

const makeTask = (
  progress: Array<HarnessProgressEvent>,
  transcript: Array<HarnessTranscriptEntry>,
  overrides: Partial<AnalysisTask<Output>> = {},
): AnalysisTask<Output> => ({
  world: "/run/world",
  prompt: "Return the requested plan.",
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

const successfulEvents = (response = '{"ok":true}'): ReadonlyArray<ThreadEvent> => [
  { type: "thread.started", thread_id: "thread-1" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "reason-1", type: "reasoning", text: "Inspecting the hunk index" },
  },
  {
    type: "item.completed",
    item: { id: "message-1", type: "agent_message", text: response },
  },
  {
    type: "turn.completed",
    usage: {
      input_tokens: 20,
      cached_input_tokens: 5,
      cache_write_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 3,
    },
  },
];

describe("CodexHarness", () => {
  it.effect("detects installed, authenticated, unavailable, and unknown states calmly", () =>
    Effect.gen(function* () {
      const process = processReturning((_executable, args) =>
        args[0] === "--version"
          ? { exitCode: 0, stdout: "codex-cli 0.145.0\n", stderr: "" }
          : { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "" },
      );
      const installed = makeCodexHarness({
        process,
        resolveBinary: () => "/bin/codex",
      });
      assert.deepStrictEqual(yield* installed.detect, {
        kind: "codex",
        installed: true,
        version: "0.145.0",
        auth: "authenticated",
      });

      const unavailable = makeCodexHarness({
        process,
        resolveBinary: () => undefined,
      });
      assert.deepStrictEqual(yield* unavailable.detect, {
        kind: "codex",
        installed: false,
        version: null,
        auth: "unknown",
      });

      const unknown = makeCodexHarness({
        process: processReturning(() => ({
          exitCode: 1,
          stdout: "",
          stderr: "unexpected",
        })),
        resolveBinary: () => "/bin/codex",
      });
      assert.strictEqual((yield* unknown.detect).auth, "unknown");

      const defective = makeCodexHarness({
        process: HarnessProcess.of({
          run: () => Effect.die(new Error("spawn ENOTDIR")),
        }),
        resolveBinary: () => "/Applications/Throughline.app/Contents/Resources/app.asar/codex",
      });
      assert.deepStrictEqual(yield* defective.detect, {
        kind: "codex",
        installed: true,
        version: null,
        auth: "unknown",
      });
    }),
  );

  it.effect("enforces run options, resumes continuations, and emits only observed activity", () =>
    Effect.gen(function* () {
      const capture: CapturedCodexCall = {};
      const progress: Array<HarnessProgressEvent> = [];
      const transcript: Array<HarnessTranscriptEntry> = [];
      const harness = makeCodexHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/codex",
        sdk: sdkReturning(capture, () => eventStream(successfulEvents())),
      });

      const result = yield* harness
        .run(
          makeTask(progress, transcript, {
            continuation: "thread-before-repair",
          }),
        )
        .pipe(Effect.scoped);

      assert.deepStrictEqual(result, {
        value: { ok: true },
        continuation: "thread-1",
        usage: {
          inputTokens: 20,
          outputTokens: 10,
          cachedInputTokens: 5,
        },
      });
      assert.deepStrictEqual(capture.clientOptions, {
        codexPathOverride: "/bundled/codex",
        config: { mcp_servers: {} },
      });
      assert.isFalse("env" in (capture.clientOptions ?? {}));
      assert.deepStrictEqual(capture.threadOptions, {
        workingDirectory: "/run/world",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
      });
      assert.strictEqual(capture.resumed, "thread-before-repair");
      assert.strictEqual(capture.prompt, "Return the requested plan.");
      assert.deepStrictEqual(capture.turnOptions?.outputSchema, {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      });
      assert.instanceOf(capture.turnOptions?.signal, AbortSignal);
      assert.isFalse(capture.turnOptions?.signal?.aborted);
      assert.deepStrictEqual(progress, [
        { type: "started" },
        { type: "activity", action: "Inspecting the hunk index" },
        { type: "completed" },
      ]);
      assert.isTrue(
        progress.every((event) => event.type !== "activity" || event.counters === undefined),
      );
      assert.lengthOf(transcript, successfulEvents().length);
      assert.isTrue(transcript.every((entry) => entry.source === "event"));
    }),
  );

  it.effect("maps low-level command events to stable product activity", () =>
    Effect.gen(function* () {
      const progress: Array<HarnessProgressEvent> = [];
      const transcript: Array<HarnessTranscriptEntry> = [];
      const events: ReadonlyArray<ThreadEvent> = [
        { type: "thread.started", thread_id: "thread-1" },
        { type: "turn.started" },
        {
          type: "item.completed",
          item: {
            id: "command-inputs",
            type: "command_execution",
            command: "jq . inputs/hunks.json",
            aggregated_output: "",
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "command-repository",
            type: "command_execution",
            command: "rg Market repository/src",
            aggregated_output: "",
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "command-workspace",
            type: "command_execution",
            command: "pwd",
            aggregated_output: "",
            exit_code: 0,
            status: "completed",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "nonfatal-error",
            type: "error",
            message: "Raw SDK item error",
          },
        },
        {
          type: "item.completed",
          item: { id: "message-1", type: "agent_message", text: '{"ok":true}' },
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 5,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 3,
          },
        },
      ];
      const harness = makeCodexHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/codex",
        sdk: sdkReturning({}, () => eventStream(events)),
      });

      yield* harness.run(makeTask(progress, transcript)).pipe(Effect.scoped);

      assert.deepStrictEqual(
        progress.filter((event) => event.type === "activity"),
        [
          { type: "activity", action: "Reading the pinned change" },
          { type: "activity", action: "Tracing the change through repository context" },
          { type: "activity", action: "Inspecting the analysis workspace" },
        ],
      );
      assert.isFalse(
        progress.some((event) => JSON.stringify(event).includes("Raw SDK item error")),
      );
      assert.lengthOf(transcript, events.length);
    }),
  );

  it.effect("reports malformed or schema-invalid structured output", () =>
    Effect.gen(function* () {
      for (const response of ['{"ok":"yes"}', "not json"]) {
        const progress: Array<HarnessProgressEvent> = [];
        const harness = makeCodexHarness({
          process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
          resolveBinary: () => "/bundled/codex",
          sdk: sdkReturning({}, () => eventStream(successfulEvents(response))),
        });

        const error = yield* harness.run(makeTask(progress, [])).pipe(Effect.scoped, Effect.flip);

        assert.instanceOf(error, HarnessRunError);
        assert.strictEqual(error.reason, "invalid-output");
        assert.strictEqual(progress.at(-1)?.type, "failed");
        assert.isFalse(progress.some((event) => event.type === "completed"));
      }
    }),
  );

  it.effect("aborts the SDK signal when the owning scope closes", () =>
    Effect.gen(function* () {
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let aborted = false;
      const capture: CapturedCodexCall = {};
      const sdk = sdkReturning(capture, (turnOptions) => ({
        async *[Symbol.asyncIterator]() {
          yield { type: "thread.started", thread_id: "thread-1" } as ThreadEvent;
          await new Promise<void>((_resolve, reject) => {
            markStarted?.();
            turnOptions.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
        },
      }));
      const harness = makeCodexHarness({
        process: processReturning(() => ({ exitCode: 0, stdout: "", stderr: "" })),
        resolveBinary: () => "/bundled/codex",
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
      assert.isTrue(capture.turnOptions?.signal?.aborted);
    }),
  );
});
