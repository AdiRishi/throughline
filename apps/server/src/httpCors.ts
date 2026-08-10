/**
 * CORS constants shared by every browser-facing HTTP surface.
 *
 * `b3` and `traceparent` are the Zipkin/W3C trace-context headers that Effect's
 * own `HttpClient` injects whenever tracer propagation is enabled, so a
 * credentialed browser request from the dev origin fails preflight without
 * them.
 *
 * @module httpCors
 */
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
] as const;

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;

export const browserApiCorsMaxAgeSeconds = 600;
