#!/usr/bin/env node
// Package the desktop app into a distributable (dmg / nsis / AppImage).
//
// Pipeline: build web -> build server -> build desktop -> stage an app dir ->
// run electron-builder. The packaged app runs the SAME local-server + web
// bundle the dev flow does; the shell spawns `apps/server/dist/bin.mjs` and
// the server serves the web build from its `dist/client`.
//
// Signing, notarization, architecture, and per-OS targets require release-owned
// values, so those choices stay explicit here. Run:
//   pnpm dist:desktop -- --platform mac --target dmg --arch arm64
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const APP_ID = "com.arsoftware.throughline";
const PRODUCT_NAME = "Throughline";
const LINUX_DESKTOP_ID = "throughline";
const SERVER_RUNTIME_DEPENDENCIES = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "@openai/codex",
  "@openai/codex-sdk",
  "zod",
] as const;

interface GitHubPublishConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly releaseType: "prerelease" | "release";
  readonly channel?: "nightly";
}

interface ElectronBuilderConfigInput {
  readonly platform: DesktopBuildPlatform;
  readonly target: string;
  readonly outputDirectory: string;
  readonly publishConfig: GitHubPublishConfig | undefined;
  readonly signed: boolean;
}

export type DesktopBuildPlatform = "mac" | "win" | "linux";
export type DesktopBuildArch = "arm64" | "x64" | "universal";
type HostDesktopBuildArch = Exclude<DesktopBuildArch, "universal">;

const DESKTOP_TARGET_BY_PLATFORM = {
  mac: "dmg",
  win: "nsis",
  linux: "AppImage",
} as const satisfies Record<DesktopBuildPlatform, string>;

const DESKTOP_ARCHES_BY_PLATFORM = {
  mac: ["arm64", "x64", "universal"],
  win: ["x64", "arm64"],
  linux: ["x64", "arm64"],
} as const satisfies Record<DesktopBuildPlatform, ReadonlyArray<DesktopBuildArch>>;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function resolveDesktopBuildPlatform(
  requestedPlatform: string | undefined,
  hostPlatform: NodeJS.Platform,
): DesktopBuildPlatform {
  const platform =
    requestedPlatform ??
    (hostPlatform === "win32" ? "win" : hostPlatform === "linux" ? "linux" : "mac");
  if (platform !== "mac" && platform !== "win" && platform !== "linux") {
    throw new Error(`Unsupported desktop platform: ${platform}`);
  }
  return platform;
}

export function resolveDesktopBuildTarget(
  platform: DesktopBuildPlatform,
  requestedTarget: string | undefined,
): string {
  const expectedTarget = DESKTOP_TARGET_BY_PLATFORM[platform];
  const target = requestedTarget ?? expectedTarget;
  if (target !== expectedTarget) {
    throw new Error(`Unsupported ${platform} desktop target: ${target}`);
  }
  return target;
}

function normalizeWindowsHostArch(value: string | undefined): HostDesktopBuildArch | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("arm64") || normalized === "aarch64") return "arm64";
  if (normalized.includes("amd64") || normalized.includes("x64")) return "x64";
  return undefined;
}

export function resolveDesktopBuildArch(
  platform: DesktopBuildPlatform,
  requestedArch: string | undefined,
  hostArch: NodeJS.Architecture,
  hostPlatform: NodeJS.Platform,
  hostEnvironment: NodeJS.ProcessEnv = {},
): DesktopBuildArch {
  const choices = DESKTOP_ARCHES_BY_PLATFORM[platform];
  const detectedHostArch =
    hostPlatform === "win32" && hostArch === "x64"
      ? (normalizeWindowsHostArch(hostEnvironment.PROCESSOR_ARCHITEW6432) ??
        normalizeWindowsHostArch(hostEnvironment.PROCESSOR_ARCHITECTURE) ??
        "x64")
      : hostArch === "arm64" || hostArch === "x64"
        ? hostArch
        : undefined;
  const arch =
    requestedArch ??
    (detectedHostArch !== undefined && choices.includes(detectedHostArch)
      ? detectedHostArch
      : choices[0]);
  if (!choices.some((choice) => choice === arch)) {
    throw new Error(`Unsupported ${platform} desktop architecture: ${arch}`);
  }
  return arch as DesktopBuildArch;
}

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsShellArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

