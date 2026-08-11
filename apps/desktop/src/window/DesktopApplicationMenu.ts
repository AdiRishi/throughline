import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopUpdater from "../updates/DesktopUpdater.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@app/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopWindow.DesktopWindow
  | DesktopUpdater.DesktopUpdater
  | ElectronDialog.ElectronDialog;

const { logInfo: logMenuInfo, logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

// A manual check reports its own outcome: the user asked a question and is
// owed an answer, including "already up to date", which the update panel would
// otherwise show as a state indistinguishable from "nothing happened".
const checkForUpdatesFromMenu = Effect.gen(function* () {
  const updater = yield* DesktopUpdater.DesktopUpdater;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const { state } = yield* updater.check("menu");

  if (state.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "You're up to date!",
      message: `Throughline ${state.currentVersion} is currently the newest version available.`,
      buttons: ["OK"],
    });
  } else if (state.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: "Update check failed",
      message: "Could not check for updates.",
      detail: state.message ?? "An unknown error occurred. Please try again later.",
      buttons: ["OK"],
    });
  }
}).pipe(Effect.withSpan("desktop.menu.checkForUpdates"));

const handleCheckForUpdatesMenuClick = Effect.gen(function* () {
  const updater = yield* DesktopUpdater.DesktopUpdater;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const disabledReason = yield* updater.disabledReason;
  if (Option.isSome(disabledReason)) {
    yield* logMenuInfo("manual update check requested, but updates are disabled", {
      disabledReason: disabledReason.value,
    });
    yield* electronDialog.showMessageBox({
      type: "info",
      title: "Updates unavailable",
      message: "Automatic updates are not available right now.",
      detail: disabledReason.value,
      buttons: ["OK"],
    });
    return;
  }

  // Surface a window first: the dialogs below are the only feedback a manual
  // check produces, and on macOS the menu is reachable with every window closed.
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.activate;
  yield* checkForUpdatesFromMenu;
}).pipe(Effect.withSpan("desktop.menu.handleCheckForUpdatesClick"));

export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = environment.displayName;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const preferencesClick = () => {
      runMenuEffect("preferences", dispatchMenuAction("preferences"));
    };
    const aboutClick = () => {
      runMenuEffect("about", dispatchMenuAction("about"));
    };
    const checkForUpdatesClick = () => {
      runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick);
    };
    const isMac = environment.platform === "darwin";
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (isMac) {
      template.push({
        label: appName,
        submenu: [
          { role: "about" },
          {
            label: "Check for Updates...",
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: "Preferences…",
            accelerator: "CmdOrCtrl+,",
            click: preferencesClick,
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
          ...(isMac
            ? []
            : [
                {
                  label: "Preferences…",
                  accelerator: "CmdOrCtrl+,",
                  click: preferencesClick,
                },
                { type: "separator" as const },
              ]),
          { role: isMac ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        role: "help",
        submenu: [
          { label: `About ${appName}`, click: aboutClick },
          // Also here on macOS, where the app menu already carries it: Help is
          // where a Windows/Linux user looks, and a duplicate costs nothing.
          { label: "Check for Updates...", click: checkForUpdatesClick },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
