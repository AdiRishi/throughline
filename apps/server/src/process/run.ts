/**
 * Running an external process, once, correctly.
 *
 * Throughline shells out to three tools — `gh`, `git`, and the harness CLIs — and
 * every one of them has the same two ways to go wrong. Both are handled here so
 * no caller has to remember them:
 *
 * - **Both pipes are drained concurrently with awaiting the exit.** A child that
 *   fills the OS pipe buffer never exits if nobody is reading, so awaiting the
 *   exit code first deadlocks on exactly the outputs worth capturing.
 * - **The spawn lives inside its own scope.** A timeout's interrupt closes that
 *   scope, which reaps the process group — otherwise a timeout leaks a child that
 *   keeps running with nobody listening.
 *
 * @module process/run
 */
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** The process could not be started, or did not finish in time. */
export class ProcessFailedError extends Data.TaggedError("ProcessFailedError")<{
  readonly executable: string;
  readonly detail: string;
}> {}

const DEFAULT_TIMEOUT: Duration.Input = "45 seconds";

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeout?: Duration.Input;
}

/**
 * Run a process and capture both pipes as text. A non-zero exit is **returned**,
 * not failed — classification is the caller's job, because what a non-zero exit
 * means is entirely tool-specific (`gh` 4xx is an answer; `git` non-zero is a
 * fault).
 */
export const runProcess = Effect.fn("process.run")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
): Effect.fn.Return<ProcessResult, ProcessFailedError, ChildProcessSpawner.ChildProcessSpawner> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(executable, [...args], {
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: options.env, extendEnv: true }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "2 seconds",
  });

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      return { stdout, stderr, exitCode: exitCode as number } satisfies ProcessResult;
    }),
  ).pipe(
    Effect.timeout(options?.timeout ?? DEFAULT_TIMEOUT),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProcessFailedError({ executable, detail: `${executable} did not finish in time.` }),
      ),
    ),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ProcessFailedError({ executable, detail: cause.message })),
    ),
  );
});

/** The same, capturing stdout as raw bytes — for `git show` on a binary blob. */
export const runProcessBytes = Effect.fn("process.runBytes")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options?: RunOptions,
): Effect.fn.Return<
  { readonly stdout: Uint8Array; readonly stderr: string; readonly exitCode: number },
  ProcessFailedError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(executable, [...args], {
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options?.env === undefined ? {} : { env: options.env, extendEnv: true }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: "2 seconds",
  });

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [chunks, stderr, exitCode] = yield* Effect.all(
        [
          Stream.runCollect(handle.stdout),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      return { stdout: concat(chunks), stderr, exitCode: exitCode as number };
    }),
  ).pipe(
    Effect.timeout(options?.timeout ?? "2 minutes"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ProcessFailedError({ executable, detail: `${executable} did not finish in time.` }),
      ),
    ),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new ProcessFailedError({ executable, detail: cause.message })),
    ),
  );
});

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/** The first non-empty line of some output, trimmed. Every tool needs this. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}
