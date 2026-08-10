#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node script; there is no Effect runtime here.
// Rename this project from "throughline" to your own name.
//
// The project name appears in exactly three shapes across the repo:
//   kebab   "throughline"             package name, ~/.<name> data dir
//   title   "Throughline"             product name, CLI docs, HTML title
//   app id  "com.arsoftware.throughline" electron-builder appId
//
// This script sweeps every git-tracked text file and replaces all three
// (app id first, since it contains the kebab name), then renames the tracked
// files whose *path* embeds the name (docs/brand/throughline-icon-*.png and
// friends, which t3.json points at). It also rewrites its own OLD_* constants
// below, so it stays re-runnable after a rename.
//
// Usage:
//   pnpm rename                        # interactive
//   pnpm rename my-app com.mycompany   # name + app id prefix (both required)
//   pnpm rename my-app com.mycompany --dry-run   # print the plan, change nothing
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { ensureCleanWorkingTree } from "./lib/git.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

const OLD_KEBAB = "throughline";
const OLD_TITLE = "Throughline";
const OLD_APP_ID = "com.arsoftware.throughline";

/** Never swept. `.repos/` is vendored, read-only reference material (see .repos/AGENTS.md). */
const EXCLUDED_PREFIXES = [".repos/"] as const;
const EXCLUDED_FILES = ["pnpm-lock.yaml"] as const;

