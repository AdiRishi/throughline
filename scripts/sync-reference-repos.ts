#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone Node repo-sync script; no Effect runtime.
// Vendors read-only reference repositories under `.repos/` as squashed git
// subtrees, pinned to the version of the dependency this workspace installs.
// The vendored copies are reference material only: never edit them, never
// import from them, and re-sync them whenever the pinned dependency is bumped.
//
// Usage:
//   pnpm sync:repos                 sync every configured repo
//   pnpm sync:repos --repo <id>     sync one repo
//   pnpm sync:repos --latest        track the default branch instead of the pin
//   pnpm sync:repos --dry-run       print the git commands without running them
//
// The T3 Code original is an Effect CLI program; this starter keeps it as a
// dependency-free Node script like the other scripts here.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ensureCleanWorkingTree } from "./lib/git.ts";
import { REFERENCE_REPOS, type ReferenceRepo } from "./lib/reference-repos.ts";

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

// pnpm does not hoist workspace dependencies to the root node_modules, so
// resolve installed packages the way a workspace package would. Contracts is
// the anchor because it depends on `effect` by definition.
const resolveFromContracts = NodeModule.createRequire(
  NodePath.join(REPO_ROOT, "packages/contracts/package.json"),
).resolve;

export interface CliOptions {
  readonly repoId: string | undefined;
  readonly latest: boolean;
  readonly dryRun: boolean;
}

export function parseCliOptions(argv: ReadonlyArray<string>): CliOptions {
  const repoFlagIndex = argv.indexOf("--repo");
  return {
    repoId: repoFlagIndex !== -1 ? argv[repoFlagIndex + 1] : undefined,
    latest: argv.includes("--latest"),
    dryRun: argv.includes("--dry-run"),
  };
}

export function selectRepos(repoId: string | undefined): ReadonlyArray<ReferenceRepo> {
  if (repoId === undefined) {
    return REFERENCE_REPOS;
  }
  const repo = REFERENCE_REPOS.find((candidate) => candidate.id === repoId);
  if (!repo) {
    const expected = REFERENCE_REPOS.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown reference repo "${repoId}". Expected one of: ${expected}.`);
  }
  return [repo];
}

/** The exact version of the dependency as installed in the workspace. */
function installedVersion(packageName: string): string {
  const packageJsonPath = resolveFromContracts(`${packageName}/package.json`);
  const parsed = JSON.parse(NodeFS.readFileSync(packageJsonPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") {
    throw new Error(`Could not read an installed version from ${packageJsonPath}.`);
  }
  return parsed.version;
}

export function resolveReferenceRepoRef(
  repo: ReferenceRepo,
  latest: boolean,
  readInstalledVersion: (packageName: string) => string = installedVersion,
): string {
  return latest
    ? repo.latestRef
    : `${repo.versionTagPrefix}${readInstalledVersion(repo.installedPackage)}`;
}

export interface ReferenceRepoSyncPlan {
  readonly repoId: string;
  /** `add` creates the subtree; `pull` updates an existing one to the new ref. */
  readonly action: "add" | "pull";
  readonly ref: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The whole decision — which repos, which ref, which git invocation — with no
 * side effects, so it can be asserted on without a git checkout or a network.
 */
export function planReferenceRepoSync(input: {
  readonly options: CliOptions;
  readonly subtreeExists: (prefix: string) => boolean;
  readonly readInstalledVersion?: (packageName: string) => string;
}): ReadonlyArray<ReferenceRepoSyncPlan> {
  return selectRepos(input.options.repoId).map((repo) => {
    const action = input.subtreeExists(repo.prefix) ? "pull" : "add";
    const ref = resolveReferenceRepoRef(
      repo,
      input.options.latest,
      input.readInstalledVersion ?? installedVersion,
    );
    return {
      repoId: repo.id,
      action,
      ref,
      args: ["subtree", action, `--prefix=${repo.prefix}`, repo.repository, ref, "--squash"],
    };
  });
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const plans = planReferenceRepoSync({
    options,
    subtreeExists: (prefix) => NodeFS.existsSync(NodePath.join(REPO_ROOT, prefix)),
  });

  if (!options.dryRun) {
    ensureCleanWorkingTree({ repoRoot: REPO_ROOT, reason: "`git subtree` needs a clean tree" });
  }

  for (const plan of plans) {
    process.stdout.write(`[sync:repos] ${plan.repoId}: git ${plan.args.join(" ")}\n`);
    if (options.dryRun) {
      continue;
    }

    const result = NodeChildProcess.spawnSync("git", [...plan.args], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(
        `git subtree ${plan.action} failed for "${plan.repoId}" (exit ${result.status}).`,
      );
    }
  }
}

// Same entrypoint guard as the sibling scripts: without it, importing anything
// from this module — a test, another script — runs a git subtree sync as a side
// effect of the import.
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    process.stderr.write(
      `[sync:repos] fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
