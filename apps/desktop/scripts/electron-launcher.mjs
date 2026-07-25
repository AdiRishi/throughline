// The stock Electron bundle identifies local runs as "Electron". This launcher
// gives Throughline's native development process a real app identity while
// keeping Electron's default-app runtime semantics.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const isDevelopment = Boolean(process.env.APP_DEV_WEB_URL);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const desktopDir = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "..", "..");
const devBundleIdSuffix = NodePath.basename(repoRoot)
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "");
export const APP_DISPLAY_NAME = isDevelopment ? "Throughline (Dev)" : "Throughline";
export const APP_BUNDLE_ID = isDevelopment
  ? `com.arsoftware.throughline.dev.${devBundleIdSuffix || "local"}`
  : "com.arsoftware.throughline";
const LAUNCHER_VERSION = 1;
const defaultIconPath = NodePath.join(desktopDir, "resources", "icon.icns");
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function setPlistString(plistPath, key, value) {
  const replaceResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    { encoding: "utf8" },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plistPath],
    { encoding: "utf8" },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function makeDevelopmentLauncherScript({
  electronBinaryPath,
  mainEntryPath,
  desktopRoot,
  userDataPath,
  environment,
}) {
  const envEntries = [
    ["APP_DEV_WEB_URL", environment.APP_DEV_WEB_URL],
    ["APP_SERVER_PORT", environment.APP_SERVER_PORT],
    ["APP_SERVER_ENTRY", environment.APP_SERVER_ENTRY],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].trim().length > 0);

  return [
    "#!/bin/sh",
    ...envEntries.map(
      ([name, value]) =>
        `if [ -z "\${${name}:-}" ]; then export ${name}=${shellSingleQuote(value)}; fi`,
    ),
    `exec ${shellSingleQuote(electronBinaryPath)} --user-data-dir=${shellSingleQuote(userDataPath)} --throughline-dev-root=${shellSingleQuote(desktopRoot)} ${shellSingleQuote(mainEntryPath)} "$@"`,
    "",
  ].join("\n");
}

function writeDevelopmentLauncherScript(targetBinaryPath, electronBinaryPath) {
  NodeFS.writeFileSync(
    targetBinaryPath,
    makeDevelopmentLauncherScript({
      electronBinaryPath,
      mainEntryPath: NodePath.join(desktopDir, "dist-electron", "main.cjs"),
      desktopRoot: desktopDir,
      userDataPath: resolveLocalUserDataPath(),
      environment: process.env,
    }),
  );
  NodeFS.chmodSync(targetBinaryPath, 0o755);
}

function registerMacLauncherBundle(appBundlePath) {
  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundlePath],
  );
}

