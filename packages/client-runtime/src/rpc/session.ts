import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { WS_METHODS } from "@app/contracts";

import {
  type ConnectionAttemptError,
  ConnectionBlockedError,
  ConnectionTransientError,
  type PreparedConnection,
} from "../connection/model.ts";
import { findErrorTraceId } from "../errors/errorTrace.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;

// An authorization rejection means the credential this session presented will
// keep being rejected, so it blocks the supervisor; anything transport-shaped
// stays transient and gets retried.
function mapSessionRpcError(error: InitialConfigError): ConnectionAttemptError {
  const traceId = findErrorTraceId(error);
  const trace = traceId === null ? {} : { traceId };
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
        ...trace,
      });
    case "RpcClientError":
      return new ConnectionTransientError({
        reason: "transport",
        detail: error.message,
        ...trace,
      });
  }
}

/**
 * A live RPC session bound to one open WebSocket. `connected` waits for the
 * socket handshake AND a round trip that proves the far side actually answers,
 * because a socket that opens against a wedged server still opens; `probe`
 * re-runs that round trip on demand.
 */
export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly connected: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
}

export interface RpcSessionFactoryShape {
  readonly connect: (
    connection: PreparedConnection,
  ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
}

export class RpcSessionFactory extends Context.Service<RpcSessionFactory, RpcSessionFactoryShape>()(
  "@app/client-runtime/rpc/session/RpcSessionFactory",
) {}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  /**
   * Opens a scoped socket and builds the typed RPC client over it. Protocol
   * retries stay off: reconnection is the supervisor's job and it rebuilds a
   * whole fresh session, so a session is single-use.
   */
  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    // Minted inside `connect` so every attempt gets a fresh credential and a
    // failed mint fails only that attempt.
    const socketUrl = yield* connection.prepareSocketUrl;

    const connected = yield* Deferred.make<void, ConnectionTransientError>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();

    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientError({
              reason: "transport",
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });

    const socketLayer = Socket.layerWebSocket(socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));

    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );

    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("clientRuntime.websocket.connect"),
    );
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));

    // Cached so repeated awaits of `connected` never refire the round trip.
    const initialSync = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.asVoid,
        Effect.withSpan("clientRuntime.rpcSession.initialSync"),
      ),
    );

    // The liveness probe deliberately does NOT reuse `initialSync`: the whole
    // point is a fresh round trip proving the far side answers right now. It
    // uses the dedicated `server.probe` method rather than re-fetching the
    // config, because this fires on every wakeup and reconnect.
    const probe = client[WS_METHODS.serverProbe]({}).pipe(
      Effect.mapError(mapSessionRpcError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.rpcSession.probe"),
    );

    return {
      client,
      connected: Deferred.await(connected).pipe(
        Effect.andThen(initialSync),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
