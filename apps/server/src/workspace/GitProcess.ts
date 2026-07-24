import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessEnvironment } from "@app/shared/hostProcess";

export interface GitCommand {
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export class GitProcessError extends Schema.TaggedErrorClass<GitProcessError>()("GitProcessError", {
  reason: Schema.Literals(["unavailable", "transport"]),
  detail: Schema.String,
}) {}

export class GitProcess extends Context.Service<
  GitProcess,
  {
    readonly run: (command: GitCommand) => Effect.Effect<GitCommandResult, GitProcessError>;
  }
>()("@app/server/workspace/GitProcess") {}

const concatenate = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const length = chunks.reduce((total, value) => total + value.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const value of chunks) {
    output.set(value, offset);
    offset += value.byteLength;
  }

  return output;
};

const fromProcessError = (error: {
  readonly message: string;
  readonly reason?: { readonly _tag?: string } | undefined;
}): GitProcessError =>
  new GitProcessError({
    reason: error.reason?._tag === "NotFound" ? "unavailable" : "transport",
    detail: error.message,
  });

export const make = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = environment.GIT_EXECUTABLE_PATH ?? "git";

  const execute = Effect.fn("GitProcess.execute")(function* (command: GitCommand) {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(executable, [...command.args], {
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
          env: {
            ...environment,
            ...command.environment,
            GIT_TERMINAL_PROMPT: "0",
          },
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          shell: false,
          killSignal: "SIGTERM",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(Effect.mapError(fromProcessError));

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.runCollect, Effect.map(concatenate)),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(fromProcessError));

    return {
      exitCode,
      stdout,
      stderr,
    };
  }, Effect.scoped);

  return GitProcess.of({
    run: execute,
  });
});

export const layer = Layer.effect(GitProcess, make);
