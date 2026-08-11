// @effect-diagnostics nodeBuiltinImport:off - Test writes a real server entry to a scratch directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { NetService, type NetServiceShape } from "@app/shared/Net";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopObservability from "../../src/app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../../src/backend/DesktopBackendConfiguration.ts";
import {
  makeManager,
  runBackendProcess,
  type DesktopBackendManagerShape,
} from "../../src/backend/DesktopBackendManager.ts";

const PORT = 34_567;

// A real file on disk so the manager's entry-exists preflight passes.
const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-manager-test-"));
const ENTRY_PATH = NodePath.join(SCRATCH, "bin.mjs");
NodeFS.writeFileSync(ENTRY_PATH, "// fake server entry\n");
const LOG_DIR_HOME = NodePath.join(SCRATCH, "home");

// The readiness probe uses the global fetch (FetchHttpClient); answer 200.
beforeEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response("ok", { status: 200 });
});

const directConfig: DesktopBackendConfiguration.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: [ENTRY_PATH, "--bootstrap-fd", "3"],
  entryPath: ENTRY_PATH,
  cwd: SCRATCH,
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrapEnvelope: { desktopBootstrapToken: "token", port: PORT },
  port: PORT,
  bootstrapToken: "token",
  httpBaseUrl: new URL(`http://127.0.0.1:${PORT}`),
};

const fakeNet: NetServiceShape = {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(PORT),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
};

interface SpawnedChild {
  readonly exit: Deferred.Deferred<number>;
  killed: boolean;
}

interface ScriptedSpawnerInput {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  /** Runs inside the child's scope finalizer, before its exit resolves. */
  readonly onTeardown?: (spawnOrdinal: number) => Effect.Effect<void>;
}

/** A spawner whose children exit when the test says so (or when killed). */
const makeScriptedSpawner = (input?: ScriptedSpawnerInput) =>
  Effect.gen(function* () {
    const children = yield* Ref.make<ReadonlyArray<SpawnedChild>>([]);
    const spawnCount = Ref.get(children).pipe(Effect.map((all) => all.length));

    const spawner = ChildProcessSpawner.make((_command) =>
      Effect.gen(function* () {
        const exit = yield* Deferred.make<number>();
        const child: SpawnedChild = { exit, killed: false };
        const ordinal = yield* Ref.modify(children, (all) => [
          all.length + 1,
          [...all, child] as ReadonlyArray<SpawnedChild>,
        ]);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* input?.onTeardown?.(ordinal) ?? Effect.void;
            child.killed = true;
            yield* Deferred.succeed(exit, 0).pipe(Effect.asVoid);
          }),
        );
        return {
          pid: 4242,
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          kill: () =>
            Effect.suspend(() => {
              child.killed = true;
              return Deferred.succeed(exit, 0 as never).pipe(Effect.asVoid);
            }),
          stdin: undefined,
          stdout: input?.stdout ?? Stream.make(new TextEncoder().encode("hello from server\n")),
          stderr: input?.stderr ?? Stream.make(new TextEncoder().encode("server warning\n")),
          all: Stream.empty,
        } as unknown as ChildProcessSpawner.ChildProcessHandle;
      }),
    );

    const exitCurrent = (code: number) =>
      Ref.get(children).pipe(
        Effect.flatMap((all) => {
          const current = all[all.length - 1];
          return current === undefined
            ? Effect.die("exitCurrent before any spawn")
            : Deferred.succeed(current.exit, code).pipe(Effect.asVoid);
        }),
      );

    const currentKilled = Ref.get(children).pipe(
      Effect.map((all) => all[all.length - 1]?.killed ?? false),
    );

    return { spawner, spawnCount, exitCurrent, currentKilled };
  });

interface HarnessInput {
  readonly isPackaged?: boolean;
  readonly entry?: string;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly spawner?: ScriptedSpawnerInput;
  /** 1-based resolve attempts that fail instead of producing a start config. */
  readonly failResolveOnAttempts?: ReadonlyArray<number>;
}

