import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import { BearerSessionJson } from "@app/contracts";

/** Shared fixtures for the bearer-bootstrap tests. Not a suite — no `.test.ts`. */

export const HTTP_BASE_URL = "http://127.0.0.1:41999";

export const encodeBearerSession = Schema.encodeEffect(BearerSessionJson);

/** Build the wire body the server sends, through the real codec. */
export const bearerSessionBody = (accessToken: string, expiresAtEpochMs: number | null) =>
  encodeBearerSession({
    access_token: accessToken,
    expires_at: expiresAtEpochMs === null ? null : DateTime.makeUnsafe(expiresAtEpochMs),
  });

export type StubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * An `HttpClient` backed by a hand-written `fetch`. Going through
 * `FetchHttpClient.layer` (rather than faking `HttpClient` itself) keeps the
 * real request-building path — method, headers, encoded body — under test.
 */
export const stubHttpClient = (stub: StubFetch): Layer.Layer<HttpClient.HttpClient> =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, ((input: URL | string, init: RequestInit) =>
        stub(String(input), init)) as unknown as typeof globalThis.fetch),
    ),
  );

export const jsonResponse = (status: number, body: unknown): Response =>
  Response.json(body, { status });