function patchMainBundleInfoPlist(appBundlePath, executableName) {
  const infoPlistPath = NodePath.join(appBundlePath, "Contents", "Info.plist");
  setPlistString(infoPlistPath, "CFBundleDisplayName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleName", APP_DISPLAY_NAME);
  setPlistString(infoPlistPath, "CFBundleIdentifier", APP_BUNDLE_ID);
  setPlistString(infoPlistPath, "CFBundleExecutable", executableName);
  setPlistString(infoPlistPath, "CFBundleIconFile", "icon.icns");

  const resourcesDir = NodePath.join(appBundlePath, "Contents", "Resources");
  NodeFS.copyFileSync(defaultIconPath, NodePath.join(resourcesDir, "icon.icns"));
  NodeFS.copyFileSync(defaultIconPath, NodePath.join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const helperBundleNames = [
    ["Electron Helper.app", "helper", `${APP_DISPLAY_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${APP_DISPLAY_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${APP_DISPLAY_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${APP_DISPLAY_NAME} Helper (Renderer)`],
  ];

  for (const [bundleName, bundleIdentifierSuffix, bundleDisplayName] of helperBundleNames) {
    const infoPlistPath = NodePath.join(
      appBundlePath,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!NodeFS.existsSync(infoPlistPath)) {
      continue;
    }

    setPlistString(infoPlistPath, "CFBundleDisplayName", bundleDisplayName);
    setPlistString(infoPlistPath, "CFBundleName", bundleDisplayName);
    setPlistString(
      infoPlistPath,
      "CFBundleIdentifier",
      `${APP_BUNDLE_ID}.${bundleIdentifierSuffix}`,
    );
  }
}

function readJson(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveMacLauncherPaths(appBundlePath, displayName = APP_DISPLAY_NAME) {
  const executableDir = NodePath.join(appBundlePath, "Contents", "MacOS");
  const launcherExecutableName = `${displayName} Launcher`;
  return {
    launcherExecutableName,
    launcherBinaryPath: NodePath.join(executableDir, launcherExecutableName),
    runtimeElectronBinaryPath: NodePath.join(executableDir, "Electron"),
  };
}

function buildMacLauncher(electronBinaryPath) {
  const sourceAppBundlePath = NodePath.resolve(NodePath.dirname(electronBinaryPath), "../..");
  const runtimeDir = NodePath.join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = NodePath.join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const developmentPaths = resolveMacLauncherPaths(targetAppBundlePath);
  const runtimeElectronBinaryPath = developmentPaths.runtimeElectronBinaryPath;
  const launcherBinaryPath = isDevelopment
    ? developmentPaths.launcherBinaryPath
    : runtimeElectronBinaryPath;
  const metadataPath = NodePath.join(runtimeDir, "metadata.json");

  NodeFS.mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: NodeFS.statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: NodeFS.statSync(defaultIconPath).mtimeMs,
    appBundleId: APP_BUNDLE_ID,
  };

  const currentMetadata = readJson(metadataPath);
  if (
    NodeFS.existsSync(launcherBinaryPath) &&
    (!isDevelopment || NodeFS.existsSync(runtimeElectronBinaryPath)) &&
    currentMetadata &&
    JSON.stringify(currentMetadata) === JSON.stringify(expectedMetadata)
  ) {
    if (isDevelopment) {
      writeDevelopmentLauncherScript(launcherBinaryPath, runtimeElectronBinaryPath);
    }
    registerMacLauncherBundle(targetAppBundlePath);
    return launcherBinaryPath;
  }

  NodeFS.rmSync(targetAppBundlePath, { recursive: true, force: true });
  // Keep Electron.framework's relative symlinks relative. Rewriting them to
  // node_modules paths makes sandboxed helper processes fail to find resources.
  NodeFS.cpSync(sourceAppBundlePath, targetAppBundlePath, {
    recursive: true,
    verbatimSymlinks: true,
  });
  patchMainBundleInfoPlist(
    targetAppBundlePath,
    isDevelopment ? developmentPaths.launcherExecutableName : "Electron",
  );
  patchHelperBundleInfoPlists(targetAppBundlePath);
  if (isDevelopment) {
    // Electron must retain its native executable name so the cloned development
    // bundle still runs as Electron's default app (app.isPackaged === false).
    writeDevelopmentLauncherScript(launcherBinaryPath, runtimeElectronBinaryPath);
  }
  NodeFS.writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  registerMacLauncherBundle(targetAppBundlePath);

  return launcherBinaryPath;
}

export function isLinuxSetuidSandboxConfigured(
  electronBinaryPath,
  { platform = hostPlatform, statSync = NodeFS.statSync } = {},
) {
  if (platform !== "linux") {
    return true;
  }

  const sandboxPath = NodePath.join(NodePath.dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = statSync(sandboxPath);
    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

export function resolveLinuxSandboxArgs(
  electronBinaryPath,
  {
    platform = hostPlatform,
    statSync = NodeFS.statSync,
    warn = (message) => process.stderr.write(`${message}\n`),
  } = {},
) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath, { platform, statSync })) {
    return [];
  }

  warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );
  return ["--no-sandbox"];
}

export function resolveElectronBinaryPath({
  ensureRuntime = ensureElectronRuntime,
  createRequire = NodeModule.createRequire,
  moduleUrl = import.meta.url,
} = {}) {
  ensureRuntime();

  const require = createRequire(moduleUrl);
  return require("electron");
}

export function resolveElectronPath() {
  const electronBinaryPath = resolveElectronBinaryPath();
  return hostPlatform === "darwin" ? buildMacLauncher(electronBinaryPath) : electronBinaryPath;
}

export function resolveLocalUserDataPath({
  environment = process.env,
  homeDirectory = NodeOS.homedir(),
  platform = hostPlatform,
  development = isDevelopment,
} = {}) {
  const directoryName = development ? "throughline-dev" : "throughline";
  if (platform === "win32") {
    const appData = environment.APPDATA?.trim();
    return NodePath.join(
      appData && appData.length > 0 ? appData : NodePath.join(homeDirectory, "AppData", "Roaming"),
      directoryName,
    );
  }
  if (platform === "darwin") {
    return NodePath.join(homeDirectory, "Library", "Application Support", directoryName);
  }
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  return NodePath.join(
    xdgConfigHome && xdgConfigHome.length > 0
      ? xdgConfigHome
      : NodePath.join(homeDirectory, ".config"),
    directoryName,
  );
}

export function resolveElectronLaunchCommand(args = []) {
  const electronPath = resolveElectronPath();
  const userDataArgs =
    hostPlatform === "darwin" && isDevelopment
      ? []
      : [`--user-data-dir=${resolveLocalUserDataPath()}`];
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath), ...userDataArgs, ...args],
  };
}

export function resolveDevelopmentLauncher() {
  if (hostPlatform !== "darwin" || !isDevelopment) {
    return null;
  }

  const electronBinaryPath = resolveElectronBinaryPath();
  const launcherBinaryPath = buildMacLauncher(electronBinaryPath);
  return {
    appBundlePath: NodePath.resolve(launcherBinaryPath, "..", "..", ".."),
    appBundleId: APP_BUNDLE_ID,
  };
}
