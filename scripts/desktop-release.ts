#!/usr/bin/env node

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
  type UpdateManifest,
} from "./lib/update-manifest.ts";

export type ReleaseChannel = "stable" | "nightly";
export type ReleasePlatform = "mac" | "win" | "linux";
export type ReleaseArchitecture = "arm64" | "x64";
export type ReleaseMode = "validation" | "production";

export interface ReleaseMetadata {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly tag: string;
  readonly releaseName: string;
  readonly prerelease: boolean;
  readonly makeLatest: boolean;
  readonly sha: string;
  readonly shortSha: string;
}

export interface ReleaseProvenance {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sha: string;
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArchitecture;
  readonly mode: ReleaseMode;
  readonly artifacts: ReadonlyArray<string>;
}

const CORE_VERSION_SOURCE = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const STABLE_VERSION_PATTERN = new RegExp(`^${CORE_VERSION_SOURCE}$`, "u");
const NIGHTLY_VERSION_PATTERN = new RegExp(
  `^${CORE_VERSION_SOURCE}-nightly\\.(\\d{8})\\.([1-9]\\d*)$`,
  "u",
);
const SHA_PATTERN = /^[\da-f]{40}(?:[\da-f]{24})?$/u;

const TARGET_EXTENSION = {
  mac: "dmg",
  win: "exe",
  linux: "AppImage",
} as const satisfies Record<ReleasePlatform, string>;

const MANIFEST_NAME = {
  stable: {
    mac: "latest-mac.yml",
    win: "latest.yml",
    linux: "latest-linux.yml",
  },
  nightly: {
    mac: "nightly-mac.yml",
    win: "nightly.yml",
    linux: "nightly-linux.yml",
  },
} as const satisfies Record<ReleaseChannel, Record<ReleasePlatform, string>>;

const RELEASE_MATRIX = [
  { platform: "mac", arch: "arm64" },
  { platform: "mac", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "win", arch: "x64" },
] as const satisfies ReadonlyArray<{
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArchitecture;
}>;

function validateNightlyDate(rawDate: string): void {
  const year = Number(rawDate.slice(0, 4));
  const month = Number(rawDate.slice(4, 6));
  const day = Number(rawDate.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  const normalized = [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("");
  if (normalized !== rawDate) {
    throw new Error(`Invalid nightly release date: ${rawDate}`);
  }
}

export function validateReleaseVersion(channel: ReleaseChannel, version: string): string {
  const normalized = version.trim();
  if (normalized !== version) {
    throw new Error(
      channel === "stable"
        ? `Stable release version must be exactly X.Y.Z: ${version}`
        : `Nightly release version must be exactly X.Y.Z-nightly.YYYYMMDD.RUN: ${version}`,
    );
  }
  if (channel === "stable") {
    if (!STABLE_VERSION_PATTERN.test(normalized)) {
      throw new Error(`Stable release version must be exactly X.Y.Z: ${version}`);
    }
    return normalized;
  }

  const match = NIGHTLY_VERSION_PATTERN.exec(normalized);
  if (!match?.[1]) {
    throw new Error(
      `Nightly release version must be exactly X.Y.Z-nightly.YYYYMMDD.RUN: ${version}`,
    );
  }
  validateNightlyDate(match[1]);
  return normalized;
}

export function resolveReleaseMetadata(input: {
  readonly channel: ReleaseChannel;
  readonly version: string;
  readonly sha: string;
}): ReleaseMetadata {
  const version = validateReleaseVersion(input.channel, input.version);
  const sha = input.sha.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`Release SHA must be a full Git commit hash: ${input.sha}`);
  }
  const shortSha = sha.slice(0, 12);
  const nightly = input.channel === "nightly";
  return {
    channel: input.channel,
    version,
    tag: `v${version}`,
    releaseName: nightly
      ? `Throughline Nightly ${version} (${shortSha})`
      : `Throughline v${version}`,
    prerelease: nightly,
    makeLatest: !nightly,
    sha,
    shortSha,
  };
}

function artifactBaseName(version: string, arch: ReleaseArchitecture): string {
  return `Throughline-${version}-${arch}`;
}

