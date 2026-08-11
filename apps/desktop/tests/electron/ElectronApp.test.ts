import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vitest";

const {
  autoUpdaterOnMock,
  autoUpdaterRemoveListenerMock,
  getAppPathMock,
  getVersionMock,
  onMock,
  quitMock,
  removeListenerMock,
  requestSingleInstanceLockMock,
  setAboutPanelOptionsMock,
  setAppUserModelIdMock,
  setNameMock,
  setPathMock,
  whenReadyMock,
} = vi.hoisted(() => ({
  autoUpdaterOnMock: vi.fn<(eventName: string, listener: () => void) => void>(),
  autoUpdaterRemoveListenerMock: vi.fn<(eventName: string, listener: () => void) => void>(),
  getAppPathMock: vi.fn<() => string>(() => "/app"),
  getVersionMock: vi.fn<() => string>(() => "1.2.3"),
  onMock: vi.fn<(eventName: string, listener: () => void) => void>(),
  quitMock: vi.fn<() => void>(),
  removeListenerMock: vi.fn<(eventName: string, listener: () => void) => void>(),
  requestSingleInstanceLockMock: vi.fn<() => boolean>(() => true),
  setAboutPanelOptionsMock: vi.fn<(options: Record<string, unknown>) => void>(),
  setAppUserModelIdMock: vi.fn<(id: string) => void>(),
  setNameMock: vi.fn<(name: string) => void>(),
  setPathMock: vi.fn<(name: string, path: string) => void>(),
  whenReadyMock: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("electron", () => ({
  autoUpdater: {
    on: autoUpdaterOnMock,
    removeListener: autoUpdaterRemoveListenerMock,
  },
  app: {
    getAppPath: getAppPathMock,
    getVersion: getVersionMock,
    isPackaged: true,
    on: onMock,
    quit: quitMock,
    removeListener: removeListenerMock,
    requestSingleInstanceLock: requestSingleInstanceLockMock,
    setAboutPanelOptions: setAboutPanelOptionsMock,
    setAppUserModelId: setAppUserModelIdMock,
    setName: setNameMock,
    setPath: setPathMock,
    whenReady: whenReadyMock,
  },
}));

import * as ElectronApp from "../../src/electron/ElectronApp.ts";

describe("ElectronApp", () => {
  beforeEach(() => {
    autoUpdaterOnMock.mockClear();
    autoUpdaterRemoveListenerMock.mockClear();
    onMock.mockClear();
    quitMock.mockClear();
    removeListenerMock.mockClear();
    setAppUserModelIdMock.mockClear();
    setPathMock.mockClear();
  });

  it.effect("reads app metadata through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const metadata = yield* electronApp.metadata;

      assert.deepEqual(metadata, {
        appVersion: "1.2.3",
        appPath: "/app",
        isPackaged: true,
        resourcesPath: process.resourcesPath,
        runningUnderArm64Translation: false,
      });
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("reports which app metadata property failed", () =>
    Effect.gen(function* () {
      const cause = new Error("version unavailable");
      getVersionMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.metadata.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppMetadataReadError);
      assert.strictEqual(error.property, "app-version");
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        'Failed to read Electron app metadata property "app-version".',
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("preserves Electron readiness failures", () =>
    Effect.gen(function* () {
      const cause = new Error("ready failed");
      whenReadyMock.mockRejectedValueOnce(cause);

      const electronApp = yield* ElectronApp.ElectronApp;
      const error = yield* electronApp.whenReady.pipe(Effect.flip);

      assert.instanceOf(error, ElectronApp.ElectronAppWhenReadyError);
      assert.strictEqual(error.isPackaged, true);
      assert.strictEqual(error.cause, cause);
      assert.strictEqual(
        error.message,
        "Failed to wait for the Electron app to become ready (packaged: true).",
      );
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes app event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn<() => void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.on("activate", listener);
        }),
      );

      assert.deepEqual(onMock.mock.calls, [["activate", listener]]);
      assert.deepEqual(removeListenerMock.mock.calls, [["activate", listener]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("scopes native updater quit listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn<() => void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.onBeforeQuitForUpdate(listener);
        }),
      );

      assert.deepEqual(autoUpdaterOnMock.mock.calls, [["before-quit-for-update", listener]]);
      assert.deepEqual(autoUpdaterRemoveListenerMock.mock.calls, [
        ["before-quit-for-update", listener],
      ]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );

  it.effect("sets the Windows app user model id through the service", () =>
    Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      yield* electronApp.setAppUserModelId("com.arsoftware.throughline");

      assert.deepEqual(setAppUserModelIdMock.mock.calls, [["com.arsoftware.throughline"]]);
    }).pipe(Effect.provide(ElectronApp.layer)),
  );
});
