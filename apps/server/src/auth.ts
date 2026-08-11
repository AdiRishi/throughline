/**
 * Bearer session store.
 *
 * A minimal in-memory auth boundary. A client first exchanges the server's
 * bootstrap token for an opaque bearer (`authenticateBootstrap`), then presents
 * that bearer on the `/ws` upgrade (`authenticateBearer`). Tokens are random
 * hex held in memory — no persistence.
 *
 * Sessions carry an expiry and are evicted. The client reconnect supervisor
 * mints a token at the top of EVERY connect attempt, so a reconnect storm would
 * otherwise retain one process-lifetime credential per attempt, forever. Expiry
 * is also what lets the client refresh ahead of time instead of discovering a
 * dead credential mid-session.
 *
 * @module auth
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Headers, HttpServerRequest } from "effect/unstable/http";

import { WS_TICKET_QUERY_PARAM } from "@app/contracts";

import * as ServerConfig from "./config.ts";

const TOKEN_BYTES = 32;

const SESSION_TTL = Duration.days(30);

/**
 * Long enough to open a socket (including a retry or two), short enough that a
 * ticket sitting in an access log is worthless by the time anyone reads it.
 */
const WEBSOCKET_TICKET_TTL = Duration.minutes(5);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Constant-time equality so a wrong credential can't leak how much of it matched. */
const timingSafeStringEqual = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length && NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
};

/**
 * BearerSessionStore - mints and validates opaque bearer tokens.
 */
export class BearerSessionStore extends Context.Service<
  BearerSessionStore,
  {
    /**
     * Exchange a bootstrap credential for a fresh bearer token. Returns
     * `Option.none()` when the credential does not match the server's token.
     */
    readonly authenticateBootstrap: (
      credential: string,
    ) => Effect.Effect<Option.Option<MintedBearerSession>>;
    /** Whether the given bearer token is a live, unexpired session. */
    readonly authenticateBearer: (token: string) => Effect.Effect<boolean>;
    /**
     * Mint a single-use `/ws` upgrade ticket for a live bearer session.
     * `Option.none()` when the bearer is not a live session.
     */
    readonly issueWebSocketTicket: (
      bearerToken: string,
    ) => Effect.Effect<Option.Option<MintedWebSocketTicket>>;
    /**
     * Redeem a `/ws` ticket. Consumes it: a replayed ticket is rejected even
     * inside its TTL, so a URL captured from a log cannot open a second socket.
     */
    readonly redeemWebSocketTicket: (ticket: string) => Effect.Effect<boolean>;
  }
>()("@app/server/auth/BearerSessionStore") {}

/** A freshly minted bearer plus the instant it stops being accepted. */
export interface MintedBearerSession {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
}

export interface MintedWebSocketTicket {
  readonly ticket: string;
  readonly expiresAt: DateTime.Utc;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  // token -> expiry epoch millis.
  const sessions = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  // ticket -> expiry epoch millis. Separate from `sessions` so a ticket can
  // never be presented as a bearer, and vice versa.
  const websocketTickets = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  /** Drop every session that has already expired as of `nowMillis`. */
  const evictExpired = (current: ReadonlyMap<string, number>, nowMillis: number) => {
    let live: Map<string, number> | undefined;
    for (const [token, expiresAtMillis] of current) {
      if (expiresAtMillis > nowMillis) continue;
      live ??= new Map(current);
      live.delete(token);
    }
    return live ?? current;
  };

  /** Whether `token` names a live session, without mutating anything. */
  const isLiveSession = (token: string, nowMillis: number) =>
    Ref.get(sessions).pipe(
      Effect.map((current) => {
        const expiresAtMillis = current.get(token);
        return expiresAtMillis !== undefined && expiresAtMillis > nowMillis;
      }),
    );

