import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { findErrorTraceId } from "../errors/errorTrace.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as RpcSession from "../rpc/session.ts";
import * as Connectivity from "./connectivity.ts";
import {
  type ConnectionAttemptError,
  type ConnectionState,
  ConnectionTransientError,
  INITIAL_CONNECTION_STATE,
  type NetworkStatus,
  type PreparedConnection,
} from "./model.ts";
import * as ConnectionWakeups from "./wakeups.ts";

// The first rung is deliberately not sub-second: a server that is still
// starting is the common case, and hammering it at 1s only makes the log
// noisier without connecting sooner.
const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

// Bounds connect + readiness probe together. The socket layer's own
// open-timeout only bounds the raw open, so a socket that opens but whose
// readiness probe hangs would otherwise freeze the loop forever.
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";

const CONNECTION_PROBE_TIMEOUT = "15 seconds";

// A server that accepts sockets and then crashes must keep escalating backoff,
// so the failure counter resets only after a session survives this long.
const BACKOFF_RESET_AFTER_MS = 30_000;

// One unbounded queue is the loop's single wake-up channel: whichever part of
// the loop is parked (establishing, connected, backing off, blocked, offline)
// is its only taker, so a signal can never be delivered twice or dropped.
type SupervisorSignal =
  | { readonly _tag: "RetryRequested" }
  | { readonly _tag: "NetworkChanged"; readonly network: NetworkStatus }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup };

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: ConnectionAttemptError;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<RpcSession.RpcSession, ConnectionAttemptError>;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut" };

function exitUnlessInterrupted<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onFailure: (cause) =>
      Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.succeed(Exit.failCause(cause)),
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
  });
}

function retryDelayMs(failureCount: number): number {
  // The `?? MAX` only satisfies `noUncheckedIndexedAccess`; the clamp
  // guarantees the index is in range, so the fallback is never taken.
  return RETRY_DELAYS_MS[Math.min(failureCount, RETRY_DELAYS_MS.length - 1)] ?? MAX_RETRY_DELAY_MS;
}

function connectingState(
  everConnected: boolean,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): ConnectionState {
  return {
    phase: everConnected ? "reconnecting" : "connecting",
    attempt,
    lastFailure,
  };
}

function failureFromExit<A>(
  connection: PreparedConnection,
  exit: Exit.Exit<A, ConnectionAttemptError>,
  established: boolean,
  stable: boolean,
): AttemptOutcome {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
    return { _tag: "Interrupted", established, stable, resetRetry: false };
  }
  const typedFailure = exit.cause.reasons.find(Cause.isFailReason);
  if (typedFailure) {
    return { _tag: "Failure", established, stable, failure: typedFailure.error };
  }
  const traceId = findErrorTraceId(exit.cause.reasons.find(Cause.isDieReason)?.defect);
  return {
    _tag: "Failure",
    established,
    stable,
    failure: new ConnectionTransientError({
      reason: "transport",
      detail: `${connection.label} connection failed unexpectedly.`,
      ...(traceId === null ? {} : { traceId }),
    }),
  };
}

/**
 * Supervises exactly one connection: connect → hold open until it drops → wait
 * (capped backoff) → reconnect, forever. A blocked failure parks the loop
 * instead, until a signal reports that whatever blocked it may have changed.
 */
export class ConnectionSupervisor extends Context.Service<
  ConnectionSupervisor,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    /**
     * Start a fresh attempt immediately and reset the backoff ladder to its
     * first rung, cutting an in-progress backoff sleep short.
     */
    readonly retryNow: Effect.Effect<void>;
  }
>()("@app/client-runtime/connection/supervisor/ConnectionSupervisor") {}

/**
 * Forks the reconnect loop into the current scope; the loop and its live socket
 * are torn down when that scope closes.
 */
export const start = (
  connection: PreparedConnection,
): Effect.Effect<
  ConnectionSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionWakeups.ConnectionWakeups
  | RpcSession.RpcSessionFactory
  | Scope.Scope
