import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  type DesktopUpdateActionResult,
  DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@app/contracts";
import { safeDiagnosticErrorType, sanitizeDiagnosticText } from "@app/shared/safeLog";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { UPDATE_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
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

const { logInfo, logWarning } = makeComponentLogger("desktop-updater");

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";

type DesktopUpdateAction = "check" | "download" | "install";

const USER_MESSAGES = {
  check: "Throughline could not check for updates. Try again.",
  download: "Throughline could not download the update. Try again.",
  install: "Throughline could not install the downloaded update. Try again.",
  unexpected: "Throughline's updater encountered an unexpected error. Try again.",
  noFeed: "Automatic updates are unavailable because no update feed is configured.",
  notPackaged: "Automatic updates are only available in packaged production builds.",
  linuxAppImage: "Automatic updates on Linux require running the AppImage build.",
} as const;

const UpdateInfo = Schema.Struct({
  version: Schema.String,
  releaseNotes: Schema.optional(Schema.Unknown),
});
const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);
const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Schema.TaggedErrorClass<DesktopUpdateActionInProgressError>()(
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

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedErrorClass<DesktopUpdateChannelPersistenceError>()(
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

export class DesktopUpdater extends Context.Service<
  DesktopUpdater,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
    ) => Effect.Effect<
      DesktopUpdateState,
      DesktopUpdateActionInProgressError | DesktopUpdateChannelPersistenceError
    >;
    readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
  }
>()("@app/desktop/updates/DesktopUpdater") {}

