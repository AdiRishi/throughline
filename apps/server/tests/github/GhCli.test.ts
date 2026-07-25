import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { HostProcessEnvironment, HostProcessPlatform } from "@app/shared/hostProcess";

import * as GhCli from "../../src/github/GhCli.ts";

const encoder = new TextEncoder();

function handle(input?: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: input?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: input?.stdout === undefined ? Stream.empty : Stream.make(encoder.encode(input.stdout)),
    stderr: input?.stderr === undefined ? Stream.empty : Stream.make(encoder.encode(input.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

const makeCli = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  GhCli.make.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(HostProcessEnvironment, {
      GH_EXECUTABLE_PATH: import.meta.filename,
      PATH: "/custom/bin",
    }),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provide(NodeServices.layer),
  );

describe("GhCli", () => {
  it.effect("passes arguments without a shell and captures a nonzero result", () =>
    Effect.gen(function* () {
      const commands = yield* Ref.make<ReadonlyArray<ChildProcess.Command>>([]);
      const spawner = ChildProcessSpawner.make((command) =>
        Ref.update(commands, (all) => [...all, command]).pipe(
          Effect.as(
            handle({
              stdout: '{"message":"not found"}\n',
              stderr: "gh: Not Found (HTTP 404)\n",
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            }),
          ),
        ),
      );
      const cli = yield* makeCli(spawner);
      const args = ["api", "repos/owner/repo", "--field", "q=$(touch ignored)"];

      const result = yield* cli.run({ args });

      assert.deepEqual(result, {
        exitCode: 1,
        stdout: '{"message":"not found"}\n',
        stderr: "gh: Not Found (HTTP 404)\n",
      });
      const spawned = yield* Ref.get(commands);
      assert.lengthOf(spawned, 1);
      const [command] = spawned;
      assert.equal(command?._tag, "StandardCommand");
      if (command?._tag === "StandardCommand") {
        assert.equal(command.command, import.meta.filename);
        assert.deepEqual(command.args, args);
        assert.equal(command.options.shell, false);
        assert.equal(command.options.extendEnv, false);
        assert.match(command.options.env?.PATH ?? "", /\/custom\/bin/u);
      }
    }),
  );

  it.effect("classifies a missing executable as unavailable", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "command not found",
          }),
        ),
      );
      const cli = yield* makeCli(spawner);

      const error = yield* cli.run({ args: ["auth", "status"] }).pipe(Effect.flip);

      assert.instanceOf(error, GhCli.GhCliError);
      assert.equal(error.reason, "unavailable");
    }),
  );

  it.effect("interrupts and finalizes the process when an external signal aborts", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Ref.make(false);
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Ref.set(finalized, true));
          yield* Deferred.succeed(started, undefined);
          return handle({ exitCode: Effect.never });
        }),
      );
      const cli = yield* makeCli(spawner);
      const controller = new AbortController();

      const fiber = yield* cli
        .run({ args: ["api", "user"], signal: controller.signal })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Effect.sync(() => controller.abort());
      const result = yield* Fiber.await(fiber);

      assert.isTrue(Exit.hasInterrupts(result));
      assert.isTrue(yield* Ref.get(finalized));
    }),
  );
});
