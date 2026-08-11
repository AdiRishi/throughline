import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

/**
 * Why something outside the reconnect loop wants it woken.
 *
 * - `application-active` / `application-active-probe`: the user returned to the
 *   app after a short absence, so a live session is health-checked and a parked
 *   loop retries at the first backoff rung.
 * - `application-active-reconnect`: the app was away long enough that the live
 *   socket is presumed dead — operating systems routinely suspend sockets
 *   without delivering a close event — so the session is replaced outright.
 * - `credentials-changed`: whatever the loop is blocked on may now be fixed.
 */
export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed";

export function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export interface ConnectionWakeupsShape {
  readonly changes: Stream.Stream<ConnectionWakeup>;
}

/**
 * The wakeups the host platform publishes. Required rather than defaulted: a
 * supervisor with no wakeup source can never leave `blocked` without an app
 * restart, so wiring one up with `layer` is a compile-time obligation.
 */
export class ConnectionWakeups extends Context.Service<ConnectionWakeups, ConnectionWakeupsShape>()(
  "@app/client-runtime/connection/wakeups/ConnectionWakeups",
) {}

export const make = (service: ConnectionWakeupsShape): ConnectionWakeupsShape =>
  ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeupsShape): Layer.Layer<ConnectionWakeups> =>
  Layer.succeed(ConnectionWakeups, make(service));
