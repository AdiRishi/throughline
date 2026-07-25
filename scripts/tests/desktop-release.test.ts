import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assembleProductionRelease,
  collectBuildArtifacts,
  resolveReleaseMetadata,
  validateReleaseVersion,
  type ReleaseArchitecture,
  type ReleaseChannel,
  type ReleasePlatform,
} from "../desktop-release.ts";
import { serializeUpdateManifest, type UpdateManifest } from "../lib/update-manifest.ts";

const SHA = "1234567890abcdef1234567890abcdef12345678";
const VERSION = "1.4.0";

let directory: string;

beforeEach(() => {
  directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-release-"));
});

afterEach(() => {
  NodeFS.rmSync(directory, { recursive: true, force: true });
});

function artifactBase(arch: ReleaseArchitecture): string {
  return `Throughline-${VERSION}-${arch}`;
}

function writeProductionBuild(
  platform: ReleasePlatform,
  arch: ReleaseArchitecture,
  channel: ReleaseChannel = "stable",
): string {
  const source = NodePath.join(directory, `source-${platform}-${arch}`);
  const destination = NodePath.join(directory, "release");
  NodeFS.mkdirSync(source, { recursive: true });
  const base = artifactBase(arch);
  const writeSource = (name: string, contents = name) => {
    NodeFS.writeFileSync(NodePath.join(source, name), contents);
  };

  if (platform === "mac") {
    writeSource(`${base}.dmg`);
    writeSource(`${base}.zip`);
    writeSource(`${base}.zip.blockmap`);
    const files = [`${base}.dmg`, `${base}.zip`];
    const manifest: UpdateManifest = {
      version: VERSION,
      files: files.map((name) => {
        const contents = NodeFS.readFileSync(NodePath.join(source, name));
        return {
          url: name,
          sha512: NodeCrypto.createHash("sha512").update(contents).digest("base64"),
          size: contents.byteLength,
        };
      }),
      releaseDate: arch === "arm64" ? "2026-07-25T02:03:04.000Z" : "2026-07-25T02:04:05.000Z",
      extras: {},
    };
    writeSource(
      channel === "stable" ? "latest-mac.yml" : "nightly-mac.yml",
      serializeUpdateManifest(manifest),
    );
  } else {
    const extension = platform === "win" ? "exe" : "AppImage";
    const installer = `${base}.${extension}`;
    const blockMapSize = 4;
    if (platform === "linux") {
      const sizeHeader = Buffer.alloc(4);
      sizeHeader.writeUInt32BE(blockMapSize);
      NodeFS.writeFileSync(
        NodePath.join(source, installer),
        Buffer.concat([Buffer.from("appimage"), Buffer.alloc(blockMapSize), sizeHeader]),
      );
    } else {
      writeSource(installer);
      writeSource(`${installer}.blockmap`);
    }
    const contents = NodeFS.readFileSync(NodePath.join(source, installer));
    const manifest: UpdateManifest = {
      version: VERSION,
      files: [
        {
          url: installer,
          sha512: NodeCrypto.createHash("sha512").update(contents).digest("base64"),
          size: contents.byteLength,
          ...(platform === "linux" ? { blockMapSize } : {}),
        },
      ],
      releaseDate: "2026-07-25T02:03:04.000Z",
      extras: {},
    };
    const manifestName =
      platform === "win"
        ? channel === "stable"
          ? "latest.yml"
          : "nightly.yml"
        : channel === "stable"
          ? "latest-linux.yml"
          : "nightly-linux.yml";
    writeSource(manifestName, serializeUpdateManifest(manifest));
  }

  collectBuildArtifacts({
    sourceDirectory: source,
    destinationDirectory: destination,
    version: VERSION,
    channel,
    sha: SHA,
    platform,
    arch,
    mode: "production",
  });
  return destination;
}

