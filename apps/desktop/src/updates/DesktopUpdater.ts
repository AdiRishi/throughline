import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  DesktopUpdateChannel,
  type DesktopRuntimeInfo,
  type DesktopUpdateActionResult,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@app/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const INSTALL_BACKEND_STOP_TIMEOUT = Duration.seconds(5);

const { logInfo, logError } = makeComponentLogger("desktop-updater");

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});

const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

type DesktopUpdateAction = "check" | "download" | "install";

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install"]),
    requestedChannel: DesktopUpdateChannel,
  },
) {
  override get message(): string {
    return `Cannot change the desktop update channel to ${this.requestedChannel} while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannel,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist the ${this.channel} desktop update channel.`;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.action} action failed unexpectedly.`;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop update ${this.poller} poller failed.`;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to handle desktop update ${this.event} event.`;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop updater ${this.operation} operation reported an error.`;
  }
}

// electron-updater emits `download-progress` per received chunk, so a fast link
// would flood the IPC channel without this bucketing.
export function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

/**
 * Why automatic updates are off, or `null` when they are on. Ordered from the
 * most fundamental cause to the most specific so the message a user sees names
 * the thing they could actually act on.
 */
export function getAutoUpdateDisabledReason(args: {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform | DesktopAppInfoPlatform;
  readonly appImage: string | undefined;
  readonly disabledByEnv: boolean;
  readonly hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the APP_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

type DesktopAppInfoPlatform = "darwin" | "win32" | "linux";

/**
 * electron-updater's delta downloads are computed against the currently
 * installed package. An x64 build on an arm64 host is about to be replaced by
 * an arm64 package, so there is no valid delta base and the differential
 * fetch must be skipped.
 */
export function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@app/desktop/updates/DesktopUpdater") {}

// electron-builder writes `app-update.yml` only when the build had a `publish`
// config, but an incomplete one is still a file. Reading `provider` out of it is
// what distinguishes "there is a feed" from "there is a stub": electron-updater
// throws "Please define publish configuration" at check time for the latter.
function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.orElseSucceed(() => Option.none<AppUpdateYmlConfig>()),
  );
}

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const desktopState = yield* DesktopState.DesktopState;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const fileSystem = yield* FileSystem.FileSystem;

  const appUpdateYmlConfigRef = yield* Ref.make(Option.none<AppUpdateYmlConfig>());
  // Distinct from "enabled": the updater is only *configured* once `configure`
  // has attached its listeners and applied the channel. Every action refuses
  // until then, because driving electron-updater before that point produces
  // events nothing is listening for.
  const updaterConfiguredRef = yield* Ref.make(false);
  const persisted = yield* settings.get;
  const stateRef = yield* Ref.make<DesktopUpdateState>(
    createBaseUpdateState(persisted.updateChannel, false, environment),
  );
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);

  const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
  const runFork = Effect.runForkWith(context);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    Ref.set(stateRef, state).pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  // electron-updater's `channel` alone does not select prereleases for the
  // GitHub/generic providers — `allowPrerelease` does, and a nightly build only
  // gets back to a `latest` release when downgrades are allowed too.
  const applyAutoUpdaterChannel = Effect.fn("desktop.updater.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* electronUpdater.setFullChangelog(allowsPrerelease);
    yield* logInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
      fullChangelog: allowsPrerelease,
    });
  });

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(Effect.map(Option.isSome));

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(environment.appImagePath),
        disabledByEnv: environment.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const actionInFlightRef = yield* Ref.make(Option.none<DesktopUpdateAction>());

  const claimAction = (action: DesktopUpdateAction) =>
    Ref.modify(actionInFlightRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some<DesktopUpdateAction>(action)] as const),
    );
  const releaseAction = Ref.set(actionInFlightRef, Option.none<DesktopUpdateAction>());

  /**
   * Returns whether a check actually ran. Refusals are ordinary — a poll that
   * lands mid-download, a check before `configure`, a check while quitting —
   * and the caller needs to tell them apart from "checked and found nothing".
   */
  const checkForUpdates = Effect.fn("desktop.updater.checkForUpdates")(function* (reason: string) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;

    // A poll that lands while an update is being fetched (or is waiting to be
    // installed) would reset the state and lose the downloaded version.
    const state = yield* Ref.get(stateRef);
    if (state.status === "downloading" || state.status === "downloaded") {
      yield* logInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    if (!(yield* claimAction("check"))) return false;

    const checkedAt = yield* currentIsoTimestamp;
    yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    yield* logInfo("checking for updates", { reason });

    return yield* electronUpdater.checkForUpdates.pipe(
      Effect.as(true),
      Effect.catchTags({
        ElectronUpdaterCheckForUpdatesError: Effect.fn("desktop.updater.handleCheckFailure")(
          function* (error) {
            const failedAt = yield* currentIsoTimestamp;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
            );
            yield* logError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              operation: "check",
            });
            return true;
          },
        ),
      }),
      Effect.ensuring(releaseAction),
    );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    // Downloading is only meaningful against an update we have been told
    // exists. Without this guard a renderer can drive electron-updater with no
    // update info and park the state in `downloading` forever.
    if (!(yield* Ref.get(updaterConfiguredRef)) || state.status !== "available") {
      return { accepted: false, completed: false };
    }
    if (!(yield* claimAction("download"))) {
      return { accepted: false, completed: false };
    }

    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logInfo("downloading update");
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterDownloadUpdateError: Effect.fn("desktop.updater.handleDownloadFailure")(
          function* (error) {
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
            );
            yield* logError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              operation: "download",
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      // An interrupted download never reached a terminal event, so the
      // `downloading` state would otherwise stick with no driver behind it.
      Effect.onInterrupt(() =>
        updateState((current) => (current.status === "downloading" ? state : current)).pipe(
          Effect.asVoid,
        ),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = new DesktopUpdateUnexpectedActionError({ action: "download", cause });
        return Effect.gen(function* () {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logError(error.message, { errorTag: error._tag, action: error.action });
          return { accepted: true, completed: false };
        });
      }),
      Effect.ensuring(releaseAction),
    );
  }).pipe(Effect.withSpan("desktop.updater.downloadAvailableUpdate"));

  const resetInstallAction = Effect.all([releaseAction, Ref.set(desktopState.quitting, false)], {
    discard: true,
  });

  const installDownloadedUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    // Nothing below this line is reversible: it stops the backend, destroys
    // every window and asks Electron to quit. Refuse unless an update is
    // actually staged, or a mistimed renderer call takes the app down with no
    // update to show for it.
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(updaterConfiguredRef)) ||
      state.status !== "downloaded"
    ) {
      return { accepted: false, completed: false };
    }
    if (!(yield* claimAction("install"))) {
      return { accepted: false, completed: false };
    }
    yield* Ref.set(desktopState.quitting, true);

    return yield* Effect.gen(function* () {
      // Stop the backend child first: quitAndInstall's app.quit() exits
      // before the run scope's stop finalizer has a chance to run, so the
      // child would be hard-killed by the OS instead of receiving SIGTERM
      // + grace.
      yield* backendManager
        .stop({ timeout: INSTALL_BACKEND_STOP_TIMEOUT })
        .pipe(Effect.timeout(INSTALL_BACKEND_STOP_TIMEOUT), Effect.ignore());
      yield* electronWindow.destroyAll;
      yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
      // Never `completed`: a successful install quits this process, so the only
      // way to reach a return value here is the install not having happened yet.
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catchTags({
        ElectronUpdaterQuitAndInstallError: Effect.fn("desktop.updater.handleInstallFailure")(
          function* (error) {
            yield* resetInstallAction;
            yield* updateState((current) =>
              reduceDesktopUpdateStateOnInstallFailure(current, error.message),
            );
            yield* logError(error.message, {
              errorTag: error._tag,
              channel: error.channel,
              isSilent: error.isSilent,
              isForceRunAfter: error.isForceRunAfter,
              operation: "install",
            });
            return { accepted: true, completed: false };
          },
        ),
      }),
      Effect.onInterrupt(() => resetInstallAction),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          if (Cause.hasInterruptsOnly(cause)) {
            return yield* Effect.failCause(cause);
          }
          yield* resetInstallAction;
          const error = new DesktopUpdateUnexpectedActionError({ action: "install", cause });
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnInstallFailure(current, error.message),
          );
          yield* logError(error.message, { errorTag: error._tag, action: error.action });
          return { accepted: true, completed: false };
        }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.updater.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "startup", cause });
        return logError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdatePollerError({ poller: "poll", cause });
        return logError(error.message, {
          errorTag: error._tag,
          poller: error.poller,
        });
      }),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updater.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updater.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updater.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(stateRef);
          // The GitHub and generic providers will happily offer a release from
          // the other channel. Taking it would move the user across channels
          // without them asking, so treat it as "no update" instead.
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const ignoredAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, ignoredAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(state, info.version, checkedAt),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logInfo("update available", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-available", cause });
        return logError(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    yield* updateState((state) => reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updater.handleUpdateNotAvailable"));

  const handleDownloadProgress = Effect.fn("desktop.updater.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updater.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(stateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "download-progress", cause });
        return logError(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updater.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updater.applyUpdateDownloaded")(function* (info) {
          yield* updateState((state) =>
            reduceDesktopUpdateStateOnDownloadComplete(state, info.version),
          );
          yield* logInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.void;
        }
        const error = new DesktopUpdateEventHandlingError({ event: "update-downloaded", cause });
        return logError(error.message, {
          errorTag: error._tag,
          event: error.event,
        });
      }),
    );
  });

  // An error raised during a check or download is already folded into the state
  // by that action's own failure path, so only background errors land here.
  const handleUpdaterError = Effect.fn("desktop.updater.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* Ref.get(actionInFlightRef);
    const error = new DesktopUpdaterReportedError({
      operation: Option.getOrElse(activeAction, () => "background" as const),
      cause,
    });

    if (Option.isNone(activeAction)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message: error.message,
        checkedAt,
        downloadPercent: null,
        errorContext: current.errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    } else if (activeAction.value === "install") {
      // The install never got far enough to quit, so hand the app back: clear
      // `quitting` or the window-all-closed handler will shut it down anyway.
      yield* resetInstallAction;
      yield* updateState((current) =>
        reduceDesktopUpdateStateOnInstallFailure(current, error.message),
      );
    }

    yield* logError(error.message, {
      errorTag: error._tag,
      operation: error.operation,
    });
  });

  return DesktopUpdater.of({
    getState: Ref.get(stateRef),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      const current = yield* settings.get;
      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(current.updateChannel, enabled, environment));
      if (!enabled) {
        const reason = yield* resolveDisabledReason;
        yield* logInfo(Option.getOrElse(reason, () => "updater disabled"));
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(current.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runFork(logInfo("looking for updates"));
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runFork(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runFork(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runFork(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runFork(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runFork(handleUpdateDownloaded(info));
      });

      yield* logInfo("updater configured", { channel: current.updateChannel });
      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updater.configure")),
    setChannel: Effect.fn("desktop.updater.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      // Switching mid-download/install would leave the driver and the
      // persisted channel disagreeing about what is being fetched.
      const activeAction = yield* Ref.get(actionInFlightRef);
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({
          action: activeAction.value,
          requestedChannel: nextChannel,
        });
      }

      const state = yield* Ref.get(stateRef);
      if (nextChannel === state.channel) {
        return state;
      }

      // A settings write that fails is the user's problem to see, not a defect
      // to die on: the channel simply did not change.
      yield* settings
        .setUpdateChannel(nextChannel)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopUpdateChannelPersistenceError({ channel: nextChannel, cause }),
          ),
        );

      const enabled = yield* shouldEnableAutoUpdates;
      // Reset rather than patch the channel in: anything discovered on the old
      // channel (an available version, a download percent, an error) describes
      // a release the user just walked away from.
      yield* setState(createBaseUpdateState(nextChannel, enabled, environment));

      if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
        return yield* Ref.get(stateRef);
      }

      yield* applyAutoUpdaterChannel(nextChannel);
      // Moving nightly -> latest is a downgrade in version terms, and the
      // provider will not offer it unless downgrades are allowed. Force it on
      // for this one check, then restore whatever the channel implies.
      const allowDowngrade = yield* electronUpdater.allowDowngrade;
      yield* electronUpdater.setAllowDowngrade(true);
      yield* checkForUpdates("channel-change").pipe(
        Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore())),
      );
      return yield* Ref.get(stateRef);
    }),
    check: Effect.fn("desktop.updater.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      const checked = yield* checkForUpdates(reason);
      return { checked, state: yield* Ref.get(stateRef) };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return { ...result, state: yield* Ref.get(stateRef) };
    }).pipe(Effect.withSpan("desktop.updater.download")),
    install: Effect.gen(function* () {
      const result = yield* installDownloadedUpdate;
      return { ...result, state: yield* Ref.get(stateRef) };
    }).pipe(Effect.withSpan("desktop.updater.install")),
  });
});

export const layer = Layer.effect(DesktopUpdater, make);
