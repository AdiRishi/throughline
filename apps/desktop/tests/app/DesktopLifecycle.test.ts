import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../src/app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../src/app/DesktopShutdown.ts";
import * as DesktopState from "../../src/app/DesktopState.ts";
import * as ElectronApp from "../../src/electron/ElectronApp.ts";
import * as ElectronTheme from "../../src/electron/ElectronTheme.ts";
import * as ElectronWindow from "../../src/electron/ElectronWindow.ts";
import * as DesktopWindow from "../../src/window/DesktopWindow.ts";

const environmentLayer = Layer.effect(
  DesktopEnvironment.DesktopEnvironment,
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith(
      {
        dirname: "/app/apps/desktop/dist-electron",
        homeDirectory: "/home/user",
        platform: "win32",
        appVersion: "0.0.0",
        appPath: "/app",
        isPackaged: false,
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

describe("DesktopLifecycle", () => {
  it.effect("synchronizes window appearance when the native theme changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const appearanceSynchronized = yield* Deferred.make<void>();
        let themeUpdated: (() => void) | undefined;
        const dependencies = Layer.mergeAll(
          DesktopShutdown.layer,
          DesktopState.layer,
          environmentLayer,
          Layer.mock(ElectronApp.ElectronApp)({
            requestSingleInstanceLock: Effect.succeed(true),
            on: () => Effect.void,
          }),
          Layer.mock(ElectronTheme.ElectronTheme)({
            onUpdated: (listener) =>
              Effect.sync(() => {
                themeUpdated = listener;
              }),
          }),
          Layer.mock(ElectronWindow.ElectronWindow)({
            destroyAll: Effect.void,
          }),
          Layer.mock(DesktopWindow.DesktopWindow)({
            syncAppearance: Deferred.succeed(appearanceSynchronized, undefined).pipe(Effect.asVoid),
          }),
        );

        yield* Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
        }).pipe(Effect.provide(DesktopLifecycle.layer), Effect.provide(dependencies));
        assert.isDefined(themeUpdated);

        themeUpdated?.();
        yield* Deferred.await(appearanceSynchronized);
      }),
    ),
  );

  it.effect("destroys renderer windows before releasing the desktop runtime", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sequence = yield* Ref.make<ReadonlyArray<string>>([]);
        const quitRequested = yield* Deferred.make<void>();
        let beforeQuit: ((event: { preventDefault: () => void }) => void) | undefined;
        let prevented = false;
        const record = (event: string) => Ref.update(sequence, (events) => [...events, event]);
        const dependencies = Layer.mergeAll(
          DesktopState.layer,
          environmentLayer,
          Layer.mock(DesktopShutdown.DesktopShutdown)({
            request: record("shutdown"),
            awaitComplete: Effect.void,
          }),
          Layer.mock(ElectronApp.ElectronApp)({
            requestSingleInstanceLock: Effect.succeed(true),
            on: (eventName, listener) =>
              Effect.sync(() => {
                if (eventName === "before-quit") {
                  beforeQuit = listener as unknown as typeof beforeQuit;
                }
              }),
            quit: record("quit").pipe(
              Effect.andThen(Deferred.succeed(quitRequested, undefined)),
              Effect.asVoid,
            ),
          }),
          Layer.mock(ElectronTheme.ElectronTheme)({
            onUpdated: () => Effect.void,
          }),
          Layer.mock(ElectronWindow.ElectronWindow)({
            destroyAll: record("destroy"),
          }),
          Layer.mock(DesktopWindow.DesktopWindow)({
            flushMainWindowBounds: record("flush"),
          }),
        );

        yield* Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
        }).pipe(Effect.provide(DesktopLifecycle.layer), Effect.provide(dependencies));
        assert.isDefined(beforeQuit);

        beforeQuit?.({
          preventDefault: () => {
            prevented = true;
          },
        });
        yield* Deferred.await(quitRequested);

        assert.isTrue(prevented);
        assert.deepEqual(yield* Ref.get(sequence), ["flush", "destroy", "shutdown", "quit"]);
      }),
    ),
  );
});
