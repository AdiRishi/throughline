import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The single shared authorization error for every WS RPC. The server's `/ws`
 * upgrade is gated by a bearer session; a request without a valid session
 * fails with this. Keeping one shared error keeps the RPC group's error
 * unions small and uniform.
 */
export class EnvironmentAuthorizationError extends Schema.TaggedError<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    reason: Schema.Literals(["missing-credential", "invalid-credential", "expired"]),
  },
) {
  override get message(): string {
    return `WebSocket request was not authorized (${this.reason}).`;
  }
}

/**
 * Body of `POST /api/auth/bootstrap/bearer`. The desktop shell mints a
 * bootstrap token, hands it to the spawned server AND to the renderer (over
 * IPC); the renderer exchanges the token here for a short-lived bearer session
 * it then uses on the `/ws` upgrade. This is the "shared secret handed to a
 * trusted child" pattern.
 */
export const BootstrapBearerInput = Schema.Struct({
  credential: TrimmedNonEmptyString,
  clientMetadata: Schema.optionalKey(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      deviceType: Schema.Literals(["desktop", "web"]),
    }),
  ),
});
export type BootstrapBearerInput = typeof BootstrapBearerInput.Type;

export const BearerSession = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  /** When the token expires, or null for "session lifetime". */
  expires_at: Schema.NullOr(Schema.DateTimeUtc),
});
export type BearerSession = typeof BearerSession.Type;

/**
 * JSON wire codec for `BearerSession` — `expires_at` crosses HTTP as an ISO
 * string. `Schema.DateTimeUtc` alone only validates in-memory `DateTime.Utc`
 * instances; the RPC layer applies `Schema.toCodecJson` automatically, but the
 * hand-rolled `POST /api/auth/bootstrap/bearer` endpoint must use this codec
 * explicitly on both ends.
 */
export const BearerSessionJson = Schema.toCodecJson(BearerSession);

/**
 * Query parameter carrying the `/ws` upgrade ticket.
 *
 * A browser cannot set headers on a WebSocket handshake, so the credential has
 * to travel in the URL — and a URL is the worst place to put a long-lived
 * secret: it lands in server access logs, proxy logs, `Referer` headers and
 * browser history. So what goes here is NOT the session bearer but a
 * single-use, minutes-long ticket minted from it. Leaking the ticket costs one
 * already-consumed connection; leaking the bearer costs the session.
 */
export const WS_TICKET_QUERY_PARAM = "wsTicket";

/**
 * Result of `POST /api/auth/websocket-ticket`. The ticket is valid once, for a
 * few minutes — long enough to open a socket, short enough that a logged URL is
 * worthless by the time anyone reads it.
 */
export const WebSocketTicket = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expires_at: Schema.DateTimeUtc,
});
export type WebSocketTicket = typeof WebSocketTicket.Type;

export const WebSocketTicketJson = Schema.toCodecJson(WebSocketTicket);
