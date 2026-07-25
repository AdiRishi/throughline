import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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

const CLAUDE_TOOLS = ["Read", "Glob", "Grep"] as const;

const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
});
const decodeClaudeAuthStatus = Schema.decodeUnknownSync(ClaudeAuthStatus);

export interface ClaudeQuery extends AsyncIterable<SDKMessage> {
  readonly close: () => void;
}

export interface ClaudeSdk {
  readonly query: (parameters: {
    readonly prompt: string;
    readonly options: Options;
  }) => ClaudeQuery;
}

export interface ClaudeHarnessDependencies {
  readonly process: HarnessProcess["Service"];
  readonly sdk?: ClaudeSdk;
  readonly resolveBinary?: () => string | undefined;
  readonly canonicalizePath?: (path: string) => Promise<string>;
}

const realSdk: ClaudeSdk = { query };

const parseAuth = (result: HarnessProcessResult): HarnessAuthState => {
  if (result.exitCode !== 0) {
    return "unknown";
  }
  try {
    const decoded = decodeClaudeAuthStatus(JSON.parse(result.stdout));
    return decoded.loggedIn ? "authenticated" : "unauthenticated";
  } catch {
    return "unknown";
  }
};

const isWithin = (world: string, candidate: string): boolean => {
  const relative = NodePath.relative(world, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};

const isSafeGlob = (pattern: string): boolean =>
  pattern.length > 0 &&
  !pattern.includes("\0") &&
  !pattern.includes("..") &&
  !NodePath.isAbsolute(pattern);

const globPrefix = (pattern: string): ReadonlyArray<string> => {
  const prefix: Array<string> = [];
  for (const segment of pattern.split(/[\\/]/u)) {
    if (/[*?[\]{}!]/u.test(segment)) {
      break;
    }
    if (segment.length > 0) {
      prefix.push(segment);
    }
  }
  return prefix;
};

const candidatePath = (world: string, value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return undefined;
  }
  const candidate = NodePath.resolve(world, value);
  return isWithin(world, candidate) ? candidate : undefined;
};

