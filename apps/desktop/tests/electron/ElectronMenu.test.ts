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
    buildFromTemplateMock: vi.fn<(template: Electron.MenuItemConstructorOptions[]) => unknown>(),
    createFromNamedImageMock: vi.fn<(name: string) => Electron.NativeImage>(),
    setApplicationMenuMock: vi.fn<(menu: unknown) => void>(),
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

const testLayer = ElectronMenu.layer.pipe(
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
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("scales CSS-pixel popup coordinates by the renderer zoom factor", () =>
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
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("omits renderer headers and separates destructive native actions", () =>
    Effect.gen(function* () {
      let template: Electron.MenuItemConstructorOptions[] | undefined;
      buildFromTemplateMock.mockImplementation((builtTemplate) => {
        template = builtTemplate;
        return {
          popup: (options: Electron.PopupOptions) => {
            options.callback?.();
          },
        };
      });

      const electronMenu = yield* ElectronMenu.ElectronMenu;
      yield* electronMenu.showContextMenu({
        window: makeWindow(),
        items: [
          { id: "heading", label: "Review", header: true },
          { id: "open", label: "Open" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position: Option.none(),
      });

      assert.deepEqual(
        template?.map((item) => ({
          label: item.label,
          type: item.type,
          enabled: item.enabled,
        })),
        [
          { label: "Open", type: undefined, enabled: true },
          { label: undefined, type: "separator", enabled: undefined },
          { label: "Delete", type: undefined, enabled: true },
        ],
      );
      assert.equal(createFromNamedImageMock.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("resolves with the clicked leaf item id exactly once", () =>
    Effect.gen(function* () {
      buildFromTemplateMock.mockImplementation(
        (template: Electron.MenuItemConstructorOptions[]) => ({
          popup: (options: Electron.PopupOptions) => {
            const click = template[0]?.click;
            if (click === undefined) {
              throw new Error("Expected menu item to have a click handler.");
            }
            click({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
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
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves native context-menu failures with structured window context", () =>
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
        assert.equal(error.platform, "linux");
        assert.equal(error.windowId, 7);
        assert.equal(error.itemCount, 1);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(testLayer)),
  );
});
