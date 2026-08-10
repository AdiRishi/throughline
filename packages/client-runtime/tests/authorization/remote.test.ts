import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { bootstrapRemoteBearerSession } from "../../src/authorization/remote.ts";
import { mapBearerBootstrapError } from "../../src/connection/errors.ts";
import { HTTP_BASE_URL, bearerSessionBody, jsonResponse, stubHttpClient } from "./testHttp.ts";

const bootstrap = bootstrapRemoteBearerSession({
  httpBaseUrl: HTTP_BASE_URL,
  credential: "bootstrap-token",
  clientMetadata: { label: "web", deviceType: "web" },
});

describe("bootstrapRemoteBearerSession", () => {
  it.effect("posts the credential and decodes the bearer session", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly url: string; readonly method: string; readonly body: string }> =
        [];
      const body = yield* bearerSessionBody("session-token", 1_800_000);

      const session = yield* bootstrap.pipe(
        Effect.provide(
          stubHttpClient((url, init) => {
            seen.push({
              url,
              method: String(init.method),
              body: new TextDecoder().decode(init.body as Uint8Array),
            });
            return Promise.resolve(jsonResponse(200, body));
          }),
        ),
      );

      assert.equal(session.access_token, "session-token");
      assert.isNotNull(session.expires_at);
      assert.equal(
        session.expires_at === null ? -1 : DateTime.toEpochMillis(session.expires_at),
        1_800_000,
      );
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.method, "POST");
      assert.equal(seen[0]?.url, `${HTTP_BASE_URL}/api/auth/bootstrap/bearer`);
      assert.include(seen[0]?.body ?? "", "bootstrap-token");
    }),
  );

  it.effect("blocks on an authentication rejection instead of retrying forever", () =>
    Effect.gen(function* () {
      const error = yield* bootstrap.pipe(
        Effect.provide(stubHttpClient(() => Promise.resolve(jsonResponse(401, { error: "nope" })))),
        Effect.flip,
      );

      assert.equal(error._tag, "BearerBootstrapStatusError");
      const mapped = mapBearerBootstrapError(error);
      assert.equal(mapped._tag, "ConnectionBlockedError");
      assert.equal(mapped.reason, "authentication");
    }),
  );

  it.effect("blocks on the proxy and session-expiry statuses a bare 401/403 check misses", () =>
    Effect.gen(function* () {
      for (const status of [407, 419, 440]) {
        const error = yield* bootstrap.pipe(
          Effect.provide(stubHttpClient(() => Promise.resolve(jsonResponse(status, {})))),
          Effect.flip,
        );
        assert.equal(
          mapBearerBootstrapError(error)._tag,
          "ConnectionBlockedError",
          `status ${status} must block`,
        );
      }
    }),
  );

  it.effect("retries a server that is not ready yet", () =>
    Effect.gen(function* () {
      const error = yield* bootstrap.pipe(
        Effect.provide(stubHttpClient(() => Promise.resolve(jsonResponse(503, {})))),
        Effect.flip,
      );

      const mapped = mapBearerBootstrapError(error);
      assert.equal(mapped._tag, "ConnectionTransientError");
      assert.equal(mapped.reason, "remote-unavailable");
    }),
  );

  it.effect("blocks when the response is not a bearer session", () =>
    Effect.gen(function* () {
      const error = yield* bootstrap.pipe(
        Effect.provide(
          stubHttpClient(() => Promise.resolve(jsonResponse(200, { unexpected: true }))),
        ),
        Effect.flip,
      );

      assert.equal(error._tag, "BearerBootstrapInvalidResponseError");
      const mapped = mapBearerBootstrapError(error);
      assert.equal(mapped._tag, "ConnectionBlockedError");
      assert.equal(mapped.reason, "configuration");
    }),
  );

  it.effect("treats an unreachable server as transient", () =>
    Effect.gen(function* () {
      const error = yield* bootstrap.pipe(
        Effect.provide(stubHttpClient(() => Promise.reject(new Error("ECONNREFUSED")))),
        Effect.flip,
      );

      assert.equal(error._tag, "BearerBootstrapTransportError");
      const mapped = mapBearerBootstrapError(error);
      assert.equal(mapped._tag, "ConnectionTransientError");
      assert.equal(mapped.reason, "network");
    }),
  );

  it.effect("times out a server that never answers", () =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(
        bootstrap.pipe(
          Effect.provide(stubHttpClient(() => new Promise<Response>(() => {}))),
          Effect.flip,
        ),
      );

      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(running);

      assert.equal(error._tag, "BearerBootstrapTimeoutError");
      const mapped = mapBearerBootstrapError(error);
      assert.equal(mapped._tag, "ConnectionTransientError");
      assert.equal(mapped.reason, "timeout");
    }),
  );
});