function expectedBuildFiles(input: {
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArchitecture;
  readonly mode: ReleaseMode;
}): ReadonlyArray<{ readonly sourceName: string; readonly destinationName: string }> {
  const baseName = artifactBaseName(input.version, input.arch);
  const installerName = `${baseName}.${TARGET_EXTENSION[input.platform]}`;
  if (input.mode === "validation") {
    return [{ sourceName: installerName, destinationName: installerName }];
  }

  const manifestName = MANIFEST_NAME[input.channel][input.platform];
  const destinationManifestName =
    input.platform === "mac" ? manifestName.replace(/\.yml$/u, `-${input.arch}.yml`) : manifestName;
  if (input.platform === "mac") {
    return [
      { sourceName: installerName, destinationName: installerName },
      { sourceName: `${baseName}.zip`, destinationName: `${baseName}.zip` },
      {
        sourceName: `${baseName}.zip.blockmap`,
        destinationName: `${baseName}.zip.blockmap`,
      },
      { sourceName: manifestName, destinationName: destinationManifestName },
    ];
  }
  if (input.platform === "linux") {
    return [
      { sourceName: installerName, destinationName: installerName },
      { sourceName: manifestName, destinationName: manifestName },
    ];
  }
  return [
    { sourceName: installerName, destinationName: installerName },
    { sourceName: `${installerName}.blockmap`, destinationName: `${installerName}.blockmap` },
    { sourceName: manifestName, destinationName: manifestName },
  ];
}

function provenanceName(
  version: string,
  platform: ReleasePlatform,
  arch: ReleaseArchitecture,
): string {
  return `Throughline-${version}-${platform}-${arch}.provenance.json`;
}

