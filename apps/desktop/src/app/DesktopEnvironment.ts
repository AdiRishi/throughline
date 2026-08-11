import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { DesktopAppInfo, DesktopRuntimeArch, DesktopRuntimeInfo } from "@app/contracts";

import type { DesktopSettings } from "../settings/DesktopAppSettings.ts";
import { resolveDefaultDesktopSettings } from "../settings/DesktopAppSettings.ts";
import { resolveDesktopStateDir } from "./DesktopStatePaths.ts";

const APP_BASE_NAME = "Throughline";
const APP_BASE_ID = "com.arsoftware.throughline";
const DEFAULT_BACKEND_PORT = 13773;
const DEFAULT_OTLP_EXPORT_INTERVAL_MS = 10_000;

// An unrecognized value falls back rather than failing: a typo in an env var
// must not stop the shell from booting.
function parseLogLevel(value: string | undefined, fallback: LogLevel.LogLevel): LogLevel.LogLevel {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return LogLevel.values.find((level) => level.toLowerCase() === normalized) ?? fallback;
}

export interface MakeDesktopEnvironmentInput {
  /** `__dirname` of the built main.cjs (dist-electron). */
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly appVersion: string;
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  /** `process.arch` — the architecture this build was compiled for. */
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
  readonly appDataDirectory: Option.Option<string>;
  readonly xdgConfigHome: Option.Option<string>;
  readonly serverEntryOverride: Option.Option<string>;
  readonly logDirOverride: Option.Option<string>;
  readonly logLevel: Option.Option<string>;
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpExportIntervalMs: Option.Option<number>;
  readonly configuredBackendPort: Option.Option<number>;
  readonly devServerUrl: Option.Option<URL>;
  /**
   * Set by the AppImage runtime to the path of the running image. On Linux
   * electron-updater can only replace an AppImage, so its absence is what tells
   * the updater it must stay disabled there.
   */
  readonly appImagePath: Option.Option<string>;
  readonly disableAutoUpdate: boolean;
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly platform: DesktopAppInfo["platform"];
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly resourcesPath: string;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly desktopSettingsPath: string;
    readonly logDir: string;
    readonly logLevel: LogLevel.LogLevel;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly preloadPath: string;
    /**
     * Where electron-updater looks for the release feed. electron-builder only
     * writes `app-update.yml` when the build had a `publish` config, so its
     * absence is what tells the updater it has no feed to talk to.
     */
    readonly appUpdateYmlPath: string;
    readonly backendEntryPath: string;
    readonly backendCwd: string;
    readonly defaultBackendPort: number;
    readonly configuredBackendPort: Option.Option<number>;
    readonly devServerUrl: Option.Option<URL>;
    readonly appImagePath: Option.Option<string>;
    readonly disableAutoUpdate: boolean;
    readonly runtimeInfo: DesktopRuntimeInfo;
    /**
     * Normalizes a renderer-supplied starting directory for the folder picker:
     * trims it, expands a leading `~`, and resolves anything relative against
     * the process cwd. Electron treats an unresolvable `defaultPath` as no
     * default at all, so a `~/projects` that the renderer sent verbatim would
     * silently open the picker somewhere else entirely.
     */
    readonly resolvePickFolderDefaultPath: (
      initialPath: string | undefined,
    ) => Option.Option<string>;
    readonly appInfo: DesktopAppInfo;
    readonly displayName: string;
    readonly userDataDirName: string;
    readonly appUserModelId: string;
    readonly defaultDesktopSettings: DesktopSettings;
  }
>()("@app/desktop/app/DesktopEnvironment") {}

