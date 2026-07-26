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

/**
 * What to say when a failure carries no message of its own.
 *
 * This deliberately does not say "try again in a moment". A failure with nothing
 * to say is, in practice, a *defect* — the process broke in a way its own contract
 * did not describe — and a defect is not a blip: a schema the server cannot query
 * or a bug on a code path fails identically on the next click. Inviting the
 * reviewer to keep pressing a button is how a five-second diagnosis becomes a
 * five-minute one. What is true, and useful, is that it was unexpected and that it
 * was written down, so that is what this says. Retrying is still one click away
 * for anyone who wants it.
 */
export const UNEXPECTED_MESSAGE =
  "Something went wrong that Throughline did not expect. It is in the log.";

/**
 * The failure's own message, or the calm fallback — never `String(cause)`. An
 * empty message counts as no message: a notice with a title and no remedy is the
 * one thing a parked state must never be.
 */
export function failureDetail(cause: Cause.Cause<unknown>): string {
  const error: unknown = Cause.squash(cause);
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : UNEXPECTED_MESSAGE;
  }
  if (typeof error === "string" && error.length > 0) return error;
  return UNEXPECTED_MESSAGE;
}