type DesktopSpawnExecutableResolver = (
  command: string,
  environment: NodeJS.ProcessEnv,
) => string | undefined;

function resolveWindowsPathExtensions(environment: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = environment.PATHEXT;
  if (!rawValue) return [".COM", ".EXE", ".BAT", ".CMD"];
  const extensions = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toUpperCase());
  return extensions.length > 0 ? Array.from(new Set(extensions)) : [".COM", ".EXE", ".BAT", ".CMD"];
}

function resolveWindowsExecutable(
  command: string,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = resolveWindowsPathExtensions(environment);
  const extension = NodePath.win32.extname(command);
  const candidates =
    extension.length > 0
      ? [command]
      : extensions.flatMap((candidateExtension) => [
          `${command}${candidateExtension}`,
          `${command}${candidateExtension.toLowerCase()}`,
        ]);
  const isExecutableFile = (filePath: string): boolean => {
    try {
      return (
        NodeFS.statSync(filePath).isFile() &&
        extensions.includes(NodePath.win32.extname(filePath).toUpperCase())
      );
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isExecutableFile);
  }
  const pathValue = environment.PATH ?? environment.Path ?? environment.path ?? "";
  for (const pathEntry of pathValue.split(";")) {
    const normalizedPathEntry = pathEntry.trim().replace(/^"+|"+$/g, "");
    if (normalizedPathEntry.length === 0) continue;
    for (const candidate of candidates) {
      const candidatePath = NodePath.win32.join(normalizedPathEntry, candidate);
      if (isExecutableFile(candidatePath)) return candidatePath;
    }
  }
  return undefined;
}

export function resolveDesktopBuildInvocation(
  command: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = {},
  resolveExecutable: DesktopSpawnExecutableResolver = resolveWindowsExecutable,
): {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
} {
  if (platform !== "win32") {
    return { command, args, shell: false };
  }

  const resolvedCommand = resolveExecutable(command, environment) ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }

  return {
    command: escapeWindowsShellArg(resolvedCommand),
    args: args.map(escapeWindowsShellArg),
    shell: true,
  };
}

export function createElectronBuilderArgs(
  platform: DesktopBuildPlatform,
  arch: DesktopBuildArch,
  stageDirectory: string,
  configPath: string,
): ReadonlyArray<string> {
  return [
    "--filter",
    "@app/desktop",
    "exec",
    "electron-builder",
    "--projectDir",
    stageDirectory,
    `--${platform}`,
    `--${arch}`,
    "--config",
    configPath,
    "--publish",
    "never",
  ];
}

export function resolveDesktopBuildVersion(
  commandLineVersion: string | undefined,
  environmentVersion: string | undefined,
  packageVersion: string,
): string {
  return commandLineVersion?.trim() || environmentVersion?.trim() || packageVersion;
}

export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

