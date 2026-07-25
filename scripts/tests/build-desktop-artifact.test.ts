import { describe, expect, it } from "vitest";

import {
  createElectronBuilderArgs,
  createElectronBuilderConfig,
  createStageWorkspaceConfig,
  resolveDesktopBuildArch,
  resolveDesktopBuilderEnvironment,
  resolveDesktopBuildInvocation,
  resolveDesktopBuildPlatform,
  resolveDesktopBuildTarget,
  resolveDesktopBuildVersion,
  resolveDesktopUpdateChannel,
  resolveGitHubPublishConfig,
  serializeStageWorkspaceConfig,
} from "../build-desktop-artifact.ts";

describe("desktop build command", () => {
  it("resolves only the supported platform and target pairs", () => {
    expect(resolveDesktopBuildPlatform(undefined, "darwin")).toBe("mac");
    expect(resolveDesktopBuildPlatform(undefined, "win32")).toBe("win");
    expect(resolveDesktopBuildTarget("linux", undefined)).toBe("AppImage");
    expect(() => resolveDesktopBuildPlatform("freebsd", "linux")).toThrow(
      "Unsupported desktop platform",
    );
    expect(() => resolveDesktopBuildTarget("mac", "zip")).toThrow("Unsupported mac desktop target");
  });

  it("validates target architectures and follows the host architecture by default", () => {
    expect(resolveDesktopBuildArch("mac", undefined, "arm64", "darwin")).toBe("arm64");
    expect(resolveDesktopBuildArch("linux", "x64", "arm64", "linux")).toBe("x64");
    expect(resolveDesktopBuildArch("mac", "universal", "arm64", "darwin")).toBe("universal");
    expect(() => resolveDesktopBuildArch("win", "universal", "x64", "win32")).toThrow(
      "Unsupported win desktop architecture",
    );
  });

  it("detects Windows on Arm when x64 Node is running under emulation", () => {
    expect(
      resolveDesktopBuildArch("win", undefined, "x64", "win32", {
        PROCESSOR_ARCHITECTURE: "AMD64",
        PROCESSOR_ARCHITEW6432: "ARM64",
      }),
    ).toBe("arm64");
  });

  it("passes the validated architecture and absolute config path to electron-builder", () => {
    expect(
      createElectronBuilderArgs(
        "mac",
        "arm64",
        "/work tree/release/app",
        "/work tree/release/electron-builder.json",
      ),
    ).toEqual([
      "--filter",
      "@app/desktop",
      "exec",
      "electron-builder",
      "--projectDir",
      "/work tree/release/app",
      "--mac",
      "--arm64",
      "--config",
      "/work tree/release/electron-builder.json",
      "--publish",
      "never",
    ]);
  });

  it("escapes a resolved Windows pnpm.cmd shim without interpreting its arguments", () => {
    const invocation = resolveDesktopBuildInvocation(
      "pnpm",
      ["--filter", "@app/web", "build & verify", "%PATH%"],
      "win32",
      {},
      () => "C:\\Program Files\\npm & tools\\pnpm.cmd",
    );

    expect(invocation.shell).toBe(true);
    expect(invocation.command).not.toContain(" & ");
    expect(invocation.command).toContain("^&");
    expect(invocation.args).toEqual([
      '^"--filter^"',
      '^"@app/web^"',
      '^"build^ ^&^ verify^"',
      '^"^%PATH^%^"',
    ]);
  });

  it("runs ordinary executables directly", () => {
    expect(resolveDesktopBuildInvocation("pnpm", ["test"], "linux")).toEqual({
      command: "pnpm",
      args: ["test"],
      shell: false,
    });
    expect(
      resolveDesktopBuildInvocation("node.exe", ["script.js"], "win32", {}, () => "node.exe"),
    ).toEqual({
      command: "node.exe",
      args: ["script.js"],
      shell: false,
    });
  });
});

describe("resolveDesktopBuildVersion", () => {
  it("prefers explicit release metadata over the package version", () => {
    expect(resolveDesktopBuildVersion(" 1.4.0 ", "1.3.0", "0.0.0")).toBe("1.4.0");
    expect(resolveDesktopBuildVersion(undefined, " 1.3.0 ", "0.0.0")).toBe("1.3.0");
  });

  it("uses the desktop package version for ordinary local builds", () => {
    expect(resolveDesktopBuildVersion(undefined, undefined, "0.0.0")).toBe("0.0.0");
    expect(resolveDesktopBuildVersion(" ", "", "0.0.0")).toBe("0.0.0");
  });
});

describe("resolveDesktopUpdateChannel", () => {
  it("recognizes release workflow nightly versions", () => {
    expect(resolveDesktopUpdateChannel("1.4.0-nightly.20260725.2")).toBe("nightly");
    expect(resolveDesktopUpdateChannel("1.4.0-beta.2")).toBe("latest");
    expect(resolveDesktopUpdateChannel("1.4.0")).toBe("latest");
  });
});

