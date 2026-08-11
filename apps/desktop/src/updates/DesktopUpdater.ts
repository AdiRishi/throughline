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

import { DesktopUpdateChannel, type DesktopUpdateState } from "@app/contracts";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
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

const UpdateInfo = Schema.Struct({
  version: Schema.String,
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});

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

export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateActionInProgressError>;
    readonly check: Effect.Effect<void>;
    readonly download: Effect.Effect<void>;
    readonly install: Effect.Effect<void>;
  }
>()("@app/desktop/updates/DesktopUpdater") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const fileSystem = yield* FileSystem.FileSystem;

  // electron-builder only writes `app-update.yml` when the build had a `publish`
  // config, and electron-updater throws "Please define publish configuration"
  // at check time without a feed. Stay visibly disabled instead.
  const hasUpdateFeedConfig = yield* fileSystem
    .exists(environment.appUpdateYmlPath)
    .pipe(Effect.orElseSucceed(() => false));
  const enabled = environment.isPackaged && hasUpdateFeedConfig;
  const persisted = yield* settings.get;
  const stateRef = yield* Ref.make<DesktopUpdateState>({
    ...createInitialDesktopUpdateState(environment.appVersion, persisted.updateChannel),
    enabled,
    status: enabled ? "idle" : "disabled",
  });
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

  const actionInFlightRef = yield* Ref.make(Option.none<DesktopUpdateAction>());

  const claimAction = (action: DesktopUpdateAction) =>
    Ref.modify(actionInFlightRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some<DesktopUpdateAction>(action)] as const),
    );
  const releaseAction = Ref.set(actionInFlightRef, Option.none<DesktopUpdateAction>());

  const runAction = (
    action: DesktopUpdateAction,
    start: Effect.Effect<void>,
    driver: Effect.Effect<void, { readonly message: string }>,
    onFailure: (message: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      if (!(yield* claimAction(action))) {
        return;
      }
      yield* start.pipe(
        Effect.andThen(driver),
        Effect.catch((error) => onFailure(error.message)),
        Effect.asVoid,
        Effect.ensuring(releaseAction),
      );
    });

  const beginCheck = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    yield* updateState((state) => reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    yield* logInfo("checking for updates");
  });

  const failCheck = (message: string) =>
    Effect.gen(function* () {
      const failedAt = yield* currentIsoTimestamp;
      yield* updateState((state) =>
        reduceDesktopUpdateStateOnCheckFailure(state, message, failedAt),
      );
      yield* logError(message, { operation: "check" });
    });

  const checkForUpdates = Effect.gen(function* () {
    // A poll that lands while an update is being fetched (or is waiting to be
    // installed) would reset the state and lose the downloaded version.
    const state = yield* Ref.get(stateRef);
    if (state.status === "downloading" || state.status === "downloaded") {
      yield* logInfo("skipping update check while update is active", { status: state.status });
      return;
    }
    yield* runAction("check", beginCheck, electronUpdater.checkForUpdates, failCheck);
  }).pipe(Effect.withSpan("desktop.updater.check"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates),
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
      Effect.andThen(checkForUpdates),
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
          const checkedAt = yield* currentIsoTimestamp;
          yield* updateState((state) =>
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
    configure: enabled
      ? Effect.gen(function* () {
          yield* electronUpdater.setAutoDownload(false);
          yield* electronUpdater.setAutoInstallOnAppQuit(false);
          yield* applyAutoUpdaterChannel(persisted.updateChannel);

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

          yield* logInfo("updater configured", { channel: persisted.updateChannel });
          yield* startUpdatePollers;
        }).pipe(Effect.withSpan("desktop.updater.configure"))
      : logInfo(
          environment.isPackaged
            ? "updater disabled (no app-update.yml: the build had no publish config)"
            : "updater disabled (app is not packaged)",
        ),
    getState: Ref.get(stateRef),
    setChannel: (channel) =>
      Effect.gen(function* () {
        // Switching mid-download/install would leave the driver and the
        // persisted channel disagreeing about what is being fetched.
        const activeAction = yield* Ref.get(actionInFlightRef);
        if (Option.isSome(activeAction)) {
          return yield* new DesktopUpdateActionInProgressError({
            action: activeAction.value,
            requestedChannel: channel,
          });
        }
        yield* settings.setUpdateChannel(channel).pipe(Effect.orDie);
        if (enabled) {
          yield* applyAutoUpdaterChannel(channel);
        }
        return yield* updateState((current) => ({ ...current, channel }));
      }).pipe(
        Effect.withSpan("desktop.updater.setChannel", {
          attributes: { channel },
        }),
      ),
    check: enabled ? checkForUpdates : Effect.void.pipe(Effect.withSpan("desktop.updater.check")),
    download: enabled
      ? runAction(
          "download",
          updateState(reduceDesktopUpdateStateOnDownloadStart).pipe(
            Effect.andThen(logInfo("downloading update")),
          ),
          electronUpdater.downloadUpdate,
          (message) =>
            updateState((state) => reduceDesktopUpdateStateOnDownloadFailure(state, message)).pipe(
              Effect.andThen(logError(message, { operation: "download" })),
            ),
        ).pipe(Effect.withSpan("desktop.updater.download"))
      : Effect.void.pipe(Effect.withSpan("desktop.updater.download")),
    install: enabled
      ? Effect.gen(function* () {
          if (!(yield* claimAction("install"))) {
            return;
          }
          yield* Effect.gen(function* () {
            // Stop the backend child first: quitAndInstall's app.quit() exits
            // before the run scope's stop finalizer has a chance to run, so the
            // child would be hard-killed by the OS instead of receiving SIGTERM
            // + grace.
            yield* backendManager.stop.pipe(
              Effect.timeout(INSTALL_BACKEND_STOP_TIMEOUT),
              Effect.ignore(),
            );
            yield* electronWindow.destroyAll;
            yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
          }).pipe(
            Effect.catch((error) =>
              updateState((state) =>
                reduceDesktopUpdateStateOnInstallFailure(state, error.message),
              ).pipe(Effect.andThen(logError(error.message, { operation: "install" }))),
            ),
            Effect.asVoid,
            Effect.ensuring(releaseAction),
          );
        }).pipe(Effect.withSpan("desktop.updater.install"))
      : Effect.void.pipe(Effect.withSpan("desktop.updater.install")),
  });
});

export const layer = Layer.effect(DesktopUpdater, make);