const environmentLayer = (input?: HarnessInput) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: NodePath.join(SCRATCH, "dist-electron"),
          homeDirectory: LOG_DIR_HOME,
          platform: "darwin",
          appVersion: "0.0.0-test",
          appPath: SCRATCH,
          isPackaged: input?.isPackaged ?? false,
          resourcesPath: NodePath.join(SCRATCH, "resources"),
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.some(input?.entry ?? ENTRY_PATH),
          logDirOverride: Option.none(),
          logLevel: Option.none(),
          otlpTracesUrl: Option.none(),
          otlpExportIntervalMs: Option.none(),
          configuredBackendPort: Option.some(PORT),
          devServerUrl: Option.none(),
          processArch: "arm64",
          runningUnderArm64Translation: false,
          appImagePath: Option.none(),
          disableAutoUpdate: false,
        },
        path,
      ),
    ),
  );

// The real configuration service, with scripted resolve failures layered on top.
const configurationLayer = (input?: HarnessInput) =>
  Layer.effect(
    DesktopBackendConfiguration.DesktopBackendConfiguration,
    Effect.gen(function* () {
      const base = yield* DesktopBackendConfiguration.make;
      const attempts = yield* Ref.make(0);
      const failOn = input?.failResolveOnAttempts ?? [];
      return {
        ...base,
        resolve: (resolveInput: { readonly port: number }) =>
          Ref.updateAndGet(attempts, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              failOn.includes(attempt)
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "Unknown",
                      module: "DesktopBackendConfiguration",
                      method: "resolve",
                      description: "transient configuration failure",
                    }),
                  )
                : base.resolve(resolveInput),
            ),
          ),
      };
    }),
  );

interface Harness {
  readonly manager: DesktopBackendManagerShape;
  readonly spawnCount: Effect.Effect<number>;
  readonly exitCurrent: (code: number) => Effect.Effect<void>;
  readonly currentKilled: Effect.Effect<boolean>;
  readonly awaitReady: Effect.Effect<void>;
  readonly notReadyCount: Effect.Effect<number>;
}

