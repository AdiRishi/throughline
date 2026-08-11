// @effect-diagnostics nodeBuiltinImport:off - Tests standalone Node path resolution.
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readWorkspaceAllowBuilds,
  resolveDesktopArtifactOptions,
  resolveGenericPublishConfig,
  resolveGitHubPublishConfig,
  resolveUpdateChannel,
} from "../build-desktop-artifact.ts";

describe("resolveDesktopArtifactOptions", () => {
  it("defaults to the host platform, architecture, and desktop package version", () => {
    const options = resolveDesktopArtifactOptions({
      argv: [],
      env: {},
      hostPlatform: "darwin",
      hostArch: "arm64",
      desktopVersion: "1.2.3",
    });

    expect(options).toMatchObject({
      platform: "mac",
      target: "dmg",
      arch: "arm64",
      version: "1.2.3",
      skipBuild: false,
      keepStage: false,
      signed: false,
    });
    expect(options.outputDir).toMatch(/release\/dist$/u);
  });

  it("honours explicit release inputs", () => {
    expect(
      resolveDesktopArtifactOptions({
        argv: [
          "--platform",
          "mac",
          "--target=zip",
          "--arch",
          "universal",
          "--build-version",
          "2.0.0-nightly.4",
          "--output-dir",
          "/tmp/throughline-artifacts",
          "--skip-build",
          "--keep-stage",
          "--signed",
        ],
        env: {},
        hostPlatform: "darwin",
        hostArch: "arm64",
        desktopVersion: "1.2.3",
      }),
    ).toEqual({
      platform: "mac",
      target: "zip",
      arch: "universal",
      version: "2.0.0-nightly.4",
      outputDir: NodePath.resolve("/tmp/throughline-artifacts"),
      skipBuild: true,
      keepStage: true,
      signed: true,
    });
  });

  it("rejects platform and architecture combinations electron-builder cannot produce", () => {
    expect(() =>
      resolveDesktopArtifactOptions({
        argv: ["--platform", "win", "--arch", "universal"],
        env: {},
        hostPlatform: "darwin",
        hostArch: "arm64",
        desktopVersion: "1.2.3",
      }),
    ).toThrow("Unsupported architecture 'universal' for win");
  });
});

// The helpers read the ambient environment, so every case pins all of the
// variables it depends on — a CI runner exports GITHUB_REPOSITORY itself.
const stubEnv = (env: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveGitHubPublishConfig", () => {
  it("resolves a release feed for the latest channel", () => {
    stubEnv({
      APP_DESKTOP_UPDATE_REPOSITORY: "arishi/throughline",
      GITHUB_REPOSITORY: undefined,
    });

    expect(resolveGitHubPublishConfig("latest")).toEqual({
      provider: "github",
      owner: "arishi",
      repo: "throughline",
      releaseType: "release",
    });
  });

  it("resolves a prerelease feed for the nightly channel", () => {
    stubEnv({
      APP_DESKTOP_UPDATE_REPOSITORY: undefined,
      GITHUB_REPOSITORY: "arishi/throughline",
    });

    expect(resolveGitHubPublishConfig("nightly")).toEqual({
      provider: "github",
      owner: "arishi",
      repo: "throughline",
      releaseType: "prerelease",
      channel: "nightly",
    });
  });

  it("prefers the explicit override over GITHUB_REPOSITORY", () => {
    stubEnv({
      APP_DESKTOP_UPDATE_REPOSITORY: "arishi/throughline",
      GITHUB_REPOSITORY: "someone/else",
    });

    expect(resolveGitHubPublishConfig("latest")).toMatchObject({
      owner: "arishi",
      repo: "throughline",
    });
  });

  it("rejects a repository that is not exactly owner/repo", () => {
    for (const rawRepo of ["arishi/throughline/extra", "throughline", "/throughline", "arishi/"]) {
      stubEnv({ APP_DESKTOP_UPDATE_REPOSITORY: rawRepo, GITHUB_REPOSITORY: undefined });
      expect(resolveGitHubPublishConfig("latest")).toBeUndefined();
    }
  });

  it("omits the feed when no repository is configured", () => {
    stubEnv({
      APP_DESKTOP_UPDATE_REPOSITORY: "   ",
      GITHUB_REPOSITORY: undefined,
    });

    expect(resolveGitHubPublishConfig("latest")).toBeUndefined();
  });
});

describe("resolveGenericPublishConfig", () => {
  it("uses the static host URL when one is set", () => {
    stubEnv({ APP_DESKTOP_UPDATE_URL: " https://updates.example.com/throughline " });

    expect(resolveGenericPublishConfig()).toEqual({
      provider: "generic",
      url: "https://updates.example.com/throughline",
    });
  });

  it("omits the feed when the URL is unset or blank", () => {
    stubEnv({ APP_DESKTOP_UPDATE_URL: undefined });
    expect(resolveGenericPublishConfig()).toBeUndefined();

    stubEnv({ APP_DESKTOP_UPDATE_URL: "  " });
    expect(resolveGenericPublishConfig()).toBeUndefined();
  });
});

describe("resolveUpdateChannel", () => {
  it("only switches to nightly for the exact channel name", () => {
    stubEnv({ APP_DESKTOP_UPDATE_CHANNEL: " nightly " });
    expect(resolveUpdateChannel()).toBe("nightly");

    stubEnv({ APP_DESKTOP_UPDATE_CHANNEL: "beta" });
    expect(resolveUpdateChannel()).toBe("latest");

    stubEnv({ APP_DESKTOP_UPDATE_CHANNEL: undefined });
    expect(resolveUpdateChannel()).toBe("latest");
  });
});

describe("readWorkspaceAllowBuilds", () => {
  it("carries the root workspace's allowBuilds block over verbatim", () => {
    // A staged `pnpm install --prod` fails with ERR_PNPM_IGNORED_BUILDS unless
    // these come across, and the sibling blocks (`catalog:`, `overrides:`) are
    // indented the same way, so a parser that never leaves the block picks up
    // unrelated keys.
    expect(readWorkspaceAllowBuilds()).toEqual({
      electron: true,
      "electron-winstaller": false,
      "msgpackr-extract": true,
    });
  });
});
