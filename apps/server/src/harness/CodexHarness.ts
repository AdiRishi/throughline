import * as NodePath from "node:path";

import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import * as Effect from "effect/Effect";

import type { HarnessAuthState, HarnessUsage } from "@app/contracts";

import {
  type AnalysisHarness,
  type AnalysisTask,
  decodeOutput,
  emitProgress,
  HarnessRunError,
  writeTranscript,
} from "./AnalysisHarness.ts";
import { resolveHarnessBinary } from "./BinaryResolution.ts";
import { detectHarness } from "./HarnessDetection.ts";
import type { HarnessProcess, HarnessProcessResult } from "./HarnessProcess.ts";

interface CodexThread {
  readonly id: string | null;
  readonly runStreamed: (
    input: string,
    options: TurnOptions,
  ) => Promise<{ readonly events: AsyncIterable<ThreadEvent> }>;
}

interface CodexClient {
  readonly startThread: (options: ThreadOptions) => CodexThread;
  readonly resumeThread: (id: string, options: ThreadOptions) => CodexThread;
}

export interface CodexSdkFactory {
  readonly create: (options: CodexOptions) => CodexClient;
}

export interface CodexHarnessDependencies {
  readonly process: HarnessProcess["Service"];
  readonly sdk?: CodexSdkFactory;
  readonly resolveBinary?: () => string | undefined;
}

const realSdk: CodexSdkFactory = {
  create: (options) => new Codex(options),
};

const threadOptions = (world: string): ThreadOptions => ({
  workingDirectory: world,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  skipGitRepoCheck: true,
  networkAccessEnabled: false,
  webSearchMode: "disabled",
});

const parseAuth = (result: HarnessProcessResult): HarnessAuthState => {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (
    output.includes("not logged in") ||
    output.includes("login required") ||
    output.includes("unauthenticated")
  ) {
    return "unauthenticated";
  }
  if (result.exitCode === 0 && output.includes("logged in")) {
    return "authenticated";
  }
  return "unknown";
};

const usageFromCodex = (usage: Usage | undefined): HarnessUsage | undefined =>
  usage === undefined
    ? undefined
    : {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cached_input_tokens,
      };

const commandActivity = (command: string): string => {
  if (/\binputs(?:\/|\b)/u.test(command)) return "Reading the pinned change";
  if (/\brepository(?:\/|\b)/u.test(command)) {
    return "Tracing the change through repository context";
  }
  return "Inspecting the analysis workspace";
};

const activityFromEvent = (
  event: ThreadEvent,
):
  | {
      readonly action: string;
      readonly path?: string;
    }
  | undefined => {
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }

  const item = event.item;
  switch (item.type) {
    case "command_execution":
      return { action: commandActivity(item.command) };
    case "mcp_tool_call":
      return { action: `${item.server}.${item.tool}` };
    case "reasoning":
      return { action: item.text.slice(0, 240) };
    case "todo_list":
      return {
        action: item.items.find((entry) => !entry.completed)?.text ?? "Plan complete",
      };
    case "web_search":
      return { action: `Web search: ${item.query}` };
    case "file_change":
      return {
        action: "File change",
        ...(item.changes[0] === undefined ? {} : { path: item.changes[0].path }),
      };
    case "error":
      return undefined;
    case "agent_message":
      return undefined;
  }
};

