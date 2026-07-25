import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import type { ContextMenuItem } from "@app/contracts";
import { HostProcessPlatform } from "@app/shared/hostProcess";

export interface ElectronMenuPosition {
  readonly x: number;
  readonly y: number;
}

export interface ElectronMenuContextInput {
  readonly window: Electron.BrowserWindow;
  readonly items: readonly ContextMenuItem[];
  readonly position: Option.Option<ElectronMenuPosition>;
}

const ElectronMenuOperation = Schema.Literals(["set-application-menu", "show-context-menu"]);

export class ElectronMenuOperationError extends Schema.TaggedErrorClass<ElectronMenuOperationError>()(
  "ElectronMenuOperationError",
  {
    operation: ElectronMenuOperation,
    platform: Schema.String,
    windowId: Schema.NullOr(Schema.Number),
    itemCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const window = this.windowId === null ? "" : ` for window ${this.windowId}`;
    return `Electron menu operation ${JSON.stringify(this.operation)} failed${window} with ${this.itemCount} items on ${this.platform}.`;
  }
}

export class ElectronMenu extends Context.Service<
  ElectronMenu,
  {
    // Pops up a native context menu built from the codec-validated contract
    // items and resolves with the clicked item's id (or None if dismissed).
    readonly showContextMenu: (
      input: ElectronMenuContextInput,
    ) => Effect.Effect<Option.Option<string>>;
    // Installs the native application menu (menu bar on Windows/Linux, the top
    // menu on macOS) from a template whose click handlers are supplied by the
    // Desktop tier.
    readonly setApplicationMenu: (
      template: readonly Electron.MenuItemConstructorOptions[],
    ) => Effect.Effect<void>;
  }
>()("@app/desktop/electron/ElectronMenu") {}

const normalizePosition = (
  position: Option.Option<ElectronMenuPosition>,
  zoomFactor: number,
): Option.Option<ElectronMenuPosition> =>
  Option.filter(
    position,
    ({ x, y }) =>
      Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && Number.isFinite(zoomFactor),
  ).pipe(
    Option.map(({ x, y }) => ({
      x: Math.floor(x * zoomFactor),
      y: Math.floor(y * zoomFactor),
    })),
  );

function buildTemplate(
  items: readonly ContextMenuItem[],
  complete: (selectedId: Option.Option<string>) => void,
): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [];
  for (const item of items) {
    if (typeof item.id !== "string" || typeof item.label !== "string") {
      continue;
    }
    if (item.children && item.children.length > 0) {
      const submenu = buildTemplate(item.children, complete);
      if (submenu.length === 0) continue;
      template.push({
        label: item.label,
        enabled: item.disabled !== true,
        submenu,
      });
      continue;
    }
    template.push({
      label: item.label,
      enabled: item.disabled !== true,
      click: () => complete(Option.some(item.id)),
    });
  }
  return template;
}

export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;

  return ElectronMenu.of({
    showContextMenu: (input) =>
      Effect.callback<Option.Option<string>>((resume) => {
        let completed = false;
        const complete = (selectedId: Option.Option<string>) => {
          if (completed) {
            return;
          }
          completed = true;
          resume(Effect.succeed(selectedId));
        };
        const template = buildTemplate(input.items, complete);
        if (template.length === 0) {
          complete(Option.none());
          return;
        }

        try {
          const menu = Electron.Menu.buildFromTemplate(template);
          const position = normalizePosition(
            input.position,
            input.window.webContents.getZoomFactor(),
          );
          menu.popup({
            window: input.window,
            ...Option.match(position, {
              onNone: () => ({}),
              onSome: ({ x, y }) => ({ x, y }),
            }),
            callback: () => {
              complete(Option.none());
            },
          });
        } catch (cause) {
          if (completed) {
            return;
          }
          completed = true;
          resume(
            Effect.die(
              new ElectronMenuOperationError({
                operation: "show-context-menu",
                platform,
                windowId: input.window.id,
                itemCount: template.length,
                cause,
              }),
            ),
          );
        }
      }),
    setApplicationMenu: (template) =>
      Effect.try({
        try: () => {
          Electron.Menu.setApplicationMenu(Electron.Menu.buildFromTemplate([...template]));
        },
        catch: (cause) =>
          new ElectronMenuOperationError({
            operation: "set-application-menu",
            platform,
            windowId: null,
            itemCount: template.length,
            cause,
          }),
      }).pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(ElectronMenu, make);
