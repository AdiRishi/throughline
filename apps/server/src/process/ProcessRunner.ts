import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface ProcessResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export class ProcessFailed extends Data.TaggedError("ProcessFailed")<{
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly stderr: string;
  readonly cause?: unknown;
}> {}

export interface ProcessOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      options?: ProcessOptions,
    ) => Effect.Effect<ProcessResult, ProcessFailed>;
  }
>()("@app/server/process/ProcessRunner") {}

export const layer = Layer.effect(
  ProcessRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ProcessRunner.of({
      run: (command, args, options) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, args, {
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options?.env === undefined ? {} : { env: options.env }),
              }),
            );
            const [stdoutChunks, stderr, exitCode] = yield* Effect.all(
              [
                Stream.runCollect(handle.stdout),
                Stream.decodeText(handle.stderr).pipe(Stream.mkString),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (exitCode !== 0) {
              return yield* new ProcessFailed({
                command,
                exitCode,
                stderr: stderr.trim(),
              });
            }
            return { stdout: concatBytes(stdoutChunks), stderr };
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof ProcessFailed
              ? error
              : new ProcessFailed({
                  command,
                  exitCode: undefined,
                  stderr: String(error),
                  cause: error,
                }),
          ),
        ),
    });
  }),
);
