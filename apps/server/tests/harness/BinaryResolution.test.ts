import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { resolveHarnessBinary, unpackAsarPath } from "../../src/harness/BinaryResolution.ts";

describe("harness binary resolution", () => {
  it("resolves the platform-specific Codex optional package deterministically", () => {
    const packageJson = "/app/node_modules/@openai/codex-darwin-arm64/package.json";
    const expected = NodePath.join(
      NodePath.dirname(packageJson),
      "vendor",
      "aarch64-apple-darwin",
      "bin",
      "codex",
    );

    const result = resolveHarnessBinary(
      "codex",
      { platform: "darwin", arch: "arm64" },
      {
        resolvePackageJson: (packageName) => {
          assert.strictEqual(packageName, "@openai/codex-darwin-arm64");
          return packageJson;
        },
        isFile: (path) => path === expected,
      },
    );

    assert.strictEqual(result, expected);
  });

  it("translates packaged Electron paths to app.asar.unpacked", () => {
    const packageJson =
      "/Applications/Throughline.app/Contents/Resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json";
    const unpackedBinary =
      "/Applications/Throughline.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";

    const result = resolveHarnessBinary(
      "claude",
      { platform: "darwin", arch: "arm64" },
      {
        resolvePackageJson: () => packageJson,
        isFile: (path) => path === unpackedBinary,
      },
    );

    assert.strictEqual(result, unpackedBinary);
    assert.strictEqual(
      unpackAsarPath("/tmp/app.asar.unpacked/node_modules/tool"),
      "/tmp/app.asar.unpacked/node_modules/tool",
    );
  });

  it("returns unavailable for unsupported platforms or missing optional packages", () => {
    assert.isUndefined(
      resolveHarnessBinary(
        "codex",
        { platform: "aix", arch: "ppc64" },
        {
          resolvePackageJson: () => {
            throw new Error("must not resolve");
          },
          isFile: () => false,
        },
      ),
    );

    assert.isUndefined(
      resolveHarnessBinary(
        "claude",
        { platform: "linux", arch: "x64" },
        {
          resolvePackageJson: () => {
            throw new Error("optional package missing");
          },
          isFile: () => false,
        },
      ),
    );
  });
});
