import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { BearerSessionJson, BootstrapBearerInput, type BearerSession } from "@app/contracts";

/** Where the bearer-bootstrap exchange lives on the local server. */
export const AUTH_BOOTSTRAP_PATH = "/api/auth/bootstrap/bearer";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * The exchange never got an answer: DNS, a refused socket, a TLS failure, an
 * aborted request. Nothing about the credential is known, so retrying is
 * reasonable.
 */
export class BearerBootstrapTransportError extends Schema.TaggedError<BearerBootstrapTransportError>()(
  "BearerBootstrapTransportError",
  {
    requestUrl: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The exchange did not finish inside its budget. */
export class BearerBootstrapTimeoutError extends Schema.TaggedError<BearerBootstrapTimeoutError>()(
  "BearerBootstrapTimeoutError",
  {
    requestUrl: Schema.String,
    timeoutMs: Schema.Finite,
  },
) {
  override get message(): string {
    return `Bearer bootstrap to ${this.requestUrl} timed out after ${this.timeoutMs}ms.`;
  }
}

/**
 * The server answered with a non-2xx status. The status is kept as a number
 * rather than pre-classified so the mapping to blocked-vs-transient lives in one
 * place (`mapBearerBootstrapError`) instead of being spread over call sites.
 */
export class BearerBootstrapStatusError extends Schema.TaggedError<BearerBootstrapStatusError>()(
  "BearerBootstrapStatusError",
  {
    requestUrl: Schema.String,
    status: Schema.Finite,
  },
) {
  override get message(): string {
    return `Bearer bootstrap to ${this.requestUrl} was refused with HTTP ${this.status}.`;
  }
}

/**
 * The server answered 2xx with a body that is not a `BearerSession`. That means
 * this client and that server disagree about the contract — a mismatched build,
 * or something else answering on the port. Retrying the same exchange cannot
 * reconcile them.
 */
export class BearerBootstrapInvalidResponseError extends Schema.TaggedError<BearerBootstrapInvalidResponseError>()(
  "BearerBootstrapInvalidResponseError",
  {
    requestUrl: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Every way the bearer-bootstrap exchange can fail, as a discriminated union.
 * A single flat error with an optional status forces every caller to re-derive
 * "can I retry this?" from a number; these tags map deterministically (see
 * `mapBearerBootstrapError`).
 */
export type BearerBootstrapError =
  | BearerBootstrapTransportError
  | BearerBootstrapTimeoutError
  | BearerBootstrapStatusError
  | BearerBootstrapInvalidResponseError;

const encodeBootstrapInput = Schema.encodeEffect(Schema.toCodecJson(BootstrapBearerInput));
const decodeBearerSession = Schema.decodeUnknownEffect(BearerSessionJson);

type BootstrapRequestError =
  | HttpClientError.HttpClientError
  | BearerBootstrapStatusError
  | BearerBootstrapTimeoutError
  | Schema.SchemaError;

const failBearerBootstrap = (
  requestUrl: string,
  cause: BootstrapRequestError,
): Effect.Effect<never, BearerBootstrapError> => {
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new BearerBootstrapInvalidResponseError({
        requestUrl,
        detail: `Bearer bootstrap to ${requestUrl} returned a response that is not a bearer session.`,
        cause,
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause)) {
    // A body that cannot even be read as JSON is the same disagreement as a
    // body that does not match the schema; anything else never reached a
    // response at all.
    return cause.reason._tag === "DecodeError" || cause.reason._tag === "EmptyBodyError"
      ? Effect.fail(
          new BearerBootstrapInvalidResponseError({
            requestUrl,
            detail: `Bearer bootstrap to ${requestUrl} returned an unreadable response body.`,
            cause,
          }),
        )
      : Effect.fail(
          new BearerBootstrapTransportError({
            requestUrl,
            detail: `Could not reach ${requestUrl} to bootstrap a bearer session (${cause.message}).`,
            cause,
          }),
        );
  }
  return Effect.fail(cause);
};

/**
 * Apply the timeout and collapse every failure mode into `BearerBootstrapError`
 * (the same shape as the reference repo's `executeEnvironmentHttpRequest`).
 */
const executeBootstrapRequest = <A, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, BootstrapRequestError, R>,
): Effect.Effect<A, BearerBootstrapError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new BearerBootstrapTimeoutError({ requestUrl, timeoutMs })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failBearerBootstrap(requestUrl, cause)),
  );

/**
 * Exchange a bootstrap credential for a short-lived `/ws` bearer session.
 *
 * `POST ${httpBaseUrl}/api/auth/bootstrap/bearer` with the credential; decode
 * the `access_token` + `expires_at`. This is the browser path of the
 * integration contract — in the Electron shell the token comes from the bridge
 * instead, but the shell's main process runs this same exchange to mint it.
 *
 * The request goes through `HttpClient` rather than the platform `fetch`, so the
 * call is testable without a network, participates in tracing, and its failures
 * arrive as typed values instead of a caught `unknown`.
 */
export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.authorization.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly clientMetadata?: BootstrapBearerInput["clientMetadata"];
  readonly timeoutMs?: number;
}): Effect.fn.Return<BearerSession, BearerBootstrapError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const requestUrl = new URL(AUTH_BOOTSTRAP_PATH, input.httpBaseUrl).toString();
  const payload: BootstrapBearerInput = {
    credential: input.credential,
    ...(input.clientMetadata ? { clientMetadata: input.clientMetadata } : {}),
  };

  // Encoding a value we just constructed can only fail on a schema bug — die.
  const request = yield* encodeBootstrapInput(payload).pipe(
    Effect.flatMap((json) => HttpClientRequest.bodyJson(HttpClientRequest.post(requestUrl), json)),
    Effect.orDie,
  );

  return yield* executeBootstrapRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    Effect.gen(function* () {
      const response = yield* client.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return yield* new BearerBootstrapStatusError({ requestUrl, status: response.status });
      }
      return yield* decodeBearerSession(yield* response.json);
    }),
  );
});
