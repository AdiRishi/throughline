import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { DesktopBackendStartConfig } from "../../src/backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "../../src/backend/DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "../../src/backend/DesktopLocalEnvironmentAuth.ts";

const backendConfig: DesktopBackendStartConfig = {
  executablePath: "/Applications/Throughline.app/Contents/MacOS/Throughline",
  args: [],
  entryPath: "/Applications/Throughline.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
  cwd: "/tmp",
  env: {},
  bootstrapEnvelope: {
    desktopBootstrapToken: "bootstrap-token",
    port: 13_773,
  },
  port: 13_773,
  bootstrapToken: "bootstrap-token",
  httpBaseUrl: new URL("http://127.0.0.1:13773"),
};

const managerLayer = Layer.succeed(
  DesktopBackendManager.DesktopBackendManager,
  DesktopBackendManager.DesktopBackendManager.of({
    start: Effect.void,
    stop: Effect.void,
    currentConfig: Effect.succeed(Option.some(backendConfig)),
  }),
);

const authLayer = DesktopLocalEnvironmentAuth.layer.pipe(Layer.provide(managerLayer));

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("mints a bearer from the current server process on every connection attempt", () =>
    Effect.gen(function* () {
      const originalFetch = globalThis.fetch;
      let requestCount = 0;
      globalThis.fetch = async () => {
        requestCount += 1;
        return Response.json({
          access_token: `server-process-${requestCount}`,
          expires_at: null,
        });
      };

      return yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;

        const first = yield* auth.getBearerToken;
        const afterRestart = yield* auth.getBearerToken;

        assert.equal(first, "server-process-1");
        assert.equal(afterRestart, "server-process-2");
        assert.equal(requestCount, 2);
      }).pipe(
        Effect.provide(authLayer),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        ),
      );
    }),
  );
});