function normalizePlatform(platform: NodeJS.Platform): DesktopAppInfo["platform"] {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

/**
 * Rosetta is the only translation layer we model, so outside macOS the host is
 * by definition whatever the build targets. On macOS an x64 build reports
 * `process.arch === "x64"` whether it runs on Intel or on Apple Silicon under
 * translation, and only `runningUnderARM64Translation` tells the two apart.
 */
function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return { hostArch: appArch, appArch, runningUnderArm64Translation: false };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

export function makeWith(
  input: MakeDesktopEnvironmentInput,
  path: Path.Path,
): DesktopEnvironment["Service"] {
  const platform = normalizePlatform(input.platform);
  const isDevelopment = Option.isSome(input.devServerUrl);
  const displayName = isDevelopment ? `${APP_BASE_NAME} (Dev)` : APP_BASE_NAME;

  const appDataDirectory =
    platform === "win32"
      ? Option.getOrElse(input.appDataDirectory, () =>
          path.join(input.homeDirectory, "AppData", "Roaming"),
        )
      : platform === "darwin"
        ? path.join(input.homeDirectory, "Library", "Application Support")
        : Option.getOrElse(input.xdgConfigHome, () => path.join(input.homeDirectory, ".config"));
  const baseDir = path.join(appDataDirectory, "throughline");
  const stateDir = resolveDesktopStateDir({ baseDir, isDevelopment, joinPath: path.join });
  // `APP_LOG_DIR` wins so a dev checkout can keep its artifacts in one known
  // place; the same resolved value is handed to the spawned server child.
  const logDir = Option.getOrElse(input.logDirOverride, () => path.join(stateDir, "logs"));
  const desktopSettingsPath = path.join(stateDir, "desktop-settings.json");
  const preloadPath = path.join(input.dirname, "preload.cjs");
  const appUpdateYmlPath = input.isPackaged
    ? path.join(input.resourcesPath, "app-update.yml")
    : path.join(input.appPath, "dev-app-update.yml");

  const backendEntryPath = Option.match(input.serverEntryOverride, {
    onSome: (override) => override,
    onNone: () =>
      input.isPackaged
        ? path.join(input.appPath, "apps/server/dist/bin.mjs")
        : path.resolve(input.dirname, "..", "..", "server", "dist", "bin.mjs"),
  });
  const backendCwd = input.isPackaged ? input.homeDirectory : path.dirname(backendEntryPath);

  const appInfo: DesktopAppInfo = {
    name: displayName,
    version: input.appVersion,
    platform,
    isPackaged: input.isPackaged,
  };

  return DesktopEnvironment.of({
    path,
    platform,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    resourcesPath: input.resourcesPath,
    homeDirectory: input.homeDirectory,
    appDataDirectory,
    baseDir,
    stateDir,
    desktopSettingsPath,
    logDir,
    logLevel: parseLogLevel(Option.getOrUndefined(input.logLevel), "Info"),
    otlpTracesUrl: input.otlpTracesUrl,
    otlpExportIntervalMs: Option.getOrElse(
      input.otlpExportIntervalMs,
      () => DEFAULT_OTLP_EXPORT_INTERVAL_MS,
    ),
    preloadPath,
    appUpdateYmlPath,
    backendEntryPath,
    backendCwd,
    defaultBackendPort: DEFAULT_BACKEND_PORT,
    configuredBackendPort: input.configuredBackendPort,
    devServerUrl: input.devServerUrl,
    appImagePath: input.appImagePath,
    disableAutoUpdate: input.disableAutoUpdate,
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (initialPath) => {
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(input.homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(input.homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    appInfo,
    displayName,
    userDataDirName: isDevelopment ? "throughline-dev" : "throughline",
    appUserModelId: isDevelopment ? `${APP_BASE_ID}.dev` : APP_BASE_ID,
    defaultDesktopSettings: resolveDefaultDesktopSettings(input.appVersion),
  });
}

/**
 * `Path.Path` is deliberately left as a requirement rather than satisfied here.
 * `effect/Path`'s own `Path.layer` is the POSIX implementation; providing it
 * would shadow the platform-aware `node:path` service that `NodeServices.layer`
 * supplies in `main.ts`, and every path this service hands out — stateDir,
 * logDir, settings, preload, the backend entry — would be computed with posix
 * semantics on Windows. `path.resolve` in particular does not treat `\` as a
 * separator or a drive letter as absolute, so the dev backend entry would
 * resolve to cwd-relative garbage there.
 */
export function layer(
  metadata: Pick<
    MakeDesktopEnvironmentInput,
    | "dirname"
    | "homeDirectory"
    | "platform"
    | "appVersion"
    | "appPath"
    | "isPackaged"
    | "resourcesPath"
    | "processArch"
    | "runningUnderArm64Translation"
  >,
): Layer.Layer<DesktopEnvironment, never, Path.Path> {
  return Layer.effect(
    DesktopEnvironment,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const appDataDirectory = yield* Config.string("APPDATA").pipe(Config.option);
      const xdgConfigHome = yield* Config.string("XDG_CONFIG_HOME").pipe(Config.option);
      const serverEntryOverride = yield* Config.string("APP_SERVER_ENTRY").pipe(Config.option);
      const logDirOverride = yield* Config.string("APP_LOG_DIR").pipe(Config.option);
      const logLevel = yield* Config.string("APP_LOG_LEVEL").pipe(Config.option);
      const otlpTracesUrl = yield* Config.string("APP_OTLP_TRACES_URL").pipe(Config.option);
      const otlpExportIntervalMs = yield* Config.int("APP_OTLP_EXPORT_INTERVAL_MS").pipe(
        Config.option,
      );
      const configuredBackendPort = yield* Config.port("APP_SERVER_PORT").pipe(Config.option);
      const devServerUrl = yield* Config.url("APP_DEV_WEB_URL").pipe(Config.option);
      const appImagePath = yield* Config.string("APPIMAGE").pipe(Config.option);
      const disableAutoUpdate = yield* Config.boolean("APP_DISABLE_AUTO_UPDATE").pipe(
        Config.withDefault(false),
      );
      return makeWith(
        {
          ...metadata,
          appDataDirectory,
          xdgConfigHome,
          serverEntryOverride,
          logDirOverride,
          logLevel,
          otlpTracesUrl,
          otlpExportIntervalMs,
          configuredBackendPort,
          devServerUrl,
          appImagePath,
          disableAutoUpdate,
        },
        path,
      );
    }).pipe(
      // A malformed env value (e.g. a non-URL APP_DEV_WEB_URL) is a startup
      // misconfiguration; die rather than thread ConfigError through the graph.
      Effect.orDie,
    ),
  );
}
