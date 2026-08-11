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
const OUTPUT_DRAIN_TIMEOUT = Duration.seconds(5);
const HEALTH_PATH = "/.well-known/app/health";

const encodeBootstrapEnvelopeJson = Schema.encodeEffect(
  Schema.fromJsonString(ServerBootstrapEnvelope),
);

export class DesktopBackendReadinessError extends Schema.TaggedError<DesktopBackendReadinessError>()(
  "DesktopBackendReadinessError",
  {
    url: Schema.String,
  },
) {
  override get message(): string {
    return `Timed out waiting for backend readiness at ${this.url}.`;
  }
}

// Shared by every backend-process error so a failure reports *which* child it
// was for. Without it, "failed to spawn" in the log names an executable that is
// the same for every run and says nothing about the entry, cwd or target URL.
const backendProcessContextSchema = {
  executablePath: Schema.String,
  entryPath: Schema.String,
  cwd: Schema.String,
  httpBaseUrl: Schema.URL,
};

export class DesktopBackendBootstrapEncodeError extends Schema.TaggedError<DesktopBackendBootstrapEncodeError>()(
  "DesktopBackendBootstrapEncodeError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to encode the backend bootstrap envelope for ${this.entryPath}.`;
  }
}

class BackendProcessSpawnError extends Schema.TaggedError<BackendProcessSpawnError>()(
  "BackendProcessSpawnError",
  {
    ...backendProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn desktop backend entry ${this.entryPath} with ${this.executablePath}.`;
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
 * Drain one of the child's output streams into the shell's backend output log.
 * Failures are ignored: a broken log must never take the backend down with it.
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
  /**
   * Tears the current run down. With `timeout` the call stops *waiting* after
   * that long — the teardown itself always runs to completion in the manager's
   * own scope, so a caller in a hurry (the installer, about to quit) never
   * abandons the child mid-SIGTERM.
   */
  readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
  readonly currentConfig: Effect.Effect<Option.Option<DesktopBackendStartConfig>>;
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
  // Set once the child's exit has been observed, and once `stop` has asked for
  // the run to go away. Together they tell the finalize path whether this was a
  // crash worth persisting or an orderly shutdown worth discarding.
  readonly exitObserved: boolean;
  readonly stopRequested: boolean;
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

const initialState: ManagerState = {
  desiredRunning: false,
  ready: false,
  config: Option.none(),
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const withActiveRun =
  (runId: number, f: (run: ActiveRun) => ActiveRun) =>
  (state: ManagerState): ManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

// Closing the run scope SIGTERMs the child and force-kills it after the grace
// window; the run fiber is then awaited so the finalize path has completed
// before the caller inspects state.
/**
 * Closes one run's scope and waits for its supervising fiber to settle.
 * Returns whether the close finished within `timeout`.
 *
 * With a timeout the close is forked into `parentScope` rather than raced in
 * place: giving up on *waiting* must not interrupt the teardown itself, or the
 * child is abandoned midway through its SIGTERM grace window and gets killed by
 * the OS instead. The forked close keeps running to completion either way.
 */
const closeRun = (
  run: ActiveRun,
  parentScope: Scope.Scope,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<boolean> => {
  const close = Scope.close(run.scope, Exit.void).pipe(
    Effect.andThen(
      Option.match(run.fiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
      }),
    ),
    Effect.ignore,
  );

  const timeout = options?.timeout;
  if (!timeout) {
    return close.pipe(Effect.as(true));
  }

  return Effect.forkIn(close, parentScope).pipe(
    Effect.flatMap((closeFiber) =>
      Fiber.await(closeFiber).pipe(Effect.timeoutOption(timeout), Effect.map(Option.isSome)),
    ),
  );
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

const resolvePort = Effect.fn("desktop.backend.resolvePort")(function* (
  net: NetService["Service"],
  configuredPort: Option.Option<number>,
  defaultPort: number,
) {
  const preferredPort = Option.getOrElse(configuredPort, () => defaultPort);
  const port = yield* net.findAvailablePort(preferredPort);
  yield* logInfo("selected backend port", {
    port,
    preferredPort,
    fromConfig: Option.isSome(configuredPort),
  });
  return port;
});

export const runBackendProcess = Effect.fn("desktop.backend.runBackendProcess")(function* (
  config: DesktopBackendStartConfig,
  backendOutputLog: DesktopObservability.DesktopBackendOutputLogShape,
  callbacks: {
    readonly onStarted: (pid: number) => Effect.Effect<void>;
    readonly onExitObserved: Effect.Effect<void>;
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
  const processContext = {
    executablePath: config.executablePath,
    entryPath: config.entryPath,
    cwd: config.cwd,
    httpBaseUrl: config.httpBaseUrl,
  };
  const bootstrapJson = yield* encodeBootstrapEnvelopeJson(config.bootstrapEnvelope).pipe(
    Effect.mapError(
      (cause) => new DesktopBackendBootstrapEncodeError({ ...processContext, cause }),
    ),
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
    .pipe(Effect.mapError((cause) => new BackendProcessSpawnError({ ...processContext, cause })));
  const outputFibers: Array<Fiber.Fiber<void, never>> = [];

  yield* callbacks.onStarted(handle.pid);

  outputFibers.push(
    yield* drainBackendOutput("stdout", handle.stdout, backendOutputLog.writeOutputChunk).pipe(
      Effect.forkScoped,
    ),
    yield* drainBackendOutput("stderr", handle.stderr, backendOutputLog.writeOutputChunk).pipe(
      Effect.forkScoped,
    ),
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

  const result = yield* Effect.result(handle.exitCode);
  yield* callbacks.onExitObserved;
  // The exit is observed first, then the trailing output is drained: the last
  // bytes the child wrote (the stack trace that explains a crash) have to land
  // in `server-child.log` before the run scope closes and interrupts the drains.
  yield* Effect.forEach(outputFibers, Fiber.await, {
    concurrency: "unbounded",
    discard: true,
  }).pipe(Effect.timeout(OUTPUT_DRAIN_TIMEOUT), Effect.ignore);
  return describeProcessExit(result);
});

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

    const currentConfig = Ref.get(state).pipe(Effect.map((current) => current.config));

    // Frozen on first success, retried on failure. A restart that re-scanned
    // would land on a different ephemeral port whenever the old one has not
    // been released yet, and every client holding the previous bootstrap URL —
    // the renderer included — would be pointing at nothing.
    const portRef = yield* Ref.make(Option.none<number>());
    const resolveOrReusePort = Effect.gen(function* () {
      const existing = yield* Ref.get(portRef);
      if (Option.isSome(existing)) {
        return existing.value;
      }
      const port = yield* resolvePort(
        net,
        environment.configuredBackendPort,
        environment.defaultBackendPort,
      );
      yield* Ref.set(portRef, Option.some(port));
      return port;
    });

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
            // An unexpected backend exit is an error, not a warning: the app is
            // running without its server until the restart lands, and this is
            // the one record that says so.
            yield* logError("backend exited unexpectedly; restart scheduled", {
              reason,
              delayMs: Duration.toMillis(delay),
            });
            const restartFiber = yield* Effect.forkIn(
              Effect.gen(function* () {
                yield* Effect.sleep(delay);
                const shouldRestart = yield* Ref.modify(state, (current) => [
                  current.desiredRunning,
                  { ...current, restartFiber: Option.none() },
                ]);
                if (shouldRestart) {
                  yield* start;
                }
              }).pipe(
                Effect.withSpan("desktop.backend.scheduleRestartFiber"),
                // Named and component-annotated: a bare `Effect.ignore({ log: true })`
                // emits the raw cause with no message and no component, which is
                // unattributable in the merged log directory.
                Effect.catchCause((cause) =>
                  logError("desktop backend restart fiber failed", {
                    cause: Cause.pretty(cause),
                  }),
                ),
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
            // A run is still in state — either healthy, or being torn down by
            // `stop`. Record the intent so the teardown path restarts it
            // instead of spawning a second child alongside the dying one.
            if (!current.desiredRunning) {
              yield* Ref.update(state, (latest) => ({
                ...latest,
                desiredRunning: true,
              }));
            }
            return;
          }

          const config = yield* resolveOrReusePort.pipe(
            Effect.flatMap((port) => configuration.resolve({ port })),
            Effect.tapError((error) =>
              logError("failed to resolve backend configuration", {
                cause: error.message,
              }),
            ),
            Effect.option,
          );
          if (Option.isNone(config)) {
            if (current.desiredRunning) {
              yield* scheduleRestart("failed to resolve backend configuration");
            }
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
                exitObserved: false,
                stopRequested: false,
              } satisfies ActiveRun),
              nextRunId: latest.nextRunId + 1,
            },
          ]);

          const finalizeRun = Effect.fn("desktop.backend.finalizeRun")(function* (reason: string) {
            yield* mutex.withPermits(1)(
              Effect.gen(function* () {
                const { isCurrentRun, nextState, pid, exitObserved, stopRequested, wasReady } =
                  yield* Ref.modify(
                    state,
                    (
                      latest,
                    ): readonly [
                      {
                        readonly isCurrentRun: boolean;
                        readonly nextState: ManagerState;
                        readonly pid: Option.Option<number>;
                        readonly exitObserved: boolean;
                        readonly stopRequested: boolean;
                        readonly wasReady: boolean;
                      },
                      ManagerState,
                    ] => {
                      const run = Option.getOrUndefined(latest.active);
                      if (run?.id !== runId) {
                        return [
                          {
                            isCurrentRun: false,
                            nextState: latest,
                            pid: Option.none<number>(),
                            exitObserved: false,
                            stopRequested: false,
                            wasReady: false,
                          },
                          latest,
                        ] as const;
                      }
                      const next = {
                        ...latest,
                        active: Option.none<ActiveRun>(),
                        ready: false,
                      };
                      return [
                        {
                          isCurrentRun: true,
                          nextState: next,
                          pid: run.pid,
                          exitObserved: run.exitObserved,
                          stopRequested: run.stopRequested,
                          wasReady: latest.ready,
                        },
                        next,
                      ] as const;
                    },
                  );

                if (isCurrentRun) {
                  if (Option.isSome(pid)) {
                    // A child that died on its own is a crash: keep its buffered
                    // output on disk. One we asked to stop is not, so its
                    // session is dropped instead of persisted.
                    if (exitObserved && !stopRequested) {
                      yield* backendOutputLog.persistFailure({
                        details: `pid=${pid.value} ${reason}`,
                      });
                    } else {
                      yield* backendOutputLog.discardSession;
                    }
                  }
                  if (wasReady) {
                    yield* callbacks.onNotReady;
                  }
                }

                if (isCurrentRun && nextState.desiredRunning) {
                  yield* scheduleRestart(reason);
                }
              }),
            );
          });

          const program = runBackendProcess(config.value, backendOutputLog, {
            onStarted: Effect.fn("desktop.backend.onStarted")(function* (pid: number) {
              yield* Ref.update(
                state,
                withActiveRun(runId, (run) => ({
                  ...run,
                  pid: Option.some(pid),
                })),
              );
              yield* backendOutputLog.beginSession({
                details: `pid=${pid} port=${config.value.port} cwd=${config.value.cwd}`,
              });
              yield* logInfo("backend started", {
                pid,
                port: config.value.port,
              });
            }),
            onExitObserved: Ref.update(
              state,
              withActiveRun(runId, (run) => ({ ...run, exitObserved: true })),
            ),
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
            }).pipe(Effect.withSpan("desktop.backend.onReady")),
            onReadinessFailure: Effect.fn("desktop.backend.onReadinessFailure")(function* (
              error: DesktopBackendReadinessError,
            ) {
              yield* logWarning("backend readiness check failed", {
                error: error.message,
              });
              yield* backendOutputLog.persistFailureSnapshot({ details: error.message });
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
          yield* Ref.update(
            state,
            withActiveRun(runId, (run) => ({ ...run, fiber: Option.some(fiber) })),
          );
        }),
      ),
    ).pipe(Effect.withSpan("desktop.backend.start"));

    const stop = Effect.fn("desktop.backend.stop")(function* (options?: {
      readonly timeout?: Duration.Duration;
    }) {
      // The run stays in state while it is torn down — only flagged as
      // stop-requested — so a `start` landing during the teardown window still
      // sees an active run.
      const { active, restartFiber, notifyShutdown } = yield* mutex.withPermits(1)(
        Ref.modify(state, (latest) => {
          const active = Option.map(latest.active, (run) =>
            run.exitObserved ? run : { ...run, stopRequested: true },
          );
          return [
            {
              active,
              restartFiber: latest.restartFiber,
              notifyShutdown: latest.ready,
            },
            {
              ...latest,
              desiredRunning: false,
              ready: false,
              active,
              restartFiber: Option.none<Fiber.Fiber<void, never>>(),
            },
          ] as const;
        }),
      );

      if (notifyShutdown) {
        yield* callbacks.onNotReady;
      }
      yield* Option.match(restartFiber, {
        onNone: () => Effect.void,
        onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
      });
      yield* Option.match(active, {
        onNone: () => Effect.void,
        onSome: (run) =>
          Effect.gen(function* () {
            yield* closeRun(run, parentScope, options);
            const cleanup = yield* mutex.withPermits(1)(
              Ref.modify(
                state,
                (
                  latest,
                ): readonly [
                  { readonly needsCleanup: boolean; readonly shouldStart: boolean },
                  ManagerState,
                ] => {
                  const current = Option.getOrUndefined(latest.active);
                  if (current?.id !== run.id) {
                    // The run finalized itself while the scope was closing, so
                    // it has already cleared `active` and decided about its
                    // session.
                    return [
                      {
                        needsCleanup: false,
                        shouldStart:
                          latest.desiredRunning &&
                          Option.isNone(latest.active) &&
                          Option.isNone(latest.restartFiber),
                      },
                      latest,
                    ] as const;
                  }
                  return [
                    { needsCleanup: true, shouldStart: latest.desiredRunning },
                    { ...latest, active: Option.none<ActiveRun>() },
                  ] as const;
                },
              ),
            );
            if (cleanup.needsCleanup) {
              yield* backendOutputLog.discardSession;
            }
            if (cleanup.shouldStart) {
              yield* start;
            }
          }),
      });
    });

    yield* Effect.addFinalizer(() => stop());

    return {
      start,
      stop,
      currentConfig,
    } satisfies DesktopBackendManagerShape;
  });

// `onNotReady` clears the window's readiness latch so a dock-click while the
// backend is down doesn't strand a window pointing at nothing.
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
      // A window-create failure while revealing on backend-ready is unexpected
      // and fatal; surface it as a defect rather than widening the callback's
      // error channel.
      onReady: (config) => window.handleBackendReady(config).pipe(Effect.orDie),
      onNotReady: window.handleBackendNotReady,
    });
    return manager;
  }),
);
