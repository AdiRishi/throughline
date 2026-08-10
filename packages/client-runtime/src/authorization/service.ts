import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type { BootstrapBearerInput } from "@app/contracts";

import { bootstrapRemoteBearerSession, type BearerBootstrapError } from "./remote.ts";

/**
 * Refresh this far ahead of the declared expiry. A token that is technically
 * still valid when the exchange starts can be evicted by the server before the
 * `/ws` upgrade presents it; a minute of slack makes that race impossible in
 * practice while still reusing the token for the other 29 days, 23 hours.
 */
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

interface CachedBearerSession {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  /** Epoch millis the token stops being accepted, or null if none was declared. */
  readonly expiresAtEpochMs: number | null;
}

export interface BearerAuthorizationInput {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly clientMetadata?: BootstrapBearerInput["clientMetadata"];
}

function isReusable(session: CachedBearerSession, nowEpochMs: number): boolean {
  return (
    session.expiresAtEpochMs === null ||
    session.expiresAtEpochMs > nowEpochMs + TOKEN_EXPIRY_SAFETY_MARGIN_MS
  );
}

/**
 * A bearer token that survives across connect attempts without outliving its
 * expiry.
 *
 * The supervisor mints a credential at the top of EVERY attempt, so without a
 * cache a reconnect storm asks the server for a fresh session per attempt.
 * Without an *expiring* cache the opposite failure appears: a token held for the
 * whole process lifetime keeps being presented after the server has evicted it,
 * and the connection blocks with no way back except a restart. Reuse is gated on
 * the declared `expires_at` plus a safety margin, and any failed exchange
 * evicts, so the next attempt always starts from a clean mint.
 */
export class BearerAuthorization extends Context.Service<
  BearerAuthorization,
  {
    /** The cached token if it is still comfortably valid, else a freshly minted one. */
    readonly accessToken: (
      input: BearerAuthorizationInput,
    ) => Effect.Effect<string, BearerBootstrapError>;
    /**
     * Drop the cached token. Call it when the far side rejects a credential that
     * this cache still believes in — an authorization failure on the `/ws`
     * upgrade is the signal that the server's view and ours have diverged.
     */
    readonly invalidate: Effect.Effect<void>;
  }
>()("@app/client-runtime/authorization/service/BearerAuthorization") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const cache = yield* Ref.make(Option.none<CachedBearerSession>());
  // Collapses concurrent first calls into one exchange: N reconnecting
  // subscriptions must not mint N sessions.
  const mutex = yield* Semaphore.make(1);

  const invalidate = Ref.set(cache, Option.none());

  const accessToken = Effect.fn("clientRuntime.authorization.accessToken")(function* (
    input: BearerAuthorizationInput,
  ) {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(cache);
        if (
          Option.isSome(cached) &&
          cached.value.httpBaseUrl === input.httpBaseUrl &&
          isReusable(cached.value, now)
        ) {
          yield* Effect.annotateCurrentSpan({ "auth.bearer_cache": "hit" });
          return cached.value.accessToken;
        }

        yield* Effect.annotateCurrentSpan({ "auth.bearer_cache": "miss" });
        const session = yield* bootstrapRemoteBearerSession(input).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // Evict on failure: a stale token must never survive a refresh that
          // did not work.
          Effect.tapError(() => invalidate),
        );
        yield* Ref.set(
          cache,
          Option.some({
            httpBaseUrl: input.httpBaseUrl,
            accessToken: session.access_token,
            expiresAtEpochMs:
              session.expires_at === null ? null : DateTime.toEpochMillis(session.expires_at),
          }),
        );
        return session.access_token;
      }),
    );
  });

  return BearerAuthorization.of({ accessToken, invalidate });
});

export const layer: Layer.Layer<BearerAuthorization, never, HttpClient.HttpClient> = Layer.effect(
  BearerAuthorization,
  make,
);
