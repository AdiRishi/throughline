import { assert, beforeEach, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { vi } from "vitest";

import { HostProcessPlatform } from "@app/shared/hostProcess";

const { buildFromTemplateMock, createFromNamedImageMock, setApplicationMenuMock } = vi.hoisted(
  () => ({
    buildFromTemplateMock:
      vi.fn<
        (template: Electron.MenuItemConstructorOptions[]) => {
          popup: (options: Electron.PopupOptions) => void;
        }
      >(),
    createFromNamedImageMock: vi.fn<() => Electron.NativeImage>(),
    setApplicationMenuMock: vi.fn<(menu: Electron.Menu | null) => void>(),
  }),
);

vi.mock("electron", () => ({
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
    setApplicationMenu: setApplicationMenuMock,
  },
  nativeImage: {
    createFromNamedImage: createFromNamedImageMock,
  },
}));

import * as ElectronMenu from "../../src/electron/ElectronMenu.ts";

const TestLayer = ElectronMenu.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "linux")),
);

const makeWindow = (zoomFactor = 1): Electron.BrowserWindow =>
  ({
    id: 7,
    webContents: { getZoomFactor: () => zoomFactor },
  }) as unknown as Electron.BrowserWindow;

describe("ElectronMenu", () => {
  beforeEach(() => {
    buildFromTemplateMock.mockReset();
    createFromNamedImageMock.mockReset();
    setApplicationMenuMock.mockReset();
  });

  it.effect("returns none without building a menu when there are no valid items", () =>
    Effect.gen(function* () {
      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: makeWindow(),
        items: [],
        position: Option.none(),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.equal(buildFromTemplateMock.mock.calls.length, 0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves with the clicked leaf item id exactly once", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: (options: Electron.PopupOptions) => {
            const firstItem = template[0];
            if (!firstItem?.click) {
              throw new Error("Expected menu item to have a click handler.");
            }
            firstItem.click(
              {} as Electron.MenuItem,
              {} as Electron.BrowserWindow,
              {} as KeyboardEvent,
            );
            options.callback?.();
          },
        }),
      );

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: makeWindow(),
        items: [{ id: "copy", label: "Copy" }],
        position: Option.none(),
      });

      assert.equal(Option.getOrNull(selectedItemId), "copy");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("scales renderer coordinates by the page zoom factor", () =>
    Effect.gen(function* () {
      let popupOptions: Electron.PopupOptions | undefined;
      buildFromTemplateMock.mockImplementation(() => ({
        popup: (options: Electron.PopupOptions) => {
          popupOptions = options;
          options.callback?.();
        },
      }));

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const selectedItemId = yield* electronMenu.showContextMenu({
        window: makeWindow(2),
        items: [{ id: "copy", label: "Copy" }],
        position: Option.some({ x: 10.8, y: 20.2 }),
      });

      assert.isTrue(Option.isNone(selectedItemId));
      assert.equal(popupOptions?.x, 21);
      assert.equal(popupOptions?.y, 40);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves application-menu failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("application menu build failed");
      buildFromTemplateMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.setApplicationMenu([{ label: "File" }, { label: "Edit" }]),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "set-application-menu");
        assert.equal(error.platform, "linux");
        assert.isNull(error.windowId);
        assert.equal(error.itemCount, 2);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves context-menu failures with window context", () =>
    Effect.gen(function* () {
      const cause = new Error("context menu build failed");
      buildFromTemplateMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      const exit = yield* Effect.exit(
        electronMenu.showContextMenu({
          window: makeWindow(),
          items: [{ id: "copy", label: "Copy" }],
          position: Option.none(),
        }),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronMenu.ElectronMenuOperationError);
        assert.equal(error.operation, "show-context-menu");
        assert.equal(error.windowId, 7);
        assert.equal(error.itemCount, 1);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});
