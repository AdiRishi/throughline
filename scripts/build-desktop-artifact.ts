#!/usr/bin/env node
// Package the desktop app into a distributable (dmg / nsis / AppImage).
//
// Pipeline: build web -> build server -> build desktop -> stage an app dir ->
// run electron-builder. The packaged app runs the SAME local-server + web
// bundle the dev flow does; the shell spawns `apps/server/dist/bin.mjs` and
// the server serves the web build from its `dist/client`.
//
// Signing, notarization, and publishing still need project-specific values and
// are deliberately left to the environment; the icon and identity come from
// `docs/brand/`. Run:
//   pnpm dist:desktop -- --platform mac --target dmg
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const APP_ID = "com.arsoftware.throughline";
const PRODUCT_NAME = "Throughline";
/** The 1024px brand mark every platform icon is derived from. */
const BRAND_ICON = "docs/brand/favicon/throughline-icon-1024.png";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] !== undefined
    ? (process.argv[index + 1] as string)
    : fallback;
}

const platform = arg(
  "platform",
  // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see dev-runner.ts header).
  process.platform === "win32" ? "win" : process.platform === "linux" ? "linux" : "mac",
);
const target = arg("target", platform === "mac" ? "dmg" : platform === "win" ? "nsis" : "AppImage");

function run(command: string, args: ReadonlyArray<string>, cwd = REPO_ROOT): void {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  NodeChildProcess.execFileSync(command, args, { cwd, stdio: "inherit" });
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

/** Packages the server bundle externalizes and the packaged app must install. */
const HARNESS_PACKAGES: ReadonlyArray<string> = [
  "@openai/codex-sdk",
  "@anthropic-ai/claude-agent-sdk",
];

/** Resolves `catalog:` versions from the workspace catalog. */
function readWorkspaceCatalog(): Record<string, string> {
  const raw = NodeFS.readFileSync(NodePath.join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const catalog: Record<string, string> = {};
  let inBlock = false;
  for (const line of raw.split("\n")) {
    if (/^catalog:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const entry = /^ {2}"?([^"\s:]+)"?:\s*(.+?)\s*$/.exec(line);
    if (entry) {
      catalog[entry[1] as string] = (entry[2] as string).replace(/^["']|["']$/g, "");
      continue;
    }
    if (line.trim().length > 0 && !line.startsWith(" ")) inBlock = false;
  }
  return catalog;
}

function main(): void {
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
  copy("apps/server/dist", "apps/server/dist");
  copy("apps/web/dist", "apps/server/dist/client");
  validateBundledClientAssets(NodePath.join(stage, "apps/server/dist/client"));

  /**
   * `build/` is electron-builder's default `buildResources` directory, and an
   * `icon.png` of at least 512px there is what it converts into the `.icns` and
   * `.ico` each platform wants. Staging the 1024px master rather than committing a
   * generated `.icns` keeps one source of truth for the mark: `docs/brand/` holds
   * the artwork, and the packaging derives every size from it.
   */
  NodeFS.mkdirSync(NodePath.join(stage, "build"), { recursive: true });
  copy(BRAND_ICON, "build/icon.png");

  const desktopPackageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/desktop/package.json"), "utf8"),
  ) as {
    readonly dependencies: { readonly "electron-updater": string };
  };
  /**
   * The harness SDKs are the one thing the server bundle deliberately does NOT
   * inline (see apps/server/vite.config.ts): each resolves and spawns its own
   * vendored platform binary from its own package directory, so it has to exist
   * as a real installed package next to the bundle. Their versions come from the
   * server's manifest so the packaged app runs the versions the repo pins.
   */
  const serverPackageJson = JSON.parse(
    NodeFS.readFileSync(NodePath.join(REPO_ROOT, "apps/server/package.json"), "utf8"),
  ) as { readonly dependencies: Record<string, string> };
  const catalog = readWorkspaceCatalog();
  const harnessDependencies = Object.fromEntries(
    HARNESS_PACKAGES.map((name) => {
      const declared = serverPackageJson.dependencies[name];
      if (declared === undefined) {
        throw new Error(
          `[desktop-artifact] apps/server does not depend on ${name}, but the server bundle ` +
            "externalizes it. Add the dependency or stop externalizing it.",
        );
      }
      const resolved = declared === "catalog:" ? catalog[name] : declared;
      if (resolved === undefined) {
        throw new Error(`[desktop-artifact] ${name} is 'catalog:' but has no catalog entry.`);
      }
      return [name, resolved];
    }),
  );
  const electronPackageJson = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(REPO_ROOT, "apps/desktop/node_modules/electron/package.json"),
      "utf8",
    ),
  ) as { readonly version: string };

  NodeFS.writeFileSync(
    NodePath.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "throughline",
        version: "0.0.0",
        // Both land in the bundle's Info.plist, and electron-builder warns when
        // either is absent. The description is the one-line answer to "what is
        // this?" that the OS shows before the app has ever been opened.
        description: "Turn a large pull request into a journey you can finish.",
        author: "Throughline",
        main: "apps/desktop/dist-electron/main.cjs",
        dependencies: {
          "electron-updater": desktopPackageJson.dependencies["electron-updater"],
          ...harnessDependencies,
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

  // 3. electron-builder config.
  const config = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    directories: { output: NodePath.join(REPO_ROOT, "release/dist") },
    files: ["**/*"],
    // A binary inside an asar archive cannot be exec'd, and both harness SDKs
    // spawn a vendored platform binary — so their whole trees ship unpacked
    // alongside the server bundle.
    asarUnpack: ["apps/server/**", "node_modules/@openai/**", "node_modules/@anthropic-ai/**"],
    mac: { target: [target], category: "public.app-category.developer-tools" },
    win: { target: [target] },
    linux: { target: [target], category: "Development" },
  };
  const configPath = NodePath.join(REPO_ROOT, "release/electron-builder.json");
  NodeFS.mkdirSync(NodePath.dirname(configPath), { recursive: true });
  NodeFS.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 4. Pack. Requires `electron-builder` (a devDependency of @app/desktop).
  run("pnpm", [
    "--filter",
    "@app/desktop",
    "exec",
    "electron-builder",
    "--projectDir",
    stage,
    `--${platform}`,
    "--config",
    configPath,
    "--publish",
    "never",
  ]);
  process.stdout.write(`\n✔ Artifacts in release/dist\n`);
}

main();
