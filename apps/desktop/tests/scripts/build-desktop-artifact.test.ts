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
  serializeStageWorkspaceConfig,
} from "../../../../scripts/build-desktop-artifact.ts";

describe("desktop build command", () => {
  it("resolves only supported platform, target, and architecture combinations", () => {
    expect(resolveDesktopBuildPlatform(undefined, "darwin")).toBe("mac");
    expect(resolveDesktopBuildPlatform(undefined, "win32")).toBe("win");
    expect(resolveDesktopBuildTarget("linux", undefined)).toBe("AppImage");
    expect(resolveDesktopBuildArch("mac", undefined, "arm64")).toBe("arm64");
    expect(resolveDesktopBuildArch("linux", "x64", "arm64")).toBe("x64");
    expect(resolveDesktopBuildArch("mac", "universal", "arm64")).toBe("universal");
    expect(() => resolveDesktopBuildPlatform("freebsd", "linux")).toThrow(
      "Unsupported desktop platform",
    );
    expect(() => resolveDesktopBuildTarget("mac", "zip")).toThrow("Unsupported mac desktop target");
    expect(() => resolveDesktopBuildArch("win", "universal", "x64")).toThrow(
      "Unsupported win desktop architecture",
    );
  });

  it("passes the selected architecture and config to electron-builder", () => {
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
});

describe("desktop builder configuration", () => {
  it("emits only the selected platform with the Throughline icon", () => {
    const mac = createElectronBuilderConfig({
      platform: "mac",
      target: "dmg",
      outputDirectory: "/release/dist",
      signed: false,
    });
    expect(mac.mac).toEqual({
      target: ["dmg"],
      category: "public.app-category.developer-tools",
      icon: "apps/desktop/resources/icon.png",
    });
    expect(mac).not.toHaveProperty("win");
    expect(mac).not.toHaveProperty("linux");

    const windows = createElectronBuilderConfig({
      platform: "win",
      target: "nsis",
      outputDirectory: "/release/dist",
      signed: false,
    });
    expect(windows.win).toEqual({
      target: ["nsis"],
      icon: "apps/desktop/resources/icon.png",
      signAndEditExecutable: true,
    });
  });

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
    expect(serializeStageWorkspaceConfig(config)).toContain("    - arm64\n    - x64\n");
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
