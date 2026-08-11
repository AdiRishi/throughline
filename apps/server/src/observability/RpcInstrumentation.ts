/**
 * Span + metric instrumentation for the websocket RPC handlers.
 *
 * `RpcServer` is mounted with `disableTracing: true`, so the handler wrappers
 * here are the only source of server-side RPC spans: every handler is wrapped
 * in `ws.rpc.<method>`, which is also what gives handler logs a span to attach
 * to and what joins server work to the client's `traceId`.
 *
 * @module observability/RpcInstrumentation
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Metric from "effect/Metric";
import * as Stream from "effect/Stream";

import { outcomeFromExit } from "./Attributes.ts";
import { metricAttributes, rpcRequestDuration, rpcRequestsTotal, withMetrics } from "./Metrics.ts";

const RPC_SPAN_PREFIX = "ws.rpc";
const DEFAULT_RPC_SPAN_ATTRIBUTES = {
  "rpc.transport": "websocket",
  "rpc.system": "effect-rpc",
} as const;

const rpcSpanAttributes = (
  method: string,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Record<string, unknown> => ({
  ...DEFAULT_RPC_SPAN_ATTRIBUTES,
  "rpc.method": method,
  ...traceAttributes,
});

const withRpcEffectTracing = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
      attributes: rpcSpanAttributes(method, traceAttributes),
    }),
  );

const withRpcStreamTracing = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> =>
  stream.pipe(
    Stream.withSpan(`${RPC_SPAN_PREFIX}.${method}`, {
      attributes: rpcSpanAttributes(method, traceAttributes),
    }),
  );

const recordRpcStreamMetrics = <E>(
  method: string,
  startedAt: bigint,
  exit: Exit.Exit<unknown, E>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const endedAt = yield* Clock.currentTimeNanos;
    const elapsedNanos = endedAt > startedAt ? endedAt - startedAt : 0n;

    yield* Metric.update(
      Metric.withAttributes(rpcRequestDuration, metricAttributes({ method })),
      Duration.nanos(elapsedNanos),
    );
    yield* Metric.update(
      Metric.withAttributes(
        rpcRequestsTotal,
        metricAttributes({
          method,
          outcome: outcomeFromExit(exit),
        }),
      ),
      1,
    );
  });

export const observeRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> => {
  const instrumented = effect.pipe(
    withMetrics({
      counter: rpcRequestsTotal,
      timer: rpcRequestDuration,
      attributes: {
        method,
      },
    }),
  );

  return withRpcEffectTracing(method, instrumented, traceAttributes);
};

export const observeRpcStream = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> => {
  const instrumented = Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeNanos;
      return stream.pipe(Stream.onExit((exit) => recordRpcStreamMetrics(method, startedAt, exit)));
    }),
  );

  return withRpcStreamTracing(method, instrumented, traceAttributes);
};

export const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, StreamError | EffectError, StreamContext | EffectContext> => {
  const instrumented = Stream.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeNanos;
      const exit = yield* Effect.exit(effect);

      if (Exit.isFailure(exit)) {
        yield* recordRpcStreamMetrics(method, startedAt, exit);
        return yield* Effect.failCause(exit.cause);
      }

      return exit.value.pipe(
        Stream.onExit((streamExit) => recordRpcStreamMetrics(method, startedAt, streamExit)),
      );
    }),
  );

  return withRpcStreamTracing(method, instrumented, traceAttributes);
};
