import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  DoorRejection,
  PrListStreamEvent,
  PrRefInput,
  ResolveUrlInput,
  SetPrFlagInput,
  Viewer,
} from "./github.ts";
import { AppSettings, HarnessReport, UpdateSettingsInput } from "./harness.ts";
import {
  CancelIngestionInput,
  IngestionStreamEvent,
  StartIngestionInput,
  StartIngestionResult,
} from "./ingestion.ts";
import { PrRef } from "./journey.ts";
import {
  FileContent,
  FilePatch,
  JourneyEnvelope,
  JourneyFileNotFoundError,
  JourneyFileRef,
  JourneyNotFoundError,
  JourneyRef,
  JourneyTree,
} from "./journeyApi.ts";
import {
  MarkFileInput,
  ReadState,
  ReadStateRef,
  ReadStateStreamEvent,
  SetDisplayModeInput,
} from "./readState.ts";
import {
  EchoInput,
  EchoResult,
  ServerConfig,
  ServerLifecycleStreamEvent,
  TickEvent,
} from "./server.ts";

/**
 * String method names for every WS RPC — the single source of truth the
 * server registers handlers against and the client calls by tag.
 *
 * The shape follows the architecture's rule: **unary for immutable artifacts,
 * snapshot-then-live streams for anything that moves.** A journey is fetched
 * once and cached forever; a PR list, an ingestion job, and read state all move,
 * so they are streams.
 */
export const WS_METHODS = {
  serverGetConfig: "server.getConfig",
  serverEcho: "server.echo",
  serverSubscribeTicks: "server.subscribeTicks",
  serverSubscribeLifecycle: "server.subscribeLifecycle",

  githubViewer: "github.viewer",
  githubSubscribePrs: "github.subscribePrs",
  githubRefreshPrs: "github.refreshPrs",
  githubResolveUrl: "github.resolveUrl",

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

  prStateSetReviewed: "prState.setReviewed",
  prStateSetHidden: "prState.setHidden",
  prStateDismissMerged: "prState.dismissMerged",

  harnessStatus: "harness.status",

  settingsGet: "settings.get",
  settingsUpdate: "settings.update",
} as const;

// ── Transport templates (kept from the starter) ──────────────────────────────

/** No payload; the first call after connect also serves as the readiness probe. */
export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
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
  payload: Schema.Struct({}),
  success: TickEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/** Retained-snapshot + live lifecycle events (the ordered push-bus pattern). */
