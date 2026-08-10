// @effect-diagnostics nodeBuiltinImport:off - Repo tooling runs before (and
// without) an Effect runtime.
import * as NodeChildProcess from "node:child_process";

/**
 * Refuse to run a tree-rewriting script on a dirty checkout.
 *
 * `git subtree` requires a clean tree outright, and a bulk rewrite is only
 * reviewable — and only revertible with `git checkout .` — when the diff it
 * produces is the entire diff.
 */
export function ensureCleanWorkingTree({
  repoRoot,
  reason,
}: {
  readonly repoRoot: string;
  readonly reason: string;
}): void {
  const status = NodeChildProcess.execSync("git status --porcelain", {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (status.trim().length > 0) {
    throw new Error(`The working tree has uncommitted changes. ${reason} — commit or stash first.`);
  }
}
