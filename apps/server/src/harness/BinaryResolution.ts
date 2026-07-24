import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export type HarnessBinaryKind = "codex" | "claude";

export interface BinaryResolutionPlatform {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}

export interface BinaryResolutionDependencies {
  readonly resolvePackageJson: (packageName: string) => string;
  readonly isFile: (path: string) => boolean;
}

interface BinaryPackage {
  readonly packageName: string;
  readonly relativeBinary: ReadonlyArray<string>;
}

const codexPackages = new Map<string, BinaryPackage>([
  [
    "darwin-arm64",
    {
      packageName: "@openai/codex-darwin-arm64",
      relativeBinary: ["vendor", "aarch64-apple-darwin", "bin", "codex"],
    },
  ],
  [
    "darwin-x64",
    {
      packageName: "@openai/codex-darwin-x64",
      relativeBinary: ["vendor", "x86_64-apple-darwin", "bin", "codex"],
    },
  ],
  [
    "linux-arm64",
    {
      packageName: "@openai/codex-linux-arm64",
      relativeBinary: ["vendor", "aarch64-unknown-linux-musl", "bin", "codex"],
    },
  ],
  [
    "linux-x64",
    {
      packageName: "@openai/codex-linux-x64",
      relativeBinary: ["vendor", "x86_64-unknown-linux-musl", "bin", "codex"],
    },
  ],
  [
    "win32-arm64",
    {
      packageName: "@openai/codex-win32-arm64",
      relativeBinary: ["vendor", "aarch64-pc-windows-msvc", "bin", "codex.exe"],
    },
  ],
  [
    "win32-x64",
    {
      packageName: "@openai/codex-win32-x64",
      relativeBinary: ["vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
    },
  ],
]);

const claudePackages = new Map<string, ReadonlyArray<BinaryPackage>>(
  [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
    ["win32", "arm64"],
    ["win32", "x64"],
  ].map(([platform, arch]) => {
    const platformKey = `${platform}-${arch}`;
    const standard = {
      packageName: `@anthropic-ai/claude-agent-sdk-${platformKey}`,
      relativeBinary: [platform === "win32" ? "claude.exe" : "claude"],
    };
    return [
      platformKey,
      [
        standard,
        ...(platform === "linux"
          ? [
              {
                packageName: `${standard.packageName}-musl`,
                relativeBinary: standard.relativeBinary,
              },
            ]
          : []),
      ],
    ] as const;
  }),
);

const moduleRequire = NodeModule.createRequire(import.meta.url);

const resolveOptionalPackageJson = (packageName: string): string => {
  try {
    return moduleRequire.resolve(`${packageName}/package.json`);
  } catch {
    for (const parentPackage of ["@openai/codex", "@anthropic-ai/claude-agent-sdk"]) {
      try {
        const parentPackageJson = moduleRequire.resolve(`${parentPackage}/package.json`);
        return NodeModule.createRequire(parentPackageJson).resolve(`${packageName}/package.json`);
      } catch {
        continue;
      }
    }
    throw new Error(`Unable to resolve ${packageName}.`);
  }
};

const defaultDependencies: BinaryResolutionDependencies = {
  resolvePackageJson: resolveOptionalPackageJson,
  isFile: (path) => {
    try {
      return NodeFS.statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

export const unpackAsarPath = (path: string): string =>
  path.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");

const availablePath = (
  candidate: string,
  isFile: (path: string) => boolean,
): string | undefined => {
  if (isFile(candidate)) {
    return candidate;
  }
  const unpacked = unpackAsarPath(candidate);
  return unpacked !== candidate && isFile(unpacked) ? unpacked : undefined;
};

export const resolveHarnessBinary = (
  kind: HarnessBinaryKind,
  platform: BinaryResolutionPlatform = {
    platform: NodeProcess.platform,
    arch: NodeProcess.arch,
  },
  dependencies: BinaryResolutionDependencies = defaultDependencies,
): string | undefined => {
  const platformKey = `${platform.platform}-${platform.arch}`;
  const binaryPackages =
    kind === "codex"
      ? [codexPackages.get(platformKey)].filter(
          (candidate): candidate is BinaryPackage => candidate !== undefined,
        )
      : (claudePackages.get(platformKey) ?? []);
  if (binaryPackages.length === 0) {
    return undefined;
  }

  for (const binaryPackage of binaryPackages) {
    try {
      const packageJson = dependencies.resolvePackageJson(binaryPackage.packageName);
      const candidate = NodePath.join(
        NodePath.dirname(packageJson),
        ...binaryPackage.relativeBinary,
      );
      const available = availablePath(candidate, dependencies.isFile);
      if (available !== undefined) {
        return available;
      }
    } catch {
      continue;
    }
  }
  return undefined;
};
