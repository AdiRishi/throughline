import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";

function makeEnvironmentLayer(homeDirectory: string) {
  return Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: path.join(homeDirectory, "app", "dist-electron"),
          homeDirectory,
          platform: "darwin",
          appVersion: "0.0.0",
          appPath: path.join(homeDirectory, "app"),
          isPackaged: true,
          resourcesPath: path.join(homeDirectory, "app", "resources"),
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          logDirOverride: Option.none(),
          logLevel: Option.none(),
          otlpTracesUrl: Option.none(),
          otlpExportIntervalMs: Option.none(),
          configuredBackendPort: Option.none(),
          devServerUrl: Option.none(),
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "throughline-desktop-settings-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(homeDirectory)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopAppSettings window state", () => {
  it("accepts only integral bounds that respect the main window minimum", () => {
    assert.deepEqual(
      DesktopAppSettings.normalizeMainWindowBounds({
        x: -120,
        y: 48,
        width: 1200,
        height: 760,
      }),
      {
        x: -120,
        y: 48,
        width: 1200,
        height: 760,
      },
    );
    assert.isNull(
      DesktopAppSettings.normalizeMainWindowBounds({
        x: 0,
        y: 0,
        width: 839,
        height: 620,
      }),
    );
    assert.isNull(
      DesktopAppSettings.normalizeMainWindowBounds({
        x: 0.5,
        y: 0,
        width: 1200,
        height: 760,
      }),
    );
  });

  it.effect("updates normal bounds and maximized state as one setting", () =>
    Effect.gen(function* () {
      const settings = yield* DesktopAppSettings.DesktopAppSettings;
      const bounds = { x: 80, y: 60, width: 1320, height: 880 };

      const first = yield* settings.setMainWindowBounds(bounds, true);
      const second = yield* settings.setMainWindowBounds(bounds, true);

      assert.isTrue(first.changed);
      assert.isFalse(second.changed);
      assert.deepEqual(yield* settings.get, {
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        mainWindowBounds: bounds,
        mainWindowMaximized: true,
      });
    }).pipe(Effect.provide(DesktopAppSettings.layerTest())),
  );

  it.effect("persists and restores window state atomically", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const bounds = { x: 140, y: 90, width: 1280, height: 820 };

        yield* settings.setMainWindowBounds(bounds, true);
        assert.deepEqual(yield* settings.load, {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: bounds,
          mainWindowMaximized: true,
        });

        const document = JSON.parse(
          yield* fileSystem.readFileString(environment.desktopSettingsPath),
        ) as unknown;
        assert.deepEqual(document, {
          mainWindowBounds: bounds,
          mainWindowMaximized: true,
        });
      }),
    ),
  );
});
