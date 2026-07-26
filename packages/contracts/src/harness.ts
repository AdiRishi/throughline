import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HarnessKind } from "./journey.ts";

/**
 * The harness surface: what the settings page and the door need to know about
 * the reviewer's own local agent harnesses. Throughline ships no model — these
 * are *their* installs, riding *their* logins.
 */

export const HarnessAuthState = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
  "missing",
]);
export type HarnessAuthState = typeof HarnessAuthState.Type;

export const HarnessStatus = Schema.Struct({
  kind: HarnessKind,
  label: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  auth: HarnessAuthState,
  /** Verbatim setup instruction when this harness cannot be used. */
  detail: Schema.NullOr(Schema.String),
});
export type HarnessStatus = typeof HarnessStatus.Type;

/**
 * Every detected harness plus which one analysis would actually use. `active`
 * is null when nothing is usable — the door-level parked state.
 */
export const HarnessReport = Schema.Struct({
  harnesses: Schema.Array(HarnessStatus),
  /** The reviewer's explicit override, or null for auto-select. */
  selected: Schema.NullOr(HarnessKind),
  /** What the next analysis would use, after auto-select. */
  active: Schema.NullOr(HarnessKind),
  probedAt: Schema.DateTimeUtc,
});
export type HarnessReport = typeof HarnessReport.Type;

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * App settings. Deliberately tiny: appearance stays a host concern (the
 * pre-mount theme guard reads it from local storage), so the only durable
 * setting is which harness to analyse with.
 */
export const AppSettings = Schema.Struct({
  /** Absent means auto-select: the first authenticated harness. */
  harness: Schema.NullOr(HarnessKind),
});
export type AppSettings = typeof AppSettings.Type;

export const AppSettingsJson = Schema.fromJsonString(Schema.toCodecJson(AppSettings));

/** Every field optional: `settings.update` is a patch, not a replace. */
export const UpdateSettingsInput = Schema.Struct({
  harness: Schema.optionalKey(Schema.NullOr(HarnessKind)),
});
export type UpdateSettingsInput = typeof UpdateSettingsInput.Type;