const runSdk = async <A>(
  task: AnalysisTask<A>,
  binary: string,
  controller: AbortController,
  sdk: CodexSdkFactory,
): Promise<{
  readonly raw: unknown;
  readonly continuation: string;
  readonly usage?: HarnessUsage;
}> => {
  const client = sdk.create({
    codexPathOverride: binary,
    config: { mcp_servers: {} },
  });
  const options = threadOptions(task.world);
  const thread =
    task.continuation === undefined
      ? client.startThread(options)
      : client.resumeThread(task.continuation, options);
  const streamed = await thread.runStreamed(task.prompt, {
    outputSchema: task.outputSchema,
    signal: controller.signal,
  });

  let continuation = thread.id;
  let finalResponse: string | undefined;
  let usage: Usage | undefined;

  for await (const event of streamed.events) {
    await writeTranscript(task, {
      source: "event",
      contents: JSON.stringify(event),
    });

    if (event.type === "thread.started") {
      continuation = event.thread_id;
      await emitProgress(task, { type: "started" });
      continue;
    }
    if (event.type === "turn.completed") {
      usage = event.usage;
      continue;
    }
    if (event.type === "turn.failed") {
      throw new HarnessRunError({
        kind: "codex",
        reason: "execution",
        detail: event.error.message,
      });
    }
    if (event.type === "error") {
      throw new HarnessRunError({
        kind: "codex",
        reason: "execution",
        detail: event.message,
      });
    }
    if (event.type === "item.completed" && event.item.type === "agent_message") {
      finalResponse = event.item.text;
    }
    if (
      (event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed") &&
      (event.item.type === "web_search" ||
        event.item.type === "mcp_tool_call" ||
        (event.type === "item.completed" &&
          event.item.type === "file_change" &&
          event.item.status === "completed"))
    ) {
      throw new HarnessRunError({
        kind: "codex",
        reason: "safety",
        detail: `Codex reported forbidden ${event.item.type} activity.`,
      });
    }

    const activity = activityFromEvent(event);
    if (activity !== undefined && activity.action.length > 0) {
      await emitProgress(task, { type: "activity", ...activity });
    }
  }

  if (continuation === null) {
    throw new HarnessRunError({
      kind: "codex",
      reason: "execution",
      detail: "Codex completed without a resumable thread id.",
    });
  }
  if (finalResponse === undefined) {
    throw new HarnessRunError({
      kind: "codex",
      reason: "invalid-output",
      detail: "Codex completed without a final structured response.",
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(finalResponse);
  } catch (cause) {
    throw new HarnessRunError({
      kind: "codex",
      reason: "invalid-output",
      detail: "Codex returned malformed JSON.",
      cause,
    });
  }

  const observedUsage = usageFromCodex(usage);
  return {
    raw,
    continuation,
    ...(observedUsage === undefined ? {} : { usage: observedUsage }),
  };
};

export const makeCodexHarness = (dependencies: CodexHarnessDependencies): AnalysisHarness => {
  const resolveBinary = dependencies.resolveBinary ?? (() => resolveHarnessBinary("codex"));
  const sdk = dependencies.sdk ?? realSdk;

  return {
    kind: "codex",

    detect: Effect.suspend(() =>
      detectHarness("codex", resolveBinary(), dependencies.process, ["login", "status"], parseAuth),
    ),

    run: <A>(task: AnalysisTask<A>) =>
      Effect.gen(function* () {
        if (!NodePath.isAbsolute(task.world)) {
          return yield* new HarnessRunError({
            kind: "codex",
            reason: "safety",
            detail: "The Codex run world must be an absolute path.",
          });
        }
        const binary = resolveBinary();
        if (binary === undefined) {
          return yield* new HarnessRunError({
            kind: "codex",
            reason: "unavailable",
            detail: "The bundled Codex executable is unavailable.",
          });
        }

        const activeRun = yield* Effect.acquireRelease(
          Effect.sync(() => ({
            controller: new AbortController(),
            settled: false,
          })),
          (active) => (active.settled ? Effect.void : Effect.sync(() => active.controller.abort())),
        );

        const result = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await runSdk(task, binary, activeRun.controller, sdk);
            } finally {
              activeRun.settled = true;
            }
          },
          catch: (cause) =>
            cause instanceof HarnessRunError
              ? cause
              : new HarnessRunError({
                  kind: "codex",
                  reason: "execution",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => activeRun.controller.abort())));

        const value = yield* decodeOutput("codex", task, result.raw);
        yield* task.onEvent({ type: "completed" });
        return {
          value,
          continuation: result.continuation,
          ...(result.usage === undefined ? {} : { usage: result.usage }),
        };
      }).pipe(
        Effect.tapError((error) =>
          task.onEvent({ type: "failed", detail: error.detail }).pipe(Effect.ignore),
        ),
      ),
  };
};
