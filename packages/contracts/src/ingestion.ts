import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PrRef } from "./github.ts";
import { JourneyId, RepositoryPath } from "./journey.ts";

export const IngestionJobId = TrimmedNonEmptyString.pipe(Schema.brand("IngestionJobId"));
export type IngestionJobId = typeof IngestionJobId.Type;

export const IngestionPhase = Schema.Literals([
  "queued",
  "resolving",
  "cloning",
  "diffing",
  "analyzing",
  "validating",
  "saving",
  "complete",
  "cancelled",
  "failed",
]);
export type IngestionPhase = typeof IngestionPhase.Type;

export const AnalysisStage = Schema.Literals(["planning", "narrating"]);
export type AnalysisStage = typeof AnalysisStage.Type;

export const IngestionActivityCounters = Schema.Struct({
  filesWalked: NonNegativeInt,
  symbolsTraced: NonNegativeInt,
  callSitesFollowed: NonNegativeInt,
});
export type IngestionActivityCounters = typeof IngestionActivityCounters.Type;

export const IngestionActivity = Schema.Struct({
  stage: AnalysisStage,
  currentAction: TrimmedNonEmptyString,
  currentFile: Schema.NullOr(RepositoryPath),
  recentActions: Schema.Array(TrimmedNonEmptyString),
  counters: IngestionActivityCounters,
});
export type IngestionActivity = typeof IngestionActivity.Type;

export const IngestionOperationalFailure = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
});
export type IngestionOperationalFailure = typeof IngestionOperationalFailure.Type;

export const IngestionJob = Schema.Struct({
  id: IngestionJobId,
  pr: PrRef,
  phase: IngestionPhase,
  queuePosition: Schema.NullOr(NonNegativeInt),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  updatedAt: Schema.DateTimeUtc,
  activity: Schema.NullOr(IngestionActivity),
  journeyId: Schema.NullOr(JourneyId),
  failure: Schema.NullOr(IngestionOperationalFailure),
});
export type IngestionJob = typeof IngestionJob.Type;

export const IngestionSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  job: Schema.NullOr(IngestionJob),
});
export type IngestionSnapshotEvent = typeof IngestionSnapshotEvent.Type;

export const IngestionUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("updated"),
  job: IngestionJob,
});
export type IngestionUpdatedEvent = typeof IngestionUpdatedEvent.Type;

export const IngestionStreamEvent = Schema.Union([IngestionSnapshotEvent, IngestionUpdatedEvent]);
export type IngestionStreamEvent = typeof IngestionStreamEvent.Type;

export const IngestionDoorRejectionReason = Schema.Literals([
  "invalid-url",
  "gh-unavailable",
  "not-found",
  "not-open",
  "harness-unavailable",
]);
export type IngestionDoorRejectionReason = typeof IngestionDoorRejectionReason.Type;

export class IngestionDoorRejectionError extends Schema.TaggedErrorClass<IngestionDoorRejectionError>()(
  "IngestionDoorRejectionError",
  {
    reason: IngestionDoorRejectionReason,
    input: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
