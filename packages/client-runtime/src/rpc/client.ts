import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { ConnectionSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";

/** Raised when a request is issued while no socket is live. */
export class RpcUnavailableError extends Schema.TaggedErrorClass<RpcUnavailableError>()(
  "RpcUnavailableError",
  {
    method: Schema.String,
  },
) {
  override get message(): string {
    return `RPC "${this.method}" was called while disconnected.`;
  }
}

/** Every method tag on the typed client (both unary and streaming). */
export type RpcTag = keyof WsRpcProtocolClient & string;

type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];

export type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

/** Unary tags: the method returns an `Effect`. */
export type UnaryRpcTag = {
  [K in RpcTag]: RpcMethod<K> extends (input: never) => Effect.Effect<unknown, unknown, unknown>
    ? K
    : never;
}[RpcTag];

/** Streaming tags: the method returns a `Stream`. */
export type StreamRpcTag = {
  [K in RpcTag]: RpcMethod<K> extends (input: never) => Stream.Stream<unknown, unknown, unknown>
    ? K
    : never;
}[RpcTag];

export type RpcSuccess<TTag extends UnaryRpcTag> =
  RpcMethod<TTag> extends (input: never) => Effect.Effect<infer A, unknown, unknown> ? A : never;

export type RpcFailure<TTag extends UnaryRpcTag> =
  RpcMethod<TTag> extends (input: never) => Effect.Effect<unknown, infer E, unknown> ? E : never;

export type RpcStreamValue<TTag extends StreamRpcTag> =
  RpcMethod<TTag> extends (input: never) => Stream.Stream<infer A, unknown, unknown> ? A : never;

export type RpcStreamFailure<TTag extends StreamRpcTag> =
  RpcMethod<TTag> extends (input: never) => Stream.Stream<unknown, infer E, unknown> ? E : never;

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

/** Resolve the live session or fail fast so callers see "disconnected" as an error. */
const currentSession = Effect.fn("clientRuntime.rpc.currentSession")(function* (method: string) {
  const supervisor = yield* ConnectionSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isNone(session)) {
    return yield* new RpcUnavailableError({ method });
  }
  return session.value;
});

/**
 * Issue a unary RPC against the currently-live session. Fails fast with
 * `RpcUnavailableError` if disconnected — callers decide whether to retry.
 */
export const request = Effect.fn("clientRuntime.rpc.request")(function* <TTag extends UnaryRpcTag>(
  tag: TTag,
  input: RpcInput<TTag>,
) {
  yield* Effect.annotateCurrentSpan({ "rpc.method": tag });
  const session = yield* currentSession(tag);
  const method = session.client[tag] as (
    input: RpcInput<TTag>,
  ) => Effect.Effect<RpcSuccess<TTag>, RpcFailure<TTag>>;
  return yield* method(input);
});

/**
 * Wait for a live session, then issue the request.
 *
 * `request` fails fast while disconnected so callers can decide, and for a
 * user-initiated action that is right — a click that cannot reach the server
 * should say so. But a surface that fetches on mount has a different need: on a
 * cold page load the socket is still opening, and failing there would make a hard
 * reload of a deep URL show an error for a journey that is perfectly readable a
 * moment later.
 *
 * This is not a retry, and so does not contend with ADR-0003's rule that exactly
 * one component reconnects. It waits for the supervisor's session ref to hold a
 * session and then asks once. `SubscriptionRef.changes` replays the current value,
 * so an already-connected caller proceeds immediately.
 */
export const requestWhenConnected = <TTag extends UnaryRpcTag>(
  tag: TTag,
  input: RpcInput<TTag>,
): Effect.Effect<RpcSuccess<TTag>, RpcFailure<TTag> | RpcUnavailableError, ConnectionSupervisor> =>
  Effect.gen(function* () {
    const supervisor = yield* ConnectionSupervisor;
    yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter(Option.isSome),
      Stream.take(1),
      Stream.runDrain,
    );
    return yield* request(tag, input);
  }).pipe(
    Effect.withSpan("clientRuntime.rpc.requestWhenConnected", {
      attributes: { "rpc.method": tag },
    }),
  );

/**
 * Subscribe to a streaming RPC. The returned stream watches the supervisor's
 * `session` ref and, on every reconnect, tears down the old subscription and
 * re-attaches to the fresh session — so a consumer subscribes once and keeps
 * receiving pushes across drops. While disconnected the stream is simply empty.
 *
 * Failure semantics: a pure transport failure (`RpcClientError`, i.e. the socket
 * dropped mid-stream) is logged and swallowed — the next session re-attaches us.
 * Every other failure (a domain error the server actually returned) propagates
 * to the consumer.
 */
export const subscribe = <TTag extends StreamRpcTag>(
  tag: TTag,
  input: RpcInput<TTag>,
): Stream.Stream<RpcStreamValue<TTag>, RpcStreamFailure<TTag>, ConnectionSupervisor> =>
  Stream.unwrap(
    Effect.map(ConnectionSupervisor, (supervisor) =>
      SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = session.client[tag] as (
                input: RpcInput<TTag>,
              ) => Stream.Stream<RpcStreamValue<TTag>, RpcStreamFailure<TTag>>;
              return Stream.suspend(() =>
                method(input).pipe(
                  Stream.catchCause((cause) => {
                    const isTransportFailure =
                      cause.reasons.length > 0 &&
                      cause.reasons.every(
                        (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                      );
                    if (isTransportFailure) {
                      // Go quiet; the session ref will emit None then a fresh
                      // session, which re-attaches this subscription.
                      return Stream.fromEffect(
                        Effect.logWarning(
                          "RPC subscription lost its transport; waiting for the next session.",
                          { method: tag, cause: Cause.pretty(cause) },
                        ),
                      ).pipe(Stream.drain);
                    }
                    return Stream.failCause(cause);
                  }),
                ),
              );
            },
          }),
        ),
      ),
    ),
  ).pipe(Stream.withSpan("clientRuntime.rpc.subscribe", { attributes: { "rpc.method": tag } }));
