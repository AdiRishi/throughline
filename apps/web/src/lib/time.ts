/**
 * Wire timestamps, as the DOM wants them.
 *
 * Every date on the wire is an Effect `DateTime.Utc`; every date the browser's
 * formatting APIs want is a `Date`. One conversion, in one place.
 *
 * @module lib/time
 */
import type * as DateTime from "effect/DateTime";

export function toDate(value: DateTime.Utc): Date {
  return new Date(value.epochMilliseconds);
}

export function toDateOrNull(value: DateTime.Utc | null): Date | null {
  return value === null ? null : toDate(value);
}
