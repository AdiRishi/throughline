/**
 * WebSocket RPC route + handler registration.
 *
 * `/ws` upgrades to the Effect RPC websocket protocol after a bearer-auth gate,
 * then serves the `WsRpcGroup` methods registered via `WsRpcGroup.toLayer`.
 *
 * @module ws
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import {
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
  type TickEvent,
} from "@app/contracts";

import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as NotesStore from "./notes/NotesStore.ts";
import {
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";

/**
 * Register the RPC handlers. `server.subscribeLifecycle` replays the retained
 * snapshot (sorted by sequence) then follows the live stream filtered to events
 * newer than the snapshot boundary; `notes.subscribe` delegates the same
 * contract to the notes store.
 */
const makeWsRpcLayer = () =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* LifecycleEvents.ServerLifecycleEvents;
      const notes = yield* NotesStore.NotesStore;

      return WsRpcGroup.of({
        [WS_METHODS.serverGetConfig]: () =>
          observeRpcEffect(
            WS_METHODS.serverGetConfig,
            Effect.succeed({
              appName: config.appName,
              version: config.version,
              startedAt: config.startedAt,
            }),
            { "rpc.aggregate": "server" },
          ),
        // Intentionally does no work: the answer is the round trip itself.
        [WS_METHODS.serverProbe]: () =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverEcho]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverEcho,
            DateTime.now.pipe(
              Effect.map((receivedAt) => ({
                message: input.message,
                receivedAt,
              })),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSubscribeTicks]: () =>
          observeRpcStream(
            WS_METHODS.serverSubscribeTicks,
            Stream.tick("1 second").pipe(
              Stream.mapAccum(
                () => 0,
                (count, _void) => {
                  const next = count + 1;
                  return [next, [next]] as const;
                },
              ),
              Stream.mapEffect((tick) =>
                DateTime.now.pipe(Effect.map((at): TickEvent => ({ tick, at }))),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverSubscribeLifecycle]: () =>
          observeRpcStreamEffect(
            WS_METHODS.serverSubscribeLifecycle,
            Effect.gen(function* () {
              // Buffering starts before the snapshot is read: an event published
              // while that read is in flight would otherwise fall in the gap
              // between the replay and the live subscription.
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((item) => Queue.offer(liveBuffer, item)),
                ),
              );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer);

              const snapshot = yield* lifecycleEvents.snapshot;
              const replay = snapshot.events.toSorted((a, b) => a.sequence - b.sequence);
              const live = bufferedLiveStream.pipe(
                Stream.filter(
                  (event: ServerLifecycleStreamEvent) => event.sequence > snapshot.sequence,
                ),
              );
              return Stream.concat(Stream.fromIterable(replay), live);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.notesCreate]: (input) =>
          observeRpcEffect(WS_METHODS.notesCreate, notes.create(input), {
            "rpc.aggregate": "notes",
          }),
        [WS_METHODS.notesUpdate]: (input) =>
          observeRpcEffect(WS_METHODS.notesUpdate, notes.update(input), {
            "rpc.aggregate": "notes",
          }),
        [WS_METHODS.notesDelete]: (input) =>
          observeRpcEffect(WS_METHODS.notesDelete, notes.remove(input), {
            "rpc.aggregate": "notes",
          }),
        [WS_METHODS.notesSubscribe]: () =>
          observeRpcStream(WS_METHODS.notesSubscribe, notes.changes, {
            "rpc.aggregate": "notes",
          }),
      });
    }),
  );

/**
 * The `/ws` upgrade route. Rejects with 401 when no valid bearer is present,
 * otherwise hands the socket to the RPC server.
 */
export const websocketRpcRouteLayer = HttpRouter.add(
  "GET",
  "/ws",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* Auth.BearerSessionStore;

    // Two ways in, and the order matters. A browser cannot set headers on a
    // WebSocket handshake, so it presents a single-use ticket in the URL; a
    // caller that CAN set headers presents the bearer there, where it does not
    // land in an access log. The long-lived bearer is deliberately not accepted
    // from the query string on this route.
    const ticket = Auth.extractWebSocketTicket(request);
    if (Option.isSome(ticket)) {
      const redeemed = yield* auth.redeemWebSocketTicket(ticket.value);
      if (!redeemed) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
    } else {
      const header = Headers.get(request.headers, "authorization");
      const token = Option.isSome(header)
        ? Option.fromNullishOr(/^Bearer\s+(.+)$/i.exec(header.value.trim())?.[1]?.trim())
        : Option.none<string>();
      if (Option.isNone(token)) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
      const valid = yield* auth.authenticateBearer(token.value);
      if (!valid) {
        return HttpServerResponse.text("Unauthorized", { status: 401 });
      }
    }

    // The handlers carry their own `ws.rpc.<method>` spans (see
    // observability/RpcInstrumentation), so RpcServer's per-request span would
    // only duplicate them.
    const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {
      disableTracing: true,
    }).pipe(Effect.provide(makeWsRpcLayer().pipe(Layer.provideMerge(RpcSerialization.layerJson))));

    return yield* rpcWebSocketHttpEffect;
  }),
);