export function resolveGitHubPublishConfig(
  updateRepository: string | undefined,
  updateChannel: "latest" | "nightly",
  signed: boolean,
): GitHubPublishConfig | undefined {
  const rawRepo = updateRepository?.trim() ?? "";
  if (!rawRepo) return undefined;
  if (!signed) {
    throw new Error("Desktop updater metadata requires a signed build");
  }

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid desktop updater repository: ${rawRepo}`);
  }

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
}

export function createElectronBuilderConfig({
  platform,
  target,
  outputDirectory,
  publishConfig,
  signed,
}: ElectronBuilderConfigInput): Record<string, unknown> {
  const platformConfig =
    platform === "mac"
      ? {
          mac: {
            target: target === "dmg" && publishConfig !== undefined ? [target, "zip"] : [target],
            category: "public.app-category.developer-tools",
            icon: "apps/desktop/resources/icon.icns",
            ...(signed ? { notarize: true } : {}),
          },
        }
      : platform === "win"
        ? {
            win: {
              target: [target],
              icon: "apps/desktop/resources/icon.ico",
              signAndEditExecutable: true,
            },
          }
        : {
            linux: {
              target: [target],
              executableName: LINUX_DESKTOP_ID,
              category: "Development",
              icon: "apps/desktop/resources/icons",
              desktop: {
                entry: {
                  StartupWMClass: LINUX_DESKTOP_ID,
                },
              },
            },
          };

  return {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    artifactName: "Throughline-${version}-${arch}.${ext}",
    directories: { output: outputDirectory },
    files: ["**/*"],
    asarUnpack: [
      "apps/server/**",
      "node_modules/@anthropic-ai/claude-agent-sdk*/**",
      "node_modules/@openai/codex*/**",
    ],
    ...platformConfig,
    ...(publishConfig === undefined ? {} : { publish: [publishConfig] }),
  };
}

export function resolveDesktopBuilderEnvironment(
  signed: boolean,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  for (const [key, value] of Object.entries(resolved)) {
    if (value === "") delete resolved[key];
  }
  if (!signed) {
    resolved.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete resolved.CSC_LINK;
    delete resolved.CSC_KEY_PASSWORD;
    delete resolved.APPLE_API_KEY;
    delete resolved.APPLE_API_KEY_ID;
    delete resolved.APPLE_API_ISSUER;
  }
  return resolved;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd = REPO_ROOT,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see dev-runner.ts header).
  const invocation = resolveDesktopBuildInvocation(command, args, process.platform, environment);
  NodeChildProcess.execFileSync(invocation.command, invocation.args, {
    cwd,
    env: environment,
    stdio: "inherit",
    shell: invocation.shell,
  });
}

function validateBundledClientAssets(clientDir: string): void {
  const indexPath = NodePath.join(clientDir, "index.html");
  if (!NodeFS.existsSync(indexPath)) {
    throw new Error(
      `[desktop-artifact] ${indexPath} is missing. The web build output is missing or stale; ` +
        "run `pnpm --filter @app/web build` and retry.",
    );
  }
  const assetsDir = NodePath.join(clientDir, "assets");
  if (!NodeFS.existsSync(assetsDir) || NodeFS.readdirSync(assetsDir).length === 0) {
    throw new Error(
      `[desktop-artifact] ${assetsDir} is empty or missing. The web build output is missing ` +
        "or stale; run `pnpm --filter @app/web build` and retry.",
    );
  }
}

function installedVersion(packagePath: string): string {
  const manifest = JSON.parse(NodeFS.readFileSync(packagePath, "utf8")) as {
    readonly version: string;
  };
  return manifest.version;
}

/**
 * Carries the root workspace's `allowBuilds` entries into the staged
 * workspace config. Without them the staged `pnpm install --prod` fails with
 * ERR_PNPM_IGNORED_BUILDS for dependencies that have lifecycle scripts.
 */
function readWorkspaceAllowBuilds(): Record<string, boolean> {
  const raw = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const allowBuilds: Record<string, boolean> = {};
  let inBlock = false;
  for (const line of raw.split("\n")) {
    if (/^allowBuilds:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const entry = /^ {2}([^\s:]+):\s*(true|false)\s*$/.exec(line);
    if (entry) {
      allowBuilds[entry[1] as string] = entry[2] === "true";
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith(" ")) inBlock = false;
  }
  return allowBuilds;
}

interface StageWorkspaceConfig {
  readonly supportedArchitectures: {
    readonly os: ReadonlyArray<"darwin" | "linux" | "win32">;
    readonly cpu: ReadonlyArray<"arm64" | "x64">;
    readonly libc?: ReadonlyArray<"glibc">;
  };
  readonly allowBuilds?: Readonly<Record<string, boolean>>;
}

export function createStageWorkspaceConfig(
  platform: DesktopBuildPlatform,
  arch: DesktopBuildArch,
  allowBuilds: Readonly<Record<string, boolean>> = {},
): StageWorkspaceConfig {
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? (["arm64", "x64"] as const) : [arch];
  return {
    supportedArchitectures: {
      os: [hostOs],
      cpu: hostCpu,
      ...(platform === "linux" ? { libc: ["glibc" as const] } : {}),
    },
    ...(Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
  };
}

export function serializeStageWorkspaceConfig(config: StageWorkspaceConfig): string {
  const lines = [
    "packages: []",
    "supportedArchitectures:",
    "  os:",
    ...config.supportedArchitectures.os.map((value) => `    - ${value}`),
    "  cpu:",
    ...config.supportedArchitectures.cpu.map((value) => `    - ${value}`),
  ];
  if (config.supportedArchitectures.libc !== undefined) {
    lines.push("  libc:", ...config.supportedArchitectures.libc.map((value) => `    - ${value}`));
  }
  if (config.allowBuilds !== undefined) {
    lines.push(
      "allowBuilds:",
      ...Object.entries(config.allowBuilds).map(
        ([name, allowed]) => `  ${name}: ${String(allowed)}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const desktopPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
  ) as { readonly version: string };
  const appVersion = resolveDesktopBuildVersion(
    arg("build-version"),
    process.env.THROUGHLINE_DESKTOP_VERSION,
    desktopPackage.version,
  );
  const updateChannel = resolveDesktopUpdateChannel(appVersion);
  const signed = hasArg("signed");
  const publishConfig = resolveGitHubPublishConfig(
    arg("update-repository") ?? process.env.THROUGHLINE_DESKTOP_UPDATE_REPOSITORY,
    updateChannel,
    signed,
  );
  const platform = resolveDesktopBuildPlatform(
    arg("platform"),
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see dev-runner.ts header).
    process.platform,
  );
  const target = resolveDesktopBuildTarget(platform, arg("target"));
  const arch = resolveDesktopBuildArch(
    platform,
    arg("arch"),
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see dev-runner.ts header).
    process.arch,
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see dev-runner.ts header).
    process.platform,
    process.env,
  );

  // 1. Build all three packages (order matters: the server serves the web build).
  run("pnpm", ["--filter", "@app/web", "build"]);
  run("pnpm", ["--filter", "@app/server", "build"]);
  run("pnpm", ["--filter", "@app/desktop", "build"]);

  // 2. Stage an app directory electron-builder will pack.
  const stage = NodePath.join(REPO_ROOT, "release/app");
  NodeFS.rmSync(stage, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(stage, "apps/desktop"), {
    recursive: true,
  });

  const copy = (from: string, to: string) =>
    NodeFS.cpSync(NodePath.join(REPO_ROOT, from), NodePath.join(stage, to), {
      recursive: true,
    });
  copy("apps/desktop/dist-electron", "apps/desktop/dist-electron");
  copy("apps/desktop/resources", "apps/desktop/resources");
  copy("apps/server/dist", "apps/server/dist");
  copy("apps/web/dist", "apps/server/dist/client");
  validateBundledClientAssets(NodePath.join(stage, "apps/server/dist/client"));

  const electronPackageJson = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(REPO_ROOT, "apps/desktop/node_modules/electron/package.json"),
      "utf8",
    ),
  ) as { readonly version: string };
  const stagedRuntimeDependencies: Record<string, string> = {
    "electron-updater": installedVersion(
      NodePath.join(REPO_ROOT, "apps/desktop/node_modules/electron-updater/package.json"),
    ),
  };
  for (const dependency of SERVER_RUNTIME_DEPENDENCIES) {
    stagedRuntimeDependencies[dependency] = installedVersion(
      NodePath.join(REPO_ROOT, "apps/server/node_modules", dependency, "package.json"),
    );
  }

  NodeFS.writeFileSync(
    NodePath.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "throughline",
        productName: PRODUCT_NAME,
        version: appVersion,
        private: true,
        main: "apps/desktop/dist-electron/main.cjs",
        dependencies: stagedRuntimeDependencies,
        devDependencies: {
          electron: electronPackageJson.version,
        },
      },
      null,
      2,
    ),
  );
  NodeFS.writeFileSync(
    NodePath.join(stage, "pnpm-workspace.yaml"),
    serializeStageWorkspaceConfig(
      createStageWorkspaceConfig(platform, arch, readWorkspaceAllowBuilds()),
    ),
  );

  process.stdout.write("\n[desktop-artifact] Installing staged production dependencies...\n");
  run("pnpm", ["install", "--prod"], stage);

  // 3. electron-builder config.
  const config = createElectronBuilderConfig({
    platform,
    target,
    outputDirectory: NodePath.join(REPO_ROOT, "release/dist"),
    publishConfig,
    signed,
  });
  const configPath = NodePath.join(REPO_ROOT, "release/electron-builder.json");
  NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
  NodeFS.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 4. Pack. Requires `electron-builder` (a devDependency of @app/desktop).
  const builderEnvironment = resolveDesktopBuilderEnvironment(signed, process.env);
  run(
    "pnpm",
    createElectronBuilderArgs(platform, arch, stage, configPath),
    REPO_ROOT,
    builderEnvironment,
  );
  process.stdout.write(`\n✔ Artifacts in release/dist\n`);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  main();
}
