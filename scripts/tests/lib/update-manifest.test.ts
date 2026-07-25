import { describe, expect, it } from "vitest";

import {
  mergeUpdateManifests,
  parseUpdateManifest,
  serializeUpdateManifest,
} from "../../lib/update-manifest.ts";

describe("update manifest", () => {
  it("merges architecture manifests without retaining single-payload aliases", () => {
    const arm64 = parseUpdateManifest(
      `version: 1.2.3
files:
  - url: Throughline-1.2.3-arm64.zip
    sha512: arm64
    size: 10
path: Throughline-1.2.3-arm64.zip
sha512: arm64
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "latest-mac-arm64.yml",
    );
    const x64 = parseUpdateManifest(
      `version: 1.2.3
files:
  - url: Throughline-1.2.3-x64.zip
    sha512: x64
    size: 12
path: Throughline-1.2.3-x64.zip
sha512: x64
releaseDate: '2026-07-25T02:04:05.000Z'
`,
      "latest-mac-x64.yml",
    );

    const serialized = serializeUpdateManifest(mergeUpdateManifests(arm64, x64));

    expect(serialized).toContain("Throughline-1.2.3-arm64.zip");
    expect(serialized).toContain("Throughline-1.2.3-x64.zip");
    expect(serialized).not.toContain("\npath:");
    expect(serialized).toContain("2026-07-25T02:04:05.000Z");
  });

  it("rejects mismatched versions and conflicting duplicate URLs", () => {
    const first = parseUpdateManifest(
      `version: 1.2.3
files:
  - url: Throughline.zip
    sha512: first
    size: 10
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "first.yml",
    );
    const wrongVersion = parseUpdateManifest(
      `version: 1.2.4
files:
  - url: Throughline.zip
    sha512: first
    size: 10
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "wrong-version.yml",
    );
    const conflictingFile = parseUpdateManifest(
      `version: 1.2.3
files:
  - url: Throughline.zip
    sha512: different
    size: 10
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "conflicting-file.yml",
    );

    expect(() => mergeUpdateManifests(first, wrongVersion)).toThrow("different versions");
    expect(() => mergeUpdateManifests(first, conflictingFile)).toThrow("conflicting file entry");
  });

  it("preserves quoted numeric-looking strings and scalar metadata", () => {
    const manifest = parseUpdateManifest(
      `version: '1.0'
files:
  - url: Throughline-1.0-x64.exe
    sha512: example
    size: 10
releaseName: 'true'
stagingPercentage: 25
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "latest.yml",
    );

    expect(manifest.version).toBe("1.0");
    expect(manifest.extras).toEqual({
      releaseName: "true",
      stagingPercentage: 25,
    });
    expect(serializeUpdateManifest(manifest)).toContain("version: '1.0'");
  });

  it("round-trips AppImage embedded block map metadata", () => {
    const manifest = parseUpdateManifest(
      `version: 1.2.3
files:
  - url: Throughline-1.2.3-x64.AppImage
    sha512: appimagesha
    size: 125621344
    blockMapSize: 148256
path: Throughline-1.2.3-x64.AppImage
sha512: appimagesha
releaseDate: '2026-07-25T02:03:04.000Z'
`,
      "latest-linux.yml",
    );

    expect(manifest.files).toEqual([
      {
        url: "Throughline-1.2.3-x64.AppImage",
        sha512: "appimagesha",
        size: 125621344,
        blockMapSize: 148256,
      },
    ]);
    expect(serializeUpdateManifest(manifest)).toContain("    blockMapSize: 148256");
  });

  it("rejects invalid embedded block map sizes", () => {
    expect(() =>
      parseUpdateManifest(
        `version: 1.2.3
files:
  - url: Throughline-1.2.3-x64.AppImage
    sha512: appimagesha
    size: 100
    blockMapSize: 100
releaseDate: '2026-07-25T02:03:04.000Z'
`,
        "latest-linux.yml",
      ),
    ).toThrow("invalid embedded block map size");
  });
});
