import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../src/app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../src/app/DesktopShutdown.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronApp from "../../src/electron/ElectronApp.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const themeListeners = new Set<() => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        whenReady: Effect.void,
        quit: Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        requestSingleInstanceLock: Effect.succeed(true),
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        activate: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        dispatchMenuAction: () => Effect.void,
        syncAppearance: Effect.void,
      } satisfies DesktopWindow.DesktopWindow["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              themeListeners.add(listener);
            }),
            () =>
              Effect.sync(() => {
                themeListeners.delete(listener);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronTheme.ElectronTheme["Service"]);

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }
});