describe("release metadata", () => {
  it("accepts only exact stable and nightly version shapes", () => {
    expect(validateReleaseVersion("stable", "1.2.3")).toBe("1.2.3");
    expect(validateReleaseVersion("nightly", "1.2.3-nightly.20260725.42")).toBe(
      "1.2.3-nightly.20260725.42",
    );

    for (const invalid of ["v1.2.3", "1.2", "01.2.3", "1.2.3-beta.1", " 1.2.3"]) {
      expect(() => validateReleaseVersion("stable", invalid)).toThrow("must be exactly X.Y.Z");
    }
    for (const invalid of [
      "1.2.3",
      "1.2.3-nightly.20260230.1",
      "1.2.3-nightly.20260725.0",
      "1.2.3-nightly.20260725.1-extra",
    ]) {
      expect(() => validateReleaseVersion("nightly", invalid)).toThrow(
        /must be exactly|Invalid nightly release date/u,
      );
    }
  });

  it("pins tags and names to the full preflight commit", () => {
    expect(resolveReleaseMetadata({ channel: "stable", version: VERSION, sha: SHA })).toEqual({
      channel: "stable",
      version: VERSION,
      tag: "v1.4.0",
      releaseName: "Throughline v1.4.0",
      prerelease: false,
      makeLatest: true,
      sha: SHA,
      shortSha: "1234567890ab",
    });
    expect(
      resolveReleaseMetadata({
        channel: "nightly",
        version: "1.4.1-nightly.20260725.18",
        sha: SHA,
      }),
    ).toMatchObject({
      tag: "v1.4.1-nightly.20260725.18",
      prerelease: true,
      makeLatest: false,
    });
    expect(() =>
      resolveReleaseMetadata({ channel: "stable", version: VERSION, sha: "1234" }),
    ).toThrow("full Git commit hash");
  });

  it("writes validated metadata to the GitHub Actions output file", () => {
    const outputPath = NodePath.join(directory, "github-output");
    const scriptPath = NodeURL.fileURLToPath(new URL("../desktop-release.ts", import.meta.url));

    NodeChildProcess.execFileSync("node", [
      scriptPath,
      "metadata",
      "--channel",
      "stable",
      "--version",
      VERSION,
      "--sha",
      SHA,
      "--github-output",
      outputPath,
    ]);

    expect(NodeFS.readFileSync(outputPath, "utf8").trim().split("\n")).toEqual(
      expect.arrayContaining([
        "channel=stable",
        `version=${VERSION}`,
        `sha=${SHA}`,
        `tag=v${VERSION}`,
      ]),
    );
  });
});

describe("build artifact collection", () => {
  it("collects only the exact unsigned installer and records validation provenance", () => {
    const source = NodePath.join(directory, "source");
    const destination = NodePath.join(directory, "validation");
    NodeFS.mkdirSync(source);
    NodeFS.writeFileSync(NodePath.join(source, `Throughline-${VERSION}-arm64.dmg`), "dmg");
    NodeFS.writeFileSync(NodePath.join(source, "latest-mac.yml"), "must not escape");
    NodeFS.writeFileSync(NodePath.join(source, "unrelated.txt"), "must not escape");

    const provenance = collectBuildArtifacts({
      sourceDirectory: source,
      destinationDirectory: destination,
      version: VERSION,
      channel: "stable",
      sha: SHA,
      platform: "mac",
      arch: "arm64",
      mode: "validation",
    });

    expect(provenance.mode).toBe("validation");
    expect(provenance.artifacts).toEqual([`Throughline-${VERSION}-arm64.dmg`]);
    expect(NodeFS.readdirSync(destination).toSorted()).toEqual([
      `Throughline-${VERSION}-arm64.dmg`,
      `Throughline-${VERSION}-mac-arm64.provenance.json`,
    ]);
  });

  it("fails when a required updater payload or manifest is absent", () => {
    const source = NodePath.join(directory, "source");
    NodeFS.mkdirSync(source);
    NodeFS.writeFileSync(NodePath.join(source, `Throughline-${VERSION}-x64.exe`), "exe");

    expect(() =>
      collectBuildArtifacts({
        sourceDirectory: source,
        destinationDirectory: NodePath.join(directory, "production"),
        version: VERSION,
        channel: "stable",
        sha: SHA,
        platform: "win",
        arch: "x64",
        mode: "production",
      }),
    ).toThrow("Missing required production release artifact");
  });

  it("collects the dedicated nightly updater channel", () => {
    const version = "1.4.1-nightly.20260725.42";
    const source = NodePath.join(directory, "source-nightly");
    const destination = NodePath.join(directory, "production-nightly");
    const installer = `Throughline-${version}-x64.exe`;
    NodeFS.mkdirSync(source);
    NodeFS.writeFileSync(NodePath.join(source, installer), "installer");
    NodeFS.writeFileSync(NodePath.join(source, `${installer}.blockmap`), "blockmap");
    const installerContents = NodeFS.readFileSync(NodePath.join(source, installer));
    NodeFS.writeFileSync(
      NodePath.join(source, "nightly.yml"),
      serializeUpdateManifest({
        version,
        files: [
          {
            url: installer,
            sha512: NodeCrypto.createHash("sha512").update(installerContents).digest("base64"),
            size: installerContents.byteLength,
          },
        ],
        releaseDate: "2026-07-25T02:03:04.000Z",
        extras: {},
      }),
    );

    const provenance = collectBuildArtifacts({
      sourceDirectory: source,
      destinationDirectory: destination,
      version,
      channel: "nightly",
      sha: SHA,
      platform: "win",
      arch: "x64",
      mode: "production",
    });

    expect(provenance.channel).toBe("nightly");
    expect(provenance.artifacts).toContain("nightly.yml");
    expect(NodeFS.existsSync(NodePath.join(destination, "latest.yml"))).toBe(false);
  });
});

