import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vitest";

import { HostProcessPlatform } from "@app/shared/hostProcess";

const { appFocusMock, browserWindowMock, getAllWindowsMock, getFocusedWindowMock } = vi.hoisted(
  () => ({
    appFocusMock: vi.fn<() => void>(),
    browserWindowMock: vi.fn<(...args: readonly unknown[]) => void>(
      function BrowserWindowMock() {},
    ),
    getAllWindowsMock: vi.fn<() => Electron.BrowserWindow[]>(),
    getFocusedWindowMock: vi.fn<() => Electron.BrowserWindow | null>(),
  }),
);

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";

const TestLayer = ElectronWindow.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

function makeBrowserWindow(input: { readonly id: number; readonly destroyed: boolean }) {
  return {
    id: input.id,
    isDestroyed: vi.fn<() => boolean>(() => input.destroyed),
  } as unknown as Electron.BrowserWindow;
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
  });

  it.effect("skips destroyed windows during native appearance synchronization", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ id: 1, destroyed: false });
      const destroyedWindow = makeBrowserWindow({ id: 2, destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves destroy failures with the target window", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn<() => void>(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});
