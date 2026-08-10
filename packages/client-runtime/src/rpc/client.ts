import type * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { ConnectionSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";

/** Raised when a request is issued while no socket is live. */
export class RpcUnavailableError extends Schema.TaggedError<RpcUnavailableError>()(
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

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

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

interface SubscriptionOptions<TTag extends StreamRpcTag> {
  /**
   * Called with a cause made entirely of *expected* failures (no defects, no
   * transport failures). Handling one keeps the subscription alive instead of
   * propagating: the stream goes quiet and waits for the next session, or for
   * `retryExpectedFailureAfter` if one is set.
   */
  readonly onExpectedFailure?: (
    cause: Cause.Cause<RpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  /** Re-subscribe to the SAME session this long after a handled failure. */
  readonly retryExpectedFailureAfter?: Duration.Input;
  /** An external trigger that re-subscribes against the current session. */
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

/**
 * Subscribe to a streaming RPC, recomputing the input for EVERY session.
 *
 * The returned stream watches the supervisor's `session` ref and, on every
 * reconnect, tears down the old subscription and re-attaches to the fresh
 * session — so a consumer subscribes once and keeps receiving pushes across
 * drops. While disconnected the stream is simply empty.
 *
 * `makeInput` runs per session rather than once at call time: that is the
 * stream-resumption seam. A subscription that tracks a cursor hands the
 * reconnecting session the cursor it actually reached, instead of replaying
 * from wherever the original call started.
 *
 * Failure semantics: a pure transport failure (`RpcClientError`, i.e. the socket
 * dropped mid-stream) is logged and swallowed — the next session re-attaches us.
 * An all-expected-failure cause is handed to `onExpectedFailure` when one is
 * given. Everything else (a defect, or a domain error with no handler)
 * propagates to the consumer.
 */
export function subscribeDynamic<TTag extends StreamRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<RpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<RpcStreamValue<TTag>, RpcStreamFailure<TTag>, ConnectionSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* ConnectionSupervisor;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = session.client[tag] as (
                input: RpcInput<TTag>,
              ) => Stream.Stream<RpcStreamValue<TTag>, RpcStreamFailure<TTag>>;
              const subscribeToSession = (): Stream.Stream<
                RpcStreamValue<TTag>,
                RpcStreamFailure<TTag>
              > =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      return method(input).pipe(
                        Stream.catchCause((cause) => {
                          const hasOnlyExpectedFailures =
                            cause.reasons.length > 0 &&
                            cause.reasons.every((reason) => reason._tag === "Fail");
                          const isTransportFailure =
                            hasOnlyExpectedFailures &&
                            cause.reasons.every(
                              (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                            );
                          if (isTransportFailure) {
                            // Go quiet; the session ref will emit None then a
                            // fresh session, which re-attaches this
                            // subscription. The annotations carry only
                            // sanitized error metadata — they are forwarded
                            // off-process as OTLP spans, so a `Cause.pretty`
                            // dump would leak whatever the failure carries.
                            return Stream.fromEffect(
                              Effect.logWarning(
                                "RPC subscription lost its transport; waiting for the next session.",
                                {
                                  method: tag,
                                  "cause.reason_count": cause.reasons.length,
                                  ...safeErrorLogAttributes(
                                    cause.reasons.find((reason) => reason._tag === "Fail")?.error,
                                  ),
                                },
                              ),
                            ).pipe(Stream.drain);
                          }
                          if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                            const handled = Stream.fromEffect(
                              options.onExpectedFailure(cause),
                            ).pipe(Stream.drain);
                            if (options.retryExpectedFailureAfter === undefined) {
                              return handled;
                            }
                            return handled.pipe(
                              Stream.concat(
                                Stream.fromEffect(
                                  Effect.sleep(options.retryExpectedFailureAfter),
                                ).pipe(Stream.drain),
                              ),
                              Stream.concat(subscribeToSession()),
                            );
                          }
                          return Stream.failCause(cause);
                        }),
                      );
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(Stream.withSpan("clientRuntime.rpc.subscribe", { attributes: { "rpc.method": tag } }));
}

/** `subscribeDynamic` with an input fixed at call time. */
export function subscribe<TTag extends StreamRpcTag>(
  tag: TTag,
  input: RpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<RpcStreamValue<TTag>, RpcStreamFailure<TTag>, ConnectionSupervisor> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}
