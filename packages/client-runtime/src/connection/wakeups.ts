import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

/**
 * Why something outside the reconnect loop wants it woken.
 *
 * - `application-active` / `application-active-probe`: the user returned to the
 *   app. A parked loop should stop waiting and try again at the first backoff
 *   rung rather than finish a sleep that was scheduled while nobody was looking.
 * - `application-active-reconnect`: the app was away long enough that the live
 *   socket is presumed dead — operating systems routinely suspend sockets
 *   without delivering a close event — so the current session is replaced by a
 *   fresh attempt, without backoff.
 * - `credentials-changed`: whatever the loop is blocked on (a rejected token, a
 *   missing profile) may now be fixed, so a `blocked` supervisor gets another
 *   attempt.
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
 * The stream of wakeups the host platform publishes. The default is empty, so
 * an app that wires no platform signals still gets the plain backoff loop;
 * providing a real stream with `layer` is what makes `blocked` recoverable
 * without an app restart.
 */
export class ConnectionWakeups extends Context.Reference<ConnectionWakeupsShape>(
  "@app/client-runtime/connection/wakeups/ConnectionWakeups",
  {
    defaultValue: (): ConnectionWakeupsShape => ({ changes: Stream.empty }),
  },
) {}

export const make = (service: ConnectionWakeupsShape): ConnectionWakeupsShape =>
  ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeupsShape): Layer.Layer<never> =>
  Layer.succeed(ConnectionWakeups, make(service));
