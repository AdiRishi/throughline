import { describe, expect, it, vi } from "vitest";

import {
  isLinuxSetuidSandboxConfigured,
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveLinuxSandboxArgs,
  resolveLocalUserDataPath,
  resolveMacLauncherPaths,
} from "../../scripts/electron-launcher.mjs";

describe("Electron launcher", () => {
  it("uses captured development values only as fallbacks", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      userDataPath: "/Users/test/Library/Application Support/throughline-dev",
      environment: {
        APP_DEV_WEB_URL: "http://127.0.0.1:8526",
        APP_SERVER_PORT: "16566",
        APP_SERVER_ENTRY: "/repo/apps/server/dist/bin.mjs",
      },
    });

    expect(script).toContain(
      "if [ -z \"${APP_DEV_WEB_URL:-}\" ]; then export APP_DEV_WEB_URL='http://127.0.0.1:8526'; fi",
    );
    expect(script).not.toContain("\nexport APP_DEV_WEB_URL=");
    expect(script).toContain(
      "exec '/repo/node_modules/electron/Electron' --user-data-dir='/Users/test/Library/Application Support/throughline-dev' --throughline-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("quotes captured shell values without allowing command substitution", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/Electron",
      mainEntryPath: "/repo/main.cjs",
      desktopRoot: "/repo/it's-throughline",
      userDataPath: "/Users/test/it's data",
      environment: {
        APP_SERVER_ENTRY: "/tmp/it's $(not-executed)",
      },
    });

    expect(script).toContain("APP_SERVER_ENTRY='/tmp/it'\\''s $(not-executed)'");
    expect(script).toContain("--user-data-dir='/Users/test/it'\\''s data'");
    expect(script).toContain("--throughline-dev-root='/repo/it'\\''s-throughline'");
  });

  it("resolves the same platform data directories used by the desktop environment", () => {
    expect(
      resolveLocalUserDataPath({
        platform: "darwin",
        homeDirectory: "/Users/test",
        development: true,
      }),
    ).toBe("/Users/test/Library/Application Support/throughline-dev");
    expect(
      resolveLocalUserDataPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\test",
        environment: { APPDATA: "D:\\Roaming" },
        development: false,
      }),
    ).toBe("D:\\Roaming/throughline");
    expect(
      resolveLocalUserDataPath({
        platform: "linux",
        homeDirectory: "/home/test",
        environment: { XDG_CONFIG_HOME: "/state/config" },
        development: true,
      }),
    ).toBe("/state/config/throughline-dev");
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    expect(electronPath).toBe(
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    expect(calls).toEqual(["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/Throughline (Dev).app",
      "Throughline (Dev)",
    );

    expect(paths).toEqual({
      launcherExecutableName: "Throughline (Dev) Launcher",
      launcherBinaryPath:
        "/repo/apps/desktop/.electron-runtime/Throughline (Dev).app/Contents/MacOS/Throughline (Dev) Launcher",
      runtimeElectronBinaryPath:
        "/repo/apps/desktop/.electron-runtime/Throughline (Dev).app/Contents/MacOS/Electron",
    });
  });

  it("uses the Linux setuid sandbox only with the required owner and mode", () => {
    expect(
      isLinuxSetuidSandboxConfigured("/repo/electron", {
        platform: "linux",
        statSync: () => ({ uid: 0, mode: 0o104755 }),
      }),
    ).toBe(true);
    expect(
      isLinuxSetuidSandboxConfigured("/repo/electron", {
        platform: "linux",
        statSync: () => ({ uid: 501, mode: 0o104755 }),
      }),
    ).toBe(false);
    expect(
      isLinuxSetuidSandboxConfigured("/repo/electron", {
        platform: "linux",
        statSync: () => ({ uid: 0, mode: 0o100755 }),
      }),
    ).toBe(false);
  });

  it("adds the Linux development fallback only when the setuid sandbox is unusable", () => {
    const warn = vi.fn();
    const unavailable = resolveLinuxSandboxArgs("/repo/electron", {
      platform: "linux",
      statSync: () => {
        throw new Error("missing");
      },
      warn,
    });
    const configured = resolveLinuxSandboxArgs("/repo/electron", {
      platform: "linux",
      statSync: () => ({ uid: 0, mode: 0o104755 }),
      warn,
    });

    expect(unavailable).toEqual(["--no-sandbox"]);
    expect(configured).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
