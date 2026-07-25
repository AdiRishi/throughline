import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HarnessKind, JourneyId, PrRef } from "./journey.ts";

export const IngestionJobId = TrimmedNonEmptyString.pipe(Schema.brand("IngestionJobId"));
export type IngestionJobId = typeof IngestionJobId.Type;

export const AnalysisStage = Schema.Literals(["planning", "narrating"]);
export type AnalysisStage = typeof AnalysisStage.Type;

export const IngestionActivity = Schema.Struct({
  action: TrimmedNonEmptyString,
  path: Schema.optionalKey(TrimmedNonEmptyString),
  recent: Schema.Array(TrimmedNonEmptyString),
  filesWalked: NonNegativeInt,
  symbolsTraced: NonNegativeInt,
  callSitesFollowed: NonNegativeInt,
});
export type IngestionActivity = typeof IngestionActivity.Type;

export const IngestionPhase = Schema.Union([
  Schema.Struct({ type: Schema.Literal("queued"), position: Schema.Int }),
  Schema.Struct({ type: Schema.Literal("resolving") }),
  Schema.Struct({ type: Schema.Literal("cloning") }),
  Schema.Struct({ type: Schema.Literal("diffing") }),
  Schema.Struct({
    type: Schema.Literal("analyzing"),
    stage: AnalysisStage,
    detail: IngestionActivity,
  }),
  Schema.Struct({ type: Schema.Literal("validating") }),
  Schema.Struct({ type: Schema.Literal("saving") }),
  Schema.Struct({ type: Schema.Literal("complete"), journeyId: JourneyId }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    detail: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
]);
export type IngestionPhase = typeof IngestionPhase.Type;

export const IngestionJob = Schema.Struct({
  id: IngestionJobId,
  pr: PrRef,
  phase: IngestionPhase,
  startedAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type IngestionJob = typeof IngestionJob.Type;

export const IngestionStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literals(["snapshot", "updated"]),
  jobs: Schema.Array(IngestionJob),
});
export type IngestionStreamEvent = typeof IngestionStreamEvent.Type;

export const LocalPrState = Schema.Struct({
  reviewed: Schema.Array(PrRef),
  hidden: Schema.Array(PrRef),
  dismissedMerged: Schema.Array(PrRef),
});
export type LocalPrState = typeof LocalPrState.Type;

export const PrStateAction = Schema.Struct({
  pr: PrRef,
  value: Schema.Boolean,
});
export type PrStateAction = typeof PrStateAction.Type;

export const Settings = Schema.Struct({
  harness: Schema.optionalKey(HarnessKind),
});
export type Settings = typeof Settings.Type;

export class IngestionJobNotFoundError extends Schema.TaggedErrorClass<IngestionJobNotFoundError>()(
  "IngestionJobNotFoundError",
  { id: IngestionJobId },
) {}

export class OperationFailedError extends Schema.TaggedErrorClass<OperationFailedError>()(
  "OperationFailedError",
  {
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
    retryable: Schema.Boolean,
  },
) {}
