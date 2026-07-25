import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Electron from "electron";

import type { DesktopUpdateState } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../src/electron/ElectronDialog.ts";
import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";
import * as DesktopUpdater from "../../src/updates/DesktopUpdater.ts";
import * as DesktopApplicationMenu from "../../src/window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

const updateState = (overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState => ({
  enabled: true,
  status: "up-to-date",
  channel: "latest",
  currentVersion: "1.0.0",
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: "2026-07-25T12:00:00.000Z",
  message: null,
  errorContext: null,
  canRetry: false,
  ...overrides,
});

const environmentLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith(
      {
        dirname: "/app/apps/desktop/dist-electron",
        homeDirectory: "/home/user",
        platform: "darwin",
        appVersion: "1.0.0",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: "/app/resources",
        appDataDirectory: Option.none(),
        xdgConfigHome: Option.none(),
        appImagePath: Option.none(),
        serverEntryOverride: Option.none(),
        configuredBackendPort: Option.none(),
        devServerUrl: Option.none(),
      },
      path,
    ),
  ),
).pipe(Layer.provide(Path.layer));

function makeLayer(input: {
  readonly state: DesktopUpdateState;
  readonly menuTemplates: Array<readonly Electron.MenuItemConstructorOptions[]>;
  readonly shownDialog: Deferred.Deferred<Electron.MessageBoxOptions>;
  readonly dispatchedActions: string[];
  readonly dialogResponse?: number;
}) {
  const updater = DesktopUpdater.DesktopUpdater.of({
    configure: Effect.void,
    getState: Effect.succeed(input.state),
    setChannel: () => Effect.succeed(input.state),
    check: () =>
      Effect.succeed({
        checked: input.state.status !== "checking" && input.state.status !== "downloading",
        state: input.state,
      }),
    download: Effect.succeed({ accepted: false, completed: false, state: input.state }),
    install: Effect.succeed({ accepted: false, completed: false, state: input.state }),
  });
  const desktopWindow = DesktopWindow.DesktopWindow.of({
    activate: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: (action) =>
      Effect.sync(() => {
        input.dispatchedActions.push(action);
      }),
    syncAppearance: Effect.void,
  });
  const dialog = ElectronDialog.ElectronDialog.of({
    pickFolder: () => Effect.succeed(Option.none()),
    confirm: () => Effect.succeed(false),
    showMessageBox: ({ options }) =>
      Deferred.succeed(input.shownDialog, options).pipe(
        Effect.as({
          response: input.dialogResponse ?? 0,
          checkboxChecked: false,
        }),
      ),
    showErrorBox: () => Effect.void,
  });
  const menu = ElectronMenu.ElectronMenu.of({
    showContextMenu: () => Effect.succeed(Option.none()),
    setApplicationMenu: (template) =>
      Effect.sync(() => {
        input.menuTemplates.push(template);
      }),
  });

  return DesktopApplicationMenu.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        environmentLayer,
        Layer.succeed(DesktopUpdater.DesktopUpdater, updater),
        Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow),
        Layer.succeed(ElectronDialog.ElectronDialog, dialog),
        Layer.succeed(ElectronMenu.ElectronMenu, menu),
      ),
    ),
  );
}

function findMenuItem(
  template: readonly Electron.MenuItemConstructorOptions[],
  topLevel: string,
  label: string,
): Electron.MenuItemConstructorOptions {
  const menu = template.find((item) => item.label === topLevel || item.role === topLevel);
  const submenu = Array.isArray(menu?.submenu) ? menu.submenu : [];
  const item = submenu.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`Missing ${topLevel} > ${label}`);
  }
  return item;
}

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native macOS update command and reports an up-to-date result", () =>
    Effect.gen(function* () {
      const shownDialog = yield* Deferred.make<Electron.MessageBoxOptions>();
      const menuTemplates: Array<readonly Electron.MenuItemConstructorOptions[]> = [];
      const dispatchedActions: string[] = [];
      const layer = makeLayer({
        state: updateState(),
        menuTemplates,
        shownDialog,
        dispatchedActions,
      });

      yield* Effect.gen(function* () {
        const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* applicationMenu.configure;

        const template = menuTemplates[0] ?? [];
        const check = findMenuItem(template, "Throughline", "Check for Updates…");
        assert.isTrue(template.some((item) => item.role === "windowMenu"));
        assert.isFunction(check.click);

        (check.click as () => void)();
        const dialog = yield* Deferred.await(shownDialog);
        assert.equal(dialog.title, "You’re up to date");
        assert.include(dialog.message, "Throughline 1.0.0");
        assert.deepEqual(dispatchedActions, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("offers Settings when a manual check finds an available update", () =>
    Effect.gen(function* () {
      const shownDialog = yield* Deferred.make<Electron.MessageBoxOptions>();
      const menuTemplates: Array<readonly Electron.MenuItemConstructorOptions[]> = [];
      const dispatchedActions: string[] = [];
      const layer = makeLayer({
        state: updateState({
          status: "available",
          availableVersion: "1.1.0",
          checkedAt: "2026-07-25T12:05:00.000Z",
        }),
        menuTemplates,
        shownDialog,
        dispatchedActions,
      });

      yield* Effect.gen(function* () {
        const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* applicationMenu.configure;
        const check = findMenuItem(menuTemplates[0] ?? [], "Throughline", "Check for Updates…");
        (check.click as () => void)();

        const dialog = yield* Deferred.await(shownDialog);
        assert.equal(dialog.title, "Update available");
        yield* Effect.yieldNow;
        assert.deepEqual(dispatchedActions, ["preferences"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports an active download without offering an already-available update", () =>
    Effect.gen(function* () {
      const shownDialog = yield* Deferred.make<Electron.MessageBoxOptions>();
      const menuTemplates: Array<readonly Electron.MenuItemConstructorOptions[]> = [];
      const layer = makeLayer({
        state: updateState({
          status: "downloading",
          availableVersion: "1.1.0",
          downloadPercent: 40,
        }),
        menuTemplates,
        shownDialog,
        dispatchedActions: [],
      });

      yield* Effect.gen(function* () {
        const applicationMenu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* applicationMenu.configure;
        const check = findMenuItem(menuTemplates[0] ?? [], "Throughline", "Check for Updates…");
        (check.click as () => void)();

        const dialog = yield* Deferred.await(shownDialog);
        assert.equal(dialog.title, "Update already in progress");
        assert.notEqual(dialog.title, "Update available");
      }).pipe(Effect.provide(layer));
    }),
  );
});