export function collectBuildArtifacts(input: {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sha: string;
  readonly platform: ReleasePlatform;
  readonly arch: ReleaseArchitecture;
  readonly mode: ReleaseMode;
}): ReleaseProvenance {
  const metadata = resolveReleaseMetadata({
    channel: input.channel,
    version: input.version,
    sha: input.sha,
  });
  const files = expectedBuildFiles({ ...input, version: metadata.version });
  NodeFS.mkdirSync(input.destinationDirectory, { recursive: true });

  for (const file of files) {
    const sourcePath = NodePath.join(input.sourceDirectory, file.sourceName);
    if (!NodeFS.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing required ${input.mode} release artifact: ${sourcePath}`);
    }
  }

  for (const file of files) {
    NodeFS.copyFileSync(
      NodePath.join(input.sourceDirectory, file.sourceName),
      NodePath.join(input.destinationDirectory, file.destinationName),
    );
  }

  const provenance: ReleaseProvenance = {
    version: metadata.version,
    channel: metadata.channel,
    sha: metadata.sha,
    platform: input.platform,
    arch: input.arch,
    mode: input.mode,
    artifacts: files.map((file) => file.destinationName),
  };
  NodeFS.writeFileSync(
    NodePath.join(
      input.destinationDirectory,
      provenanceName(metadata.version, input.platform, input.arch),
    ),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

function readProvenance(path: string): ReleaseProvenance {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as ReleaseProvenance;
}

function assertExactValues(
  label: string,
  actualValues: ReadonlyArray<string>,
  expectedValues: ReadonlyArray<string>,
): void {
  const actual = [...actualValues].toSorted();
  const expected = [...expectedValues].toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  }
}

function verifyManifest(
  directory: string,
  manifestName: string,
  manifest: UpdateManifest,
  version: string,
  expectedPayloadNames: ReadonlyArray<string>,
): void {
  if (manifest.version !== version) {
    throw new Error(
      `Update manifest ${manifestName} has version ${manifest.version}; expected ${version}`,
    );
  }
  if (Number.isNaN(Date.parse(manifest.releaseDate))) {
    throw new Error(`Update manifest ${manifestName} has an invalid releaseDate`);
  }
  assertExactValues(
    `Update manifest ${manifestName} URLs`,
    manifest.files.map((file) => file.url),
    expectedPayloadNames,
  );

  for (const file of manifest.files) {
    if (
      NodePath.basename(file.url) !== file.url ||
      file.url.includes("\\") ||
      NodeURL.URL.canParse(file.url)
    ) {
      throw new Error(`Update manifest ${manifestName} contains an unsafe URL: ${file.url}`);
    }
    const assetPath = NodePath.join(directory, file.url);
    const stat = NodeFS.statSync(assetPath, { throwIfNoEntry: false });
    if (!stat?.isFile()) {
      throw new Error(`Update manifest ${manifestName} references missing asset ${file.url}`);
    }
    if (stat.size !== file.size) {
      throw new Error(
        `Update manifest ${manifestName} has the wrong size for ${file.url}: ${file.size} != ${stat.size}`,
      );
    }
    const contents = NodeFS.readFileSync(assetPath);
    if (NodeCrypto.createHash("sha512").update(contents).digest("base64") !== file.sha512) {
      throw new Error(`Update manifest ${manifestName} has the wrong sha512 for ${file.url}`);
    }
    if (
      file.blockMapSize !== undefined &&
      contents.readUInt32BE(contents.byteLength - 4) !== file.blockMapSize
    ) {
      throw new Error(
        `Update manifest ${manifestName} has the wrong embedded block map size for ${file.url}`,
      );
    }
  }
}

function prepareMacManifest(
  directory: string,
  channel: ReleaseChannel,
  version: string,
): {
  readonly canonicalName: string;
  readonly sourcePaths: readonly [string, string];
  readonly manifest: UpdateManifest;
} {
  const canonicalName = MANIFEST_NAME[channel].mac;
  const arm64Name = canonicalName.replace(/\.yml$/u, "-arm64.yml");
  const x64Name = canonicalName.replace(/\.yml$/u, "-x64.yml");
  const arm64Path = NodePath.join(directory, arm64Name);
  const x64Path = NodePath.join(directory, x64Name);
  const merged = mergeUpdateManifests(
    parseUpdateManifest(NodeFS.readFileSync(arm64Path, "utf8"), arm64Path),
    parseUpdateManifest(NodeFS.readFileSync(x64Path, "utf8"), x64Path),
  );
  if (merged.version !== version) {
    throw new Error(`macOS update manifests have version ${merged.version}; expected ${version}`);
  }
  return {
    canonicalName,
    sourcePaths: [arm64Path, x64Path],
    manifest: merged,
  };
}

export function assembleProductionRelease(input: {
  readonly directory: string;
  readonly version: string;
  readonly channel: ReleaseChannel;
  readonly sha: string;
}): void {
  const metadata = resolveReleaseMetadata(input);
  for (const target of RELEASE_MATRIX) {
    const name = provenanceName(metadata.version, target.platform, target.arch);
    const path = NodePath.join(input.directory, name);
    if (!NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing release provenance: ${name}`);
    }
    const provenance = readProvenance(path);
    const expected = {
      version: metadata.version,
      channel: metadata.channel,
      sha: metadata.sha,
      platform: target.platform,
      arch: target.arch,
      mode: "production",
    } as const;
    for (const [key, value] of Object.entries(expected)) {
      if (provenance[key as keyof ReleaseProvenance] !== value) {
        throw new Error(`Release provenance ${name} has the wrong ${key}`);
      }
    }
    const expectedArtifacts = expectedBuildFiles({
      version: metadata.version,
      channel: metadata.channel,
      platform: target.platform,
      arch: target.arch,
      mode: "production",
    }).map((file) => file.destinationName);
    assertExactValues(
      `Release provenance ${name} artifacts`,
      provenance.artifacts,
      expectedArtifacts,
    );
    for (const artifact of provenance.artifacts) {
      if (
        !NodeFS.statSync(NodePath.join(input.directory, artifact), {
          throwIfNoEntry: false,
        })?.isFile()
      ) {
        throw new Error(`Release provenance ${name} references missing artifact ${artifact}`);
      }
    }
  }

  const pendingMacManifest = prepareMacManifest(
    input.directory,
    metadata.channel,
    metadata.version,
  );
  const manifestNames = {
    mac: pendingMacManifest.canonicalName,
    win: MANIFEST_NAME[metadata.channel].win,
    linux: MANIFEST_NAME[metadata.channel].linux,
  } as const;
  const payloadNames = {
    mac: (["arm64", "x64"] as const).flatMap((arch) => {
      const baseName = artifactBaseName(metadata.version, arch);
      return [`${baseName}.dmg`, `${baseName}.zip`];
    }),
    win: [`${artifactBaseName(metadata.version, "x64")}.exe`],
    linux: [`${artifactBaseName(metadata.version, "x64")}.AppImage`],
  } as const;

  for (const platform of ["mac", "win", "linux"] as const) {
    const manifestName = manifestNames[platform];
    const manifestPath = NodePath.join(input.directory, manifestName);
    const manifest =
      platform === "mac"
        ? pendingMacManifest.manifest
        : parseUpdateManifest(NodeFS.readFileSync(manifestPath, "utf8"), manifestPath);
    verifyManifest(
      input.directory,
      manifestName,
      manifest,
      metadata.version,
      payloadNames[platform],
    );
  }

  NodeFS.writeFileSync(
    NodePath.join(input.directory, pendingMacManifest.canonicalName),
    serializeUpdateManifest(pendingMacManifest.manifest),
  );
  for (const sourcePath of pendingMacManifest.sourcePaths) {
    NodeFS.unlinkSync(sourcePath);
  }
}

