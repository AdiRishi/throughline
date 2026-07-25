import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerBootstrapEnvelope } from "@app/contracts";
import { waitForHttpReady } from "@app/shared/httpReadiness";
import { NetService } from "@app/shared/Net";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import type { DesktopBackendStartConfig } from "./DesktopBackendConfiguration.ts";

// Supervises the single local server child: picks a free port, spawns the
// process, probes HTTP readiness before revealing the window, restarts with
// exponential backoff on unexpected exit, and stops it with SIGTERM + a grace
// window. A `Semaphore(1)` serializes start/stop so overlapping requests can't
// spawn two children.

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const READINESS_TIMEOUT = Duration.minutes(1);
const READINESS_INTERVAL = Duration.millis(100);
const READINESS_REQUEST_TIMEOUT = Duration.seconds(1);
const TERMINATE_GRACE = Duration.seconds(2);
const HEALTH_PATH = "/.well-known/app/health";

const encodeBootstrapEnvelopeJson = Schema.encodeEffect(
  Schema.fromJsonString(ServerBootstrapEnvelope),
);

export class DesktopBackendReadinessError extends Schema.TaggedErrorClass<DesktopBackendReadinessError>()(
  "DesktopBackendReadinessError",
  {
    url: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting for backend readiness at ${this.url}.`;
  }
}

export class DesktopBackendBootstrapEncodeError extends Schema.TaggedErrorClass<DesktopBackendBootstrapEncodeError>()(
  "DesktopBackendBootstrapEncodeError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to encode the backend bootstrap envelope.";
  }
}

class BackendProcessSpawnError extends Schema.TaggedErrorClass<BackendProcessSpawnError>()(
  "BackendProcessSpawnError",
  {
    executablePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn the desktop backend process at ${this.executablePath}.`;
  }
}

interface BackendProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
  readonly result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
}

function describeProcessExit(
  result: Result.Result<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): BackendProcessExit {
  if (Result.isSuccess(result)) {
    return {
      code: Option.some(result.success),
      reason: `code=${result.success}`,
      result,
    };
  }

  return {
    code: Option.none(),
    reason: result.failure.message,
    result,
  };
}

interface DesktopBackendReadyCallbacks {
  readonly onReady: (config: DesktopBackendStartConfig) => Effect.Effect<void>;
  readonly onNotReady: Effect.Effect<void>;
}

/**
 * Drain one of the child's output streams into the shell's backend output log,
 * which records it to `server-child.log` and (in development) echoes it to the
 * shell's own stdout/stderr. Failures are ignored: a broken log must never take
 * the backend down with it.
 */
function drainBackendOutput(
  streamName: "stdout" | "stderr",
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  onOutput: DesktopObservability.DesktopBackendOutputLogShape["writeOutputChunk"],
): Effect.Effect<void> {
  return stream.pipe(
    Stream.runForEach((chunk) => onOutput(streamName, chunk)),
    Effect.ignore,
  );
}

export interface DesktopBackendManagerShape {
  readonly start: Effect.Effect<void>;
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
  readonly snapshot: Effect.Effect<DesktopBackendSnapshot>;
}

export class DesktopBackendManager extends Context.Service<
  DesktopBackendManager,
  DesktopBackendManagerShape
>()("@app/desktop/backend/DesktopBackendManager") {}

interface ActiveRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
}

interface ManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly config: Option.Option<DesktopBackendStartConfig>;
  readonly active: Option.Option<ActiveRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

export interface DesktopBackendSnapshot {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly activePid: Option.Option<number>;
  readonly restartAttempt: number;
  readonly restartScheduled: boolean;
}

const initialState: ManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, update: (run: ActiveRun) => ActiveRun) =>
  (state: ManagerState): ManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? update(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<void> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));

  return (
    options?.timeout ? close.pipe(Effect.timeoutOption(options.timeout), Effect.asVoid) : close
  ).pipe(Effect.ignore);
};

type ManagerServices =
  | DesktopBackendConfiguration.DesktopBackendConfiguration
  | DesktopEnvironment.DesktopEnvironment
  | DesktopObservability.DesktopBackendOutputLog
  | NetService
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient;

const { logInfo, logWarning, logError } = makeComponentLogger("desktop-backend");