> =>
  Effect.gen(function* () {
    const connectivity = yield* Connectivity.Connectivity;
    const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
    const sessions = yield* RpcSession.RpcSessionFactory;

    const state = yield* SubscriptionRef.make<ConnectionState>(INITIAL_CONNECTION_STATE);
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.none(),
    );
    const network = yield* Ref.make<NetworkStatus>(yield* connectivity.status);
    const signals = yield* Queue.unbounded<SupervisorSignal>();
    const resetRetryState = yield* Ref.make(false);
    // Set when a foreground wake probe fails or times out: the user is actively
    // returning to the app on a dead transport, so the follow-up reconnect skips
    // the first backoff rung instead of sleeping.
    const wakeProbeFailed = yield* Ref.make(false);

    const clearSession = SubscriptionRef.set(session, Option.none());
    const setState = (next: ConnectionState) => SubscriptionRef.set(state, next);
    const signal = (next: SupervisorSignal) => Queue.offer(signals, next).pipe(Effect.asVoid);

    const establish = Effect.fnUntraced(function* () {
      const active = yield* sessions.connect(connection);
      yield* active.connected;
      return active;
    });

    // Every signal that does not abandon the in-flight establishment is
    // consumed here on purpose, so it cannot leak into the next `Queue.take`
    // and cut a later backoff short.
    const waitForEstablishmentInterrupt = Effect.fnUntraced(function* () {
      for (;;) {
        const next = yield* Queue.take(signals);
        switch (next._tag) {
          case "RetryRequested":
            return false;
          case "NetworkChanged":
            if (next.network === "offline") {
              return false;
            }
            break;
          case "Wakeup":
            if (next.reason === "application-active-reconnect") {
              return true;
            }
            break;
        }
      }
    });

    const monitorConnectedSession = Effect.fnUntraced(function* (active: RpcSession.RpcSession) {
      for (;;) {
        const next = yield* Queue.take(signals);
        switch (next._tag) {
          case "RetryRequested":
            return false;
          case "NetworkChanged":
            if (next.network === "offline") {
              return false;
            }
            break;
          case "Wakeup":
            if (next.reason === "application-active-reconnect") {
              // Operating systems commonly suspend sockets without delivering a
              // close event. A long background resume deliberately replaces that
              // session and starts a fresh attempt without backoff.
              return true;
            }
            if (
              next.reason === "application-active" ||
              next.reason === "application-active-probe"
            ) {
              // A shorter absence only warrants a health check. The probe is
              // forked so the queue keeps draining while it runs; a probe that
              // answers leaves the session alone, one that fails or stalls ends
              // it as a transient failure.
              const probe = yield* active.probe.pipe(
                Effect.timeoutOrElse({
                  duration: CONNECTION_PROBE_TIMEOUT,
                  orElse: () =>
                    Effect.fail(
                      new ConnectionTransientError({
                        reason: "timeout",
                        detail: `${connection.label} did not respond to a connection health check.`,
                      }),
                    ),
                }),
                Effect.forkChild,
              );
              for (;;) {
                const probeEvent = yield* Effect.raceFirst(
                  Fiber.await(probe).pipe(
                    Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
                  ),
                  Queue.take(signals).pipe(
                    Effect.map((signal) => ({ _tag: "Signal" as const, signal })),
                  ),
                );
                if (probeEvent._tag === "ProbeCompleted") {
                  if (Exit.isFailure(probeEvent.exit)) {
                    yield* Ref.set(wakeProbeFailed, true);
                  }
                  yield* probeEvent.exit;
                  break;
                }
                switch (probeEvent.signal._tag) {
                  case "RetryRequested":
                    yield* Fiber.interrupt(probe);
                    return false;
                  case "NetworkChanged":
                    if (probeEvent.signal.network === "offline") {
                      yield* Fiber.interrupt(probe);
                      return false;
                    }
                    break;
                  case "Wakeup":
                    if (probeEvent.signal.reason === "application-active-reconnect") {
                      yield* Fiber.interrupt(probe);
                      return true;
                    }
                    break;
                }
              }
            }
            break;
        }
      }
    });

    const runAttempt = Effect.fnUntraced(
      function* (): Effect.fn.Return<AttemptOutcome, never, Scope.Scope> {
        const establishment = yield* Effect.raceAllFirst([
          exitUnlessInterrupted(establish()).pipe(
            Effect.map((exit): EstablishmentEvent => ({ _tag: "Completed", exit })),
          ),
          waitForEstablishmentInterrupt().pipe(
            Effect.map((resetRetry): EstablishmentEvent => ({ _tag: "Interrupted", resetRetry })),
          ),
          Effect.sleep(CONNECTION_ESTABLISHMENT_TIMEOUT).pipe(
            Effect.as<EstablishmentEvent>({ _tag: "TimedOut" }),
          ),
        ]);

        if (establishment._tag === "Interrupted") {
          return {
            _tag: "Interrupted",
            established: false,
            stable: false,
            resetRetry: establishment.resetRetry,
          } satisfies AttemptOutcome;
        }
        if (establishment._tag === "TimedOut") {
          return {
            _tag: "Failure",
            established: false,
            stable: false,
            failure: new ConnectionTransientError({
              reason: "timeout",
              detail: `${connection.label} did not respond during connection setup.`,
            }),
          } satisfies AttemptOutcome;
        }
        if (Exit.isFailure(establishment.exit)) {
          const cause = establishment.exit.cause;
          const isUnexpectedDefect =
            !Cause.hasInterruptsOnly(cause) && !cause.reasons.some(Cause.isFailReason);
          const outcome = failureFromExit(connection, establishment.exit, false, false);
          if (isUnexpectedDefect) {
            // These annotations are forwarded off-process as OTLP spans, so a
            // raw `Cause.pretty` dump would leak whatever the defect happens to
            // carry (tokens in URLs, payload fragments).
            const defect = cause.reasons.find(Cause.isDieReason)?.defect;
            yield* Effect.logError("Connection attempt failed with an unexpected defect.").pipe(
              Effect.annotateLogs({
                "connection.label": connection.label,
                "cause.reason_count": cause.reasons.length,
                ...safeErrorLogAttributes(defect),
              }),
            );
          }
          return outcome;
        }

        const active = establishment.exit.value;
        // The network can drop while the handshake is in flight. Publishing the
        // freshly built session now would hand the app a lease over a link that
        // is already gone, and the next failure would look like a server fault
        // rather than the disconnect it is. Returning `Interrupted` closes the
        // attempt scope, which tears the just-built session down.
        if ((yield* Ref.get(network)) === "offline") {
          return {
            _tag: "Interrupted",
            established: false,
            stable: false,
            resetRetry: false,
          } satisfies AttemptOutcome;
        }

        const connectedAt = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.set(session, Option.some(active));
        yield* setState({ phase: "connected", attempt: 0, lastFailure: null });

        const connectedExit = yield* Effect.raceFirst(
          active.closed,
          monitorConnectedSession(active),
        ).pipe(exitUnlessInterrupted);
        const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
        if (Exit.isSuccess(connectedExit)) {
          return {
            _tag: "Interrupted",
            established: true,
            stable: connectedForMs >= BACKOFF_RESET_AFTER_MS,
            resetRetry: connectedExit.value,
          } satisfies AttemptOutcome;
        }
        return failureFromExit(
          connection,
          connectedExit,
          true,
          connectedForMs >= BACKOFF_RESET_AFTER_MS,
        );
      },
      // Whatever ends the attempt, the published session must not outlive it:
      // an interrupt while connected would otherwise leave a dead session on
      // the ref, and `request` would dispatch into a torn-down RPC client
      // instead of failing with `RpcUnavailableError`.
      Effect.ensuring(clearSession),
    );

    /** Parks until a signal arrives; the boolean answers "restart the retry ladder?". */
    const waitForSignal = Queue.take(signals).pipe(
      Effect.map(
        (next) =>
          next._tag === "Wakeup" && ConnectionWakeups.isApplicationActiveWakeup(next.reason),
      ),
    );

    const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
      return yield* Effect.raceFirst(
        Effect.sleep(delayMs).pipe(Effect.as(false)),
        Effect.gen(function* () {
          for (;;) {
            const next = yield* Queue.take(signals);
            switch (next._tag) {
              case "Wakeup":
                return ConnectionWakeups.isApplicationActiveWakeup(next.reason);
              case "RetryRequested":
              case "NetworkChanged":
                return false;
            }
          }
        }),
      );
    });

    const run = Effect.fnUntraced(function* () {
      let failureCount = 0;
      let everConnected = false;
      let latestFailure: ConnectionAttemptError | null = null;

      for (;;) {
        if (yield* Ref.getAndSet(resetRetryState, false)) {
          failureCount = 0;
          latestFailure = null;
        }

        if ((yield* Ref.get(network)) === "offline") {
          yield* clearSession;
          yield* setState({
            phase: "offline",
            attempt: failureCount + 1,
            lastFailure: latestFailure,
          });
          if (yield* waitForSignal) {
            failureCount = 0;
          }
          continue;
        }

        const attempt = failureCount + 1;
        // The previous failure stays on the state for the whole next attempt, so
        // the UI keeps showing WHY it is reconnecting instead of flickering back
        // to "no error" the moment a retry starts.
        yield* setState(connectingState(everConnected, attempt, latestFailure));

        const outcome = yield* Effect.scoped(runAttempt());
        // Consumed on every iteration so a stale marker can never leak into a
        // later, unrelated failure.
        const failedWakeProbe = yield* Ref.getAndSet(wakeProbeFailed, false);
        if (outcome.established) {
          everConnected = true;
          if (outcome.stable) {
            failureCount = 0;
            latestFailure = null;
          }
        }
        if (outcome._tag === "Interrupted") {
          if (outcome.resetRetry) {
            failureCount = 0;
          }
          continue;
        }

        latestFailure = outcome.failure;
        if (outcome.failure._tag === "ConnectionBlockedError") {
          yield* setState({ phase: "blocked", attempt, lastFailure: outcome.failure });
          if (yield* waitForSignal) {
            failureCount = 0;
          }
          continue;
        }

        if (failedWakeProbe) {
          // The wake probe found a dead transport while the user is returning to
          // the app, so reconnect immediately instead of sleeping the first
          // backoff rung. Only this first attempt skips the ladder; if it fails
          // too, normal backoff resumes.
          failureCount = 0;
          yield* setState(connectingState(everConnected, 1, outcome.failure));
          continue;
        }

        failureCount += 1;
        const delayMs = retryDelayMs(failureCount - 1);
        // `attempt` counts failures since the last *stable* session, so it is
        // published after the increment: a drop that follows a stable session
        // reads as attempt 1 even though it was the loop's tenth try.
        yield* setState({ phase: "backoff", attempt: failureCount, lastFailure: outcome.failure });
        if (yield* waitForRetrySignal(delayMs)) {
          failureCount = 0;
        }
      }
    });

    yield* connectivity.changes.pipe(
      Stream.runForEach((next) =>
        Ref.modify(network, (current) =>
          current === next ? ([false, current] as const) : ([true, next] as const),
        ).pipe(
          Effect.flatMap((changed) =>
            changed ? signal({ _tag: "NetworkChanged", network: next }) : Effect.void,
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* wakeups.changes.pipe(
      Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason })),
      Effect.forkScoped,
    );
    yield* Effect.forkScoped(run());

    const retryNow = Ref.set(resetRetryState, true).pipe(
      Effect.andThen(signal({ _tag: "RetryRequested" })),
      Effect.withSpan("ConnectionSupervisor.retryNow"),
    );

    // Shutting the queue down interrupts whichever `Queue.take` the loop is
    // parked on, so teardown never leaves a dead session visible to callers.
    yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearSession)));

    return ConnectionSupervisor.of({ state, session, retryNow });
  });

export const layer = (
  connection: PreparedConnection,
): Layer.Layer<
  ConnectionSupervisor,
  never,
  Connectivity.Connectivity | ConnectionWakeups.ConnectionWakeups | RpcSession.RpcSessionFactory
> => Layer.effect(ConnectionSupervisor, start(connection));
