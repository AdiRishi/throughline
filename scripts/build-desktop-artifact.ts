#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Node build script; no Effect runtime.
// Package the desktop app into a distributable (dmg / nsis / AppImage):
//   pnpm dist:desktop -- --platform mac --target dmg
//
// The packaged app runs the same local-server + web bundle the dev flow does:
// the shell spawns `apps/server/dist/bin.mjs` and the server serves the web
// build from its `dist/client`.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const APP_ID = "com.arsoftware.throughline";
const PRODUCT_NAME = "Throughline";

// Electron ships ~50 locale .pak files; the app is English-only, so the rest
// are dead weight in every artifact.
const DESKTOP_ELECTRON_LANGUAGES = ["en-US"] as const;
// electron-builder's default file set is "everything under the project dir";
// listing only negations narrows it. The sourcemaps are the bulk of the stage
// dir (main.cjs.map alone is ~3.6MB) and are only useful against a local build.
const DESKTOP_FILE_EXCLUSIONS = ["!**/*.map"] as const;
// The server child is spawned as `process.execPath` with ELECTRON_RUN_AS_NODE
// against `apps/server/dist/bin.mjs`, and that bundle then serves the web build
// from `dist/client`. Keeping the whole server tree outside the asar is what
// makes both the ESM entry and the static assets plain files on disk. Nothing
// else needs unpacking: the main process reads its own deps through Electron's
// asar redirect.
const ASAR_UNPACK = ["apps/server/dist/**"] as const;

export type DesktopBuildPlatform = "mac" | "win" | "linux";
export type DesktopBuildArch = "arm64" | "x64" | "universal";

export interface DesktopArtifactOptions {
  readonly platform: DesktopBuildPlatform;
  readonly target: string;
  readonly arch: DesktopBuildArch;
  readonly version: string;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly signed: boolean;
}

function argumentValue(argv: ReadonlyArray<string>, name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);

  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`[desktop-artifact] --${name} requires a value.`);
  }
  return value;
}

function resolveBooleanOption(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  name: string,
  envName: string,
): boolean {
  if (argv.includes(`--${name}`)) return true;
  const value = env[envName]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function hostBuildPlatform(platform: NodeJS.Platform): DesktopBuildPlatform {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  if (platform === "linux") return "linux";
  throw new Error(`[desktop-artifact] Unsupported host platform '${platform}'.`);
}

function hostBuildArch(arch: string): Exclude<DesktopBuildArch, "universal"> {
  if (arch === "arm64" || arch === "x64") return arch;
  throw new Error(`[desktop-artifact] Unsupported host architecture '${arch}'.`);
}

function readDesktopVersion(): string {
  const packageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
  ) as { readonly version: string };
  return packageJson.version;
}

