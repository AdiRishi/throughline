import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProductWsRpcGroup } from "./productRpc.ts";
import { ServerConfig, ServerLifecycleStreamEvent } from "./server.ts";

/**
 * String method names for every WS RPC — the single source of truth the
 * server registers handlers against and the client calls by tag.
 */
export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverSubscribeLifecycle: "server.subscribeLifecycle",
} as const;

/** No payload; the first call after connect also serves as initial sync. */
export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: EnvironmentAuthorizationError,
});

/** Retained-snapshot + live lifecycle events (the ordered push-bus pattern). */
export const WsServerSubscribeLifecycleRpc = Rpc.make(WS_METHODS.serverSubscribeLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** The wire contract the server decodes against and the client is typed by. */
export const WsRpcGroup = RpcGroup.make(WsServerGetConfigRpc, WsServerSubscribeLifecycleRpc);

/** Core supervision methods plus the complete Throughline product surface. */
export const CompleteWsRpcGroup = WsRpcGroup.merge(ProductWsRpcGroup);