function hasUpdateFeedConfig(raw: string): boolean {
  for (const line of raw.split(/\r?\n/u)) {
    const match = line.match(/^\s*provider:\s*(.+?)\s*$/u);
    const provider = match?.[1]?.replace(/^(['"])(.*)\1$/u, "$2").trim();
    if (provider && provider !== "null" && provider !== "~") {
      return true;
    }
  }
  return false;
}

function createBaseState(
  currentVersion: string,
  channel: DesktopUpdateState["channel"],
  enabled: boolean,
  disabledMessage: string | null,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(currentVersion, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
    message: enabled ? null : disabledMessage,
  };
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading" || currentState.downloadPercent === null) {
    return true;
  }
  return (
    Math.floor(currentState.downloadPercent / 10) !== Math.floor(nextPercent / 10) ||
    nextPercent === 100
  );
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const manager = yield* DesktopBackendManager.DesktopBackendManager;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const fileSystem = yield* FileSystem.FileSystem;

  const feedConfigured = yield* fileSystem
    .readFileString(environment.appUpdateYmlPath, "utf-8")
    .pipe(
      Effect.map(hasUpdateFeedConfig),
      Effect.orElseSucceed(() => false),
    );
  const platformSupportsUpdates =
    environment.platform !== "linux" || Option.isSome(environment.appImagePath);
  const enabled = environment.isPackaged && feedConfigured && platformSupportsUpdates;
  const disabledMessage = !feedConfigured
    ? USER_MESSAGES.noFeed
    : !environment.isPackaged
      ? USER_MESSAGES.notPackaged
      : !platformSupportsUpdates
        ? USER_MESSAGES.linuxAppImage
        : null;
  const stateRef = yield* Ref.make<DesktopUpdateState>(
    createBaseState(
      environment.appVersion,
      environment.defaultDesktopSettings.updateChannel,
      enabled,
      disabledMessage,
    ),
  );
  const actionInFlightRef = yield* Ref.make(Option.none<DesktopUpdateAction>());
  const configuredRef = yield* Ref.make(false);
  const installHostNeedsRecoveryRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const callbackAnnotationsRef = yield* Ref.make<Record<string, unknown>>({});
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const emitState = Ref.get(stateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState) =>
    Ref.set(stateRef, state).pipe(Effect.andThen(emitState), Effect.as(state));

  const updateState = (update: (state: DesktopUpdateState) => DesktopUpdateState) =>
    Ref.get(stateRef).pipe(Effect.flatMap((state) => setState(update(state))));

  const restoreStateWhile = (
    status: DesktopUpdateState["status"],
    state: DesktopUpdateState,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const restored = yield* Ref.modify(stateRef, (current) =>
        current.status === status
          ? ([Option.some(state), state] as const)
          : ([Option.none<DesktopUpdateState>(), current] as const),
      );
      if (Option.isSome(restored)) {
        yield* electronWindow.sendAll(UPDATE_STATE_CHANNEL, restored.value);
      }
    });

  const claimAction = (action: DesktopUpdateAction) =>
    Ref.modify(actionInFlightRef, (current) =>
      Option.isSome(current)
        ? ([false, current] as const)
        : ([true, Option.some<DesktopUpdateAction>(action)] as const),
    );
  const releaseAction = Ref.set(actionInFlightRef, Option.none<DesktopUpdateAction>());

  const logActionFailure = (action: DesktopUpdateAction, cause: unknown) =>
    logWarning("updater action failed", {
      action,
      errorType: safeDiagnosticErrorType(cause),
      cause: sanitizeDiagnosticText(
        Cause.isCause(cause) ? Cause.pretty(cause) : String(cause),
        2_048,
      ),
    });

  const recoverInstallHost = Effect.gen(function* () {
    yield* Ref.set(desktopState.quitting, false);
    if (yield* Ref.getAndSet(installHostNeedsRecoveryRef, false)) {
      yield* manager.start;
    }
  });

  const configureChannel = Effect.fn("desktop.updater.configureChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
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

  const handleUpdaterError = Effect.fn("desktop.updater.handleUpdaterError")(function* (
    cause: unknown,
  ) {
    const activeAction = yield* Ref.get(actionInFlightRef);
    const installHostNeedsRecovery = yield* Ref.get(installHostNeedsRecoveryRef);
    yield* logWarning("updater reported an error", {
      errorType: safeDiagnosticErrorType(cause),
      cause: sanitizeDiagnosticText(String(cause), 2_048),
    });

    if (
      installHostNeedsRecovery ||
      (Option.isSome(activeAction) && activeAction.value === "install")
    ) {
      yield* recoverInstallHost;
      yield* releaseAction;
      yield* updateState((state) =>
        reduceDesktopUpdateStateOnInstallFailure(state, USER_MESSAGES.install),
      );
      return;
    }

    if (Option.isSome(activeAction)) {
      return;
    }

    if (yield* Ref.get(configuredRef)) {
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((state) => ({
        ...state,
        status:
          state.downloadedVersion !== null
            ? "downloaded"
            : state.availableVersion !== null
              ? "available"
              : "error",
        checkedAt,
        message: USER_MESSAGES.unexpected,
        errorContext: null,
        downloadPercent: null,
        canRetry: state.availableVersion !== null || state.downloadedVersion !== null,
      }));
    }
  });

  if (enabled) {
    yield* electronUpdater.on("checking-for-update", () => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            logInfo("looking for updates").pipe(Effect.annotateLogs(annotations)),
          ),
        ),
      );
    });
    yield* electronUpdater.on("update-available", (raw: unknown) => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            decodeUpdateInfo(raw).pipe(
              Effect.flatMap((info) =>
                Effect.gen(function* () {
                  const state = yield* Ref.get(stateRef);
                  const checkedAt = yield* currentIsoTimestamp;
                  if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
                    yield* logInfo("ignored update that does not match selected channel", {
                      version: info.version,
                      channel: state.channel,
                    });
                    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
                    return;
                  }
                  const releaseNotes = normalizeDesktopUpdateReleaseNotes(
                    info.releaseNotes,
                    info.version,
                  );
                  yield* setState(
                    reduceDesktopUpdateStateOnUpdateAvailable(
                      state,
                      info.version,
                      checkedAt,
                      releaseNotes,
                    ),
                  );
                  yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
                  yield* logInfo("update available", {
                    version: info.version,
                    releaseNoteGroups: releaseNotes.length,
                  });
                }),
              ),
              Effect.catchCause((cause) =>
                logWarning("ignored malformed update-available event", {
                  errorType: safeDiagnosticErrorType(Cause.squash(cause)),
                }),
              ),
              Effect.annotateLogs(annotations),
            ),
          ),
        ),
      );
    });
    yield* electronUpdater.on("update-not-available", () => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef);
              const checkedAt = yield* currentIsoTimestamp;
              yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
              yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
              yield* logInfo("no updates available");
            }).pipe(Effect.annotateLogs(annotations)),
          ),
        ),
      );
    });
    yield* electronUpdater.on("download-progress", (raw: unknown) => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            decodeDownloadProgressInfo(raw).pipe(
              Effect.flatMap((progress) =>
                Effect.gen(function* () {
                  const state = yield* Ref.get(stateRef);
                  const percent = Math.max(0, Math.min(100, progress.percent));
                  if (shouldBroadcastDownloadProgress(state, percent) || state.message !== null) {
                    yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, percent));
                  }
                  const milestone = Math.floor(percent / 10) * 10;
                  const previousMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
                  if (milestone > previousMilestone) {
                    yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
                    yield* logInfo("download progress", { percent: Math.floor(percent) });
                  }
                }),
              ),
              Effect.catchCause((cause) =>
                logWarning("ignored malformed download-progress event", {
                  errorType: safeDiagnosticErrorType(Cause.squash(cause)),
                }),
              ),
              Effect.annotateLogs(annotations),
            ),
          ),
        ),
      );
    });
    yield* electronUpdater.on("update-downloaded", (raw: unknown) => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            decodeUpdateInfo(raw).pipe(
              Effect.flatMap((info) =>
                updateState((state) =>
                  reduceDesktopUpdateStateOnDownloadComplete(state, info.version),
                ).pipe(Effect.andThen(logInfo("update downloaded", { version: info.version }))),
              ),
              Effect.catchCause((cause) =>
                logWarning("ignored malformed update-downloaded event", {
                  errorType: safeDiagnosticErrorType(Cause.squash(cause)),
                }),
              ),
              Effect.annotateLogs(annotations),
            ),
          ),
        ),
      );
    });
    yield* electronUpdater.on("error", (cause: unknown) => {
      runFork(
        Ref.get(callbackAnnotationsRef).pipe(
          Effect.flatMap((annotations) =>
            handleUpdaterError(cause).pipe(Effect.annotateLogs(annotations)),
          ),
        ),
      );
    });
  }

  const checkForUpdates = Effect.fn("desktop.updater.checkForUpdates")(function* (
    reason: string,
  ): Effect.fn.Return<DesktopUpdateCheckResult> {
    yield* Effect.annotateCurrentSpan({ reason });
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(configuredRef)) ||
      !(yield* claimAction("check"))
    ) {
      return { checked: false, state: yield* Ref.get(stateRef) };
    }

    return yield* Effect.gen(function* () {
      const previous = yield* Ref.get(stateRef);
      if (previous.status === "downloading" || previous.status === "downloaded") {
        return { checked: false, state: previous };
      }

      const checkedAt = yield* currentIsoTimestamp;
      yield* setState(reduceDesktopUpdateStateOnCheckStart(previous, checkedAt));
      yield* logInfo("checking for updates", { reason });
      yield* electronUpdater.checkForUpdates.pipe(
        Effect.onInterrupt(() => restoreStateWhile("checking", previous)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          return Effect.gen(function* () {
            const failedAt = yield* currentIsoTimestamp;
            yield* logActionFailure("check", cause);
            yield* updateState((state) =>
              reduceDesktopUpdateStateOnCheckFailure(state, USER_MESSAGES.check, failedAt),
            );
          });
        }),
      );
      return { checked: true, state: yield* Ref.get(stateRef) };
    }).pipe(Effect.ensuring(releaseAction));
  });

  const download = Effect.gen(function* (): Effect.fn.Return<DesktopUpdateActionResult> {
    if (!(yield* Ref.get(configuredRef)) || !(yield* claimAction("download"))) {
      return { accepted: false, completed: false, state: yield* Ref.get(stateRef) };
    }
    const previous = yield* Ref.get(stateRef);
    if (previous.status !== "available") {
      yield* releaseAction;
      return { accepted: false, completed: false, state: previous };
    }

    yield* setState(reduceDesktopUpdateStateOnDownloadStart(previous));
    const completed = yield* electronUpdater.downloadUpdate.pipe(
      Effect.as(true),
      Effect.onInterrupt(() => restoreStateWhile("downloading", previous)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return logActionFailure("download", cause).pipe(
          Effect.andThen(
            updateState((state) =>
              reduceDesktopUpdateStateOnDownloadFailure(state, USER_MESSAGES.download),
            ),
          ),
          Effect.as(false),
        );
      }),
      Effect.ensuring(releaseAction),
    );
    return { accepted: true, completed, state: yield* Ref.get(stateRef) };
  }).pipe(Effect.withSpan("desktop.updater.download"));

  const install = Effect.gen(function* (): Effect.fn.Return<DesktopUpdateActionResult> {
    if (!(yield* Ref.get(configuredRef)) || !(yield* claimAction("install"))) {
      return { accepted: false, completed: false, state: yield* Ref.get(stateRef) };
    }
    const previous = yield* Ref.get(stateRef);
    if (previous.status !== "downloaded" || (yield* Ref.get(desktopState.quitting))) {
      yield* releaseAction;
      return { accepted: false, completed: false, state: previous };
    }

    const resetInstall = recoverInstallHost.pipe(
      Effect.andThen(restoreStateWhile("downloaded", previous)),
    );
    yield* Ref.set(desktopState.quitting, true);
    yield* Ref.set(installHostNeedsRecoveryRef, true);
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* desktopWindow.flushMainWindowBounds;
        yield* manager.stop;
        yield* electronWindow.destroyAll;
        yield* restore(electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true }));
      }),
    ).pipe(
      Effect.onInterrupt(() => resetInstall),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return logActionFailure("install", cause).pipe(
          Effect.andThen(recoverInstallHost),
          Effect.andThen(
            updateState((state) =>
              reduceDesktopUpdateStateOnInstallFailure(state, USER_MESSAGES.install),
            ),
          ),
          Effect.asVoid,
        );
      }),
      Effect.ensuring(releaseAction),
    );
    return { accepted: true, completed: false, state: yield* Ref.get(stateRef) };
  }).pipe(Effect.withSpan("desktop.updater.install"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : logWarning("updater startup poller failed", {
              errorType: safeDiagnosticErrorType(Cause.squash(cause)),
            }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : logWarning("updater periodic poll failed", {
              errorType: safeDiagnosticErrorType(Cause.squash(cause)),
            }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }).pipe(Effect.asVoid);

  return DesktopUpdater.of({
    configure: Effect.gen(function* () {
      yield* Ref.set(callbackAnnotationsRef, yield* References.CurrentLogAnnotations);
      const loadedSettings = yield* settings.get;
      yield* setState(
        createBaseState(
          environment.appVersion,
          loadedSettings.updateChannel,
          enabled,
          disabledMessage,
        ),
      );
      if (!enabled) {
        yield* logInfo("updater disabled", {
          reason: disabledMessage ?? USER_MESSAGES.noFeed,
        });
        return;
      }

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* configureChannel(loadedSettings.updateChannel);
      yield* Ref.set(configuredRef, true);
      yield* logInfo("updater configured", { channel: loadedSettings.updateChannel });
      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updater.configure")),
    getState: Ref.get(stateRef),
    setChannel: (channel) =>
      Effect.gen(function* () {
        const activeAction = yield* Ref.get(actionInFlightRef);
        if (Option.isSome(activeAction)) {
          return yield* new DesktopUpdateActionInProgressError({
            action: activeAction.value,
            requestedChannel: channel,
          });
        }

        const current = yield* Ref.get(stateRef);
        if (current.channel === channel || current.downloadedVersion !== null) {
          return current;
        }

        yield* settings
          .setUpdateChannel(channel)
          .pipe(
            Effect.mapError(
              (cause) => new DesktopUpdateChannelPersistenceError({ channel, cause }),
            ),
          );
        yield* setState(createBaseState(environment.appVersion, channel, enabled, disabledMessage));
        if (enabled && (yield* Ref.get(configuredRef))) {
          yield* configureChannel(channel);
          const allowDowngrade = yield* electronUpdater.allowDowngrade;
          yield* electronUpdater.setAllowDowngrade(true);
          yield* checkForUpdates("channel-change").pipe(
            Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
          );
        }
        return yield* Ref.get(stateRef);
      }).pipe(
        Effect.withSpan("desktop.updater.setChannel", {
          attributes: { channel },
        }),
      ),
    check: checkForUpdates,
    download,
    install,
  });
});

export const layer = Layer.effect(DesktopUpdater, make);
