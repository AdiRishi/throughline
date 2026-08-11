import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { BearerAuthorization, bearerAuthorizationLayer } from "@app/client-runtime/authorization";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";

// Exchanges the shell's bootstrap token for a bearer session the renderer uses
// on the `/ws` upgrade. The token is minted by the shell and handed to BOTH the
// spawned server (via fd3) and here — the "shared secret handed to a trusted
// child" pattern. The exchange runs through the shared `BearerAuthorization`
// service (the same cache the browser path uses), which honours the session's
// `expires_at`: it refreshes 60s before expiry and evicts on a failed exchange,
// so a stale credential can't strand the renderer's reconnect loop in `blocked`.

export class DesktopLocalEnvironmentAuthBackendNotReadyError extends Schema.TaggedError<DesktopLocalEnvironmentAuthBackendNotReadyError>()(
  "DesktopLocalEnvironmentAuthBackendNotReadyError",
  {},
) {
  override get message(): string {
    return "Local backend is not configured yet.";
  }
}

export class DesktopLocalEnvironmentAuthSessionBootstrapError extends Schema.TaggedError<DesktopLocalEnvironmentAuthSessionBootstrapError>()(
  "DesktopLocalEnvironmentAuthSessionBootstrapError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to create the local desktop bearer session.";
  }
}

export const DesktopLocalEnvironmentAuthError = Schema.Union([
  DesktopLocalEnvironmentAuthBackendNotReadyError,
  DesktopLocalEnvironmentAuthSessionBootstrapError,
]);
export type DesktopLocalEnvironmentAuthError = typeof DesktopLocalEnvironmentAuthError.Type;

export class DesktopLocalEnvironmentAuth extends Context.Service<
  DesktopLocalEnvironmentAuth,
  {
    readonly getBearerToken: Effect.Effect<string, DesktopLocalEnvironmentAuthError>;
  }
>()("@app/desktop/backend/DesktopLocalEnvironmentAuth") {}

export const make = Effect.gen(function* () {
  const manager = yield* DesktopBackendManager.DesktopBackendManager;
  const authorization = yield* BearerAuthorization;

  const getBearerToken = Effect.gen(function* () {
    const configOption = yield* manager.currentConfig;
    if (Option.isNone(configOption)) {
      return yield* new DesktopLocalEnvironmentAuthBackendNotReadyError();
    }
    const config = configOption.value;

    return yield* authorization
      .accessToken({
        httpBaseUrl: config.httpBaseUrl.href,
        credential: config.bootstrapToken,
        clientMetadata: { label: "App Desktop", deviceType: "desktop" },
      })
      .pipe(
        Effect.mapError((cause) => new DesktopLocalEnvironmentAuthSessionBootstrapError({ cause })),
      );
  }).pipe(Effect.withSpan("desktop.localEnvironmentAuth.getBearerToken"));

  return DesktopLocalEnvironmentAuth.of({ getBearerToken });
});

// The HttpClient is deliberately NOT provided here: `main.ts` supplies one for
// the whole application (Electron's global `fetch`, because bundling undici into
// the CJS main crashes Electron at load). Building a second one here would
// silently opt this caller out of that decision.
export const layer = Layer.effect(DesktopLocalEnvironmentAuth, make).pipe(
  Layer.provide(bearerAuthorizationLayer),
);
