import type { BearerBootstrapError } from "../authorization/remote.ts";
import { findErrorTraceId } from "../errors/errorTrace.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type ConnectionBlockedReason,
  ConnectionTransientError,
} from "./model.ts";

/**
 * Classify an HTTP status the bearer-bootstrap exchange was refused with.
 *
 * Returns the blocking reason when retrying the same exchange cannot possibly
 * succeed, or `null` when the status is a "come back later" the supervisor
 * should back off from.
 *
 * The retryable set is deliberately small and explicit: request timeout, "too
 * early", rate limiting, and the server-side 5xx family (a server that is still
 * booting answers 502/503 and then starts working). Everything else in the 4xx
 * family — including the proxy- and session-expiry statuses (407, 419, 440) that
 * a bare 401/403 check silently retries forever — is a credential or
 * configuration problem that only changes when something outside the loop does.
 */
export function bearerBootstrapBlockedReason(status: number): ConnectionBlockedReason | null {
  switch (status) {
    case 401:
    case 407:
    case 419:
    case 440:
      return "authentication";
    case 403:
    case 451:
      return "permission";
    case 408:
    case 425:
    case 429:
      return null;
    case 501:
      return "configuration";
  }
  if (status >= 500) {
    return null;
  }
  if (status >= 400) {
    return "configuration";
  }
  // A 1xx/3xx answer to a POST the client did not ask to follow means the
  // endpoint is not what this client thinks it is.
  return "configuration";
}

/**
 * Map a bearer-bootstrap failure onto the supervisor's two-way split.
 *
 * This is the whole point of the typed error union: every tag has exactly one
 * answer to "should the supervisor back off or park?", decided here instead of
 * at each call site from a loose status number.
 */
export function mapBearerBootstrapError(error: BearerBootstrapError): ConnectionAttemptError {
  const traceId = findErrorTraceId(error);
  const trace = traceId === null ? {} : { traceId };
  switch (error._tag) {
    case "BearerBootstrapTransportError":
      return new ConnectionTransientError({
        reason: "network",
        detail: error.message,
        ...trace,
      });
    case "BearerBootstrapTimeoutError":
      return new ConnectionTransientError({
        reason: "timeout",
        detail: error.message,
        ...trace,
      });
    case "BearerBootstrapInvalidResponseError":
      return new ConnectionBlockedError({
        reason: "configuration",
        detail: error.message,
        ...trace,
      });
    case "BearerBootstrapStatusError": {
      const blockedReason = bearerBootstrapBlockedReason(error.status);
      return blockedReason === null
        ? new ConnectionTransientError({
            reason: "remote-unavailable",
            detail: error.message,
            ...trace,
          })
        : new ConnectionBlockedError({
            reason: blockedReason,
            detail: error.message,
            ...trace,
          });
    }
  }
}
