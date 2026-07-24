import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HarnessAuthState = Schema.Literals(["authenticated", "unauthenticated", "unknown"]);
export type HarnessAuthState = typeof HarnessAuthState.Type;

export const HarnessStatus = Schema.Struct({
  kind: TrimmedNonEmptyString,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  auth: HarnessAuthState,
});
export type HarnessStatus = typeof HarnessStatus.Type;
