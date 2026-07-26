/**
 * The one way this server runs an external command.
 *
 * `ChildProcessSpawner`'s convenience helpers (`string`, `lines`) collect
 * stdout without ever looking at the exit code, which is exactly the wrong
 * default for `gh` and `git`: a failed call would look like an empty success.
 * This module always waits for the exit code and hands it back with both
 * streams, so callers classify the outcome deliberately.
 *
 * The child is scoped: closing the calling scope kills it. Nothing here retries
 * — retry policy belongs to the module that knows what the command meant.
 *
 * @module process/Subprocess
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

export interface CommandOutcome {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The command could not be run at all — missing binary, bad cwd, timeout. */
export class CommandFailedError extends Schema.TaggedErrorClass<CommandFailedError>()(
  "CommandFailedError",
  {
    command: Schema.String,
    reason: Schema.Literals(["spawn-failed", "timed-out", "interrupted"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `${this.command} could not run (${this.reason}): ${this.detail}`;
  }
}

export interface RunOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
  /** Hard ceiling. A `gh` or `git` call that hangs must not hang ingestion. */
  readonly timeout?: Duration.Input | undefined;
  /** Decoded output is capped so a runaway command cannot exhaust memory. */
  readonly maxOutputBytes?: number | undefined;
}

const DEFAULT_TIMEOUT = Duration.seconds(120);
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const describe = (options: RunOptions): string => [options.command, ...options.args].join(" ");

/**
 * Run a command to completion. Succeeds with the outcome whatever the exit code
 * is; fails only when the process could not produce one.
 */
export const run = Effect.fn("subprocess.run")(function* (options: RunOptions) {
  const label = describe(options);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(options.command, [...options.args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    extendEnv: true,
    // Never inherit stdin: a subprocess that decides to prompt would otherwise
    // block the server on a terminal nobody is watching.
    stdin: "pipe",
  });

  const outcome = yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(command);
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.scan("", (accumulated, chunk) =>
          accumulated.length >= limit ? accumulated : accumulated + chunk,
        ),
        Stream.runLast,
        Effect.map(Option.getOrElse(() => "")),
      );

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collect(handle.stdout),
        collect(handle.stderr),
        // A child killed by a signal has no exit code; report it as one so the
        // caller sees "did not succeed" rather than a spawn failure.
        handle.exitCode.pipe(Effect.orElseSucceed(() => -1 as number)),
      ],
      { concurrency: 3 },
    );

    return { command: label, exitCode: exitCode as number, stdout, stderr };
  }).pipe(
    Effect.scoped,
    // The scope closes on timeout, so the child dies with it — a hung `gh` or
    // `git` can never outlive the call that started it.
    Effect.timeoutOrElse({
      duration: options.timeout ?? DEFAULT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new CommandFailedError({
            command: label,
            reason: "timed-out",
            detail: `no result within ${Duration.format(Duration.fromInputUnsafe(options.timeout ?? DEFAULT_TIMEOUT))}`,
          }),
        ),
    }),
    Effect.catch((cause: unknown) =>
      Effect.fail(
        cause instanceof CommandFailedError
          ? cause
          : new CommandFailedError({
              command: label,
              reason: "spawn-failed",
              detail: String(cause),
            }),
      ),
    ),
  );

  yield* Effect.annotateCurrentSpan({
    "process.command": options.command,
    "process.exitCode": outcome.exitCode,
  });
  return outcome;
});

/**
 * A command runner with the spawner already captured.
 *
 * Long-lived services build one of these at construction so that running a
 * command does not leak `ChildProcessSpawner` into the requirements of every
 * method they expose — a service interface should describe what it does, not
 * what it is built from.
 */
export type Runner = (options: RunOptions) => Effect.Effect<CommandOutcome, CommandFailedError>;

export const makeRunner: Effect.Effect<Runner, never, ChildProcessSpawner.ChildProcessSpawner> =
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return (options: RunOptions) =>
      Effect.provideService(run(options), ChildProcessSpawner.ChildProcessSpawner, spawner);
  });

/** True when the command reported success. */
export const succeeded = (outcome: CommandOutcome): boolean => outcome.exitCode === 0;

/** stderr, trimmed to something a UI can show without a scrollbar. */
export const briefError = (outcome: CommandOutcome, limit = 400): string => {
  const text = (outcome.stderr.trim().length > 0 ? outcome.stderr : outcome.stdout).trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
};
