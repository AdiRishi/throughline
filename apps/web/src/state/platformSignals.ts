/**
 * The browser's platform signals, fed to the connection supervisor.
 *
 * Without these the supervisor's `Connectivity` and `ConnectionWakeups` seams
 * fall back to their no-op defaults: the loop never learns the radio died, and
 * — more importantly — a `blocked` supervisor has nothing that can wake it, so
 * a rejected credential parks the connection until the app is restarted.
 *
 * @module state/platformSignals
 */
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  connectionWakeupsLayer,
  connectivityLayer,
  type ConnectionWakeup,
  type NetworkStatus,
} from "@app/client-runtime/connection";

function currentNetworkStatus(): NetworkStatus {
  if (typeof navigator === "undefined") {
    return "unknown";
  }
  return navigator.onLine ? "online" : "offline";
}

export const browserConnectivityLayer = connectivityLayer({
  status: Effect.sync(currentNetworkStatus),
  changes: Stream.callback<NetworkStatus>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online" as NetworkStatus);
        const offline = () => Queue.offerUnsafe(queue, "offline" as NetworkStatus);
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

/**
 * Two sources, both of which mean "conditions may have changed, try again":
 * the tab becoming visible, and the browser reporting the network came back.
 * The `online` event is mapped to `credentials-changed` rather than
 * `application-active` because it must also un-park a `blocked` supervisor,
 * not merely reset the backoff ladder.
 */
export const browserWakeupsLayer = connectionWakeupsLayer({
  changes: Stream.merge(
    Stream.callback<ConnectionWakeup>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () => {
            if (document.visibilityState === "visible") {
              Queue.offerUnsafe(queue, "application-active" as ConnectionWakeup);
            }
          };
          document.addEventListener("visibilitychange", listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            document.removeEventListener("visibilitychange", listener);
          }),
      ).pipe(Effect.asVoid),
    ),
    Stream.callback<ConnectionWakeup>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () =>
            Queue.offerUnsafe(queue, "credentials-changed" as ConnectionWakeup);
          window.addEventListener("online", listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            window.removeEventListener("online", listener);
          }),
      ).pipe(Effect.asVoid),
    ),
  ),
});