/** "my-cool-app" -> "My Cool App" */
export function toTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isKebabCase(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

/** Reverse-DNS prefix, e.g. "com.mycompany" — at least two lowercase segments. */
export function isReverseDns(prefix: string): boolean {
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(prefix);
}

/**
 * Whether a git-tracked path takes part in the rename.
 *
 * `.repos/` is excluded because it is a vendored read-only subtree — roughly
 * 95% of `git ls-files` here — and rewriting it would both corrupt the
 * reference material and make the next `pnpm sync:repos` conflict.
 */
export function isSweepableFile(file: string): boolean {
  if (file === "") return false;
  if ((EXCLUDED_FILES as readonly string[]).includes(file)) return false;
  return !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export interface RenameTargets {
  readonly kebab: string;
  readonly title: string;
  readonly appId: string;
}

/** Order matters: the app id contains the kebab name. */
export function renameContent(before: string, { kebab, title, appId }: RenameTargets): string {
  return before
    .replaceAll(OLD_APP_ID, appId)
    .replaceAll(OLD_KEBAB, kebab)
    .replaceAll(OLD_TITLE, title);
}

/**
 * The path a tracked file moves to, or `undefined` when it stays put. Applied
 * to the whole relative path so a directory named after the project moves too.
 */
export function renamePath(file: string, { kebab, title }: RenameTargets): string | undefined {
  const renamed = file.replaceAll(OLD_KEBAB, kebab).replaceAll(OLD_TITLE, title);
  return renamed === file ? undefined : renamed;
}

/**
 * A NUL byte in the first few KiB means the file is not text. Reading a PNG as
 * UTF-8 and writing it back would replace every invalid byte with U+FFFD, so
 * binaries are renamed but never rewritten.
 */
export function isProbablyBinary(contents: Uint8Array): boolean {
  const limit = Math.min(contents.length, 8000);
  for (let index = 0; index < limit; index += 1) {
    if (contents[index] === 0) return true;
  }
  return false;
}

export interface CliOptions {
  readonly kebab: string | undefined;
  readonly appIdPrefix: string | undefined;
  readonly dryRun: boolean;
}

export function parseCliOptions(argv: ReadonlyArray<string>): CliOptions {
  const positional = argv.filter((argument) => !argument.startsWith("--"));
  return {
    kebab: positional[0],
    appIdPrefix: positional[1],
    dryRun: argv.includes("--dry-run"),
  };
}

function ask(question: string): Promise<string> {
  const rl = NodeReadline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function trackedFiles(): ReadonlyArray<string> {
  return NodeChildProcess.execSync("git ls-files", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  })
    .split("\n")
    .filter((file) => isSweepableFile(file));
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));

  let kebab = options.kebab;
  let appIdPrefix = options.appIdPrefix;

  if (!kebab) {
    kebab = await ask("Project name (kebab-case, e.g. my-cool-app)");
  }
  if (!kebab || !isKebabCase(kebab)) {
    console.error(`Error: project name must be kebab-case (got "${kebab ?? ""}").`);
    process.exit(1);
  }
  if (!appIdPrefix) {
    appIdPrefix = await ask("App id prefix (reverse-DNS, e.g. com.mycompany)");
  }
  if (!appIdPrefix || !isReverseDns(appIdPrefix)) {
    console.error(`Error: app id prefix must be reverse-DNS (got "${appIdPrefix ?? ""}").`);
    process.exit(1);
  }

  const targets: RenameTargets = {
    kebab,
    title: toTitle(kebab),
    appId: `${appIdPrefix}.${kebab}`,
  };

  // This rewrites and moves hundreds of tracked files in one pass. On a dirty
  // tree the result is unreviewable and cannot be undone with `git checkout .`,
  // so require a clean one — `--dry-run` is the way to look first.
  if (!options.dryRun) {
    ensureCleanWorkingTree({
      repoRoot: REPO_ROOT,
      reason: "renaming rewrites every tracked file, so the diff must be reviewable",
    });
  }

  console.log(`\nRenaming project${options.dryRun ? " (dry run — nothing is written)" : ""}:\n`);
  console.log(`  name          ${OLD_KEBAB} -> ${targets.kebab}`);
  console.log(`  product name  ${OLD_TITLE} -> ${targets.title}`);
  console.log(`  app id        ${OLD_APP_ID} -> ${targets.appId}`);
  console.log(`  app data dir  ~/.${OLD_KEBAB} -> ~/.${targets.kebab}`);
  console.log();

  const files = trackedFiles();

  // Contents first: a rewrite has to find the files where `git ls-files` said
  // they were. `t3.json` points at one of the icons renamed below, and the two
  // sweeps use the same replacements, so the pointer and the file stay in sync.
  let rewritten = 0;
  for (const file of files) {
    const absolute = NodePath.join(REPO_ROOT, file);
    const raw = NodeFS.readFileSync(absolute);
    if (isProbablyBinary(raw)) continue;
    const before = raw.toString("utf-8");
    const after = renameContent(before, targets);
    if (after === before) continue;
    if (!options.dryRun) {
      NodeFS.writeFileSync(absolute, after);
    }
    rewritten += 1;
    console.log(`  ✓ ${file}`);
  }

  let moved = 0;
  for (const file of files) {
    const renamed = renamePath(file, targets);
    if (renamed === undefined) continue;
    console.log(`  → ${file} -> ${renamed}`);
    moved += 1;
    if (options.dryRun) continue;
    // `git mv` so history follows the file; plain fs.rename would look like a
    // delete plus an add.
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(REPO_ROOT, renamed)), { recursive: true });
    const result = NodeChildProcess.spawnSync("git", ["mv", "--", file, renamed], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `git mv failed for "${file}" -> "${renamed}" (exit ${String(result.status)}).`,
      );
    }
  }

  console.log(
    `\n${options.dryRun ? "Would rewrite" : "Rewrote"} ${String(rewritten)} file(s) and ${
      options.dryRun ? "move" : "moved"
    } ${String(moved)}.`,
  );
  if (options.dryRun) {
    console.log("Re-run without --dry-run to apply.");
    return;
  }
  console.log("\nDone! You may also want to:");
  console.log("  • Rewrite the README intro for your project");
  console.log("  • Run `pnpm check && pnpm test` to verify everything still passes");
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error: unknown) {
    process.stderr.write(
      `[rename] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
