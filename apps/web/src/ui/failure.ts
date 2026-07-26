import * as Cause from "effect/Cause";

/**
 * One way to turn a failed round trip into a sentence a reviewer can read.
 *
 * Throughline's failures are almost always *authored* — the server writes the
 * remedy into the error it returns (`gh` not signed in, the exact `codex login`
 * to run), because it is the process that knows what went wrong. So the renderer's
 * job is not to diagnose: it is to surface that sentence and, when there isn't
 * one, to say plainly that nothing happened rather than dump a `Cause` at someone
 * mid-review.
 *
 * It lives in `ui/` rather than in one surface because every verb in this product
 * can fail, and a failure described in a different voice on each screen is how a
 * calm product starts to feel unreliable.
 *
 * @module ui/failure
 */

/** What to say when the failure carries no message of its own. */
export const INCOMPLETE_MESSAGE = "The request did not complete. Try again in a moment.";

/**
 * The failure's own message, or the calm fallback — never `String(cause)`. An
 * empty message counts as no message: a notice with a title and no remedy is the
 * one thing a parked state must never be.
 */
export function failureDetail(cause: Cause.Cause<unknown>): string {
  const error: unknown = Cause.squash(cause);
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : INCOMPLETE_MESSAGE;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return INCOMPLETE_MESSAGE;
}
