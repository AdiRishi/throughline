/**
 * Issuing a unary RPC from an atom, correctly.
 *
 * `rpcRequest` fails fast when there is no live socket — that is deliberate
 * (ADR-0003: exactly one component reconnects, and it is the supervisor). But
 * an atom that fires at mount races the handshake, and a failure there reads to
 * the UI as "there is nothing here", which is a lie.
 *
 * So unary reads are expressed as a stream over the session: the request is
 * issued once per live session and re-issued after a reconnect. Waiting is
 * `AsyncResult.Initial` — which is what "we have not heard back yet" should
 * look like — and refetch-on-reconnect comes free.
 *
 * @module state/rpc
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ConnectionSupervisor } from "@app/client-runtime/connection";
import {
  request as rpcRequest,
  sessionChanges,
  type RpcInput,
  type RpcSuccess,
  type UnaryRpcTag,
} from "@app/client-runtime/rpc";

/**
 * A request per live session.
 *
 * Deliberately built from `filter` + `mapEffect` rather than `switchMap` over
 * an empty stream: an inner stream that completes without emitting is an easy
 * way to end up with an atom that waits forever.
 */
export function requestWhenConnected<TTag extends UnaryRpcTag>(
  tag: TTag,
  input: RpcInput<TTag>,
): Stream.Stream<RpcSuccess<TTag>, never, ConnectionSupervisor> {
  return requestWhenConnectedWith(tag, () => input);
}

/** The same, for a request whose input depends on other atoms. */
export function requestWhenConnectedWith<TTag extends UnaryRpcTag>(
  tag: TTag,
  input: () => RpcInput<TTag> | null,
): Stream.Stream<RpcSuccess<TTag>, never, ConnectionSupervisor> {
  return Stream.unwrap(
    Effect.map(ConnectionSupervisor, (supervisor) =>
      sessionChanges(supervisor).pipe(
        Stream.filter(Option.isSome),
        Stream.mapEffect(() => {
          const resolved = input();
          if (resolved === null) return Effect.succeed(Option.none<RpcSuccess<TTag>>());
          // A failure here is either a domain answer the caller renders as
          // absence, or a dropped socket the supervisor is already rebuilding
          // from. Neither should tear down the atom.
          return rpcRequest(tag, resolved).pipe(
            Effect.map(Option.some<RpcSuccess<TTag>>),
            Effect.orElseSucceed(() => Option.none<RpcSuccess<TTag>>()),
          );
        }),
        Stream.filter(Option.isSome),
        Stream.map((value) => value.value),
      ),
    ),
  );
}
