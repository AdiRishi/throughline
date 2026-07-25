import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../../src/app/DesktopEnvironment.ts";
import * as ElectronShell from "../../../src/electron/ElectronShell.ts";
import * as ElectronTheme from "../../../src/electron/ElectronTheme.ts";
import { getTheme, openLogsFolder, setTheme } from "../../../src/ipc/methods/window.ts";
import * as DesktopAppSettings from "../../../src/settings/DesktopAppSettings.ts";

describe("window IPC theme methods", () => {
  it.effect("returns the persisted shell theme after a renderer change", () => {
    const sources: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(),
      Layer.succeed(
        ElectronTheme.ElectronTheme,
        ElectronTheme.ElectronTheme.of({
          shouldUseDarkColors: Effect.succeed(false),
          setSource: (source) =>
            Effect.sync(() => {
              sources.push(source);
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      yield* setTheme.handler("dark");

      assert.strictEqual(yield* getTheme.handler(), "dark");
      assert.deepStrictEqual(sources, ["dark"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("window IPC diagnostics methods", () => {
  it.effect("creates and opens the app-owned logs directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "throughline-ipc-",
        });
        const environment = DesktopEnvironment.makeWith(
          {
            dirname: homeDirectory,
            homeDirectory,
            platform: "darwin",
            appVersion: "1.2.3",
            appPath: homeDirectory,
            isPackaged: true,
            resourcesPath: homeDirectory,
            appDataDirectory: Option.none(),
            xdgConfigHome: Option.none(),
            serverEntryOverride: Option.none(),
            configuredBackendPort: Option.none(),
            devServerUrl: Option.none(),
          },
          path,
        );
        const openedPaths: Array<string> = [];
        const shell = ElectronShell.ElectronShell.of({
          openExternal: () => Effect.succeed(false),
          openPath: (openedPath) =>
            fileSystem.exists(openedPath).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  openedPaths.push(openedPath);
                }),
              ),
              Effect.orDie,
            ),
        });

        assert.isFalse(yield* fileSystem.exists(environment.logDir));
        const opened = yield* openLogsFolder
          .handler(undefined)
          .pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
            Effect.provideService(ElectronShell.ElectronShell, shell),
          );

        assert.isTrue(opened);
        assert.isTrue(yield* fileSystem.exists(environment.logDir));
        assert.deepStrictEqual(openedPaths, [environment.logDir]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
