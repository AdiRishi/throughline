import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { PrRef, Viewer } from "./github.ts";
import {
  DoorRejection,
  IngestionStartInput,
  IngestionStartResult,
  IngestionStreamEvent,
  JobId,
} from "./ingestion.ts";
import { ClusterId, Journey, JourneyId } from "./journey.ts";
import {
  DisplayMode,
  FileContent,
  FilePatch,
  FileTreeListing,
  FileUnavailableError,
  JourneyNotFoundError,
  ReadState,
  ReadStateStreamEvent,
} from "./reading.ts";
import {
  EchoInput,
  EchoResult,
  ServerConfig,
  ServerLifecycleStreamEvent,
  TickEvent,
} from "./server.ts";
import { HarnessStatusView, Settings, SettingsUpdate } from "./settings.ts";
import { PrListStreamEvent, PrListView } from "./welcome.ts";

/**
 * String method names for every WS RPC — the single source of truth the
 * server registers handlers against and the client calls by tag.
 */
export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverEcho: "server.echo",
  serverSubscribeTicks: "server.subscribeTicks",
  serverSubscribeLifecycle: "server.subscribeLifecycle",

  githubViewer: "github.viewer",
  githubPrs: "github.prs",
  githubSubscribePrs: "github.subscribePrs",
  githubRefresh: "github.refresh",

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

const Empty = Schema.Struct({});

// ── Transport templates ─────────────────────────────────────────────────────

/** No payload; the first call after connect also serves as initial sync. */
export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Empty,
  success: ServerConfig,
  error: EnvironmentAuthorizationError,
});

/** Round-trips input → output. The template for a request/response method. */
export const WsServerEchoRpc = Rpc.make(WS_METHODS.serverEcho, {
  payload: EchoInput,
  success: EchoResult,
  error: EnvironmentAuthorizationError,
});

