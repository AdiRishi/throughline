import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { NetService, type NetServiceShape } from "@app/shared/Net";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopObservability from "../../src/app/DesktopObservability.ts";
import * as DesktopBackendConfiguration from "../../src/backend/DesktopBackendConfiguration.ts";
import {
  DesktopBackendManager,
  layer as desktopBackendManagerLayer,
  makeManager,
  type DesktopBackendManagerShape,
} from "../../src/backend/DesktopBackendManager.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

const PORT = 34_567;

// A real file on disk so the manager's entry-exists preflight passes.
const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-manager-test-"));
const ENTRY_PATH = NodePath.join(SCRATCH, "bin.mjs");
NodeFS.writeFileSync(ENTRY_PATH, "// fake server entry\n");
const LOG_DIR_HOME = NodePath.join(SCRATCH, "home");
const BACKEND_LOG_FILE_LIMIT_BYTES = 8 * 1024 * 1024;

// The readiness probe uses the global fetch (FetchHttpClient); answer 200.
beforeEach(() => {
  (globalThis as { fetch: typeof fetch }).fetch = async () => new Response("ok", { status: 200 });
});

const fakeNet: NetServiceShape = {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  reserveLoopbackPort: () => Effect.succeed(PORT),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
};

interface SpawnedChild {
  readonly exit: Deferred.Deferred<number>;
  readonly shutdownStderr: Deferred.Deferred<Uint8Array>;
  killed: boolean;
}

