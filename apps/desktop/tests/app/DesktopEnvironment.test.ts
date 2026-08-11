import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  appVersion: "0.0.22",
  appPath: "/Applications/Throughline.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Throughline.app/Contents/Resources",
  appDataDirectory: Option.none(),
  xdgConfigHome: Option.none(),
  serverEntryOverride: Option.none(),
  logDirOverride: Option.none(),
  logLevel: Option.none(),
  otlpTracesUrl: Option.none(),
  otlpExportIntervalMs: Option.none(),
  configuredBackendPort: Option.none(),
  devServerUrl: Option.none(),
  processArch: "arm64",
  runningUnderArm64Translation: false,
  appImagePath: Option.none(),
  disableAutoUpdate: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const DEV_SERVER_URL = Option.some(new URL("http://localhost:5173"));

const makeEnvironment = (overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {}) =>
  Effect.map(Path.Path, (path) =>
    DesktopEnvironment.makeWith({ ...defaultInput, ...overrides }, path),
  ).pipe(Effect.provide(Path.layer));

describe("DesktopEnvironment", () => {
  it.effect("derives state paths and development identity", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ devServerUrl: DEV_SERVER_URL });

      assert.isTrue(environment.isDevelopment);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(
        environment.stateDir,
        "/Users/alice/Library/Application Support/throughline/dev",
      );
      assert.equal(
        environment.desktopSettingsPath,
        "/Users/alice/Library/Application Support/throughline/dev/desktop-settings.json",
      );
      assert.equal(
        environment.logDir,
        "/Users/alice/Library/Application Support/throughline/dev/logs",
      );
      assert.equal(environment.displayName, "Throughline (Dev)");
      assert.equal(environment.userDataDirName, "throughline-dev");
      assert.equal(environment.appUserModelId, "com.arsoftware.throughline.dev");
      assert.deepEqual(environment.appInfo, {
        name: "Throughline (Dev)",
        version: "0.0.22",
        platform: "darwin",
        isPackaged: false,
      });
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment({ devServerUrl: DEV_SERVER_URL });
      const production = yield* makeEnvironment({ isPackaged: true });

      assert.equal(
        development.stateDir,
        "/Users/alice/Library/Application Support/throughline/dev",
      );
      assert.equal(
        production.stateDir,
        "/Users/alice/Library/Application Support/throughline/userdata",
      );
      assert.notEqual(development.desktopSettingsPath, production.desktopSettingsPath);
      assert.notEqual(development.userDataDirName, production.userDataDirName);
      assert.equal(production.userDataDirName, "throughline");
      assert.equal(production.appUserModelId, "com.arsoftware.throughline");
      assert.equal(production.displayName, "Throughline");
    }),
  );

  it.effect("resolves the app-data root per platform", () =>
    Effect.gen(function* () {
      const windows = yield* makeEnvironment({
        platform: "win32",
        appDataDirectory: Option.some("C:/Users/alice/AppData/Roaming"),
      });
      assert.equal(windows.appDataDirectory, "C:/Users/alice/AppData/Roaming");
      assert.equal(windows.baseDir, "C:/Users/alice/AppData/Roaming/throughline");

      const windowsWithoutAppData = yield* makeEnvironment({ platform: "win32" });
      assert.equal(windowsWithoutAppData.appDataDirectory, "/Users/alice/AppData/Roaming");

      const linux = yield* makeEnvironment({
        platform: "linux",
        xdgConfigHome: Option.some("/Users/alice/.config-custom"),
      });
      assert.equal(linux.appDataDirectory, "/Users/alice/.config-custom");

      const freebsd = yield* makeEnvironment({ platform: "freebsd" });
      assert.equal(freebsd.platform, "linux");
      assert.equal(freebsd.appDataDirectory, "/Users/alice/.config");
    }),
  );

  it.effect("resolves the server entry from the override, the package, then the dev build", () =>
    Effect.gen(function* () {
      const overridden = yield* makeEnvironment({
        serverEntryOverride: Option.some("/repo/apps/server/src/bin.ts"),
        isPackaged: true,
      });
      assert.equal(overridden.backendEntryPath, "/repo/apps/server/src/bin.ts");
      // A packaged run keeps the child's cwd out of the read-only bundle.
      assert.equal(overridden.backendCwd, "/Users/alice");

      const packaged = yield* makeEnvironment({ isPackaged: true, appPath: "/app" });
      assert.equal(packaged.backendEntryPath, "/app/apps/server/dist/bin.mjs");

      const development = yield* makeEnvironment();
      assert.equal(development.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(development.backendCwd, "/repo/apps/server/dist");
    }),
  );

  it.effect("points the updater at the packaged feed only when packaged", () =>
    Effect.gen(function* () {
      const packaged = yield* makeEnvironment({ isPackaged: true });
      assert.equal(
        packaged.appUpdateYmlPath,
        "/Applications/Throughline.app/Contents/Resources/app-update.yml",
      );

      const development = yield* makeEnvironment();
      assert.equal(
        development.appUpdateYmlPath,
        "/Applications/Throughline.app/Contents/Resources/app.asar/dev-app-update.yml",
      );
    }),
  );

  it.effect("parses the log level case-insensitively and falls back on garbage", () =>
    Effect.gen(function* () {
      const parsed = yield* makeEnvironment({ logLevel: Option.some(" dEbUg ") });
      assert.equal(parsed.logLevel, "Debug");

      const garbage = yield* makeEnvironment({ logLevel: Option.some("chatty") });
      assert.equal(garbage.logLevel, "Info");

      const unset = yield* makeEnvironment();
      assert.equal(unset.logLevel, "Info");
    }),
  );

  it.effect("lets APP_LOG_DIR win over the derived state directory", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({
        logDirOverride: Option.some("/tmp/throughline-logs"),
      });

      assert.equal(environment.logDir, "/tmp/throughline-logs");
    }),
  );
});