// Resolve the backend port: the configured/default port when free on both
// loopback stacks, otherwise a fresh ephemeral loopback port.
const resolvePort = Effect.fn("desktop.backend.resolvePort")(function* (
  net: NetService["Service"],
  configuredPort: Option.Option<number>,
  defaultPort: number,
) {
  const preferredPort = Option.getOrElse(configuredPort, () => defaultPort);
  return yield* net.findAvailablePort(preferredPort);
});

// Spawn the child + probe readiness (in a forked fiber), then wait for exit.
const runBackendProcess = Effect.fn("desktop.backend.runBackendProcess")(function* (
  config: DesktopBackendStartConfig,
  backendOutputLog: DesktopObservability.DesktopBackendOutputLogShape,
  callbacks: {
    readonly onStarted: (pid: number) => Effect.Effect<void>;
    readonly onReady: Effect.Effect<void>;
    readonly onReadinessFailure: (error: DesktopBackendReadinessError) => Effect.Effect<void>;
  },
): Effect.fn.Return<
  BackendProcessExit,
  DesktopBackendBootstrapEncodeError | BackendProcessSpawnError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootstrapJson = yield* encodeBootstrapEnvelopeJson(config.bootstrapEnvelope).pipe(
    Effect.mapError((cause) => new DesktopBackendBootstrapEncodeError({ cause })),
  );
  const command = ChildProcess.make(config.executablePath, [...config.args], {
    cwd: config.cwd,
    env: config.env,
    // The primary passes ELECTRON_RUN_AS_NODE + the token/port in `env`; merge
    // the parent env on top so PATH and friends are still available to the child.
    extendEnv: true,
    stdin: "ignore",
    // Always piped, never inherited: the shell has to see the child's bytes to
    // record them, and a packaged build has no terminal to inherit anyway. The
    // dev terminal still gets them, echoed by the backend output log.
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: TERMINATE_GRACE,
    additionalFds: {
      fd3: {
        type: "input",
        stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)),
      },
    },
  });

  const handle = yield* spawner
    .spawn(command)
    .pipe(
      Effect.mapError(
        (cause) => new BackendProcessSpawnError({ executablePath: config.executablePath, cause }),
      ),
    );
  yield* callbacks.onStarted(handle.pid);

  // Both drains live for this run's scope and die with it.
  yield* drainBackendOutput("stdout", handle.stdout, backendOutputLog.writeOutputChunk).pipe(
    Effect.forkScoped,
  );
  yield* drainBackendOutput("stderr", handle.stderr, backendOutputLog.writeOutputChunk).pipe(
    Effect.forkScoped,
  );

  yield* waitForHttpReady({
    baseUrl: config.httpBaseUrl.href,
    path: HEALTH_PATH,
    timeoutMs: Duration.toMillis(READINESS_TIMEOUT),
    intervalMs: Duration.toMillis(READINESS_INTERVAL),
    probeTimeoutMs: Duration.toMillis(READINESS_REQUEST_TIMEOUT),
    makeError: () =>
      new DesktopBackendReadinessError({
        url: new URL(HEALTH_PATH, config.httpBaseUrl).href,
      }),
  }).pipe(
    Effect.matchEffect({
      onFailure: callbacks.onReadinessFailure,
      onSuccess: () => callbacks.onReady,
    }),
    Effect.forkScoped,
  );

  // Block on the child's exit. When it resolves the run scope closes and the
  // finalize path decides whether to restart, with the exit code (or kill
  // signal) carried in the restart reason.
  return describeProcessExit(yield* Effect.result(handle.exitCode));
});

