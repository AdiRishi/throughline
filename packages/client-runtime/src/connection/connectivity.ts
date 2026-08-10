import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export interface ConnectivityShape {
  readonly status: Effect.Effect<NetworkStatus>;
  readonly changes: Stream.Stream<NetworkStatus>;
}

/**
 * The platform's network reachability, as a seam. The supervisor reads `status`
 * before every attempt and reacts to `changes`, so a device that goes offline
 * parks instead of burning the backoff ladder against a dead radio.
 *
 * The default reports a permanently-online network that never changes: a host
 * that exposes no reachability signal must not be able to park the supervisor.
 * Provide a real implementation (browser `online`/`offline` events, Electron
 * `net.isOnline`) with `layer` to get the parking behaviour.
 */
export class Connectivity extends Context.Reference<ConnectivityShape>(
  "@app/client-runtime/connection/connectivity/Connectivity",
  {
    defaultValue: (): ConnectivityShape => ({
      status: Effect.succeed<NetworkStatus>("online"),
      changes: Stream.empty,
    }),
  },
) {}

export const make = (service: ConnectivityShape): ConnectivityShape => Connectivity.of(service);

export const layer = (service: ConnectivityShape): Layer.Layer<never> =>
  Layer.succeed(Connectivity, make(service));