const makeHarness = (input?: HarnessInput) =>
  Effect.gen(function* () {
    const scripted = yield* makeScriptedSpawner(input?.spawner);
    const readyLatch = yield* Deferred.make<void>();
    const notReadyHits = yield* Ref.make(0);

    const manager = yield* makeManager({
      onReady: () => Deferred.succeed(readyLatch, undefined).pipe(Effect.asVoid),
      onNotReady: Ref.update(notReadyHits, (n) => n + 1),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted.spawner),
      Effect.provideService(NetService, fakeNet),
      Effect.provideService(DesktopObservability.DesktopBackendOutputLog, {
        ...DesktopObservability.DesktopBackendOutputLogNoop,
        ...input?.backendOutputLog,
      }),
      Effect.provide(
        configurationLayer(input).pipe(
          Layer.provideMerge(environmentLayer(input)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    );

    return {
      manager,
      spawnCount: scripted.spawnCount,
      exitCurrent: scripted.exitCurrent,
      currentKilled: scripted.currentKilled,
      awaitReady: Deferred.await(readyLatch),
      notReadyCount: Ref.get(notReadyHits),
    } satisfies Harness;
  });

// TestClock.adjust only fires timers that are already registered, and each rung
// of the restart ladder registers the next one from inside the fiber the
// previous rung woke, so step the clock until the expected spawn lands.
const advanceUntilSpawn = (harness: Harness, target: number) =>
  Effect.gen(function* () {
    for (let step = 0; step < 20; step += 1) {
      if ((yield* harness.spawnCount) >= target) {
        return;
      }
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
    }
  });

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend and reveals the window on readiness", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* harness.manager.start;
      yield* harness.awaitReady;

      assert.equal(yield* harness.spawnCount, 1);
      const config = yield* harness.manager.currentConfig;
      assert.isTrue(Option.isSome(config));
      if (Option.isSome(config)) {
        assert.equal(config.value.port, PORT);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("restarts with backoff after an unexpected exit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });

      yield* TestClock.adjust("500 millis");
      yield* Effect.gen(function* () {
        while ((yield* harness.spawnCount) < 2) {
          yield* Effect.yieldNow;
        }
      });
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("stop kills the child and does not restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.manager.stop();
      assert.isTrue(yield* harness.currentKilled);

      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });

      yield* harness.manager.start;
      yield* Effect.gen(function* () {
        while ((yield* harness.spawnCount) < 2) {
          yield* Effect.yieldNow;
        }
      });

      yield* harness.manager.stop();
      yield* TestClock.adjust("500 millis");
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });

      yield* harness.manager.stop();
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not spawn when the server entry is missing, and keeps retrying", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ entry: NodePath.join(SCRATCH, "missing.mjs") });
      yield* harness.manager.start;

      yield* TestClock.adjust("500 millis");
      yield* TestClock.adjust("1 second");
      assert.equal(yield* harness.spawnCount, 0);
      assert.isTrue(Option.isSome(yield* harness.manager.currentConfig));
    }).pipe(Effect.scoped),
  );

  it.effect("reports the child's output and session start to the backend output log", () =>
    Effect.gen(function* () {
      const chunks: Array<{ stream: string; text: string }> = [];
      const sessions: Array<string> = [];
      const decoder = new TextDecoder();

      const harness = yield* makeHarness({
        isPackaged: true,
        backendOutputLog: {
          beginSession: ({ details }) =>
            Effect.sync(() => {
              sessions.push(details);
            }),
          writeOutputChunk: (stream, chunk) =>
            Effect.sync(() => {
              chunks.push({ stream, text: decoder.decode(chunk) });
            }),
        },
      });

      yield* harness.manager.start;
      yield* harness.awaitReady;
      while (chunks.length < 2) {
        yield* Effect.yieldNow;
      }

      assert.deepStrictEqual(
        chunks.toSorted((a, b) => a.stream.localeCompare(b.stream)),
        [
          { stream: "stderr", text: "server warning\n" },
          { stream: "stdout", text: "hello from server\n" },
        ],
      );

      assert.strictEqual(sessions.length, 1);
      assert.include(sessions[0] ?? "", "pid=4242");
      assert.include(sessions[0] ?? "", `port=${PORT}`);
    }).pipe(Effect.scoped),
  );

  it.effect("persists the session when the child exits unexpectedly", () =>
    Effect.gen(function* () {
      const failures: Array<string> = [];
      let discarded = 0;

      const harness = yield* makeHarness({
        backendOutputLog: {
          persistFailure: ({ details }) =>
            Effect.sync(() => {
              failures.push(details);
            }),
          discardSession: Effect.sync(() => {
            discarded += 1;
          }),
        },
      });

      yield* harness.manager.start;
      yield* harness.awaitReady;
      yield* harness.exitCurrent(1);
      while (failures.length < 1) {
        yield* Effect.yieldNow;
      }

      assert.include(failures[0] ?? "", "code=1");
      assert.include(failures[0] ?? "", "pid=4242");
      assert.strictEqual(discarded, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("discards the session and clears the readiness latch on stop", () =>
    Effect.gen(function* () {
      const failures: Array<string> = [];
      let discarded = 0;

      const harness = yield* makeHarness({
        backendOutputLog: {
          persistFailure: ({ details }) =>
            Effect.sync(() => {
              failures.push(details);
            }),
          discardSession: Effect.sync(() => {
            discarded += 1;
          }),
        },
      });

      yield* harness.manager.start;
      yield* harness.awaitReady;
      yield* harness.manager.stop();

      assert.deepStrictEqual(failures, []);
      assert.strictEqual(discarded, 1);
      assert.equal(yield* harness.notReadyCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("reschedules a restart when resolving the configuration fails", () =>
    Effect.gen(function* () {
      // The second resolve — the one the post-crash restart makes — fails.
      const harness = yield* makeHarness({ failResolveOnAttempts: [2] });

      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      while ((yield* harness.notReadyCount) < 1) {
        yield* Effect.yieldNow;
      }

      yield* advanceUntilSpawn(harness, 2);
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("reports child exit before waiting for trailing output to drain", () =>
    Effect.gen(function* () {
      const exitObserved = yield* Deferred.make<void>();
      const finishOutputDrain = yield* Deferred.make<void>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4242),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.fromEffect(
              Deferred.await(finishOutputDrain).pipe(
                Effect.as(new TextEncoder().encode("trailing output\n")),
              ),
            ),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      );

      const runFiber = yield* runBackendProcess(
        directConfig,
        DesktopObservability.DesktopBackendOutputLogNoop,
        {
          onStarted: () => Effect.void,
          onExitObserved: Deferred.succeed(exitObserved, undefined).pipe(Effect.asVoid),
          onReady: Effect.void,
          onReadinessFailure: () => Effect.void,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.provide(FileSystem.layerNoop({})),
        Effect.orDie,
        Effect.scoped,
        Effect.forkChild,
      );

      yield* Deferred.await(exitObserved);
      for (let step = 0; step < 10; step += 1) {
        yield* Effect.yieldNow;
      }
      assert.isUndefined(runFiber.pollUnsafe());

      yield* Deferred.succeed(finishOutputDrain, undefined);
      const exit = yield* Fiber.join(runFiber);
      assert.deepStrictEqual(exit.code, Option.some(1));
    }),
  );

  // A drain that dies quietly is indistinguishable from a child that printed
  // nothing, which is the worst possible failure mode for `server-child.log`.
  it.effect("reports a failure to read the child's output instead of swallowing it", () =>
    Effect.gen(function* () {
      const logged: Array<string> = [];
      const captureLogger = Logger.make<unknown, void>(({ message }) => {
        logged.push(String(message));
      });

      const readFailure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "stdout",
        description: "stdout pipe collapsed",
      });

      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4242),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.fail(readFailure),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
      );

      const exit = yield* runBackendProcess(
        directConfig,
        DesktopObservability.DesktopBackendOutputLogNoop,
        {
          onStarted: () => Effect.void,
          onExitObserved: Effect.void,
          onReady: Effect.void,
          onReadinessFailure: () => Effect.void,
        },
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({}),
            Logger.layer([captureLogger], { mergeWithExisting: false }),
          ),
        ),
        Effect.orDie,
        Effect.scoped,
      );

      // The run itself is unaffected: a broken log must not take the backend down.
      assert.deepStrictEqual(exit.code, Option.some(0));
      assert.isTrue(
        logged.some((message) =>
          message.includes("Failed to read stdout from desktop backend process 4242"),
        ),
        `expected the stdout read failure to be logged, got [${logged.join(" | ")}]`,
      );
    }),
  );

  it.effect("drains trailing child output before persisting an unexpected exit", () =>
    Effect.gen(function* () {
      const outputDrainStarted = yield* Deferred.make<void>();
      const persistedOutput = yield* Deferred.make<ReadonlyArray<string>>();
      const chunks: Array<string> = [];
      const decoder = new TextDecoder();

      const harness = yield* makeHarness({
        spawner: {
          stdout: Stream.fromEffect(
            Deferred.succeed(outputDrainStarted, undefined).pipe(
              Effect.andThen(Effect.sleep("1 second")),
              Effect.as(new TextEncoder().encode("trailing output\n")),
            ),
          ),
          stderr: Stream.empty,
        },
        backendOutputLog: {
          writeOutputChunk: (_stream, chunk) =>
            Effect.sync(() => {
              chunks.push(decoder.decode(chunk));
            }),
          persistFailure: () => Deferred.succeed(persistedOutput, [...chunks]).pipe(Effect.asVoid),
        },
      });

      yield* harness.manager.start;
      yield* Deferred.await(outputDrainStarted);
      yield* harness.exitCurrent(1);
      yield* TestClock.adjust("1 second");

      assert.deepStrictEqual(yield* Deferred.await(persistedOutput), ["trailing output\n"]);
    }).pipe(Effect.scoped),
  );

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.gen(function* () {
      const teardownStarted = yield* Deferred.make<void>();
      const finishTeardown = yield* Deferred.make<void>();

      const harness = yield* makeHarness({
        spawner: {
          onTeardown: (ordinal) =>
            ordinal === 1
              ? Deferred.succeed(teardownStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(finishTeardown)),
                  Effect.asVoid,
                )
              : Effect.void,
        },
      });

      yield* harness.manager.start;
      yield* harness.awaitReady;
      assert.equal(yield* harness.spawnCount, 1);

      const stopFiber = yield* harness.manager.stop().pipe(Effect.forkChild);
      yield* Deferred.await(teardownStarted);

      yield* harness.manager.start;
      for (let step = 0; step < 10; step += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(yield* harness.spawnCount, 1);

      yield* Deferred.succeed(finishTeardown, undefined);
      yield* Fiber.join(stopFiber);

      yield* advanceUntilSpawn(harness, 2);
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );
});