/** A spawner whose children exit when the test says so (or when killed). */
const makeScriptedSpawner = (options?: {
  readonly killStderr: string | undefined;
  readonly killFailsAfterExit: boolean | undefined;
  readonly killFailsWhileRunning: boolean | undefined;
}) =>
  Effect.gen(function* () {
    const children = yield* Ref.make<ReadonlyArray<SpawnedChild>>([]);
    const spawnCount = Ref.get(children).pipe(Effect.map((all) => all.length));

    const spawner = ChildProcessSpawner.make((_command) =>
      Effect.gen(function* () {
        const exit = yield* Deferred.make<number>();
        const shutdownStderr = yield* Deferred.make<Uint8Array>();
        const child: SpawnedChild = { exit, shutdownStderr, killed: false };
        yield* Ref.update(children, (all) => [...all, child]);
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            child.killed = true;
            if (options?.killStderr !== undefined) {
              yield* Deferred.succeed(
                shutdownStderr,
                new TextEncoder().encode(options.killStderr),
              ).pipe(Effect.asVoid);
            }
            yield* Deferred.succeed(exit, 0).pipe(Effect.asVoid);
          }),
        );
        return {
          pid: 4242,
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          kill: () =>
            Effect.gen(function* () {
              if (options?.killFailsWhileRunning === true) {
                return yield* Effect.fail(
                  new Error("failed to terminate running process") as never,
                );
              }
              child.killed = true;
              if (options?.killStderr !== undefined) {
                yield* Deferred.succeed(
                  shutdownStderr,
                  new TextEncoder().encode(options.killStderr),
                ).pipe(Effect.asVoid);
              }
              yield* Deferred.succeed(exit, 0 as never).pipe(Effect.asVoid);
              if (options?.killFailsAfterExit === true) {
                return yield* Effect.fail(new Error("process already exited") as never);
              }
            }),
          stdin: undefined,
          stdout: Stream.make(new TextEncoder().encode("hello from server\n")),
          stderr:
            options?.killStderr === undefined
              ? Stream.make(new TextEncoder().encode("server warning\n"))
              : Stream.fromEffect(Deferred.await(shutdownStderr)),
          all: Stream.make(new TextEncoder().encode("hello from server\nserver warning\n")),
        } as unknown as ChildProcessSpawner.ChildProcessHandle;
      }),
    );

    const exitCurrent = (code: number) =>
      Ref.get(children).pipe(
        Effect.flatMap((all) => {
          const current = all[all.length - 1];
          if (current === undefined) {
            return Effect.die("exitCurrent before any spawn");
          }
          return Effect.gen(function* () {
            if (options?.killStderr !== undefined) {
              yield* Deferred.succeed(current.shutdownStderr, new Uint8Array()).pipe(Effect.asVoid);
            }
            yield* Deferred.succeed(current.exit, code).pipe(Effect.asVoid);
          });
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
  readonly homeDirectory?: string;
  readonly killStderr?: string;
  readonly killFailsAfterExit?: boolean;
  readonly killFailsWhileRunning?: boolean;
  readonly onNotReady?: Effect.Effect<void>;
  readonly httpClient?: HttpClient.HttpClient;
}

const environmentLayer = (input?: HarnessInput) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: NodePath.join(SCRATCH, "dist-electron"),
          homeDirectory: input?.homeDirectory ?? LOG_DIR_HOME,
          platform: "darwin",
          appVersion: "0.0.0-test",
          appPath: SCRATCH,
          isPackaged: input?.isPackaged ?? false,
          resourcesPath: NodePath.join(SCRATCH, "resources"),
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          appImagePath: Option.none(),
          serverEntryOverride: Option.some(input?.entry ?? ENTRY_PATH),
          configuredBackendPort: Option.some(PORT),
          devServerUrl: Option.none(),
        },
        path,
      ),
    ),
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
    const scripted = yield* makeScriptedSpawner({
      killStderr: input?.killStderr,
      killFailsAfterExit: input?.killFailsAfterExit,
      killFailsWhileRunning: input?.killFailsWhileRunning,
    });
    const readyLatch = yield* Deferred.make<void>();
    const notReadyHits = yield* Ref.make(0);
    const httpClientLayer =
      input?.httpClient === undefined
        ? FetchHttpClient.layer
        : Layer.succeed(HttpClient.HttpClient, input.httpClient);

    const manager = yield* makeManager({
      onReady: () => Deferred.succeed(readyLatch, undefined).pipe(Effect.asVoid),
      onNotReady: Ref.update(notReadyHits, (n) => n + 1).pipe(
        Effect.andThen(input?.onNotReady ?? Effect.void),
      ),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted.spawner),
      Effect.provideService(NetService, fakeNet),
      Effect.provide(
        Layer.mergeAll(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(environmentLayer(input)),
            Layer.provideMerge(NodeServices.layer),
          ),
          DesktopObservability.layer.pipe(
            Layer.provideMerge(environmentLayer(input)),
            Layer.provideMerge(NodeServices.layer),
          ),
          httpClientLayer,
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

  it.effect("keeps window activation recoverable after the initial ready callback fails", () =>
    Effect.gen(function* () {
      const scripted = yield* makeScriptedSpawner();
      const openAttempts = yield* Ref.make(0);
      const createError = new ElectronWindow.ElectronWindowCreateError({
        options: {
          title: "Throughline",
          width: 1440,
          height: 900,
          show: false,
          backgroundColor: "#f7f8fa",
          webPreferences: {
            preload: "/app/preload.cjs",
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
        cause: new Error("simulated BrowserWindow failure"),
      });
      const openMain = Ref.updateAndGet(openAttempts, (attempt) => attempt + 1).pipe(
        Effect.flatMap((attempt) => (attempt === 1 ? Effect.fail(createError) : Effect.void)),
      );
      const window = DesktopWindow.DesktopWindow.of({
        activate: openMain,
        handleBackendReady: () => openMain,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchMenuAction: () => Effect.void,
        syncAppearance: Effect.void,
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });

      yield* Effect.gen(function* () {
        const manager = yield* DesktopBackendManager;
        yield* manager.start;
        yield* Effect.gen(function* () {
          while (
            !records.some(
              (record) => record.message === "failed to open main window after backend readiness",
            )
          ) {
            yield* Effect.yieldNow;
          }
        });

        yield* window.activate;

        assert.equal(yield* Ref.get(openAttempts), 2);
        assert.equal(yield* scripted.spawnCount, 1);
        const warning = records.find(
          (record) => record.message === "failed to open main window after backend readiness",
        );
        assert.equal(warning?.annotations.component, "desktop-backend");
        assert.equal(warning?.annotations.error, createError.message);
        yield* manager.stop;
      }).pipe(
        Effect.provide(desktopBackendManagerLayer),
        Effect.provideService(DesktopWindow.DesktopWindow, window),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted.spawner),
        Effect.provideService(NetService, fakeNet),
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(environmentLayer()),
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(FetchHttpClient.layer),
            ),
            Layer.succeed(DesktopObservability.DesktopBackendOutputLog, {
              writeSessionBoundary: () => Effect.void,
              writeOutputChunk: () => Effect.void,
              flushOutput: () => Effect.void,
            } satisfies DesktopObservability.DesktopBackendOutputLog["Service"]),
          ),
        ),
        Effect.provide(Logger.layer([recordingLogger])),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("restarts with backoff after an unexpected exit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(1);
      // The exit path clears the window latch, then schedules the restart.
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

  it.effect("terminates and restarts a backend that never becomes ready", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const httpClient = HttpClient.make((request) =>
        Ref.updateAndGet(attempts, (count) => count + 1).pipe(
          Effect.map(() =>
            HttpClientResponse.fromWeb(request, new Response("not ready", { status: 503 })),
          ),
        ),
      );
      const harness = yield* makeHarness({ httpClient });

      yield* harness.manager.start;
      while ((yield* Ref.get(attempts)) === 0) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("1 minute");
      yield* Effect.gen(function* () {
        while (!(yield* harness.currentKilled)) {
          yield* Effect.yieldNow;
        }
      });
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });
      assert.equal(yield* harness.notReadyCount, 1);

      yield* TestClock.adjust("500 millis");
      yield* Effect.gen(function* () {
        while ((yield* harness.spawnCount) < 2) {
          yield* Effect.yieldNow;
        }
      });
      assert.equal(yield* harness.spawnCount, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("stop preserves the shutdown tail, writes one end boundary, and does not restart", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "shutdown-tail-"));
      const shutdownTail = "stderr emitted during SIGTERM";
      const harness = yield* makeHarness({
        homeDirectory,
        isPackaged: true,
        killStderr: shutdownTail,
      });
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.manager.stop;
      assert.isTrue(yield* harness.currentKilled);
      assert.equal(yield* harness.notReadyCount, 1);

      const logPath = NodePath.join(
        homeDirectory,
        "Library",
        "Application Support",
        "throughline",
        "logs",
        "server-child.log",
      );
      const contents = NodeFS.readFileSync(logPath, "utf8");
      assert.include(contents, shutdownTail);

      const records = contents
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { annotations?: { phase?: string; reason?: string } });
      const endRecords = records.filter((record) => record.annotations?.phase === "END");
      assert.lengthOf(endRecords, 1);
      assert.equal(endRecords[0]?.annotations?.reason, "desktop shutdown");
      assert.isBelow(contents.indexOf(shutdownTail), contents.indexOf('"phase":"END"'));

      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("terminates the backend when the not-ready callback defects during stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        onNotReady: Effect.die("not-ready callback defect"),
      });
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.manager.stop;

      assert.isTrue(yield* harness.currentKilled);
      assert.equal(yield* harness.notReadyCount, 1);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("notifies the window once when natural exit races with stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.exitCurrent(0);
      yield* Effect.gen(function* () {
        while ((yield* harness.notReadyCount) < 1) {
          yield* Effect.yieldNow;
        }
      });
      yield* harness.manager.stop;

      assert.equal(yield* harness.notReadyCount, 1);
      yield* TestClock.adjust("5 seconds");
      assert.equal(yield* harness.spawnCount, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("finishes draining when the child exits just before the shutdown kill", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "shutdown-exit-race-"));
      const shutdownTail = "natural exit won the shutdown race";
      const harness = yield* makeHarness({
        homeDirectory,
        isPackaged: true,
        killStderr: shutdownTail,
        killFailsAfterExit: true,
      });
      yield* harness.manager.start;
      yield* harness.awaitReady;

      yield* harness.manager.stop;

      const contents = NodeFS.readFileSync(
        NodePath.join(
          homeDirectory,
          "Library",
          "Application Support",
          "throughline",
          "logs",
          "server-child.log",
        ),
        "utf8",
      );
      assert.include(contents, shutdownTail);
      assert.equal(contents.match(/"phase":"END"/gu)?.length, 1);
      assert.isBelow(contents.indexOf(shutdownTail), contents.indexOf('"phase":"END"'));
    }).pipe(Effect.scoped),
  );

  it.effect("records a failed termination without writing a normal end boundary", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "shutdown-kill-failure-"));
      const harness = yield* makeHarness({
        homeDirectory,
        isPackaged: true,
        killFailsWhileRunning: true,
      });
      const records: Array<ReturnType<typeof Logger.formatStructured.log>> = [];
      const recordingLogger = Logger.make((options) => {
        records.push(Logger.formatStructured.log(options));
      });

      yield* Effect.gen(function* () {
        yield* harness.manager.start;
        yield* harness.awaitReady;
        yield* harness.manager.stop;
      }).pipe(Effect.provide(Logger.layer([recordingLogger])));

      assert.isTrue(yield* harness.currentKilled);
      const contents = NodeFS.readFileSync(
        NodePath.join(
          homeDirectory,
          "Library",
          "Application Support",
          "throughline",
          "logs",
          "server-child.log",
        ),
        "utf8",
      );
      assert.notInclude(contents, '"phase":"END"');

      const failure = records.find((record) => record.message === "backend termination failed");
      assert.equal(failure?.annotations.errorType, "BackendProcessTerminationError");
      assert.equal(failure?.annotations.pid, 4242);
      assert.equal(failure?.annotations.port, PORT);

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

      // A manual start during the backoff window spawns immediately and
      // cancels the scheduled restart.
      yield* harness.manager.start;
      yield* Effect.gen(function* () {
        while ((yield* harness.spawnCount) < 2) {
          yield* Effect.yieldNow;
        }
      });

      yield* harness.manager.stop;
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

      // Stop during the backoff window cancels the pending restart; nothing
      // respawns once the delay elapses.
      yield* harness.manager.stop;
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
      // Still wants to run: the config is resolved and waiting on the entry.
      assert.isTrue(Option.isSome(yield* harness.manager.currentConfig));
    }).pipe(Effect.scoped),
  );

  it.effect("captures child output to logDir/server-child.log when packaged", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "capture-"));
      const harness = yield* makeHarness({ homeDirectory, isPackaged: true });
      yield* harness.manager.start;
      yield* harness.awaitReady;

      const logPath = NodePath.join(
        homeDirectory,
        "Library",
        "Application Support",
        "throughline",
        "logs",
        "server-child.log",
      );
      yield* Effect.gen(function* () {
        while (
          !NodeFS.existsSync(logPath) ||
          !NodeFS.readFileSync(logPath, "utf8").includes("hello from server") ||
          !NodeFS.readFileSync(logPath, "utf8").includes("server warning")
        ) {
          yield* Effect.yieldNow;
        }
      });

      const contents = NodeFS.readFileSync(logPath, "utf8");
      assert.include(contents, '"message":"backend child process session start"');
      assert.include(contents, '"pid":4242');
      assert.include(contents, "hello from server");
      assert.include(contents, "server warning");
      assert.include(contents, '"stream":"stdout"');
      assert.include(contents, '"stream":"stderr"');
    }).pipe(Effect.scoped),
  );

  it.effect("rolls over an oversized legacy log and retains its newest diagnostics", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "legacy-log-"));
      const logDirectory = NodePath.join(
        homeDirectory,
        "Library",
        "Application Support",
        "throughline",
        "logs",
      );
      const logPath = NodePath.join(logDirectory, "server-child.log");
      const previousLogPath = NodePath.join(logDirectory, "server-child.1.log");
      const earliestDiagnostic = "obsolete earliest diagnostic\n";
      const latestDiagnostic = "\nlatest crash diagnostic\n";
      NodeFS.mkdirSync(logDirectory, { recursive: true });
      NodeFS.writeFileSync(
        logPath,
        Buffer.concat([
          Buffer.from(earliestDiagnostic),
          Buffer.alloc(BACKEND_LOG_FILE_LIMIT_BYTES, "x"),
          Buffer.from(latestDiagnostic),
        ]),
      );

      const harness = yield* makeHarness({ homeDirectory, isPackaged: true });
      yield* harness.manager.start;
      yield* harness.awaitReady;
      yield* Effect.gen(function* () {
        while (
          !NodeFS.existsSync(logPath) ||
          !NodeFS.readFileSync(logPath, "utf8").includes("hello from server")
        ) {
          yield* Effect.yieldNow;
        }
      });

      const activeContents = NodeFS.readFileSync(logPath, "utf8");
      const previousContents = NodeFS.readFileSync(previousLogPath, "utf8");
      assert.include(activeContents, '"message":"backend child process session start"');
      assert.include(previousContents, latestDiagnostic.trim());
      assert.notInclude(previousContents, earliestDiagnostic.trim());
      assert.isAtMost(NodeFS.statSync(logPath).size, BACKEND_LOG_FILE_LIMIT_BYTES);
      assert.isAtMost(NodeFS.statSync(previousLogPath).size, BACKEND_LOG_FILE_LIMIT_BYTES);
    }).pipe(Effect.scoped),
  );

  it.effect("rolls over at the file limit and keeps both recent runs", () =>
    Effect.gen(function* () {
      const homeDirectory = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "rollover-log-"));
      const logDirectory = NodePath.join(
        homeDirectory,
        "Library",
        "Application Support",
        "throughline",
        "logs",
      );
      const logPath = NodePath.join(logDirectory, "server-child.log");
      const previousLogPath = NodePath.join(logDirectory, "server-child.1.log");
      const priorRunDiagnostic = "\nprior run crash diagnostic\n";
      NodeFS.mkdirSync(logDirectory, { recursive: true });
      NodeFS.writeFileSync(
        logPath,
        Buffer.concat([
          Buffer.alloc(BACKEND_LOG_FILE_LIMIT_BYTES - Buffer.byteLength(priorRunDiagnostic), "y"),
          Buffer.from(priorRunDiagnostic),
        ]),
      );

      const harness = yield* makeHarness({ homeDirectory, isPackaged: true });
      yield* harness.manager.start;
      yield* harness.awaitReady;
      yield* Effect.gen(function* () {
        while (
          !NodeFS.existsSync(logPath) ||
          !NodeFS.readFileSync(logPath, "utf8").includes("hello from server")
        ) {
          yield* Effect.yieldNow;
        }
      });

      const activeContents = NodeFS.readFileSync(logPath, "utf8");
      assert.include(activeContents, '"message":"backend child process session start"');
      assert.include(activeContents, "hello from server");
      assert.include(NodeFS.readFileSync(previousLogPath, "utf8"), priorRunDiagnostic.trim());
      assert.isAtMost(NodeFS.statSync(logPath).size, BACKEND_LOG_FILE_LIMIT_BYTES);
      assert.isAtMost(NodeFS.statSync(previousLogPath).size, BACKEND_LOG_FILE_LIMIT_BYTES);
    }).pipe(Effect.scoped),
  );
});