export const WsServerSubscribeLifecycleRpc = Rpc.make(WS_METHODS.serverSubscribeLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── GitHub ──────────────────────────────────────────────────────────────────

export const WsGithubViewerRpc = Rpc.make(WS_METHODS.githubViewer, {
  payload: Schema.Struct({}),
  success: Viewer,
  error: EnvironmentAuthorizationError,
});

/**
 * The welcome screen's whole data source. Snapshot on subscribe, then a fresh
 * snapshot whenever anything in it changes — a refresh landing, a journey being
 * committed, a local mark, an ingestion job moving.
 */
export const WsGithubSubscribePrsRpc = Rpc.make(WS_METHODS.githubSubscribePrs, {
  payload: Schema.Struct({}),
  success: PrListStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Explicit refresh — on app focus or the reviewer's request. The module enforces
 * its own minimum interval and parked state, so calling this cannot stampede;
 * nothing polls on its own.
 */
export const WsGithubRefreshPrsRpc = Rpc.make(WS_METHODS.githubRefreshPrs, {
  payload: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

/** Door validation for a pasted URL, before any job exists. */
export const WsGithubResolveUrlRpc = Rpc.make(WS_METHODS.githubResolveUrl, {
  payload: ResolveUrlInput,
  success: PrRef,
  error: Schema.Union([DoorRejection, EnvironmentAuthorizationError]),
});

// ── Ingestion ───────────────────────────────────────────────────────────────

/** Door rejections are this method's ONLY error channel; analysis never fails. */
export const WsIngestionStartRpc = Rpc.make(WS_METHODS.ingestionStart, {
  payload: StartIngestionInput,
  success: StartIngestionResult,
  error: Schema.Union([DoorRejection, EnvironmentAuthorizationError]),
});

export const WsIngestionCancelRpc = Rpc.make(WS_METHODS.ingestionCancel, {
  payload: CancelIngestionInput,
  error: EnvironmentAuthorizationError,
});

export const WsIngestionSubscribeRpc = Rpc.make(WS_METHODS.ingestionSubscribe, {
  payload: Schema.Struct({}),
  success: IngestionStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── Journey (immutable per journey — cacheable forever client-side) ──────────

export const WsJourneyGetRpc = Rpc.make(WS_METHODS.journeyGet, {
  payload: PrRefInput,
  success: JourneyEnvelope,
  error: Schema.Union([JourneyNotFoundError, EnvironmentAuthorizationError]),
});

export const WsJourneyFilePatchRpc = Rpc.make(WS_METHODS.journeyFilePatch, {
  payload: JourneyFileRef,
  success: FilePatch,
  error: Schema.Union([
    JourneyFileNotFoundError,
    JourneyNotFoundError,
    EnvironmentAuthorizationError,
  ]),
});

/**
 * Full old/new contents. Serves context expansion, just-the-code, and free
 * reading of files outside the changed set (re-fetched from the clone on demand).
 */
export const WsJourneyFileContentRpc = Rpc.make(WS_METHODS.journeyFileContent, {
  payload: JourneyFileRef,
  success: FileContent,
  error: Schema.Union([
    JourneyFileNotFoundError,
    JourneyNotFoundError,
    EnvironmentAuthorizationError,
  ]),
});

export const WsJourneyTreeRpc = Rpc.make(WS_METHODS.journeyTree, {
  payload: JourneyRef,
  success: JourneyTree,
  error: Schema.Union([JourneyNotFoundError, EnvironmentAuthorizationError]),
});

// ── Read state ──────────────────────────────────────────────────────────────

export const WsReadStateGetRpc = Rpc.make(WS_METHODS.readStateGet, {
  payload: ReadStateRef,
  success: ReadState,
  error: EnvironmentAuthorizationError,
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
  payload: SetDisplayModeInput,
  success: ReadState,
  error: EnvironmentAuthorizationError,
});

/** Multi-window consistency for free: one read state, every window folded on it. */
export const WsReadStateSubscribeRpc = Rpc.make(WS_METHODS.readStateSubscribe, {
  payload: ReadStateRef,
  success: ReadStateStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

// ── Local PR marks ──────────────────────────────────────────────────────────

export const WsPrStateSetReviewedRpc = Rpc.make(WS_METHODS.prStateSetReviewed, {
  payload: SetPrFlagInput,
  error: EnvironmentAuthorizationError,
});

export const WsPrStateSetHiddenRpc = Rpc.make(WS_METHODS.prStateSetHidden, {
  payload: SetPrFlagInput,
  error: EnvironmentAuthorizationError,
});

export const WsPrStateDismissMergedRpc = Rpc.make(WS_METHODS.prStateDismissMerged, {
  payload: PrRefInput,
  error: EnvironmentAuthorizationError,
});

// ── Harness + settings ──────────────────────────────────────────────────────

export const WsHarnessStatusRpc = Rpc.make(WS_METHODS.harnessStatus, {
  payload: Schema.Struct({}),
  success: HarnessReport,
  error: EnvironmentAuthorizationError,
});

export const WsSettingsGetRpc = Rpc.make(WS_METHODS.settingsGet, {
  payload: Schema.Struct({}),
  success: AppSettings,
  error: EnvironmentAuthorizationError,
});

export const WsSettingsUpdateRpc = Rpc.make(WS_METHODS.settingsUpdate, {
  payload: UpdateSettingsInput,
  success: AppSettings,
  error: EnvironmentAuthorizationError,
});

/** The wire contract the server decodes against and the client is typed by. */
export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerEchoRpc,
  WsServerSubscribeTicksRpc,
  WsServerSubscribeLifecycleRpc,

  WsGithubViewerRpc,
  WsGithubSubscribePrsRpc,
  WsGithubRefreshPrsRpc,
  WsGithubResolveUrlRpc,

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

  WsPrStateSetReviewedRpc,
  WsPrStateSetHiddenRpc,
  WsPrStateDismissMergedRpc,

  WsHarnessStatusRpc,

  WsSettingsGetRpc,
  WsSettingsUpdateRpc,
);