describe("resolveGitHubPublishConfig", () => {
  it("prefers the dedicated updater repository and configures stable releases", () => {
    expect(resolveGitHubPublishConfig("throughline/updates", "latest", true)).toEqual({
      provider: "github",
      owner: "throughline",
      repo: "updates",
      releaseType: "release",
    });
  });

  it("configures the nightly channel only for an explicit signed updater build", () => {
    expect(resolveGitHubPublishConfig("throughline/app", "nightly", true)).toEqual({
      provider: "github",
      owner: "throughline",
      repo: "app",
      releaseType: "prerelease",
      channel: "nightly",
    });
  });

  it("leaves ordinary local builds feed-free and rejects unsafe release intent", () => {
    expect(resolveGitHubPublishConfig(undefined, "latest", false)).toBeUndefined();
    expect(() => resolveGitHubPublishConfig("throughline/app", "latest", false)).toThrow(
      "requires a signed build",
    );
    expect(() => resolveGitHubPublishConfig("throughline", "latest", true)).toThrow(
      "Invalid desktop updater repository",
    );
    expect(() => resolveGitHubPublishConfig("throughline/app/extra", "latest", true)).toThrow(
      "Invalid desktop updater repository",
    );
  });
});

describe("createElectronBuilderConfig", () => {
  it("keeps ordinary local packages feed-free and preserves their requested target", () => {
    const config = createElectronBuilderConfig({
      platform: "mac",
      target: "dmg",
      outputDirectory: "/release/dist",
      publishConfig: undefined,
      signed: false,
    });

    expect(config).not.toHaveProperty("publish");
    expect(config.artifactName).toBe("Throughline-${version}-${arch}.${ext}");
    expect(config.mac).toEqual({
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      icon: "apps/desktop/resources/icon.icns",
    });
    expect(config).not.toHaveProperty("win");
    expect(config).not.toHaveProperty("linux");
  });

  it("emits only the selected Windows or Linux target configuration", () => {
    const windows = createElectronBuilderConfig({
      platform: "win",
      target: "nsis",
      outputDirectory: "/release/dist",
      publishConfig: undefined,
      signed: false,
    });
    expect(windows).not.toHaveProperty("mac");
    expect(windows).not.toHaveProperty("linux");
    expect(windows.win).toEqual({
      target: ["nsis"],
      icon: "apps/desktop/resources/icon.ico",
      signAndEditExecutable: true,
    });

    const linux = createElectronBuilderConfig({
      platform: "linux",
      target: "AppImage",
      outputDirectory: "/release/dist",
      publishConfig: undefined,
      signed: false,
    });
    expect(linux).not.toHaveProperty("mac");
    expect(linux).not.toHaveProperty("win");
    expect(linux.linux).toEqual({
      target: ["AppImage"],
      executableName: "throughline",
      category: "Development",
      icon: "apps/desktop/resources/icons",
      desktop: {
        entry: {
          StartupWMClass: "throughline",
        },
      },
    });
  });

  it("includes the update provider and macOS update payload in release packages", () => {
    const publishConfig = resolveGitHubPublishConfig("throughline/updates", "nightly", true);
    const config = createElectronBuilderConfig({
      platform: "mac",
      target: "dmg",
      outputDirectory: "/release/dist",
      publishConfig,
      signed: true,
    });

    expect(config.publish).toEqual([publishConfig]);
    expect(config.artifactName).toBe("Throughline-${version}-${arch}.${ext}");
    expect(config.mac).toEqual({
      target: ["dmg", "zip"],
      category: "public.app-category.developer-tools",
      icon: "apps/desktop/resources/icon.icns",
      notarize: true,
    });
  });
});

describe("staged desktop workspace", () => {
  it("installs target-architecture optional packages for cross-architecture builds", () => {
    const config = createStageWorkspaceConfig("mac", "universal", {
      electron: true,
    });

    expect(config).toEqual({
      supportedArchitectures: {
        os: ["darwin"],
        cpu: ["arm64", "x64"],
      },
      allowBuilds: {
        electron: true,
      },
    });
    expect(serializeStageWorkspaceConfig(config)).toBe(
      [
        "packages: []",
        "supportedArchitectures:",
        "  os:",
        "    - darwin",
        "  cpu:",
        "    - arm64",
        "    - x64",
        "allowBuilds:",
        "  electron: true",
        "",
      ].join("\n"),
    );
  });

  it("pins Linux native optional dependencies to glibc", () => {
    expect(createStageWorkspaceConfig("linux", "x64")).toEqual({
      supportedArchitectures: {
        os: ["linux"],
        cpu: ["x64"],
        libc: ["glibc"],
      },
    });
  });
});

describe("desktop builder environment", () => {
  it("prevents unsigned builds from discovering release credentials", () => {
    expect(
      resolveDesktopBuilderEnvironment(false, {
        PATH: "/bin",
        EMPTY_VALUE: "",
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: "password",
        APPLE_API_KEY: "/keys/key.p8",
        APPLE_API_KEY_ID: "key-id",
        APPLE_API_ISSUER: "issuer",
      }),
    ).toEqual({
      PATH: "/bin",
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });
  });

  it("retains configured credentials for explicit signed builds", () => {
    expect(
      resolveDesktopBuilderEnvironment(true, {
        CSC_LINK: "certificate",
        CSC_KEY_PASSWORD: "password",
      }),
    ).toEqual({
      CSC_LINK: "certificate",
      CSC_KEY_PASSWORD: "password",
    });
  });
});