function flag(args: ReadonlyArray<string>, name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function parseChannel(raw: string): ReleaseChannel {
  if (raw !== "stable" && raw !== "nightly") {
    throw new Error(`Unsupported release channel: ${raw}`);
  }
  return raw;
}

function parsePlatform(raw: string): ReleasePlatform {
  if (raw !== "mac" && raw !== "win" && raw !== "linux") {
    throw new Error(`Unsupported release platform: ${raw}`);
  }
  return raw;
}

function parseArchitecture(raw: string): ReleaseArchitecture {
  if (raw !== "arm64" && raw !== "x64") {
    throw new Error(`Unsupported release architecture: ${raw}`);
  }
  return raw;
}

function parseMode(raw: string): ReleaseMode {
  if (raw !== "validation" && raw !== "production") {
    throw new Error(`Unsupported release mode: ${raw}`);
  }
  return raw;
}

function writeGitHubOutput(path: string, metadata: ReleaseMetadata): void {
  const entries = {
    channel: metadata.channel,
    version: metadata.version,
    tag: metadata.tag,
    release_name: metadata.releaseName,
    prerelease: String(metadata.prerelease),
    make_latest: String(metadata.makeLatest),
    sha: metadata.sha,
    short_sha: metadata.shortSha,
  };
  NodeFS.appendFileSync(
    path,
    `${Object.entries(entries)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function main(args: ReadonlyArray<string>): void {
  const [command] = args;
  if (command === "metadata") {
    const metadata = resolveReleaseMetadata({
      channel: parseChannel(flag(args, "channel")),
      version: flag(args, "version"),
      sha: flag(args, "sha"),
    });
    const githubOutput = args.includes("--github-output") ? flag(args, "github-output") : undefined;
    if (githubOutput) writeGitHubOutput(githubOutput, metadata);
    else process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
    return;
  }
  if (command === "collect") {
    collectBuildArtifacts({
      sourceDirectory: NodePath.resolve(flag(args, "source")),
      destinationDirectory: NodePath.resolve(flag(args, "destination")),
      version: flag(args, "version"),
      channel: parseChannel(flag(args, "channel")),
      sha: flag(args, "sha"),
      platform: parsePlatform(flag(args, "platform")),
      arch: parseArchitecture(flag(args, "arch")),
      mode: parseMode(flag(args, "mode")),
    });
    return;
  }
  if (command === "assemble") {
    assembleProductionRelease({
      directory: NodePath.resolve(flag(args, "directory")),
      version: flag(args, "version"),
      channel: parseChannel(flag(args, "channel")),
      sha: flag(args, "sha"),
    });
    return;
  }
  throw new Error(`Unknown desktop release command: ${command ?? ""}`);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
