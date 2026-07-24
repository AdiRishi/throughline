import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  GitHubParkedError,
  GitHubPrListStreamEvent,
  GitHubReadError,
  PrDetail,
  PrRef,
  Viewer,
} from "./github.ts";
import { HarnessStatus } from "./harness.ts";
import {
  IngestionDoorRejectionError,
  IngestionJob,
  IngestionJobId,
  IngestionStreamEvent,
} from "./ingestion.ts";
import {
  ClusterId,
  DisplayMode,
  FileContent,
  HarnessSelection,
  Journey,
  JourneyId,
  LocalPrState,
  ReadState,
  RepositoryPath,
  Settings,
} from "./journey.ts";

export const PRODUCT_WS_METHODS = {
  githubViewer: "github.viewer",
  githubPrs: "github.prs",
  githubRefreshPrs: "github.refreshPrs",
  githubRetry: "github.retry",
  ingestionStart: "ingestion.start",
  ingestionCancel: "ingestion.cancel",
  ingestionSubscribe: "ingestion.subscribe",
  journeyGet: "journey.get",
  journeyFilePatch: "journey.filePatch",
  journeyFileContent: "journey.fileContent",
  journeyTree: "journey.tree",
  readStateGet: "readState.get",
  readStateMarkFile: "readState.markFile",
  readStateUnmarkFile: "readState.unmarkFile",
  readStateSetDisplayMode: "readState.setDisplayMode",
  readStateSubscribe: "readState.subscribe",
  prStateGet: "prState.get",
  prStateReviewed: "prState.reviewed",
  prStateHide: "prState.hide",
  prStateDismissMerged: "prState.dismissMerged",
  harnessStatus: "harness.status",
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
} as const;

export const IngestionSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ref"),
    ref: PrRef,
  }),
  Schema.Struct({
    type: Schema.Literal("url"),
    url: TrimmedNonEmptyString,
  }),
]);
export type IngestionSource = typeof IngestionSource.Type;

export const JourneyDocument = Schema.Struct({
  journey: Journey,
  pullRequest: PrDetail,
});
export type JourneyDocument = typeof JourneyDocument.Type;

export const JourneyFilePatch = Schema.Struct({
  path: RepositoryPath,
  patch: Schema.NullOr(Schema.String),
});
export type JourneyFilePatch = typeof JourneyFilePatch.Type;

export const JourneyTree = Schema.Struct({
  paths: Schema.Array(RepositoryPath),
});
export type JourneyTree = typeof JourneyTree.Type;

export const ReadStateSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("snapshot"),
  state: ReadState,
});
export type ReadStateSnapshotEvent = typeof ReadStateSnapshotEvent.Type;

export const ReadStateUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("updated"),
  state: ReadState,
});
export type ReadStateUpdatedEvent = typeof ReadStateUpdatedEvent.Type;

export const ReadStateStreamEvent = Schema.Union([ReadStateSnapshotEvent, ReadStateUpdatedEvent]);
export type ReadStateStreamEvent = typeof ReadStateStreamEvent.Type;

export const HarnessStatusResult = Schema.Struct({
  harnesses: Schema.Array(HarnessStatus),
});
export type HarnessStatusResult = typeof HarnessStatusResult.Type;

