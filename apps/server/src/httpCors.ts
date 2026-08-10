/**
 * CORS constants shared by every browser-facing HTTP surface.
 *
 * Kept as a named module rather than inlined into the CORS layer because more
 * than one route family has to agree on the list — duplicating it is how the
 * trace-context headers get dropped from one surface and not another.
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
