import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentAuthorizationError, WS_METHODS, type TickEvent } from "@app/contracts";

import { INITIAL_CONNECTION_STATE, type ConnectionState } from "../../src/connection/model.ts";
import { ConnectionSupervisor } from "../../src/connection/supervisor.ts";
import { RpcUnavailableError, request, subscribe, subscribeDynamic } from "../../src/rpc/client.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import type { RpcSession } from "../../src/rpc/session.ts";

const isRpcUnavailableError = Schema.is(RpcUnavailableError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const AT = DateTime.makeUnsafe(0);

const tick = (n: number): TickEvent => ({ tick: n, at: AT });

/** A live-looking session around a hand-rolled client record. */
const session = (client: WsRpcProtocolClient): RpcSession => ({
  client,
  connected: Effect.void,
  closed: Effect.never,
});

const transportError = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "socket closed",
      cause: new Error("socket closed"),
    }),
  });

/** A fake supervisor whose session ref the test drives by hand. */
const makeHarness = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<ConnectionState>(INITIAL_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = ConnectionSupervisor.of({
    state,
    session: activeSession,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  });
  return { activeSession, retryCount, supervisor };
});

describe("rpc client", () => {
  it.effect("request fails fast with RpcUnavailableError while disconnected", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* makeHarness;

      const exit = yield* request(WS_METHODS.serverEcho, { message: "hello" }).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const unavailable = exit.cause.reasons.some(
          (reason) => reason._tag === "Fail" && isRpcUnavailableError(reason.error),
        );
        assert.isTrue(unavailable, "expected RpcUnavailableError");
      }
    }),
  );

  it.effect("request runs against the live session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const client = {
        [WS_METHODS.serverEcho]: (input: { readonly message: string }) =>
          Effect.succeed({ message: input.message, receivedAt: AT }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.serverEcho, { message: "hello" }).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
      );

      assert.equal(result.message, "hello");
    }),
  );

  it.effect("subscribe re-attaches to each fresh session across reconnects", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const firstTicks = yield* Queue.unbounded<TickEvent>();
      const secondTicks = yield* Queue.unbounded<TickEvent>();
      const firstClient = {
        [WS_METHODS.serverSubscribeTicks]: () => Stream.fromQueue(firstTicks),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.serverSubscribeTicks]: () => Stream.fromQueue(secondTicks),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawFirst = yield* Deferred.make<void>();
      const sawSecond = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.serverSubscribeTicks, {}).pipe(
          Stream.runForEach((event) =>
            Ref.updateAndGet(values, (current) => [...current, event.tick]).pipe(
              Effect.flatMap((current) =>
                current.length === 1
                  ? Deferred.succeed(sawFirst, undefined).pipe(Effect.asVoid)
                  : current.length === 2
                    ? Deferred.succeed(sawSecond, undefined).pipe(Effect.asVoid)
                    : Effect.void,
              ),
            ),
          ),
          Effect.provideService(ConnectionSupervisor, supervisor),
        ),
      );

      // First session delivers, then the connection drops and a new session
      // replaces it — the consumer must keep receiving without re-subscribing.
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* Queue.offer(firstTicks, tick(1));
      yield* Deferred.await(sawFirst);

      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondTicks, tick(2));
      yield* Deferred.await(sawSecond);

      assert.deepEqual(yield* Ref.get(values), [1, 2]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("subscribeDynamic recomputes its input for every session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const observedSessions = yield* Ref.make<ReadonlyArray<RpcSession>>([]);
      const makeClient = (ticks: Queue.Queue<TickEvent>) =>
        ({
          [WS_METHODS.serverSubscribeTicks]: () => Stream.fromQueue(ticks),
        }) as unknown as WsRpcProtocolClient;
      const firstTicks = yield* Queue.unbounded<TickEvent>();
      const secondTicks = yield* Queue.unbounded<TickEvent>();
      const firstSession = session(makeClient(firstTicks));
      const secondSession = session(makeClient(secondTicks));

      const consumer = yield* Effect.forkChild(
        subscribeDynamic(WS_METHODS.serverSubscribeTicks, (current) =>
          Ref.update(observedSessions, (all) => [...all, current]).pipe(Effect.as({})),
        ).pipe(Stream.runDrain, Effect.provideService(ConnectionSupervisor, supervisor)),
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(observedSessions)).length >= 1) break;
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(observedSessions)).length >= 2) break;
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(consumer);

      // The input is derived from the session that is actually live — that is
      // the seam a resume cursor rides on.
      assert.deepEqual(yield* Ref.get(observedSessions), [firstSession, secondSession]);
    }),
  );

  it.effect("subscribe goes quiet on a transport failure and survives to re-attach", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const failingClient = {
        [WS_METHODS.serverSubscribeTicks]: () => Stream.fail(transportError()),
      } as unknown as WsRpcProtocolClient;
      const nextTicks = yield* Queue.unbounded<TickEvent>();
      const nextClient = {
        [WS_METHODS.serverSubscribeTicks]: () => Stream.fromQueue(nextTicks),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawValue = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.serverSubscribeTicks, {}).pipe(
          Stream.runForEach((event) =>
            Ref.update(values, (current) => [...current, event.tick]).pipe(
              Effect.andThen(Deferred.succeed(sawValue, undefined)),
            ),
          ),
          Effect.provideService(ConnectionSupervisor, supervisor),
        ),
      );

      // The transport failure must not kill the consumer...
      yield* SubscriptionRef.set(activeSession, Option.some(session(failingClient)));
      // ...so a later session still delivers.
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
      yield* Queue.offer(nextTicks, tick(7));
      yield* Deferred.await(sawValue);

      assert.deepEqual(yield* Ref.get(values), [7]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new EnvironmentAuthorizationError({ reason: "expired" });
      const subscriptions: Array<string> = [];
      const observedFailures: Array<unknown> = [];
      const firstClient = {
        [WS_METHODS.serverSubscribeTicks]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.serverSubscribeTicks]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness;

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const consumer = yield* Effect.forkChild(
        subscribe(
          WS_METHODS.serverSubscribeTicks,
          {},
          {
            onExpectedFailure: (cause) =>
              Effect.sync(() => {
                observedFailures.push(Cause.squash(cause));
              }),
          },
        ).pipe(Stream.runDrain, Effect.provideService(ConnectionSupervisor, supervisor)),
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      assert.deepEqual(subscriptions, ["first"]);
      assert.deepEqual(observedFailures, [domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(consumer);

      assert.deepEqual(subscriptions, ["first", "second"]);
      assert.equal(yield* Ref.get(retryCount), 0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new EnvironmentAuthorizationError({ reason: "expired" });
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.serverSubscribeTicks]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness;

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* Effect.forkChild(
        subscribe(
          WS_METHODS.serverSubscribeTicks,
          {},
          {
            onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
            retryExpectedFailureAfter: "100 millis",
          },
        ).pipe(Stream.runDrain, Effect.provideService(ConnectionSupervisor, supervisor)),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) break;
        yield* Effect.yieldNow;
      }

      assert.equal(yield* Ref.get(subscriptionCount), 1);
      assert.equal(yield* Ref.get(expectedFailureCount), 1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(consumer);

      assert.equal(yield* Ref.get(subscriptionCount), 2);
      assert.equal(yield* Ref.get(expectedFailureCount), 1);
    }),
  );

  it.effect("does not classify subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      let expectedFailureCount = 0;
      const client = {
        [WS_METHODS.serverSubscribeTicks]: () => Stream.die(defect),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness;

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const exit = yield* subscribe(
        WS_METHODS.serverSubscribeTicks,
        {},
        {
          onExpectedFailure: () =>
            Effect.sync(() => {
              expectedFailureCount += 1;
            }),
        },
      ).pipe(Stream.runDrain, Effect.provideService(ConnectionSupervisor, supervisor), Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasDies(exit.cause));
      }
      assert.equal(expectedFailureCount, 0);
    }),
  );

  it.effect("subscribe propagates domain failures to the consumer", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const rejectingClient = {
        [WS_METHODS.serverSubscribeTicks]: () =>
          Stream.fail(new EnvironmentAuthorizationError({ reason: "expired" })),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(rejectingClient).pipe(Option.map(session)),
      );

      const exit = yield* subscribe(WS_METHODS.serverSubscribeTicks, {}).pipe(
        Stream.runCollect,
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const authFailure = exit.cause.reasons.some(
          (reason) => reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
        );
        assert.isTrue(authFailure, "expected the authorization error to surface");
      }
    }),
  );
});
