import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import type { NetworkStatus } from "./model.ts";

export interface ConnectivityShape {
  readonly status: Effect.Effect<NetworkStatus>;
  readonly changes: Stream.Stream<NetworkStatus>;
}

/**
 * The platform's network reachability. Required rather than defaulted: a host
 * that ships no reachability signal can never park the supervisor while
 * offline, so wiring one up with `layer` is a compile-time obligation.
 */
export class Connectivity extends Context.Service<Connectivity, ConnectivityShape>()(
  "@app/client-runtime/connection/connectivity",
) {}

export const make = (service: ConnectivityShape): ConnectivityShape => Connectivity.of(service);

export const layer = (service: ConnectivityShape): Layer.Layer<Connectivity> =>
  Layer.succeed(Connectivity, make(service));
