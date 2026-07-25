import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  GitHubPrsStreamEvent,
  GitHubUnavailableError,
  GitHubViewer,
  HarnessStatus,
  IngestionDoorError,
  PullRequestSummary,
} from "./github.ts";
import {
  ClusterId,
  DisplayMode,
  FileContent,
  FilePatch,
  Journey,
  JourneyFileNotFoundError,
  JourneyId,
  JourneyNotFoundError,
  JourneyTree,
  PrRef,
  ReadState,
  ReadStateStreamEvent,
} from "./journey.ts";
import {
  IngestionJob,
  IngestionJobId,
  IngestionJobNotFoundError,
  IngestionStreamEvent,
  LocalPrState,
  OperationFailedError,
  PrStateAction,
  Settings,
} from "./productState.ts";
import { ServerConfig, ServerLifecycleStreamEvent } from "./server.ts";

export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverSubscribeLifecycle: "server.subscribeLifecycle",
  githubViewer: "github.viewer",
  githubPrs: "github.prs",
  githubSubscribePrs: "github.subscribePrs",
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
  prStateReviewed: "prState.reviewed",
  prStateHide: "prState.hide",
  prStateDismissMerged: "prState.dismissMerged",
  harnessStatus: "harness.status",
  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
} as const;

const Authorized = EnvironmentAuthorizationError;
const GitHubError = Schema.Union([GitHubUnavailableError, Authorized]);
const JourneyError = Schema.Union([JourneyNotFoundError, Authorized]);
const JourneyFileError = Schema.Union([JourneyNotFoundError, JourneyFileNotFoundError, Authorized]);

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Authorized,
});

export const WsServerSubscribeLifecycleRpc = Rpc.make(WS_METHODS.serverSubscribeLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: Authorized,
  stream: true,
});

export const WsGitHubViewerRpc = Rpc.make(WS_METHODS.githubViewer, {
  payload: Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) }),
  success: GitHubViewer,
  error: GitHubError,
});

export const WsGitHubPrsRpc = Rpc.make(WS_METHODS.githubPrs, {
  payload: Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Array(PullRequestSummary),
  error: GitHubError,
});

export const WsGitHubSubscribePrsRpc = Rpc.make(WS_METHODS.githubSubscribePrs, {
  payload: Schema.Struct({}),
  success: GitHubPrsStreamEvent,
  error: GitHubError,
  stream: true,
});

export const WsIngestionStartRpc = Rpc.make(WS_METHODS.ingestionStart, {
  payload: Schema.Union([Schema.Struct({ pr: PrRef }), Schema.Struct({ url: Schema.String })]),
  success: IngestionJob,
  error: Schema.Union([IngestionDoorError, GitHubUnavailableError, Authorized]),
});

export const WsIngestionCancelRpc = Rpc.make(WS_METHODS.ingestionCancel, {
  payload: Schema.Struct({ id: IngestionJobId }),
  error: Schema.Union([IngestionJobNotFoundError, Authorized]),
});

export const WsIngestionSubscribeRpc = Rpc.make(WS_METHODS.ingestionSubscribe, {
  payload: Schema.Struct({}),
  success: IngestionStreamEvent,
  error: Authorized,
  stream: true,
});

export const WsJourneyGetRpc = Rpc.make(WS_METHODS.journeyGet, {
  payload: Schema.Struct({ pr: PrRef }),
  success: Journey,
  error: JourneyError,
});

export const WsJourneyFilePatchRpc = Rpc.make(WS_METHODS.journeyFilePatch, {
  payload: Schema.Struct({ journeyId: JourneyId, path: Schema.String }),
  success: FilePatch,
  error: JourneyFileError,
});

export const WsJourneyFileContentRpc = Rpc.make(WS_METHODS.journeyFileContent, {
  payload: Schema.Struct({ journeyId: JourneyId, path: Schema.String }),
  success: FileContent,
  error: JourneyFileError,
});

export const WsJourneyTreeRpc = Rpc.make(WS_METHODS.journeyTree, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: JourneyTree,
  error: JourneyFileError,
});

export const WsReadStateGetRpc = Rpc.make(WS_METHODS.readStateGet, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: ReadState,
  error: JourneyError,
});

const ReadFilePayload = Schema.Struct({
  journeyId: JourneyId,
  clusterId: ClusterId,
  path: Schema.String,
});

export const WsReadStateMarkFileRpc = Rpc.make(WS_METHODS.readStateMarkFile, {
  payload: ReadFilePayload,
  success: ReadState,
  error: JourneyError,
});

export const WsReadStateUnmarkFileRpc = Rpc.make(WS_METHODS.readStateUnmarkFile, {
  payload: ReadFilePayload,
  success: ReadState,
  error: JourneyError,
});

export const WsReadStateSetDisplayModeRpc = Rpc.make(WS_METHODS.readStateSetDisplayMode, {
  payload: Schema.Struct({ journeyId: JourneyId, displayMode: DisplayMode }),
  success: ReadState,
  error: JourneyError,
});

export const WsReadStateSubscribeRpc = Rpc.make(WS_METHODS.readStateSubscribe, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: ReadStateStreamEvent,
  error: JourneyError,
  stream: true,
});

export const WsPrStateReviewedRpc = Rpc.make(WS_METHODS.prStateReviewed, {
  payload: PrStateAction,
  success: LocalPrState,
  error: Authorized,
});

export const WsPrStateHideRpc = Rpc.make(WS_METHODS.prStateHide, {
  payload: PrStateAction,
  success: LocalPrState,
  error: Authorized,
});

export const WsPrStateDismissMergedRpc = Rpc.make(WS_METHODS.prStateDismissMerged, {
  payload: PrStateAction,
  success: LocalPrState,
  error: Authorized,
});

export const WsHarnessStatusRpc = Rpc.make(WS_METHODS.harnessStatus, {
  payload: Schema.Struct({ refresh: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Array(HarnessStatus),
  error: Schema.Union([OperationFailedError, Authorized]),
});

export const WsSettingsGetRpc = Rpc.make(WS_METHODS.settingsGet, {
  payload: Schema.Struct({}),
  success: Settings,
  error: Authorized,
});

export const WsSettingsUpdateRpc = Rpc.make(WS_METHODS.settingsUpdate, {
  payload: Settings,
  success: Settings,
  error: Authorized,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerSubscribeLifecycleRpc,
  WsGitHubViewerRpc,
  WsGitHubPrsRpc,
  WsGitHubSubscribePrsRpc,
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
  WsPrStateReviewedRpc,
  WsPrStateHideRpc,
  WsPrStateDismissMergedRpc,
  WsHarnessStatusRpc,
  WsSettingsGetRpc,
  WsSettingsUpdateRpc,
);