/** A monotonic counter. The template for a live server-push stream. */
export const WsServerSubscribeTicksRpc = Rpc.make(WS_METHODS.serverSubscribeTicks, {
  payload: Empty,
  success: TickEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** Retained-snapshot + live lifecycle events (the ordered push-bus pattern). */
export const WsServerSubscribeLifecycleRpc = Rpc.make(WS_METHODS.serverSubscribeLifecycle, {
  payload: Empty,
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── GitHub ──────────────────────────────────────────────────────────────────

/**
 * Identity behind the welcome screen. Cached for an hour by the `GitHub`
 * module; an unauthenticated `gh` is a value here, not an error.
 */
export const WsGithubViewerRpc = Rpc.make(WS_METHODS.githubViewer, {
  payload: Empty,
  success: Viewer,
  error: EnvironmentAuthorizationError,
});

/** One-shot read of the enriched PR list (served from cache within its TTL). */
export const WsGithubPrsRpc = Rpc.make(WS_METHODS.githubPrs, {
  payload: Empty,
  success: PrListView,
  error: EnvironmentAuthorizationError,
});

/**
 * The welcome screen's live view. Snapshot then live: journey progress, read
 * marks, and ingestion state change without GitHub being consulted again.
 */
export const WsGithubSubscribePrsRpc = Rpc.make(WS_METHODS.githubSubscribePrs, {
  payload: Empty,
  success: PrListStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Explicit user refresh — the only thing that bypasses the list's TTL. Nothing
 * polls; an idle Throughline issues zero requests.
 */
export const WsGithubRefreshRpc = Rpc.make(WS_METHODS.githubRefresh, {
  payload: Empty,
  success: PrListView,
  error: EnvironmentAuthorizationError,
});

// ── Ingestion ───────────────────────────────────────────────────────────────

/**
 * Door rejections are this method's *only* error channel: once a job exists,
 * everything else is reported through the job's own stream.
 */
export const WsIngestionStartRpc = Rpc.make(WS_METHODS.ingestionStart, {
  payload: IngestionStartInput,
  success: IngestionStartResult,
  error: Schema.Union([DoorRejection, EnvironmentAuthorizationError]),
});

export const WsIngestionCancelRpc = Rpc.make(WS_METHODS.ingestionCancel, {
  payload: Schema.Struct({ jobId: JobId }),
  error: EnvironmentAuthorizationError,
});

/** Watch one PR's job. Reconnect replays the snapshot; leaving costs nothing. */
export const WsIngestionSubscribeRpc = Rpc.make(WS_METHODS.ingestionSubscribe, {
  payload: Schema.Struct({ pr: PrRef }),
  success: IngestionStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── Journey (immutable per journeyId — cacheable forever client-side) ────────

export const WsJourneyGetRpc = Rpc.make(WS_METHODS.journeyGet, {
  payload: Schema.Struct({ pr: PrRef }),
  success: Schema.NullOr(Journey),
  error: EnvironmentAuthorizationError,
});

export const WsJourneyFilePatchRpc = Rpc.make(WS_METHODS.journeyFilePatch, {
  payload: Schema.Struct({ journeyId: JourneyId, path: Schema.String }),
  success: FilePatch,
  error: Schema.Union([JourneyNotFoundError, FileUnavailableError, EnvironmentAuthorizationError]),
});

/**
 * Both revisions of one file. Backs context expansion, just-the-code, and free
 * reading of any tree file — files outside the changed set are served from the
 * repository clone, re-fetched on demand if the workspace was evicted.
 */
export const WsJourneyFileContentRpc = Rpc.make(WS_METHODS.journeyFileContent, {
  payload: Schema.Struct({ journeyId: JourneyId, path: Schema.String }),
  success: FileContent,
  error: Schema.Union([JourneyNotFoundError, FileUnavailableError, EnvironmentAuthorizationError]),
});

/** The project's real file tree at the pinned head. */
export const WsJourneyTreeRpc = Rpc.make(WS_METHODS.journeyTree, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: FileTreeListing,
  error: Schema.Union([JourneyNotFoundError, EnvironmentAuthorizationError]),
});

// ── Read state ──────────────────────────────────────────────────────────────

export const WsReadStateGetRpc = Rpc.make(WS_METHODS.readStateGet, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: ReadState,
  error: EnvironmentAuthorizationError,
});

const MarkFileInput = Schema.Struct({
  journeyId: JourneyId,
  clusterId: ClusterId,
  path: Schema.String,
});

export const WsReadStateMarkFileRpc = Rpc.make(WS_METHODS.readStateMarkFile, {
  payload: MarkFileInput,
  success: ReadState,
  error: EnvironmentAuthorizationError,
});

export const WsReadStateUnmarkFileRpc = Rpc.make(WS_METHODS.readStateUnmarkFile, {
  payload: MarkFileInput,
  success: ReadState,
  error: EnvironmentAuthorizationError,
});

export const WsReadStateSetDisplayModeRpc = Rpc.make(WS_METHODS.readStateSetDisplayMode, {
  payload: Schema.Struct({ journeyId: JourneyId, mode: DisplayMode }),
  success: ReadState,
  error: EnvironmentAuthorizationError,
});

/** Multi-window consistency for free. */
export const WsReadStateSubscribeRpc = Rpc.make(WS_METHODS.readStateSubscribe, {
  payload: Schema.Struct({ journeyId: JourneyId }),
  success: ReadStateStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── Local PR marks ──────────────────────────────────────────────────────────

const PrMarkInput = Schema.Struct({ pr: PrRef, value: Schema.Boolean });

export const WsPrStateReviewedRpc = Rpc.make(WS_METHODS.prStateReviewed, {
  payload: PrMarkInput,
  error: EnvironmentAuthorizationError,
});

export const WsPrStateHideRpc = Rpc.make(WS_METHODS.prStateHide, {
  payload: PrMarkInput,
  error: EnvironmentAuthorizationError,
});

export const WsPrStateDismissMergedRpc = Rpc.make(WS_METHODS.prStateDismissMerged, {
  payload: Schema.Struct({ pr: PrRef }),
  error: EnvironmentAuthorizationError,
});

// ── Harness + settings ──────────────────────────────────────────────────────

export const WsHarnessStatusRpc = Rpc.make(WS_METHODS.harnessStatus, {
  payload: Empty,
  success: HarnessStatusView,
  error: EnvironmentAuthorizationError,
});

export const WsSettingsGetRpc = Rpc.make(WS_METHODS.settingsGet, {
  payload: Empty,
  success: Settings,
  error: EnvironmentAuthorizationError,
});

export const WsSettingsUpdateRpc = Rpc.make(WS_METHODS.settingsUpdate, {
  payload: SettingsUpdate,
  success: Settings,
  error: EnvironmentAuthorizationError,
});

/** The wire contract the server decodes against and the client is typed by. */
export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerEchoRpc,
  WsServerSubscribeTicksRpc,
  WsServerSubscribeLifecycleRpc,

  WsGithubViewerRpc,
  WsGithubPrsRpc,
  WsGithubSubscribePrsRpc,
  WsGithubRefreshRpc,

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
