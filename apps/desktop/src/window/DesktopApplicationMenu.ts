import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";

import { safeDiagnosticErrorType } from "@app/shared/safeLog";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopUpdater from "../updates/DesktopUpdater.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdater.DesktopUpdater
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo, logWarning } = makeComponentLogger("desktop-menu");

const showMessage = (
  options: Electron.MessageBoxOptions,
): Effect.Effect<
  void,
  ElectronDialog.ElectronDialogShowMessageBoxError,
  ElectronDialog.ElectronDialog
> =>
  ElectronDialog.ElectronDialog.pipe(
    Effect.flatMap((dialog) =>
      dialog.showMessageBox({ owner: Option.none(), options }).pipe(Effect.asVoid),
    ),
  );

const openSettings = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction("preferences");
});

const showUpdateReady = Effect.fn("desktop.menu.showUpdateReady")(function* (version: string) {
  const dialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* dialog.showMessageBox({
    owner: Option.none(),
    options: {
      type: "info",
      title: "Update available",
      message: `Throughline ${version} is ready.`,
      detail: "Open Settings to download or install it when you are ready.",
      buttons: ["Open Settings", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    },
  });
  if (result.response === 0) {
    yield* openSettings;
  }
});

const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updater = yield* DesktopUpdater.DesktopUpdater;
  const initialState = yield* updater.getState;
  if (!initialState.enabled) {
    yield* logInfo("manual update check requested while updates are disabled");
    yield* showMessage({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: initialState.message ?? "This build does not have an update feed.",
      buttons: ["OK"],
    });
    return;
  }

  const result = yield* updater.check("menu");
  const state = result.state;
  if (!result.checked && (state.status === "checking" || state.status === "downloading")) {
    yield* showMessage({
      type: "info",
      title: "Update already in progress",
      message: "Throughline is already checking, downloading, or preparing an update.",
      buttons: ["OK"],
    });
    return;
  }
  if (state.status === "up-to-date") {
    yield* showMessage({
      type: "info",
      title: "You’re up to date",
      message: `Throughline ${state.currentVersion} is the newest version on the ${state.channel === "nightly" ? "nightly" : "stable"} channel.`,
      buttons: ["OK"],
    });
    return;
  }
  if (state.status === "error") {
    yield* showMessage({
      type: "warning",
      title: "Update check failed",
      message: "Throughline could not check for updates.",
      detail: state.message ?? "Try again later.",
      buttons: ["OK"],
    });
    return;
  }
  if (state.downloadedVersion !== null || state.availableVersion !== null) {
    yield* showUpdateReady(
      state.downloadedVersion ?? state.availableVersion ?? state.currentVersion,
    );
    return;
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.catchCause((cause) =>
          logWarning("desktop menu action failed", {
            action,
            errorType: safeDiagnosticErrorType(Cause.squash(cause)),
          }),
        ),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", checkForUpdatesFromMenu);
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", openSettings);
    };
    const aboutClick = () => {
      runMenuEffect(
        "open-about",
        DesktopWindow.DesktopWindow.pipe(
          Effect.flatMap((desktopWindow) => desktopWindow.dispatchMenuAction("about")),
        ),
      );
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates…",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Settings…",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings…",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          { role: environment.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          {
            label: "Check for Updates…",
            click: checkForUpdatesClick,
          },
          ...(environment.platform === "darwin"
            ? []
            : [
                { type: "separator" as const },
                {
                  label: `About ${environment.displayName}`,
                  click: aboutClick,
                },
              ]),
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({ configure });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
