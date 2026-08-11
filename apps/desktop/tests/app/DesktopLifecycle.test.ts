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

interface Harness {
  readonly appListeners: Map<string, (...args: readonly unknown[]) => void>;
  readonly themeListeners: Set<() => void>;
  /** Append-only record of lifecycle side effects, in the order they happened. */
  readonly events: Array<string>;
  readonly layer: Layer.Layer<
    | DesktopEnvironment.DesktopEnvironment
    | DesktopLifecycle.DesktopLifecycle
    | DesktopShutdown.DesktopShutdown
    | DesktopState.DesktopState
    | DesktopWindow.DesktopWindow
    | ElectronApp.ElectronApp
    | ElectronTheme.ElectronTheme
  >;
}

function makeHarness(platform: NodeJS.Platform): Harness {
  const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const themeListeners = new Set<() => void>();
  const events: Array<string> = [];

  const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    whenReady: Effect.void,
    quit: Effect.sync(() => {
      events.push("quit");
    }),
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
          appListeners.set(eventName, listener as unknown as (...args: readonly unknown[]) => void);
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
    flushMainWindowBounds: Effect.sync(() => {
      events.push("flushMainWindowBounds");
    }),
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

  return {
    appListeners,
    themeListeners,
    events,
    layer: DesktopLifecycle.layer.pipe(
      Layer.provideMerge(electronAppLayer),
      Layer.provideMerge(desktopWindowLayer),
      Layer.provideMerge(electronThemeLayer),
      Layer.provideMerge(environmentLayer),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
    ),
  };
}

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const harness = makeHarness(platform);

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          harness.appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          harness.appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(harness.layer));
    });
  }

  // Regression guard: the geometry write is fire-and-forget inside Electron's
  // "close" handler, so the shutdown path is the only place that can wait for
  // it. If the flush moves after `shutdown.request`, the process can exit with
  // the write still in flight and the last resize is silently lost.
  it.effect("flushes main-window bounds before shutdown completes", () => {
    const harness = makeHarness("darwin");

    return Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        const shutdown = yield* DesktopShutdown.DesktopShutdown;
        // Stands in for the app's real teardown: completes the shutdown only
        // once it has been requested, so `awaitComplete` cannot resolve early.
        yield* Effect.forkScoped(
          shutdown.awaitRequest.pipe(
            Effect.andThen(
              Effect.sync(() => {
                harness.events.push("shutdownRequested");
              }),
            ),
            Effect.andThen(shutdown.markComplete),
          ),
        );

        const event = { preventDefault: () => {} } as Electron.Event;
        harness.appListeners.get("before-quit")?.(event);

        yield* shutdown.awaitComplete;
        // `quit` is dispatched from a `.finally` on the outer promise, so give
        // that continuation a turn before asserting on the full ordering.
        yield* Effect.yieldNow;

        assert.deepEqual(harness.events, ["flushMainWindowBounds", "shutdownRequested", "quit"]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});
