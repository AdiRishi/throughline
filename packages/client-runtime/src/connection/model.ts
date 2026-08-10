import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Whether the host platform believes it has a network at all. `unknown` is the
 * honest answer on platforms that expose no such signal — it is treated as
 * "online" so a missing seam can never park the supervisor.
 */
export type NetworkStatus = "unknown" | "offline" | "online";

/**
 * Why a transient failure happened. The supervisor treats every reason the
 * same (back off, retry), but the discriminant survives into logs, traces, and
 * the UI — "the endpoint is unavailable" and "the request timed out" are
 * different stories to tell a reviewer staring at a stuck connection.
 */
export const ConnectionTransientReason = Schema.Literals([
  "network",
  "timeout",
  "transport",
  "endpoint-unavailable",
  "remote-unavailable",
]);
export type ConnectionTransientReason = typeof ConnectionTransientReason.Type;

export const ConnectionBlockedReason = Schema.Literals([
  "authentication",
  "configuration",
  "permission",
]);
export type ConnectionBlockedReason = typeof ConnectionBlockedReason.Type;

/**
 * A failure the supervisor can recover from on its own. A dropped socket, a
 * failed open, or a network blip all collapse to this; the supervisor treats it
 * as "retry after backoff".
 *
 * `traceId` carries the id of the span the failure was raised under when one is
 * known. It is the only link between an error the UI is showing and the trace
 * files `docs/technical/06-observability.md` tells you to grep, so populate it
 * wherever the underlying failure carries one.
 */
export class ConnectionTransientError extends Schema.TaggedError<ConnectionTransientError>()(
  "ConnectionTransientError",
  {
    reason: ConnectionTransientReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * A failure retrying cannot fix: rejected credentials, missing permission, or
 * broken configuration. The supervisor parks instead of backing off — it stays
 * `blocked` until something outside the loop (changed credentials, an app
 * activation, an explicit retry) requests another attempt.
 */
export class ConnectionBlockedError extends Schema.TaggedError<ConnectionBlockedError>()(
  "ConnectionBlockedError",
  {
    reason: ConnectionBlockedReason,
    detail: Schema.String,
    traceId: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type ConnectionAttemptError = ConnectionTransientError | ConnectionBlockedError;

/**
 * Everything the supervisor needs to open one socket: a human label for
 * diagnostics plus `prepareSocketUrl`, an effect that mints a fresh bearer
 * credential and returns the fully-formed `/ws` URL. The supervisor runs it at
 * the top of EVERY connect attempt, so a failed credential mint fails that
 * attempt — transient mints back off and retry, rejected credentials block —
 * the auth step lives inside the reconnect loop, not above it. The supervisor
 * stays transport-agnostic.
 */
export interface PreparedConnection {
  readonly label: string;
  readonly prepareSocketUrl: Effect.Effect<string, ConnectionAttemptError>;
}

/**
 * The coarse connection phase the UI renders.
 *
 * - `connecting` covers the very first attempt; once we have been connected at
 *   least once, subsequent attempts show as `reconnecting` so the status dot can
 *   distinguish a cold start from a blip.
 * - `backoff` means the loop is *sleeping* between attempts, as opposed to
 *   actively trying. Keeping it separate is what lets the UI show the reason for
 *   the wait instead of a spinner that says nothing.
 * - `blocked` means the last attempt failed in a way retrying cannot fix; the
 *   supervisor is parked until `retryNow`, a credentials-changed wakeup, or an
 *   application-active wakeup arrives.
 * - `offline` means the platform reports no network, so attempting would only
 *   burn the backoff ladder.
 */
export type ConnectionPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "backoff"
  | "blocked"
  | "offline";

export interface ConnectionState {
  readonly phase: ConnectionPhase;
  /** Failed attempts since the last *stable* connection (30s+ uptime). */
  readonly attempt: number;
  /**
   * The most recent failure, or null while healthy. Carried as the typed error
   * rather than a string so the UI keeps the reason discriminant and the
   * `traceId` that links it to the trace files.
   */
  readonly lastFailure: ConnectionAttemptError | null;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = Object.freeze({
  phase: "idle",
  attempt: 0,
  lastFailure: null,
});