export class ProductOperationError extends Schema.TaggedErrorClass<ProductOperationError>()(
  "ProductOperationError",
  {
    reason: Schema.Literals(["storage", "workspace", "internal"]),
    operation: TrimmedNonEmptyString,
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class JourneyNotFoundError extends Schema.TaggedErrorClass<JourneyNotFoundError>()(
  "JourneyNotFoundError",
  {
    journeyId: Schema.optionalKey(JourneyId),
    pr: Schema.optionalKey(PrRef),
  },
) {
  override get message(): string {
    return "The requested journey no longer exists.";
  }
}

export class JourneyFileNotFoundError extends Schema.TaggedErrorClass<JourneyFileNotFoundError>()(
  "JourneyFileNotFoundError",
  {
    journeyId: JourneyId,
    path: RepositoryPath,
  },
) {
  override get message(): string {
    return `The requested file '${this.path}' is not available for this journey.`;
  }
}

export class ReadStateMarkInvalidError extends Schema.TaggedErrorClass<ReadStateMarkInvalidError>()(
  "ReadStateMarkInvalidError",
  {
    journeyId: JourneyId,
    clusterId: ClusterId,
    path: RepositoryPath,
  },
) {
  override get message(): string {
    return `The file '${this.path}' is not homed in the requested cluster.`;
  }
}

const ProductRpcError = Schema.Union([ProductOperationError, EnvironmentAuthorizationError]);
const GitHubRpcError = Schema.Union([
  GitHubReadError,
  GitHubParkedError,
  ProductOperationError,
  EnvironmentAuthorizationError,
]);
const JourneyRpcError = Schema.Union([
  JourneyNotFoundError,
  ProductOperationError,
  EnvironmentAuthorizationError,
]);
const JourneyFileRpcError = Schema.Union([
  JourneyNotFoundError,
  JourneyFileNotFoundError,
  ProductOperationError,
  EnvironmentAuthorizationError,
]);
const ReadStateMutationRpcError = Schema.Union([
  JourneyNotFoundError,
  ReadStateMarkInvalidError,
  ProductOperationError,
  EnvironmentAuthorizationError,
]);

export const WsGitHubViewerRpc = Rpc.make(PRODUCT_WS_METHODS.githubViewer, {
  payload: Schema.Struct({}),
  success: Viewer,
  error: GitHubRpcError,
});

export const WsGitHubPrsRpc = Rpc.make(PRODUCT_WS_METHODS.githubPrs, {
  payload: Schema.Struct({}),
  success: GitHubPrListStreamEvent,
  error: GitHubRpcError,
  stream: true,
});

export const WsGitHubRefreshPrsRpc = Rpc.make(PRODUCT_WS_METHODS.githubRefreshPrs, {
  payload: Schema.Struct({}),
  error: GitHubRpcError,
});

export const WsGitHubRetryRpc = Rpc.make(PRODUCT_WS_METHODS.githubRetry, {
  payload: Schema.Struct({}),
  error: GitHubRpcError,
});

export const WsIngestionStartRpc = Rpc.make(PRODUCT_WS_METHODS.ingestionStart, {
  payload: Schema.Struct({ source: IngestionSource }),
  success: IngestionJob,
  error: Schema.Union([IngestionDoorRejectionError, EnvironmentAuthorizationError]),
});

export const WsIngestionCancelRpc = Rpc.make(PRODUCT_WS_METHODS.ingestionCancel, {
  payload: Schema.Struct({ jobId: IngestionJobId }),
  success: Schema.NullOr(IngestionJob),
  error: EnvironmentAuthorizationError,
});

export const WsIngestionSubscribeRpc = Rpc.make(PRODUCT_WS_METHODS.ingestionSubscribe, {
  payload: Schema.Struct({ pr: PrRef }),
  success: IngestionStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsJourneyGetRpc = Rpc.make(PRODUCT_WS_METHODS.journeyGet, {
  payload: Schema.Struct({ pr: PrRef }),
  success: JourneyDocument,
  error: JourneyRpcError,
});

const JourneyFileInput = Schema.Struct({
  journeyId: JourneyId,
  path: RepositoryPath,
});

export const WsJourneyFilePatchRpc = Rpc.make(PRODUCT_WS_METHODS.journeyFilePatch, {
  payload: JourneyFileInput,
  success: JourneyFilePatch,
  error: JourneyFileRpcError,
});

export const WsJourneyFileContentRpc = Rpc.make(PRODUCT_WS_METHODS.journeyFileContent, {
  payload: JourneyFileInput,
  success: FileContent,
  error: JourneyFileRpcError,
});

export const WsJourneyTreeRpc = Rpc.make(PRODUCT_WS_METHODS.journeyTree, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: JourneyTree,
  error: JourneyRpcError,
});

const ReadStateInput = Schema.Struct({ journeyId: JourneyId });
const ReadStateFileInput = Schema.Struct({
  journeyId: JourneyId,
  clusterId: ClusterId,
  path: RepositoryPath,
});

export const WsReadStateGetRpc = Rpc.make(PRODUCT_WS_METHODS.readStateGet, {
  payload: ReadStateInput,
  success: ReadState,
  error: JourneyRpcError,
});

export const WsReadStateMarkFileRpc = Rpc.make(PRODUCT_WS_METHODS.readStateMarkFile, {
  payload: ReadStateFileInput,
  success: ReadState,
  error: ReadStateMutationRpcError,
});

export const WsReadStateUnmarkFileRpc = Rpc.make(PRODUCT_WS_METHODS.readStateUnmarkFile, {
  payload: ReadStateFileInput,
  success: ReadState,
  error: ReadStateMutationRpcError,
});

export const WsReadStateSetDisplayModeRpc = Rpc.make(PRODUCT_WS_METHODS.readStateSetDisplayMode, {
  payload: Schema.Struct({
    journeyId: JourneyId,
    displayMode: DisplayMode,
  }),
  success: ReadState,
  error: JourneyRpcError,
});

export const WsReadStateSubscribeRpc = Rpc.make(PRODUCT_WS_METHODS.readStateSubscribe, {
  payload: ReadStateInput,
  success: ReadStateStreamEvent,
  error: JourneyRpcError,
  stream: true,
});

const PrStateInput = Schema.Struct({
  pr: PrRef,
  active: Schema.Boolean,
});

export const WsPrStateGetRpc = Rpc.make(PRODUCT_WS_METHODS.prStateGet, {
  payload: Schema.Struct({}),
  success: LocalPrState,
  error: ProductRpcError,
});

export const WsPrStateReviewedRpc = Rpc.make(PRODUCT_WS_METHODS.prStateReviewed, {
  payload: PrStateInput,
  success: LocalPrState,
  error: ProductRpcError,
});

export const WsPrStateHideRpc = Rpc.make(PRODUCT_WS_METHODS.prStateHide, {
  payload: PrStateInput,
  success: LocalPrState,
  error: ProductRpcError,
});

export const WsPrStateDismissMergedRpc = Rpc.make(PRODUCT_WS_METHODS.prStateDismissMerged, {
  payload: PrStateInput,
  success: LocalPrState,
  error: ProductRpcError,
});

export const WsHarnessStatusRpc = Rpc.make(PRODUCT_WS_METHODS.harnessStatus, {
  payload: Schema.Struct({}),
  success: HarnessStatusResult,
  error: EnvironmentAuthorizationError,
});

export const WsSettingsGetRpc = Rpc.make(PRODUCT_WS_METHODS.settingsGet, {
  payload: Schema.Struct({}),
  success: Settings,
  error: ProductRpcError,
});

export const WsSettingsUpdateRpc = Rpc.make(PRODUCT_WS_METHODS.settingsUpdate, {
  payload: Schema.Struct({
    harness: Schema.NullOr(HarnessSelection),
  }),
  success: Settings,
  error: ProductRpcError,
});

export const ProductWsRpcGroup = RpcGroup.make(
  WsGitHubViewerRpc,
  WsGitHubPrsRpc,
  WsGitHubRefreshPrsRpc,
  WsGitHubRetryRpc,
  WsIngestionStartRpc,
  WsIngestionCancelRpc,
  WsIngestionSubscribeRpc,
  WsJourneyGetRpc,
  WsJourneyFilePatchRpc,
  WsJourneyFileContentRpc,
  WsJourneyTreeRpc,
  WsReadStateGetRpc,
  WsReadStateMarkFileRpc,
  WsReadStateUnmarkFileRpc,
  WsReadStateSetDisplayModeRpc,
  WsReadStateSubscribeRpc,
  WsPrStateGetRpc,
  WsPrStateReviewedRpc,
  WsPrStateHideRpc,
  WsPrStateDismissMergedRpc,
  WsHarnessStatusRpc,
  WsSettingsGetRpc,
  WsSettingsUpdateRpc,
);