export const validateClaudeToolPath = async (
  world: string,
  canonicalWorld: string,
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  canonicalizePath: (path: string) => Promise<string>,
): Promise<boolean> => {
  let paths: ReadonlyArray<string>;

  switch (toolName) {
    case "Read": {
      const candidate = candidatePath(world, input.file_path);
      if (candidate === undefined) {
        return false;
      }
      paths = [candidate];
      break;
    }
    case "Glob": {
      if (typeof input.pattern !== "string" || !isSafeGlob(input.pattern)) {
        return false;
      }
      const candidate = input.path === undefined ? world : candidatePath(world, input.path);
      if (candidate === undefined) {
        return false;
      }
      const prefix = globPrefix(input.pattern);
      paths = [candidate, ...(prefix.length === 0 ? [] : [NodePath.resolve(candidate, ...prefix)])];
      break;
    }
    case "Grep": {
      if (typeof input.pattern !== "string" || input.pattern.length === 0) {
        return false;
      }
      if (input.glob !== undefined && (typeof input.glob !== "string" || !isSafeGlob(input.glob))) {
        return false;
      }
      const candidate = input.path === undefined ? world : candidatePath(world, input.path);
      if (candidate === undefined) {
        return false;
      }
      const prefix = typeof input.glob === "string" ? globPrefix(input.glob) : [];
      paths = [candidate, ...(prefix.length === 0 ? [] : [NodePath.resolve(candidate, ...prefix)])];
      break;
    }
    default:
      return false;
  }

  try {
    for (const path of paths) {
      if (!isWithin(world, path) || !isWithin(canonicalWorld, await canonicalizePath(path))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
};

const permissionGate =
  (
    world: string,
    canonicalWorld: string,
    canonicalizePath: (path: string) => Promise<string>,
  ): CanUseTool =>
  async (toolName, input): Promise<PermissionResult> =>
    (await validateClaudeToolPath(world, canonicalWorld, toolName, input, canonicalizePath))
      ? { behavior: "allow", updatedInput: input }
      : {
          behavior: "deny",
          message: "Throughline only permits read operations inside the run world.",
          interrupt: true,
        };

const usageFromClaude = (message: Extract<SDKMessage, { type: "result" }>): HarnessUsage => ({
  inputTokens: message.usage.input_tokens,
  outputTokens: message.usage.output_tokens,
  cachedInputTokens: message.usage.cache_read_input_tokens,
});

const activityFromMessage = (
  message: SDKMessage,
): ReadonlyArray<{ readonly action: string; readonly path?: string }> => {
  if (message.type === "assistant") {
    return message.message.content.flatMap((block) => {
      if (block.type !== "tool_use") {
        return [];
      }
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const path =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.path === "string"
            ? input.path
            : undefined;
      return [
        {
          action: block.name,
          ...(path === undefined ? {} : { path }),
        },
      ];
    });
  }
  if (message.type === "tool_progress") {
    return [{ action: message.tool_name }];
  }
  if (message.type === "tool_use_summary") {
    return [{ action: message.summary }];
  }
  if (message.type === "system" && message.subtype === "status" && message.status !== null) {
    return [{ action: message.status }];
  }
  return [];
};

const runSdk = async <A>(
  task: AnalysisTask<A>,
  binary: string,
  controller: AbortController,
  sdk: ClaudeSdk,
  canonicalizePath: (path: string) => Promise<string>,
): Promise<{
  readonly raw: unknown;
  readonly continuation: string;
  readonly usage: HarnessUsage;
}> => {
  const canonicalWorld = await canonicalizePath(task.world);
  const stderrWrites: Array<Promise<void>> = [];
  const options: Options = {
    cwd: task.world,
    tools: [...CLAUDE_TOOLS],
    allowedTools: [...CLAUDE_TOOLS],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    agents: {},
    additionalDirectories: [],
    abortController: controller,
    outputFormat: {
      type: "json_schema",
      schema: task.outputSchema,
    },
    pathToClaudeCodeExecutable: binary,
    canUseTool: permissionGate(task.world, canonicalWorld, canonicalizePath),
    stderr: (contents) => {
      stderrWrites.push(writeTranscript(task, { source: "stderr", contents }));
    },
    ...(task.continuation === undefined ? {} : { resume: task.continuation }),
  };
  const stream = sdk.query({ prompt: task.prompt, options });

  let continuation: string | undefined;
  let raw: unknown;
  let usage: HarnessUsage | undefined;
  try {
    for await (const message of stream) {
      await writeTranscript(task, {
        source: "event",
        contents: JSON.stringify(message),
      });

      if (message.type === "system" && message.subtype === "init") {
        continuation = message.session_id;
        const actualTools = new Set(message.tools);
        if (
          actualTools.size !== CLAUDE_TOOLS.length ||
          CLAUDE_TOOLS.some((tool) => !actualTools.has(tool))
        ) {
          throw new HarnessRunError({
            kind: "claude",
            reason: "safety",
            detail: "Claude initialized with tools outside the read-only allowlist.",
          });
        }
        await emitProgress(task, { type: "started" });
      }

      if (message.type === "assistant" && message.error === "authentication_failed") {
        throw new HarnessRunError({
          kind: "claude",
          reason: "unauthenticated",
          detail: "Claude authentication expired during analysis.",
        });
      }

      for (const activity of activityFromMessage(message)) {
        if (activity.action.length > 0) {
          await emitProgress(task, { type: "activity", ...activity });
        }
      }

      if (message.type === "result") {
        continuation = message.session_id;
        if (message.subtype !== "success") {
          throw new HarnessRunError({
            kind: "claude",
            reason: "execution",
            detail: message.errors.join("\n") || message.subtype,
          });
        }
        if (message.structured_output === undefined) {
          throw new HarnessRunError({
            kind: "claude",
            reason: "invalid-output",
            detail: "Claude completed without structured output.",
          });
        }
        raw = message.structured_output;
        usage = usageFromClaude(message);
      }
    }
  } finally {
    stream.close();
    await Promise.all(stderrWrites);
  }

  if (continuation === undefined) {
    throw new HarnessRunError({
      kind: "claude",
      reason: "execution",
      detail: "Claude completed without a resumable session id.",
    });
  }
  if (raw === undefined || usage === undefined) {
    throw new HarnessRunError({
      kind: "claude",
      reason: "invalid-output",
      detail: "Claude completed without a successful structured result.",
    });
  }
  return { raw, continuation, usage };
};

export const makeClaudeHarness = (dependencies: ClaudeHarnessDependencies): AnalysisHarness => {
  const resolveBinary = dependencies.resolveBinary ?? (() => resolveHarnessBinary("claude"));
  const sdk = dependencies.sdk ?? realSdk;
  const canonicalizePath =
    dependencies.canonicalizePath ?? ((path: string) => NodeFSP.realpath(path));

  return {
    kind: "claude",

    detect: Effect.suspend(() =>
      detectHarness("claude", resolveBinary(), dependencies.process, ["auth", "status"], parseAuth),
    ),

    run: <A>(task: AnalysisTask<A>) =>
      Effect.gen(function* () {
        if (!NodePath.isAbsolute(task.world)) {
          return yield* new HarnessRunError({
            kind: "claude",
            reason: "safety",
            detail: "The Claude run world must be an absolute path.",
          });
        }
        const binary = resolveBinary();
        if (binary === undefined) {
          return yield* new HarnessRunError({
            kind: "claude",
            reason: "unavailable",
            detail: "The bundled Claude executable is unavailable.",
          });
        }

        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (active) => Effect.sync(() => active.abort()),
        );

        const result = yield* Effect.tryPromise({
          try: () => runSdk(task, binary, controller, sdk, canonicalizePath),
          catch: (cause) =>
            cause instanceof HarnessRunError
              ? cause
              : new HarnessRunError({
                  kind: "claude",
                  reason: "execution",
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())));

        const value = yield* decodeOutput("claude", task, result.raw);
        yield* task.onEvent({ type: "completed" });
        return {
          value,
          continuation: result.continuation,
          usage: result.usage,
        };
      }).pipe(
        Effect.tapError((error) =>
          task.onEvent({ type: "failed", detail: error.detail }).pipe(Effect.ignore),
        ),
      ),
  };
};
