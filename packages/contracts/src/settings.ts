/**
 * Harness detection and app settings — the quiet page behind the gear.
 *
 * @module settings
 */
import * as Schema from "effect/Schema";

import { HarnessKind } from "./journey.ts";

export const HarnessAuthState = Schema.Literals(["authenticated", "unauthenticated", "unknown"]);
export type HarnessAuthState = typeof HarnessAuthState.Type;

/**
 * What `detect()` found. An unknown auth state is honest — some harnesses only
 * reveal it by running — and is treated as usable-but-unverified.
 */
export const HarnessStatus = Schema.Struct({
  kind: HarnessKind,
  label: Schema.String,
  installed: Schema.Boolean,
  version: Schema.NullOr(Schema.String),
  auth: HarnessAuthState,
  /** Why it is unusable, when it is — rendered as setup instructions. */
  detail: Schema.String,
});
export type HarnessStatus = typeof HarnessStatus.Type;

export const HarnessStatusView = Schema.Struct({
  harnesses: Schema.Array(HarnessStatus),
  /** The reviewer's explicit choice, if any. */
  selected: Schema.NullOr(HarnessKind),
  /** What the next analysis would actually use — selection, else auto-pick. */
  active: Schema.NullOr(HarnessKind),
});
export type HarnessStatusView = typeof HarnessStatusView.Type;

export const Settings = Schema.Struct({
  /** Absent means auto-select: first authenticated harness, Codex then Claude. */
  harness: Schema.NullOr(HarnessKind),
});
export type Settings = typeof Settings.Type;

export const SettingsUpdate = Schema.Struct({
  harness: Schema.NullOr(HarnessKind),
});
export type SettingsUpdate = typeof SettingsUpdate.Type;