  return {
    authenticateBootstrap: (credential) =>
      Effect.gen(function* () {
        if (!timingSafeStringEqual(credential, config.bootstrapToken)) {
          return Option.none();
        }
        const bytes = yield* crypto.randomBytes(TOKEN_BYTES).pipe(Effect.orDie);
        const token = toHex(bytes);
        const issuedAt = yield* DateTime.now;
        const expiresAt = DateTime.add(issuedAt, {
          milliseconds: Duration.toMillis(SESSION_TTL),
        });
        // Sweep on mint so a reconnect storm cannot grow the map without bound.
        yield* Ref.update(sessions, (current) => {
          const live = new Map(evictExpired(current, DateTime.toEpochMillis(issuedAt)));
          live.set(token, DateTime.toEpochMillis(expiresAt));
          return live;
        });
        return Option.some({ token, expiresAt });
      }),
    authenticateBearer: (token) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const current = yield* Ref.get(sessions);
        const expiresAtMillis = current.get(token);
        if (expiresAtMillis === undefined) {
          return false;
        }
        if (expiresAtMillis <= DateTime.toEpochMillis(now)) {
          yield* Ref.update(sessions, (latest) =>
            evictExpired(latest, DateTime.toEpochMillis(now)),
          );
          return false;
        }
        return true;
      }),
    issueWebSocketTicket: (bearerToken) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMillis = DateTime.toEpochMillis(now);
        if (!(yield* isLiveSession(bearerToken, nowMillis))) {
          return Option.none();
        }
        const bytes = yield* crypto.randomBytes(TOKEN_BYTES).pipe(Effect.orDie);
        const ticket = toHex(bytes);
        const expiresAt = DateTime.add(now, {
          milliseconds: Duration.toMillis(WEBSOCKET_TICKET_TTL),
        });
        // Swept on mint for the same reason sessions are: a reconnect storm
        // mints one ticket per attempt.
        yield* Ref.update(websocketTickets, (current) => {
          const live = new Map(evictExpired(current, nowMillis));
          live.set(ticket, DateTime.toEpochMillis(expiresAt));
          return live;
        });
        return Option.some({ ticket, expiresAt });
      }),
    redeemWebSocketTicket: (ticket) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMillis = DateTime.toEpochMillis(now);
        // Read and delete in one `modify` so two concurrent upgrades cannot
        // both redeem the same ticket.
        return yield* Ref.modify(websocketTickets, (current) => {
          const expiresAtMillis = current.get(ticket);
          const live = evictExpired(current, nowMillis);
          if (expiresAtMillis === undefined || expiresAtMillis <= nowMillis) {
            return [false, live] as const;
          }
          const remaining = new Map(live);
          remaining.delete(ticket);
          return [true, remaining] as const;
        });
      }),
  } satisfies BearerSessionStore["Service"];
});

export const layer = Layer.effect(BearerSessionStore, make);

/** The single-use `/ws` upgrade ticket, when the request carries one. */
export function extractWebSocketTicket(
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<string> {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return Option.none();
  }
  const ticket = url.value.searchParams.get(WS_TICKET_QUERY_PARAM);
  return ticket ? Option.some(ticket) : Option.none();
}

/**
 * Extract a bearer token from a request: `Authorization: Bearer <t>` header, or
 * `?access_token=<t>` query param. Shared by the OTLP ingest route and the
 * ticket-minting route so the two gates cannot drift apart.
 *
 * The query-param form exists for non-browser callers that cannot set headers;
 * the browser `/ws` path uses a ticket instead (see `extractWebSocketTicket`),
 * because a 30-day bearer has no business in a URL.
 */
export function extractBearer(request: HttpServerRequest.HttpServerRequest): Option.Option<string> {
  const header = Headers.get(request.headers, "authorization");
  if (Option.isSome(header)) {
    const match = /^Bearer\s+(.+)$/i.exec(header.value.trim());
    if (match?.[1]) {
      return Option.some(match[1].trim());
    }
  }
  const url = HttpServerRequest.toURL(request);
  if (Option.isSome(url)) {
    const token = url.value.searchParams.get("access_token");
    if (token) {
      return Option.some(token);
    }
  }
  return Option.none();
}
