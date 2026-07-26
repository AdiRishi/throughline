/**
 * The files rail: the project's real file tree, not a list of changed paths.
 *
 * It looks and behaves like an editor's tree because the intent is to feel like
 * you are in the project, not in a report about it. Changed files carry the
 * quiet status marker an editor uses for uncommitted work, and the filter
 * narrows to them when the full tree is noise.
 *
 * A pinned entry sits above the tree holding the Overview and, while a cluster
 * is open, that cluster's narrative — docs-as-files, the way an editor treats a
 * README. It is what keeps the story one click away in the receded posture.
 *
 * @module features/journey/FilesRail
 */
import { useAtomValue } from "@effect/atom-react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Link, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import type { FileChange } from "@app/contracts";

import { journeyAtomsFor, prKeyString } from "../../state/journey.ts";
import { useJourney } from "./context.tsx";

type GitStatus = "added" | "deleted" | "modified" | "renamed" | "untracked";

function statusOf(file: FileChange): GitStatus {
  switch (file.changeKind) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
    case "copied":
      return "renamed";
    default:
      return "modified";
  }
}

export function FilesRail() {
  const { journey, railMode } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const navigate = useNavigate();
  const [changedOnly, setChangedOnly] = useState(false);

  const key = prKeyString({
    owner: params.owner,
    repo: params.repo,
    number: Number.parseInt(params.number, 10),
  });
  const treeResult = useAtomValue(journeyAtomsFor(key).tree);
  const treePaths = useMemo(
    () => Option.getOrNull(AsyncResult.value(treeResult))?.paths ?? [],
    [treeResult],
  );

  const changedPaths = useMemo(
    () => journey.files.map((file) => file.path).toSorted(),
    [journey.files],
  );

  // Deleted files are not in the head tree, but they are part of the change and
  // must stay reachable — so the full tree is the head revision plus them.
  const fullPaths = useMemo(() => {
    const paths = new Set<string>(treePaths);
    for (const path of changedPaths) paths.add(path);
    return [...paths].toSorted();
  }, [changedPaths, treePaths]);

  const gitStatus = useMemo(
    () => journey.files.map((file) => ({ path: file.path, status: statusOf(file) })),
    [journey.files],
  );

  const clustersByPath = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const hunk of journey.hunks) {
      const existing = map.get(hunk.path);
      if (existing === undefined) map.set(hunk.path, new Set([hunk.home]));
      else existing.add(hunk.home);
    }
    return map;
  }, [journey.hunks]);

  const { model } = useFileTree({
    paths: changedOnly ? changedPaths : fullPaths,
    initialExpansion: 2,
    flattenEmptyDirectories: true,
    density: "compact",
    search: true,
    gitStatus,
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") return null;
      const homes = clustersByPath.get(item.path);
      if (homes === undefined) return null;
      return {
        text: homes.size === 1 ? "1 cluster" : `${homes.size} clusters`,
        title: "Clusters that home a hunk in this file",
      };
    },
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      if (path === undefined || path.endsWith("/")) return;
      void navigate({
        to: "/pr/$owner/$repo/$number/file/$",
        params: { ...params, _splat: path },
      });
    },
  });

  useEffect(() => {
    model.resetPaths(changedOnly ? changedPaths : fullPaths);
  }, [changedOnly, changedPaths, fullPaths, model]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  if (railMode !== "files") return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pb-2">
        <PinnedEntry />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-1">
        <FileTree model={model} style={{ height: "100%" }} />
      </div>
      <label className="flex shrink-0 cursor-pointer items-center gap-2 border-t border-border px-3 py-2.5 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={changedOnly}
          onChange={(event) => setChangedOnly(event.target.checked)}
          className="h-3.5 w-3.5 accent-[var(--color-foreground)]"
        />
        Changed files only
      </label>
    </div>
  );
}

/**
 * Docs-as-files. It shows the Overview, or — when a cluster is open — that
 * cluster's story, so the narrative never becomes something you have to leave
 * the code to find.
 */
function PinnedEntry() {
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const routeParams = { owner: params.owner, repo: params.repo, number: params.number };
  const { journey, progress } = useJourney();

  const currentCluster =
    progress.currentClusterPosition === null
      ? null
      : (journey.clusters.find((cluster) => cluster.position === progress.currentClusterPosition) ??
        null);

  return (
    <Link
      to="/pr/$owner/$repo/$number"
      params={routeParams}
      activeOptions={{ exact: true }}
      className="flex items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[13px] transition-colors hover:border-border-strong data-[status=active]:bg-raised"
    >
      <span className="mt-[2px] font-mono text-[11px] text-faint">§</span>
      <span className="min-w-0">
        <span className="block truncate">
          Overview
          {currentCluster !== null && (
            <span className="text-muted">
              {" — "}
              {currentCluster.position} · {currentCluster.title}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
}
