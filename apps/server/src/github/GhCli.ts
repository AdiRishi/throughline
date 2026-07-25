import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessEnvironment, HostProcessPlatform } from "@app/shared/hostProcess";

export interface GhCliCommand {
  readonly args: ReadonlyArray<string>;
  readonly signal?: AbortSignal | undefined;
}

export interface GhCliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GhCliError extends Schema.TaggedErrorClass<GhCliError>()("GhCliError", {
  reason: Schema.Literals(["unavailable", "transport"]),
  detail: Schema.String,
}) {}

export class GhCli extends Context.Service<
  GhCli,
  {
    readonly run: (command: GhCliCommand) => Effect.Effect<GhCliResult, GhCliError>;
  }
>()("@app/server/github/GhCli") {}

function commonExecutables(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
): ReadonlyArray<string> {
  if (platform === "win32") {
    return [
      environment.LOCALAPPDATA === undefined
        ? undefined
        : path.join(environment.LOCALAPPDATA, "GitHub CLI", "gh.exe"),
      environment.ProgramFiles === undefined
        ? undefined
        : path.join(environment.ProgramFiles, "GitHub CLI", "gh.exe"),
      environment["ProgramFiles(x86)"] === undefined
        ? undefined
        : path.join(environment["ProgramFiles(x86)"], "GitHub CLI", "gh.exe"),
    ].filter((candidate): candidate is string => candidate !== undefined);
  }

  const userLocal =
    environment.HOME === undefined ? undefined : path.join(environment.HOME, ".local", "bin", "gh");

  return platform === "darwin"
    ? [userLocal, "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].filter(
        (candidate): candidate is string => candidate !== undefined,
      )
    : [
        userLocal,
        "/home/linuxbrew/.linuxbrew/bin/gh",
        "/usr/local/bin/gh",
        "/usr/bin/gh",
        "/snap/bin/gh",
      ].filter((candidate): candidate is string => candidate !== undefined);
}

function searchDirectories(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  path: Path.Path,
  executable: string,
): ReadonlyArray<string> {
  const delimiter = platform === "win32" ? ";" : ":";
  const existingPath = environment.PATH ?? environment.Path ?? "";
  const existingDirectories = existingPath.split(delimiter).filter((entry) => entry.length > 0);
  const candidateDirectories = commonExecutables(platform, environment, path).map(path.dirname);
  const executableDirectory = path.isAbsolute(executable) ? [path.dirname(executable)] : [];

  return [
    ...new Set([
      ...executableDirectory,
      ...candidateDirectories,
      ...existingDirectories,
      ...(platform === "win32"
        ? []
        : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]),
    ]),
  ];
}

const discoverExecutable = Effect.fn("GhCli.discoverExecutable")(function* (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const explicit = environment.GH_EXECUTABLE_PATH ?? environment.GH_PATH;
  if (explicit !== undefined && path.isAbsolute(explicit)) {
    const exists = yield* fileSystem.exists(explicit).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return explicit;
    }
  }

  for (const candidate of commonExecutables(platform, environment, path)) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      return candidate;
    }
  }

  return platform === "win32" ? "gh.exe" : "gh";
});

function fromPlatformError(error: PlatformError.PlatformError): GhCliError {
  return new GhCliError({
    reason: error.reason._tag === "NotFound" ? "unavailable" : "transport",
    detail: error.message,
  });
}

const externalAbort = { _tag: "ExternalAbort" } as const;

function interruptOnAbort<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E, R> {
  if (signal === undefined) {
    return effect;
  }
  if (signal.aborted) {
    return Effect.interrupt;
  }

  const aborted = Effect.callback<typeof externalAbort>((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed(externalAbort));
      return;
    }

    const onAbort = () => {
      resume(Effect.succeed(externalAbort));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

  const raced: Effect.Effect<Result.Result<A, typeof externalAbort>, E, R> = Effect.raceFirst(
    effect.pipe(Effect.map(Result.succeed)),
    aborted.pipe(Effect.map(Result.fail)),
  );

  return raced.pipe(
    Effect.flatMap(
      Result.match({
        onFailure: () => Effect.interrupt,
        onSuccess: Effect.succeed,
      }),
    ),
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const executable = yield* discoverExecutable(platform, environment, fileSystem, path);
  const delimiter = platform === "win32" ? ";" : ":";
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PATH: searchDirectories(platform, environment, path, executable).join(delimiter),
  };

  const execute = Effect.fn("GhCli.execute")(function* (
    command: GhCliCommand,
  ): Effect.fn.Return<GhCliResult, GhCliError, Scope.Scope> {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make(executable, [...command.args], {
          env: childEnvironment,
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          shell: false,
          killSignal: "SIGTERM",
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(Effect.mapError(fromPlatformError));

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(fromPlatformError));

    return {
      exitCode,
      stdout,
      stderr,
    };
  }, Effect.scoped);

  return GhCli.of({
    run: (command) => interruptOnAbort(execute(command), command.signal),
  });
});

export const layer = Layer.effect(GhCli, make);
