import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DesktopUpdateChannel } from "@app/contracts";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../src/settings/DesktopAppSettings.ts";

function makeEnvironmentLayer(homeDirectory: string, appVersion: string) {
  return Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: path.join(homeDirectory, "app", "dist-electron"),
          homeDirectory,
          platform: "darwin",
          appVersion,
          appPath: path.join(homeDirectory, "app"),
          isPackaged: true,
          resourcesPath: path.join(homeDirectory, "app", "resources"),
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
}

const withSettings = <A, E, R>(
  effect: Effect.Effect<
    A,
    E,
    R | DesktopAppSettings.DesktopAppSettings | DesktopEnvironment.DesktopEnvironment
  >,
  appVersion = "0.0.17",
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "throughline-desktop-settings-",
    });
    return yield* effect.pipe(
      Effect.provide(
        DesktopAppSettings.layer.pipe(
          Layer.provideMerge(makeEnvironmentLayer(homeDirectory, appVersion)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

function writeUpdateChannelSettings(input: {
  readonly updateChannel: DesktopUpdateChannel;
  readonly updateChannelConfiguredByUser?: boolean;
}) {
  return Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(environment.desktopSettingsPath), {
      recursive: true,
    });
    yield* fileSystem.writeFileString(
      environment.desktopSettingsPath,
      `${JSON.stringify(input)}\n`,
    );
  });
}

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
        width: 899,
        height: 640,
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

  it.effect("updates normal bounds and maximized state as one durable setting", () =>
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
});

describe("DesktopAppSettings update channel", () => {
  const nightlyVersion = "0.0.17-nightly.20260415.1";

  it("defaults nightly builds to nightly without treating the default as a user choice", () => {
    assert.deepEqual(DesktopAppSettings.resolveDefaultDesktopSettings(nightlyVersion), {
      ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
      updateChannel: "nightly",
    });
  });

  it.effect("uses the nightly runtime default when settings are missing or malformed", () =>
    withSettings(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const nightlyDefaults = {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          updateChannel: "nightly",
        } satisfies DesktopAppSettings.DesktopSettings;

        assert.deepEqual(yield* settings.load, nightlyDefaults);

        yield* fileSystem.makeDirectory(path.dirname(environment.desktopSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(environment.desktopSettingsPath, "{not-json");
        assert.deepEqual(yield* settings.load, nightlyDefaults);
      }),
      nightlyVersion,
    ),
  );

  it.effect("migrates a legacy stable channel to the nightly runtime default", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeUpdateChannelSettings({ updateChannel: "latest" });

        assert.deepEqual(yield* settings.load, {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          updateChannel: "nightly",
        });
      }),
      nightlyVersion,
    ),
  );

  it.effect("preserves an explicitly configured stable channel on nightly builds", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeUpdateChannelSettings({
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });

        assert.deepEqual(yield* settings.load, {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          updateChannel: "latest",
          updateChannelConfiguredByUser: true,
        });
      }),
      nightlyVersion,
    ),
  );

  it.effect("treats a legacy nightly channel as user-configured", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* writeUpdateChannelSettings({ updateChannel: "nightly" });

        assert.deepEqual(yield* settings.load, {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          updateChannel: "nightly",
          updateChannelConfiguredByUser: true,
        });
      }),
    ),
  );

  it.effect("persists a changed channel as an explicit user choice", () =>
    withSettings(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        const unchanged = yield* settings.setUpdateChannel("latest");
        assert.isFalse(unchanged.changed);
        assert.isFalse(unchanged.settings.updateChannelConfiguredByUser);

        const changed = yield* settings.setUpdateChannel("nightly");
        assert.isTrue(changed.changed);
        assert.isTrue(changed.settings.updateChannelConfiguredByUser);
        assert.deepEqual(yield* settings.load, changed.settings);
      }),
    ),
  );
});
