import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const JourneyId = TrimmedNonEmptyString.pipe(Schema.brand("JourneyId"));
