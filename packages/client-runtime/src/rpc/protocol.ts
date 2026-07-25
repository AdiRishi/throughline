import type * as Effect from "effect/Effect";
import * as RpcClient from "effect/unstable/rpc/RpcClient";

import { CompleteWsRpcGroup } from "@app/contracts";

/**
 * The factory that materializes a typed client for every application method.
 * Building it requires an `RpcClient.Protocol` in context (wired in `session.ts`).
 */
export const makeWsRpcProtocolClient = RpcClient.make(CompleteWsRpcGroup);

type RpcClientFactory = typeof makeWsRpcProtocolClient;

/**
 * The typed RPC client surface. Unary methods return `Effect`s; `stream: true`
 * methods such as `server.subscribeLifecycle` return `Stream`s. Method tags
 * come straight from the shared contracts.
 */
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, unknown, unknown> ? Client : never;