// Builds a backend manager bound to the given readiness callbacks. `layer`
// supplies the window's onReady/onNotReady hooks. Exported for tests, which
// drive it with scripted spawner/net/http services and recording callbacks.
export const makeManager = (
  callbacks: DesktopBackendReadyCallbacks,
): Effect.Effect<DesktopBackendManagerShape, never, ManagerServices | Scope.Scope> =>
  Effect.gen(function* () {
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const net = yield* NetService;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const backendOutputLog = yield* DesktopObservability.DesktopBackendOutputLog;
    const parentScope = yield* Scope.Scope;
    const state = yield* Ref.make(initialState);
    const mutex = yield* Semaphore.make(1);

    const updateActiveRun = (runId: number, update: (run: ActiveRun) => ActiveRun) =>
      Ref.update(state, withActiveRun(runId, update));
    const snapshot = Ref.get(state).pipe(
      Effect.map(
        (current): DesktopBackendSnapshot => ({
          desiredRunning: current.desiredRunning,
          ready: current.ready,
          activePid: activePid(current.active),
          restartAttempt: current.restartAttempt,
          restartScheduled: Option.isSome(current.restartFiber),
        }),
      ),
    );
    const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));
    const notifyNotReady = callbacks.onNotReady.pipe(
      Effect.catchCause((cause) =>
        logWarning("backend not-ready callback failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const cancelRestart = Effect.gen(function* () {
      const restartFiber = yield* Ref.modify(state, (current) => [
        current.restartFiber,
        { ...current, restartFiber: Option.none() },
      ]);
      yield* Option.match(restartFiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      });
    });

    const scheduleRestart = Effect.fn("desktop.backend.scheduleRestart")(function* (
      reason: string,
    ) {
      const scheduled = yield* Ref.modify(state, (current) => {
        if (!current.desiredRunning || Option.isSome(current.restartFiber)) {
          return [Option.none<Duration.Duration>(), current] as const;
        }
        const delay = calculateRestartDelay(current.restartAttempt);
        return [
          Option.some(delay),
          { ...current, restartAttempt: current.restartAttempt + 1 },
        ] as const;
      });

      yield* Option.match(scheduled, {
        onNone: () => Effect.void,
        onSome: (delay) =>
          Effect.gen(function* () {
            yield* logWarning("backend exited; restart scheduled", {
              reason,
              delayMs: Duration.toMillis(delay),
            });
            const restartFiber = yield* Effect.forkIn(
              Effect.sleep(delay).pipe(
                Effect.andThen(
                  Ref.modify(state, (current) => [
                    current.desiredRunning,
                    { ...current, restartFiber: Option.none() },
                  ]),
                ),
                Effect.flatMap((shouldRestart) => (shouldRestart ? start : Effect.void)),
                Effect.catchCause((cause) => {
                  if (Cause.hasInterruptsOnly(cause)) {
                    return Effect.void;
                  }
                  return logError("desktop backend restart fiber failed", {
                    reason,
                    delayMs: Duration.toMillis(delay),
                    cause: Cause.pretty(cause),
                  });
                }),
              ),
              parentScope,
            );
            yield* Ref.update(state, (current) =>
              Option.isNone(current.restartFiber)
                ? { ...current, restartFiber: Option.some(restartFiber) }
                : current,
            );
          }),
      });
    });

    const start: Effect.Effect<void> = Effect.suspend(() =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (Option.isSome(current.active)) {
            return;
          }

          const config = yield* resolvePort(
            net,
            environment.configuredBackendPort,
            environment.defaultBackendPort,
          ).pipe(
            Effect.flatMap((port) => configuration.resolve({ port })),
            Effect.tapError((error) =>
              logError("failed to resolve backend configuration", {
                cause: error.message,
              }),
            ),
            Effect.option,
          );
          if (Option.isNone(config)) {
            return;
          }

          yield* cancelRestart;
          yield* Ref.update(state, (latest) => ({
            ...latest,
            desiredRunning: true,
            ready: false,
            config: Option.some(config.value),
          }));

          const entryExists = yield* fileSystem
            .exists(config.value.entryPath)
            .pipe(Effect.orElseSucceed(() => false));
          if (!entryExists) {
            yield* scheduleRestart(`missing server entry at ${config.value.entryPath}`);
            return;
          }

          const runScope = yield* Scope.make("sequential");
          const runId = yield* Ref.modify(state, (latest) => [
            latest.nextRunId,
            {
              ...latest,
              active: Option.some({
                id: latest.nextRunId,
                scope: runScope,
                fiber: Option.none<Fiber.Fiber<void, never>>(),
                pid: Option.none<number>(),
              } satisfies ActiveRun),
              nextRunId: latest.nextRunId + 1,
            },
          ]);

          const finalizeRun = Effect.fn("desktop.backend.finalizeRun")(function* (reason: string) {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                const isCurrentRun = yield* Ref.modify(state, (latest) => {
                  const run = Option.getOrUndefined(latest.active);
                  if (run?.id !== runId) {
                    return [false, latest] as const;
                  }
                  return [
                    true,
                    {
                      ...latest,
                      active: Option.none<ActiveRun>(),
                      ready: false,
                    },
                  ] as const;
                });
                if (isCurrentRun) {
                  yield* backendOutputLog.writeSessionBoundary({ phase: "END", details: reason });
                  yield* notifyNotReady;
                  const latest = yield* Ref.get(state);
                  if (latest.desiredRunning) {
                    yield* scheduleRestart(reason);
                  }
                }
              }),
            );
          });

          const program = runBackendProcess(config.value, backendOutputLog, {
            onStarted: (pid) =>
              Effect.gen(function* () {
                yield* updateActiveRun(runId, (run) => ({ ...run, pid: Option.some(pid) }));
                yield* backendOutputLog.writeSessionBoundary({
                  phase: "START",
                  details: `pid=${pid} port=${config.value.port} cwd=${config.value.cwd}`,
                });
                yield* logInfo("backend started", {
                  pid,
                  port: config.value.port,
                });
              }),
            onReady: Effect.gen(function* () {
              const isCurrentRun = yield* Ref.modify(state, (latest) => {
                const run = Option.getOrUndefined(latest.active);
                if (run?.id !== runId) {
                  return [false, latest] as const;
                }
                return [true, { ...latest, restartAttempt: 0, ready: true }] as const;
              });
              if (!isCurrentRun) {
                return;
              }
              yield* logInfo("backend ready", {
                url: config.value.httpBaseUrl.href,
              });
              yield* callbacks.onReady(config.value);
            }),
            onReadinessFailure: (error) =>
              logWarning("backend readiness check failed", {
                error: error.message,
              }),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Scope.provide(runScope),
            Effect.matchEffect({
              onFailure: (error) => finalizeRun(error.message),
              onSuccess: (exit) => finalizeRun(exit.reason),
            }),
            Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
          );

          const fiber = yield* Effect.forkIn(program, parentScope);
          yield* updateActiveRun(runId, (run) => ({ ...run, fiber: Option.some(fiber) }));
        }),
      ),
    ).pipe(Effect.withSpan("desktop.backend.start"));

    const stop = Effect.fn("desktop.backend.stop")(function* (options?: {
      readonly timeout?: Duration.Duration;
    }) {
      const { active, restartFiber } = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const result = yield* Ref.modify(state, (latest) => [
            { active: latest.active, restartFiber: latest.restartFiber },
            {
              ...latest,
              desiredRunning: false,
              ready: false,
              active: Option.none<ActiveRun>(),
              restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            },
          ]);
          if (Option.isSome(result.active)) {
            yield* notifyNotReady;
          }
          return result;
        }),
      );

      yield* Option.match(restartFiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      });
      yield* Option.match(active, {
        onNone: () => Effect.void,
        onSome: (run) => closeRun(run, options),
      });
    });

    yield* Effect.addFinalizer(() => stop());

    return {
      start,
      stop,
      currentConfig,
      snapshot,
    } satisfies DesktopBackendManagerShape;
  });

// Wires the manager into the window's readiness callbacks. `onReady` reveals the
// main window; `onNotReady` clears the latch so a dock-click while the backend
// is down doesn't strand a window pointing at nothing.
export const layer: Layer.Layer<
  DesktopBackendManager,
  never,
  | DesktopBackendConfiguration.DesktopBackendConfiguration
  | DesktopEnvironment.DesktopEnvironment
  | DesktopObservability.DesktopBackendOutputLog
  | DesktopWindow.DesktopWindow
  | NetService
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
> = Layer.effect(
  DesktopBackendManager,
  Effect.gen(function* () {
    const window = yield* DesktopWindow.DesktopWindow;
    const manager = yield* makeManager({
      onReady: (config) =>
        window.handleBackendReady(config).pipe(
          Effect.catch((error) =>
            logWarning("failed to open main window after backend readiness", {
              error: error.message,
            }),
          ),
        ),
      onNotReady: window.handleBackendNotReady,
    });
    return manager;
  }),
);
