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
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import {
  EnvironmentAuthorizationError,
  PRODUCT_WS_METHODS,
  WS_METHODS,
  type ServerLifecycleStreamEvent,
} from "@app/contracts";

import { INITIAL_CONNECTION_STATE, type ConnectionState } from "../../src/connection/model.ts";
import { ConnectionSupervisor } from "../../src/connection/supervisor.ts";
import { RpcUnavailableError, request, subscribe } from "../../src/rpc/client.ts";
import type { WsRpcProtocolClient } from "../../src/rpc/protocol.ts";
import type { RpcSession } from "../../src/rpc/session.ts";

const AT = DateTime.makeUnsafe(0);

const lifecycle = (sequence: number): ServerLifecycleStreamEvent => ({
  version: 1,
  sequence,
  phase: "ready",
  at: AT,
});

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
  const supervisor = ConnectionSupervisor.of({
    state,
    session: activeSession,
    retryNow: Effect.void,
  });
  return { activeSession, supervisor };
});

describe("rpc client", () => {
  it.effect("request fails fast with RpcUnavailableError while disconnected", () =>
    Effect.gen(function* () {
      const { supervisor } = yield* makeHarness;

      const exit = yield* request(WS_METHODS.serverGetConfig, {}).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const unavailable = exit.cause.reasons.find(
          (reason) => reason._tag === "Fail" && reason.error instanceof RpcUnavailableError,
        );
        assert.isDefined(unavailable, "expected RpcUnavailableError");
        if (unavailable?._tag === "Fail" && unavailable.error instanceof RpcUnavailableError) {
          assert.strictEqual(unavailable.error.method, WS_METHODS.serverGetConfig);
        }
      }
    }),
  );

  it.effect("request runs against the live session", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const client = {
        [PRODUCT_WS_METHODS.settingsUpdate]: (input: {
          readonly harness: "codex" | "claude" | null;
        }) => Effect.succeed(input.harness === null ? {} : { harness: input.harness }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(PRODUCT_WS_METHODS.settingsUpdate, { harness: "codex" }).pipe(
        Effect.provideService(ConnectionSupervisor, supervisor),
      );

      assert.deepStrictEqual(result, { harness: "codex" });
    }),
  );

  it.effect("subscribe re-attaches to each fresh session across reconnects", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const firstEvents = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
      const secondEvents = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
      const firstClient = {
        [WS_METHODS.serverSubscribeLifecycle]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.serverSubscribeLifecycle]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawFirst = yield* Deferred.make<void>();
      const sawSecond = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.serverSubscribeLifecycle, {}).pipe(
          Stream.runForEach((event) =>
            Ref.updateAndGet(values, (current) => [...current, event.sequence]).pipe(
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
      yield* Queue.offer(firstEvents, lifecycle(1));
      yield* Deferred.await(sawFirst);

      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, lifecycle(2));
      yield* Deferred.await(sawSecond);

      assert.deepEqual(yield* Ref.get(values), [1, 2]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("subscribe goes quiet on a transport failure and survives to re-attach", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const failingClient = {
        [WS_METHODS.serverSubscribeLifecycle]: () => Stream.fail(transportError()),
      } as unknown as WsRpcProtocolClient;
      const nextEvents = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
      const nextClient = {
        [WS_METHODS.serverSubscribeLifecycle]: () => Stream.fromQueue(nextEvents),
      } as unknown as WsRpcProtocolClient;

      const values = yield* Ref.make<ReadonlyArray<number>>([]);
      const sawValue = yield* Deferred.make<void>();

      const consumer = yield* Effect.forkChild(
        subscribe(WS_METHODS.serverSubscribeLifecycle, {}).pipe(
          Stream.runForEach((event) =>
            Ref.update(values, (current) => [...current, event.sequence]).pipe(
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
      yield* Queue.offer(nextEvents, lifecycle(7));
      yield* Deferred.await(sawValue);

      assert.deepEqual(yield* Ref.get(values), [7]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("does not classify subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      const client = {
        [WS_METHODS.serverSubscribeLifecycle]: () => Stream.die(defect),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness;

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const exit = yield* subscribe(WS_METHODS.serverSubscribeLifecycle, {}).pipe(
        Stream.runDrain,
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.isTrue(Cause.hasDies(exit.cause));
      }
    }),
  );

  it.effect("subscribe propagates domain failures to the consumer", () =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness;
      const rejectingClient = {
        [WS_METHODS.serverSubscribeLifecycle]: () =>
          Stream.fail(new EnvironmentAuthorizationError({ reason: "expired" })),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(activeSession, Option.some(session(rejectingClient)));

      const exit = yield* subscribe(WS_METHODS.serverSubscribeLifecycle, {}).pipe(
        Stream.runCollect,
        Effect.provideService(ConnectionSupervisor, supervisor),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const authFailure = exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && reason.error instanceof EnvironmentAuthorizationError,
        );
        assert.isTrue(authFailure, "expected the authorization error to surface");
      }
    }),
  );
});
