import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import * as Connectivity from "../../src/connection/connectivity.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  type ConnectionAttemptError,
  type ConnectionState,
  type NetworkStatus,
  type PreparedConnection,
} from "../../src/connection/model.ts";
import { start } from "../../src/connection/supervisor.ts";
import * as ConnectionWakeups from "../../src/connection/wakeups.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import { RpcSessionFactory, type RpcSession } from "../../src/rpc/session.ts";

const SOCKET_URL = "ws://127.0.0.1:0/ws";

function transient(detail = "Connection failed.") {
  return new ConnectionTransientError({ reason: "transport", detail });
}

function blocked(detail = "Authentication required.") {
  return new ConnectionBlockedError({ reason: "authentication", detail });
}

/** Await the first state (current or future) matching `predicate`. */
const awaitState = (
  states: SubscriptionRef.SubscriptionRef<ConnectionState>,
  predicate: (state: ConnectionState) => boolean,
) =>
  SubscriptionRef.changes(states).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.flatMap(
      Option.match({ onNone: () => Effect.die("state stream ended"), onSome: Effect.succeed }),
    ),
  );

/**
 * Poll the *current* state instead of subscribing. `awaitState` can miss a state
 * that is published and replaced within one fiber turn — which is exactly what
 * happens when an explicit retry cuts a backoff short.
 */
