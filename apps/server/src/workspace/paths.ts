/**
 * The on-disk layout, in one place.
 *
 * Two rules shape it. First, **git moves all repository bytes** — clones and
 * fetches cost API quota nothing — so the clone cache is a first-class
 * directory rather than a temp folder. Second, **file names are indices, never
 * paths**: a repository path may contain slashes, spaces, unicode, or a leading
 * dot, and encoding all of that safely is a bug farm. `files.json` maps index →
 * path, and every artifact for that file is named by its index.
 *
 * @module workspace/paths
 */
import type { PrRef } from "@app/contracts";

/** `<dataRoot>/workspaces/<owner>/<repo>` — one clone per repository, shared. */
export function repoRoot(dataRoot: string, ref: Pick<PrRef, "owner" | "repo">): string {
  return join(dataRoot, "workspaces", safe(ref.owner), safe(ref.repo));
}

/** The bare, partial clone every worktree for this repository is added from. */
export function bareRepo(dataRoot: string, ref: Pick<PrRef, "owner" | "repo">): string {
  return join(repoRoot(dataRoot, ref), "repo.git");
}

/** One worktree per analysis run, removed when the run finishes. */
export function worktreeDir(
  dataRoot: string,
  ref: Pick<PrRef, "owner" | "repo">,
  runId: string,
): string {
  return join(repoRoot(dataRoot, ref), "worktrees", safe(runId));
}

/**
 * `<dataRoot>/runs/<owner>/<repo>/<number>/<runId>` — the run directory. The
 * run id is the journey id, which is what lets a reading surface find the
 * materialized diff for a journey it only knows by id.
 */
export function runDir(dataRoot: string, ref: PrRef, runId: string): string {
  return join(dataRoot, "runs", safe(ref.owner), safe(ref.repo), String(ref.number), safe(runId));
}

export const RUN_FILES = {
  /** Zero-context patch: the seed-hunk source of truth. */
  zeroContextPatch: "diff/full-zero.patch",
  /** Standard-context patch, whole; the per-file chunks are split from it. */
  contextPatch: "diff/full.patch",
  perFileDir: "diff/by-file",
  files: "files.json",
  hunks: "hunks.json",
  tree: "tree.json",
  contentsDir: "contents",
  agentDir: "agent",
  fallbacks: "fallbacks.log",
} as const;

export function perFilePatch(index: number): string {
  return `${RUN_FILES.perFileDir}/${index}.patch`;
}

export function fileContentName(index: number, side: "old" | "new"): string {
  return `${RUN_FILES.contentsDir}/${index}.${side}`;
}

/**
 * A path segment safe on every platform. Repository and owner names are already
 * restricted by GitHub, but a run id or a fork name should never be able to
 * escape the data root.
 */
function safe(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

function join(...segments: ReadonlyArray<string>): string {
  return segments.join("/");
}