describe("production release assembly", () => {
  it("merges both macOS architectures and verifies every manifest asset", () => {
    const releaseDirectory = writeProductionBuild("mac", "arm64");
    writeProductionBuild("mac", "x64");
    writeProductionBuild("linux", "x64");
    writeProductionBuild("win", "x64");

    assembleProductionRelease({
      directory: releaseDirectory,
      version: VERSION,
      channel: "stable",
      sha: SHA,
    });

    const merged = NodeFS.readFileSync(NodePath.join(releaseDirectory, "latest-mac.yml"), "utf8");
    expect(merged).toContain(`Throughline-${VERSION}-arm64.zip`);
    expect(merged).toContain(`Throughline-${VERSION}-x64.zip`);
    expect(NodeFS.existsSync(NodePath.join(releaseDirectory, "latest-mac-arm64.yml"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(releaseDirectory, "latest-mac-x64.yml"))).toBe(false);
  });

  it("rejects updater metadata that does not match the release payload", () => {
    const releaseDirectory = writeProductionBuild("mac", "arm64");
    writeProductionBuild("mac", "x64");
    writeProductionBuild("linux", "x64");
    writeProductionBuild("win", "x64");

    NodeFS.appendFileSync(
      NodePath.join(releaseDirectory, "latest-linux.yml"),
      "releaseName: tampered\n",
    );
    NodeFS.appendFileSync(
      NodePath.join(releaseDirectory, `Throughline-${VERSION}-x64.AppImage`),
      "tampered",
    );

    expect(() =>
      assembleProductionRelease({
        directory: releaseDirectory,
        version: VERSION,
        channel: "stable",
        sha: SHA,
      }),
    ).toThrow(/wrong size|wrong sha512/u);
    expect(NodeFS.existsSync(NodePath.join(releaseDirectory, "latest-mac-arm64.yml"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(releaseDirectory, "latest-mac-x64.yml"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(releaseDirectory, "latest-mac.yml"))).toBe(false);
  });

  it("rejects an incorrect embedded AppImage block map size", () => {
    const releaseDirectory = writeProductionBuild("mac", "arm64");
    writeProductionBuild("mac", "x64");
    writeProductionBuild("linux", "x64");
    writeProductionBuild("win", "x64");

    const manifestPath = NodePath.join(releaseDirectory, "latest-linux.yml");
    NodeFS.writeFileSync(
      manifestPath,
      NodeFS.readFileSync(manifestPath, "utf8").replace("blockMapSize: 4", "blockMapSize: 3"),
    );

    expect(() =>
      assembleProductionRelease({
        directory: releaseDirectory,
        version: VERSION,
        channel: "stable",
        sha: SHA,
      }),
    ).toThrow("wrong embedded block map size");
  });

  it("rejects manifests that reference URLs instead of uploaded asset basenames", () => {
    const releaseDirectory = writeProductionBuild("mac", "arm64");
    writeProductionBuild("mac", "x64");
    writeProductionBuild("linux", "x64");
    writeProductionBuild("win", "x64");
    const manifestPath = NodePath.join(releaseDirectory, "latest-linux.yml");
    NodeFS.writeFileSync(
      manifestPath,
      NodeFS.readFileSync(manifestPath, "utf8").replace(
        `url: Throughline-${VERSION}-x64.AppImage`,
        `url: https://example.com/Throughline-${VERSION}-x64.AppImage`,
      ),
    );

    expect(() =>
      assembleProductionRelease({
        directory: releaseDirectory,
        version: VERSION,
        channel: "stable",
        sha: SHA,
      }),
    ).toThrow("URLs mismatch");
  });

  it("rejects provenance that omits a required updater artifact", () => {
    const releaseDirectory = writeProductionBuild("mac", "arm64");
    writeProductionBuild("mac", "x64");
    writeProductionBuild("linux", "x64");
    writeProductionBuild("win", "x64");
    const provenancePath = NodePath.join(
      releaseDirectory,
      `Throughline-${VERSION}-win-x64.provenance.json`,
    );
    const provenance = JSON.parse(NodeFS.readFileSync(provenancePath, "utf8")) as {
      artifacts: string[];
    };
    provenance.artifacts = provenance.artifacts.filter((name) => !name.endsWith(".blockmap"));
    NodeFS.writeFileSync(provenancePath, JSON.stringify(provenance));

    expect(() =>
      assembleProductionRelease({
        directory: releaseDirectory,
        version: VERSION,
        channel: "stable",
        sha: SHA,
      }),
    ).toThrow("artifacts mismatch");
  });
});
