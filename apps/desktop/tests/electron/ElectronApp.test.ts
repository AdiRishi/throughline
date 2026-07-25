import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { vi } from "vitest";

const {
  appendSwitchMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setDesktopNameMock,
  setDockIconMock,
  setNameMock,
} = vi.hoisted(() => ({
  appendSwitchMock: vi.fn<(switchName: string, value?: string) => void>(),
  setAboutPanelOptionsMock: vi.fn<(options: Electron.AboutPanelOptionsOptions) => void>(),
  setAppUserModelIdMock: vi.fn<(id: string) => void>(),
  setDesktopNameMock: vi.fn<(desktopName: string) => void>(),
  setDockIconMock: vi.fn<(iconPath: string) => void>(),
  setNameMock: vi.fn<(name: string) => void>(),
}));

vi.mock("electron", () => ({
  app: {
    commandLine: {
      appendSwitch: appendSwitchMock,
    },
    dock: {
      setIcon: setDockIconMock,
    },
    getAppPath: () => "/app",
    getVersion: () => "1.2.3",
    isPackaged: false,
    on: vi.fn<(eventName: string, listener: (...args: Array<unknown>) => void) => void>(),
    quit: vi.fn<() => void>(),
    removeListener:
      vi.fn<(eventName: string, listener: (...args: Array<unknown>) => void) => void>(),
    requestSingleInstanceLock: vi.fn<() => boolean>(() => true),
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAppUserModelId: setAppUserModelIdMock,
    setDesktopName: setDesktopNameMock,
    setName: setNameMock,
    setPath: vi.fn<(name: string, path: string) => void>(),
    whenReady: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  },
}));

import * as ElectronApp from "../../src/electron/ElectronApp.ts";

describe("ElectronApp identity", () => {
  beforeEach(() => {
    appendSwitchMock.mockClear();
    setAboutPanelOptionsMock.mockClear();
    setAppUserModelIdMock.mockClear();
    setDesktopNameMock.mockClear();
    setDockIconMock.mockClear();
    setNameMock.mockClear();
  });

  it.effect("applies native application identity through Electron", () =>
    Effect.gen(function* () {
      const app = yield* ElectronApp.ElectronApp;
      const about = {
        applicationName: "Throughline (Dev)",
        applicationVersion: "1.2.3",
      };

      yield* app.setName("Throughline (Dev)");
      yield* app.setAboutPanelOptions(about);
      yield* app.setAppUserModelId("com.arsoftware.throughline.dev");
      yield* app.appendCommandLineSwitch("class", "throughline-dev");
      yield* app.setDesktopName("throughline-dev.desktop");
      yield* app.setDockIcon("/app/icon.png");

      assert.deepEqual(setNameMock.mock.calls, [["Throughline (Dev)"]]);
      assert.deepEqual(setAboutPanelOptionsMock.mock.calls, [[about]]);
      assert.deepEqual(setAppUserModelIdMock.mock.calls, [["com.arsoftware.throughline.dev"]]);
      assert.deepEqual(appendSwitchMock.mock.calls, [["class", "throughline-dev"]]);
      assert.deepEqual(setDesktopNameMock.mock.calls, [["throughline-dev.desktop"]]);
      assert.deepEqual(setDockIconMock.mock.calls, [["/app/icon.png"]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
