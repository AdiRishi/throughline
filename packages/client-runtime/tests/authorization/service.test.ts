import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { make as makeBearerAuthorization } from "../../src/authorization/service.ts";
import { HTTP_BASE_URL, bearerSessionBody, jsonResponse, stubHttpClient } from "./testHttp.ts";

const INPUT = { httpBaseUrl: HTTP_BASE_URL, credential: "bootstrap-token" } as const;

/**
 * A server that answers each exchange with the next scripted body, counting
 * calls. A `null` entry answers 500 so the test can drive a failed refresh.
 */
const scriptedAuth = Effect.fn("TestBearerServer.make")(function* (
  bodies: ReadonlyArray<unknown | null>,
) {
  const exchanges = { count: 0 };
  const authorization = yield* makeBearerAuthorization.pipe(
    Effect.provide(
      stubHttpClient(() => {
        const body = bodies[Math.min(exchanges.count, bodies.length - 1)];
        exchanges.count += 1;
        return Promise.resolve(
          body === null || body === undefined ? jsonResponse(500, {}) : jsonResponse(200, body),
        );
      }),
    ),
  );
  return { exchanges, authorization };
});

describe("BearerAuthorization", () => {
  it.effect("reuses the cached token while it is comfortably valid", () =>
    Effect.gen(function* () {
      const first = yield* bearerSessionBody("token-1", 3_600_000);
      const second = yield* bearerSessionBody("token-2", 3_600_000);
      const { authorization, exchanges } = yield* scriptedAuth([first, second]);

      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      assert.equal(exchanges.count, 1);
    }),
  );

  it.effect("refreshes a minute before the declared expiry", () =>
    Effect.gen(function* () {
      // The first token expires at t=90s, so it stays reusable until t=30s and
      // must be replaced from t=30s onward (60s safety margin).
      const first = yield* bearerSessionBody("token-1", 90_000);
      const second = yield* bearerSessionBody("token-2", 3_600_000);
      const { authorization, exchanges } = yield* scriptedAuth([first, second]);

      assert.equal(yield* authorization.accessToken(INPUT), "token-1");

      yield* TestClock.adjust("29 seconds");
      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      assert.equal(exchanges.count, 1);

      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* authorization.accessToken(INPUT), "token-2");
      assert.equal(exchanges.count, 2);
    }),
  );

  it.effect("keeps a token the server declared no expiry for", () =>
    Effect.gen(function* () {
      const first = yield* bearerSessionBody("token-1", null);
      const second = yield* bearerSessionBody("token-2", null);
      const { authorization, exchanges } = yield* scriptedAuth([first, second]);

      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      yield* TestClock.adjust("30 days");
      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      assert.equal(exchanges.count, 1);
    }),
  );

  it.effect("evicts the cached token when an exchange fails", () =>
    Effect.gen(function* () {
      const first = yield* bearerSessionBody("token-1", null);
      const third = yield* bearerSessionBody("token-3", null);
      // Exchange 2 fails; without eviction the never-expiring token-1 would keep
      // being served from the cache forever.
      const { authorization, exchanges } = yield* scriptedAuth([first, null, third]);

      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      yield* authorization
        .accessToken({ httpBaseUrl: "http://127.0.0.1:41998", credential: "other" })
        .pipe(Effect.flip);
      assert.equal(yield* authorization.accessToken(INPUT), "token-3");
      assert.equal(exchanges.count, 3);
    }),
  );

  it.effect("re-mints after an explicit invalidate", () =>
    Effect.gen(function* () {
      const first = yield* bearerSessionBody("token-1", null);
      const second = yield* bearerSessionBody("token-2", null);
      const { authorization, exchanges } = yield* scriptedAuth([first, second]);

      assert.equal(yield* authorization.accessToken(INPUT), "token-1");
      yield* authorization.invalidate;
      assert.equal(yield* authorization.accessToken(INPUT), "token-2");
      assert.equal(exchanges.count, 2);
    }),
  );
});