export function resolveDesktopArtifactOptions(input?: {
  readonly argv?: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly desktopVersion?: string;
}): DesktopArtifactOptions {
  const argv = input?.argv ?? process.argv.slice(2);
  const env = input?.env ?? process.env;
  const platform = (argumentValue(argv, "platform") ??
    env.APP_DESKTOP_PLATFORM?.trim() ??
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime.
    hostBuildPlatform(input?.hostPlatform ?? NodeOS.platform())) as DesktopBuildPlatform;
  if (platform !== "mac" && platform !== "win" && platform !== "linux") {
    throw new Error(`[desktop-artifact] Unsupported build platform '${platform}'.`);
  }

  const arch = (argumentValue(argv, "arch") ??
    env.APP_DESKTOP_ARCH?.trim() ??
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime.
    hostBuildArch(input?.hostArch ?? NodeOS.arch())) as DesktopBuildArch;
  const supportedArchitectures: ReadonlyArray<DesktopBuildArch> =
    platform === "mac" ? ["arm64", "x64", "universal"] : ["arm64", "x64"];
  if (!supportedArchitectures.includes(arch)) {
    throw new Error(
      `[desktop-artifact] Unsupported architecture '${arch}' for ${platform}; expected ${supportedArchitectures.join(", ")}.`,
    );
  }

  const version = (
    argumentValue(argv, "build-version") ??
    env.APP_DESKTOP_VERSION?.trim() ??
    input?.desktopVersion ??
    readDesktopVersion()
  ).trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`[desktop-artifact] '${version}' is not a valid build version.`);
  }

  const target =
    argumentValue(argv, "target") ??
    env.APP_DESKTOP_TARGET?.trim() ??
    (platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "AppImage");
  const outputDir = NodePath.resolve(
    REPO_ROOT,
    argumentValue(argv, "output-dir") ?? env.APP_DESKTOP_OUTPUT_DIR?.trim() ?? "release/dist",
  );

  return {
    platform,
    target,
    arch,
    version,
    outputDir,
    skipBuild: resolveBooleanOption(argv, env, "skip-build", "APP_DESKTOP_SKIP_BUILD"),
    keepStage: resolveBooleanOption(argv, env, "keep-stage", "APP_DESKTOP_KEEP_STAGE"),
    signed: resolveBooleanOption(argv, env, "signed", "APP_DESKTOP_SIGNED"),
  };
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  cwd = REPO_ROOT,
  env?: NodeJS.ProcessEnv,
): void {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  NodeChildProcess.execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    ...(env ? { env } : {}),
    // `pnpm` is a .CMD shim on Windows, which cannot be spawned without a shell.
    // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see file header).
    shell: process.platform === "win32",
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

/**
 * Carries the root workspace's `allowBuilds` entries into the staged
 * workspace config. Without them the staged `pnpm install --prod` fails with
 * ERR_PNPM_IGNORED_BUILDS for dependencies that have lifecycle scripts.
 */
export function readWorkspaceAllowBuilds(): Record<string, boolean> {
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

export type PublishConfig = Readonly<Record<string, string>>;

/**
 * electron-builder only emits `app-update.yml` — the file electron-updater
 * reads to find the release feed — from a `publish` config, so without one the
 * packaged app's `checkForUpdates()` throws "Please define publish
 * configuration". The feed is therefore resolved from the environment:
 *
 *   APP_DESKTOP_UPDATE_REPOSITORY / GITHUB_REPOSITORY -> GitHub releases
 *   APP_DESKTOP_UPDATE_URL                            -> a generic static host
 *   APP_DESKTOP_UPDATE_CHANNEL=nightly                -> prereleases
 *
 * Leaving them unset omits the block; the shell then reports the updater as
 * disabled (it looks for `app-update.yml`) rather than failing at check time.
 */
export function resolveGitHubPublishConfig(
  updateChannel: "latest" | "nightly",
): PublishConfig | undefined {
  const rawRepo = (
    process.env.APP_DESKTOP_UPDATE_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY?.trim() ||
    ""
  ).trim();
  if (!rawRepo) return undefined;

  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) return undefined;

  return {
    provider: "github",
    owner,
    repo,
    releaseType: updateChannel === "nightly" ? "prerelease" : "release",
    ...(updateChannel === "nightly" ? { channel: "nightly" as const } : {}),
  };
}

/** Fallback feed for builds published to a plain static host (or a mock server). */
export function resolveGenericPublishConfig(): PublishConfig | undefined {
  const url = process.env.APP_DESKTOP_UPDATE_URL?.trim();
  return url ? { provider: "generic", url } : undefined;
}

export function resolveUpdateChannel(): "latest" | "nightly" {
  return process.env.APP_DESKTOP_UPDATE_CHANNEL?.trim() === "nightly" ? "nightly" : "latest";
}

function main(): void {
  const options = resolveDesktopArtifactOptions();
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, APP_VERSION: options.version };

  if (!options.skipBuild) {
    run("pnpm", ["build:desktop"], REPO_ROOT, buildEnv);
  }

  const stageRoot = NodeFS.mkdtempSync(
    NodePath.join(NodeOS.tmpdir(), `throughline-desktop-${options.platform}-stage-`),
  );
  const stage = NodePath.join(stageRoot, "app");

  try {
    NodeFS.mkdirSync(NodePath.join(stage, "apps/desktop"), { recursive: true });

    const copy = (from: string, to: string) =>
      NodeFS.cpSync(NodePath.join(REPO_ROOT, from), NodePath.join(stage, to), {
        recursive: true,
      });
    copy("apps/desktop/dist-electron", "apps/desktop/dist-electron");
    copy("apps/server/dist", "apps/server/dist");
    copy("apps/web/dist", "apps/server/dist/client");
    validateBundledClientAssets(NodePath.join(stage, "apps/server/dist/client"));

    const desktopPackageJson = JSON.parse(
      NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
    ) as {
      readonly dependencies: { readonly "electron-updater": string };
    };
    const electronPackageJson = JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(REPO_ROOT, "apps/desktop/node_modules/electron/package.json"),
        "utf8",
      ),
    ) as { readonly version: string };
    const rootPackageJson = JSON.parse(
      NodeFS.readFileSync(NodePath.join(REPO_ROOT, "package.json"), "utf8"),
    ) as { readonly packageManager: string };

    NodeFS.writeFileSync(
      NodePath.join(stage, "package.json"),
      JSON.stringify(
        {
          name: "throughline",
          version: options.version,
          buildVersion: options.version,
          private: true,
          packageManager: rootPackageJson.packageManager,
          description: "Throughline desktop build",
          main: "apps/desktop/dist-electron/main.cjs",
          dependencies: {
            "electron-updater": desktopPackageJson.dependencies["electron-updater"],
          },
          devDependencies: {
            electron: electronPackageJson.version,
          },
        },
        null,
        2,
      ),
    );
    const allowBuilds = readWorkspaceAllowBuilds();
    const allowBuildsYaml =
      Object.keys(allowBuilds).length > 0
        ? `allowBuilds:\n${Object.entries(allowBuilds)
            .map(([name, allowed]) => `  ${name}: ${String(allowed)}`)
            .join("\n")}\n`
        : "";
    NodeFS.writeFileSync(
      NodePath.join(stage, "pnpm-workspace.yaml"),
      `packages: []\n${allowBuildsYaml}`,
    );

    process.stdout.write("\n[desktop-artifact] Installing staged production dependencies...\n");
    run("pnpm", ["install", "--prod"], stage);

    const updateChannel = resolveUpdateChannel();
    const publishConfig =
      resolveGitHubPublishConfig(updateChannel) ?? resolveGenericPublishConfig();
    if (publishConfig === undefined) {
      process.stdout.write(
        "\n[desktop-artifact] No update feed configured (set APP_DESKTOP_UPDATE_REPOSITORY or " +
          "APP_DESKTOP_UPDATE_URL); the packaged app ships with auto-updates disabled.\n",
      );
    }
    const config = {
      appId: APP_ID,
      productName: PRODUCT_NAME,
      artifactName: `Throughline-${options.version}-${options.arch}.\${ext}`,
      directories: { output: options.outputDir },
      electronLanguages: [...DESKTOP_ELECTRON_LANGUAGES],
      files: [...DESKTOP_FILE_EXCLUSIONS],
      asarUnpack: [...ASAR_UNPACK],
      ...(publishConfig ? { publish: [publishConfig] } : {}),
      ...(options.platform === "mac"
        ? {
            mac: {
              target: options.target === "dmg" ? [options.target, "zip"] : [options.target],
              category: "public.app-category.developer-tools",
              ...(options.signed ? {} : { identity: null }),
            },
          }
        : {}),
      ...(options.platform === "win" ? { win: { target: [options.target] } } : {}),
      ...(options.platform === "linux"
        ? { linux: { target: [options.target], category: "Development" } }
        : {}),
    };
    const configPath = NodePath.join(stageRoot, "electron-builder.json");
    NodeFS.writeFileSync(configPath, JSON.stringify(config, null, 2));

    for (const [key, value] of Object.entries(buildEnv)) {
      if (value === "") delete buildEnv[key];
    }
    if (!options.signed) {
      buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
      delete buildEnv.CSC_LINK;
      delete buildEnv.CSC_KEY_PASSWORD;
      delete buildEnv.APPLE_API_KEY;
      delete buildEnv.APPLE_API_KEY_ID;
      delete buildEnv.APPLE_API_ISSUER;
    }

    run(
      "pnpm",
      [
        "--filter",
        "@app/desktop",
        "exec",
        "electron-builder",
        "--projectDir",
        stage,
        `--${options.platform}`,
        `--${options.arch}`,
        "--config",
        configPath,
        "--publish",
        "never",
      ],
      REPO_ROOT,
      buildEnv,
    );
    process.stdout.write(`\n✔ Artifacts in ${options.outputDir}\n`);
  } finally {
    if (options.keepStage) {
      process.stdout.write(`\n[desktop-artifact] Kept stage at ${stageRoot}\n`);
    } else {
      NodeFS.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  main();
}