const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  states: SubscriptionRef.SubscriptionRef<ConnectionState>,
  predicate: (state: ConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(states);
  for (let iteration = 0; iteration < 200; iteration += 1) {
    lastState = yield* SubscriptionRef.get(states);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, attempt=${lastState.attempt}, failure=${lastState.lastFailure?.detail ?? "none"}`,
    ),
  );
});

/**
 * A supervisor harness the tests drive by hand: `prepareSocketUrl` and the
 * session factory are both scripted per attempt, and the platform seams
 * (network status, wakeups) are `SubscriptionRef`s the test pushes into.
 */
const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (attempt: number) => Effect.Effect<string, ConnectionAttemptError>;
  readonly connect?: (attempt: number) => Effect.Effect<RpcSession, ConnectionAttemptError>;
  readonly connected?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({ sequence: 0, reason: "application-active" });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connection: PreparedConnection = {
    label: "test",
    prepareSocketUrl: Effect.gen(function* () {
      const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
      return options?.prepare === undefined ? SOCKET_URL : yield* options.prepare(attempt);
    }),
  };

  const connect = (target: PreparedConnection) =>
    Effect.gen(function* () {
      // The real factory mints the credential inside `connect`, so a rejected
      // mint fails the attempt rather than the loop.
      yield* target.prepareSocketUrl;
      const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
      if (options?.connect !== undefined) {
        return yield* options.connect(attempt);
      }
      const closed = yield* Deferred.make<never, ConnectionTransientError>();
      yield* Ref.update(closedSessions, (all) => [...all, closed]);
      return yield* Effect.acquireRelease(
        Effect.succeed({
          client: {} as WsRpcProtocolClient,
          connected: options?.connected?.(attempt) ?? Effect.void,
          closed: Deferred.await(closed),
        } satisfies RpcSession),
        () => Ref.update(releaseCount, (count) => count + 1),
      );
    });

  const dependencies = Layer.mergeAll(
    Socket.layerWebSocketConstructorGlobal,
    Layer.succeed(RpcSessionFactory, { connect }),
    Connectivity.layer({
      status: SubscriptionRef.get(networkStatus),
      changes: SubscriptionRef.changes(networkStatus),
    }),
    ConnectionWakeups.layer({
      changes: SubscriptionRef.changes(wakeups).pipe(
        Stream.drop(1),
        Stream.map((event) => event.reason),
      ),
    }),
  );

  return {
    connection,
    dependencies,
    prepareCount,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({ sequence: event.sequence + 1, reason })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      error = transient("Session closed."),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.fail(latest, error);
      }
    }),
  };
});

describe("ConnectionSupervisor", () => {
  it.effect("keeps retrying when the credential mint fails, without freezing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient("mint failed")),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      const backoff = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      assert.equal(backoff.lastFailure?.detail, "mint failed");
      assert.isTrue((yield* Ref.get(harness.prepareCount)) >= 1);
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped),
  );

  it.effect("publishes the session while connected and clears it on drop", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));

      yield* harness.closeLatestSession(transient("socket dropped"));
      const backoff = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      assert.equal(backoff.lastFailure?.detail, "socket dropped");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));

      // After the first backoff rung a fresh session is connected and republished.
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));
      assert.equal(yield* Ref.get(harness.sessionCount), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("retries forever with exponential backoff capped at sixteen seconds", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()) });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      assert.equal(yield* Ref.get(harness.prepareCount), 1);

      for (const [index, delay] of [3_000, 4_000, 8_000, 16_000, 16_000, 16_000].entries()) {
        yield* TestClock.adjust(delay);
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === index + 2,
        );
      }

      assert.equal(yield* Ref.get(harness.prepareCount), 7);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Server did not answer.")) : Effect.never,
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.attempt === 2,
      );
      assert.equal(retrying.lastFailure?._tag, "ConnectionTransientError");
      assert.equal(retrying.lastFailure?.detail, "Server did not answer.");
    }).pipe(Effect.scoped),
  );

  it.effect("escalates backoff while the connection keeps flapping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      // Three instant drops: the counter must climb 1 → 2 → 3 even though
      // every attempt technically "connected" before dying.
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession(transient("flap 1"));
      const first = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      assert.equal(first.attempt, 1);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession(transient("flap 2"));
      const second = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt > 1,
      );
      assert.equal(second.attempt, 2);

      yield* TestClock.adjust("4 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession(transient("flap 3"));
      const third = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt > 2,
      );
      assert.equal(third.attempt, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("resets backoff only after a stable (30s+) session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      // Build up a failure streak of 2.
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession(transient("flap 1"));
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession(transient("flap 2"));
      yield* TestClock.adjust("4 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      // This session survives past the stability window before dropping…
      yield* TestClock.adjust("30 seconds");
      yield* harness.closeLatestSession(transient("late drop"));

      // …so the streak resets: the next backoff is attempt 1 again.
      const afterStable = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      assert.equal(afterStable.attempt, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("converts unexpected session defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        connect: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed({
                client: {} as WsRpcProtocolClient,
                connected: Effect.void,
                closed: Effect.never,
              } satisfies RpcSession),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      assert.equal(failed.lastFailure?._tag, "ConnectionTransientError");
      assert.equal(failed.lastFailure?.detail, "test connection failed unexpectedly.");

      // The defect must not have killed the loop: the next attempt succeeds.
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* Ref.get(harness.sessionCount), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("retries when a session never becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ connected: () => Effect.never });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
      yield* TestClock.adjust("14 seconds");
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "connecting");

      yield* TestClock.adjust("1 second");
      const retrying = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      assert.equal(retrying.lastFailure?.detail, "test did not respond during connection setup.");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts a connection attempt when setup times out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ connect: () => Effect.never });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
      yield* TestClock.adjust("15 seconds");
      const retrying = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      assert.equal(retrying.lastFailure?.detail, "test did not respond during connection setup.");
    }).pipe(Effect.scoped),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(SOCKET_URL),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      // No clock movement at all: the retry must cut the 3s sleep short.
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      assert.equal(yield* Ref.get(harness.prepareCount), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("explicit retry starts a fresh backoff sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ prepare: () => Effect.fail(transient()) });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      yield* supervisor.retryNow;
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      assert.equal(yield* Ref.get(harness.prepareCount), 3);

      // Back at rung one: 2999ms is not enough, 3000ms is.
      yield* TestClock.adjust("2999 millis");
      assert.equal(yield* Ref.get(harness.prepareCount), 3);
      yield* TestClock.adjust("1 milli");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      assert.equal(yield* Ref.get(harness.prepareCount), 4);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(SOCKET_URL)),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      const parked = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      assert.equal(parked.lastFailure?.detail, "Authentication required.");
      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));

      // Parked: no amount of elapsed time triggers another attempt.
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(harness.prepareCount), 1);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "blocked");

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* Ref.get(harness.prepareCount), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("blocks when the credential mint is rejected outright", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () =>
          Effect.fail(
            new ConnectionBlockedError({
              reason: "permission",
              detail: "The bootstrap credential was rejected.",
            }),
          ),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      const parked = yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      assert.equal(parked.lastFailure?.detail, "The bootstrap credential was rejected.");
      assert.equal(parked.lastFailure?._tag, "ConnectionBlockedError");

      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(harness.prepareCount), 1);

      // The retry mints again immediately (no backoff) and parks once more.
      yield* supervisor.retryNow;
      for (let iteration = 0; iteration < 200; iteration += 1) {
        const settled =
          (yield* Ref.get(harness.prepareCount)) === 2 &&
          (yield* SubscriptionRef.get(supervisor.state)).phase === "blocked";
        if (settled) break;
        yield* Effect.yieldNow;
      }
      assert.equal(yield* Ref.get(harness.prepareCount), 2);
      assert.equal((yield* SubscriptionRef.get(supervisor.state)).phase, "blocked");
    }).pipe(Effect.scoped),
  );

  it.effect("resets retries when activation wakes a blocked connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(transient())
            : attempt === 2
              ? Effect.fail(blocked())
              : Effect.succeed(SOCKET_URL),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "blocked" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.attempt === 0,
      );
      assert.equal(yield* Ref.get(harness.prepareCount), 3);
    }).pipe(Effect.scoped),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(SOCKET_URL)),
      });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      assert.equal(yield* Ref.get(harness.prepareCount), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* Ref.get(harness.prepareCount), 0);

      yield* harness.setNetworkStatus("online");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.equal(yield* Ref.get(harness.prepareCount), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("clears the published session when the supervisor is torn down", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const scope = yield* Scope.make();
      const supervisor = yield* start(harness.connection).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(harness.dependencies),
      );

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      assert.isTrue(Option.isSome(yield* SubscriptionRef.get(supervisor.session)));

      // Interrupting a *connected* supervisor must not leave a dead session on
      // the ref: `request` would dispatch into a torn-down RPC client instead of
      // failing with `RpcUnavailableError`.
      yield* Scope.close(scope, Exit.void);

      assert.isTrue(Option.isNone(yield* SubscriptionRef.get(supervisor.session)));
      assert.equal(yield* Ref.get(harness.releaseCount), 1);
    }).pipe(Effect.scoped),
  );
});
