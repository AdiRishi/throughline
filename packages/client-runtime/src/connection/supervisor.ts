import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Socket from "effect/unstable/socket/Socket";

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

/**
 * Capped exponential backoff. The first rung is deliberately not sub-second: a
 * server that is still starting is the common case, and hammering it at 1s only
 * makes the log noisier without connecting sooner.
 */
const RETRY_DELAYS_MS = [3_000, 4_000, 8_000, 16_000] as const;
const MAX_RETRY_DELAY_MS = 16_000;

/**
 * Bounds the whole establishment phase (connect + readiness probe). The socket
 * layer's own open-timeout only bounds the raw open; a socket that opens but
 * whose readiness probe hangs would otherwise freeze the loop forever.
 */
const CONNECTION_ESTABLISHMENT_TIMEOUT = "15 seconds";

/**
 * The failure counter resets only after a session survives this long. A server
 * that accepts sockets and then crashes keeps escalating backoff instead of
 * being reconnected at the first rung forever.
 */
const BACKOFF_RESET_AFTER_MS = 30_000;

/**
 * Everything that can interrupt whatever the loop is currently waiting on. One
 * unbounded queue is the single wake-up channel: whichever part of the loop is
 * parked (establishing, connected, backing off, blocked, offline) is the one
 * taking from it, so a signal can never be delivered to two waiters or dropped.
 */
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

/**
 * Collapse a finished attempt into an outcome the loop can act on. A typed
 * failure passes through as-is — transient OR blocked. A pure interrupt means
 * something else already decided what happens next; an unexpected defect is
 * synthesized into a transient failure instead of killing the supervisor fiber
 * (defects are never blocking).
 */
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
 * instead: it publishes `blocked` and waits for a signal that whatever blocked
 * it may have changed. Consumers observe two `SubscriptionRef`s:
 *
 * - `state`: the coarse phase + attempt count + last failure the UI renders.
 * - `session`: `Some(session)` while a socket is live, `None` otherwise. RPC
 *   subscriptions watch this to auto-re-attach across reconnects (see `client.ts`).
 */
export class ConnectionSupervisor extends Context.Service<
  ConnectionSupervisor,
  {
    readonly state: SubscriptionRef.SubscriptionRef<ConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    /**
     * Wake the supervisor for an immediate fresh attempt and reset the backoff
     * ladder to its first rung — call it after whatever blocked or slowed the
     * connection (credentials, configuration) has changed. It cuts an
     * in-progress backoff sleep short instead of waiting it out.
     */
    readonly retryNow: Effect.Effect<void>;
  }
>()("@app/client-runtime/connection/supervisor/ConnectionSupervisor") {}

/**
 * Build a supervisor for one connection and fork its loop into the current
 * scope. The loop (and its socket) is torn down when the scope closes.
 */
export const start = (
  connection: PreparedConnection,
): Effect.Effect<
  ConnectionSupervisor["Service"],
  never,
  Scope.Scope | Socket.WebSocketConstructor
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

    const clearSession = SubscriptionRef.set(session, Option.none());
    const setState = (next: ConnectionState) => SubscriptionRef.set(state, next);
    const signal = (next: SupervisorSignal) => Queue.offer(signals, next).pipe(Effect.asVoid);

    const establish = Effect.fnUntraced(function* () {
      const active = yield* sessions.connect(connection);
      yield* active.connected;
      return active;
    });

    /**
     * Signals that abandon an in-flight establishment. An explicit retry or a
     * network loss makes the current attempt pointless; a resume-triggered
     * wakeup additionally means the ladder should restart at rung one. Every
     * other signal is consumed here on purpose, so it cannot leak into the next
     * `Queue.take` and cut a later backoff short.
     */
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

    /** The same triage while a session is live: which signals end this session. */
    const monitorConnectedSession = Effect.fnUntraced(function* () {
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
            // Operating systems commonly suspend sockets without delivering a
            // close event. A long background resume deliberately replaces that
            // session and starts a fresh attempt without backoff.
            if (next.reason === "application-active-reconnect") {
              return true;
            }
            break;
        }
      }
    });

    const runAttempt = Effect.fnUntraced(
      function* (): Effect.fn.Return<
        AttemptOutcome,
        never,
        Scope.Scope | Socket.WebSocketConstructor
      > {
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
            // `safeErrorLogAttributes` takes the defect, not the cause: these
            // annotations are forwarded off-process as OTLP spans and written to
            // `.logs`, so a raw `Cause.pretty` dump would leak whatever the
            // defect happens to carry (tokens in URLs, payload fragments).
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
        const connectedAt = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.set(session, Option.some(active));
        yield* setState({ phase: "connected", attempt: 0, lastFailure: null });

        // Hold here until the socket drops (`closed` fails with the reason) or a
        // signal decides this session is over.
        const connectedExit = yield* Effect.raceFirst(
          active.closed,
          monitorConnectedSession(),
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
      // Whatever ends the attempt — a drop, a signal, an interrupt from the
      // enclosing scope — the published session must not outlive it. Without
      // this, an interrupt while connected leaves a dead session on the ref and
      // `request()` dispatches into a torn-down RPC client instead of failing
      // with `RpcUnavailableError`.
      Effect.ensuring(clearSession),
    );

    /**
     * Park until something happens. The boolean answers "should the retry ladder
     * restart?" — only a user-visible return to the app earns a fresh rung.
     */
    const waitForSignal = Queue.take(signals).pipe(
      Effect.map(
        (next) =>
          next._tag === "Wakeup" && ConnectionWakeups.isApplicationActiveWakeup(next.reason),
      ),
    );

    /** The backoff sleep, racing the signal queue so an explicit retry cuts it short. */
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
        if (outcome.established) {
          everConnected = true;
          if (outcome.stable) {
            // Backoff only resets after a *stable* session — a crash-flapping
            // server (accepts the socket, dies moments later) keeps escalating
            // toward the 16s cap instead of being hammered at the first rung.
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
          // A blocked failure never feeds the backoff schedule: publish
          // `blocked` and park until an external signal reports that whatever
          // blocked us may have changed.
          yield* setState({ phase: "blocked", attempt, lastFailure: outcome.failure });
          if (yield* waitForSignal) {
            failureCount = 0;
          }
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
    // parked on, then the published session is cleared — teardown never leaves
    // a dead session visible to `request`/`subscribe`.
    yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearSession)));

    return ConnectionSupervisor.of({ state, session, retryNow });
  });

/**
 * A `Layer` that supervises `connection` and provides `ConnectionSupervisor` to
 * the rest of the runtime — so `request`/`subscribe` resolve the same instance.
 */
export const layer = (
  connection: PreparedConnection,
): Layer.Layer<ConnectionSupervisor, never, Socket.WebSocketConstructor> =>
  Layer.effect(ConnectionSupervisor, start(connection));
