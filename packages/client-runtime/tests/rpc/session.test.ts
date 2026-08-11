import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import { ServerConfig, WS_METHODS, type ServerConfig as ServerConfigType } from "@app/contracts";

import { ConnectionTransientError, type PreparedConnection } from "../../src/connection/model.ts";
import * as RpcSession from "../../src/rpc/session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const SOCKET_URL = "wss://environment.example.test/ws?token=test";

const PREPARED: PreparedConnection = {
  label: "test",
  prepareSocketUrl: Effect.succeed(SOCKET_URL),
};

const SERVER_CONFIG: ServerConfigType = {
  appName: "test-app",
  version: "0.0.0-test",
  startedAt: DateTime.makeUnsafe(0),
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url: string) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = (sockets: ReadonlyArray<TestWebSocket>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const socket = sockets[0];
      if (socket) {
        return socket;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
  });

const awaitRequest = (socket: TestWebSocket, index = 0) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const request = socket.sent[index];
      if (request) {
        return decodeRpcRequest(decodeJson(request));
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
  });

/** Answers the readiness round trip the session fires as soon as the socket opens. */
const completeInitialSync = (socket: TestWebSocket) =>
  Effect.gen(function* () {
    const request = yield* awaitRequest(socket);
    assert.equal(request.tag, WS_METHODS.serverGetConfig);
    assert.deepEqual(request.payload, {});
    socket.serverMessage(
      encodeJson({
        _tag: "Exit",
        requestId: request.id,
        exit: {
          _tag: "Success",
          value: encodeServerConfig(SERVER_CONFIG),
        },
      }),
    );
  });

describe("RpcSession", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const connectedFiber = yield* Effect.forkChild(session.connected);
      const socket = yield* awaitSocket(sockets);

      assert.equal(socket.url, SOCKET_URL);
      socket.open();
      yield* completeInitialSync(socket);
      yield* Fiber.join(connectedFiber);
      assert.equal(socket.sent.length, 1);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      assert.instanceOf(error, ConnectionTransientError);
      assert.equal(error.detail, "test disconnected.");
      yield* Effect.yieldNow;
      assert.equal(sockets.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const connectedFiber = yield* Effect.forkChild(session.connected);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialSync(socket);
          yield* Fiber.join(connectedFiber);
        }),
      );

      assert.equal(sockets[0]?.readyState, TestWebSocket.CLOSED);
    }),
  );

  it.effect("closes the session when the server stops answering pings", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const connectedFiber = yield* Effect.forkChild(session.connected);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialSync(socket);
      yield* Fiber.join(connectedFiber);

      // The protocol pings a silent socket every five seconds and tolerates one
      // unanswered window. An OS-suspended socket that never delivers a close
      // event is only detectable this way, so the whole window is load-bearing.
      yield* TestClock.adjust("9 seconds");
      assert.isUndefined(closedFiber.pollUnsafe());
      assert.deepEqual(
        socket.sent.slice(1).map((request) => decodeJson(request)),
        [{ _tag: "Ping" }],
      );

      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(closedFiber);
      assert.instanceOf(error, ConnectionTransientError);
      assert.equal(error.reason, "transport");
    }).pipe(Effect.scoped),
  );

  it.effect("re-runs the config round trip on every liveness probe", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const connectedFiber = yield* Effect.forkChild(session.connected);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialSync(socket);
      yield* Fiber.join(connectedFiber);

      const probeFiber = yield* Effect.forkChild(session.probe);
      const probeRequest = yield* awaitRequest(socket, 1);
      assert.equal(probeRequest.tag, WS_METHODS.serverGetConfig);
      assert.deepEqual(probeRequest.payload, {});
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: probeRequest.id,
          exit: { _tag: "Success", value: encodeServerConfig(SERVER_CONFIG) },
        }),
      );
      yield* Fiber.join(probeFiber);

      assert.deepEqual(
        socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag),
        [WS_METHODS.serverGetConfig, WS_METHODS.serverGetConfig],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const connectedFiber = yield* Effect.forkChild(Effect.flip(session.connected));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(connectedFiber);
        }),
      );

      assert.instanceOf(error, ConnectionTransientError);
      assert.equal(error.reason, "transport");
      assert.equal(error.detail, "test could not establish a WebSocket connection.");
      assert.equal(sockets[0]?.readyState, TestWebSocket.CLOSED);
    }),
  );
});
