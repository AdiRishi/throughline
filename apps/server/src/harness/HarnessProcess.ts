import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface HarnessProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class HarnessProcessError extends Schema.TaggedErrorClass<HarnessProcessError>()(
  "HarnessProcessError",
  {
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class HarnessProcess extends Context.Service<
  HarnessProcess,
  {
    readonly run: (
      executable: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<HarnessProcessResult, HarnessProcessError>;
  }
>()("@app/server/harness/HarnessProcess") {}

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return HarnessProcess.of({
    run: (executable, args) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(executable, [...args], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              shell: false,
              killSignal: "SIGTERM",
              forceKillAfter: "2 seconds",
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
              handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { exitCode, stdout, stderr };
        }),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(
          (cause) =>
            new HarnessProcessError({
              detail: `Failed to run ${executable}.`,
              cause,
            }),
        ),
      ),
  });
});

export const layer = Layer.effect(HarnessProcess, make);
