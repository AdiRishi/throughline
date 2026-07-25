import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useState } from "react";

import type { ClusterId, Journey, ReadState } from "@app/contracts";
import { clusterProgress, journeyProgress } from "@app/journey/progress";

export type JourneyView =
  | { readonly type: "overview" }
  | { readonly type: "cluster"; readonly clusterId: string }
  | { readonly type: "file"; readonly path: string };

function gitStatus(kind: Journey["files"][number]["kind"]) {
  switch (kind) {
    case "added":
      return "added" as const;
    case "renamed":
      return "renamed" as const;
    case "deleted":
      return "deleted" as const;
    default:
      return "modified" as const;
  }
}

export function JourneyNavigation({
  journey,
  readState,
  view,
  treePaths,
  stale,
  onOverview,
  onCluster,
  onFile,
}: {
  readonly journey: Journey;
  readonly readState: ReadState;
  readonly view: JourneyView;
  readonly treePaths: ReadonlyArray<string>;
  readonly stale: boolean;
  readonly onOverview: () => void;
  readonly onCluster: (clusterId: ClusterId) => void;
  readonly onFile: (path: string) => void;
}) {
  const [mode, setMode] = useState<"journey" | "files">(view.type === "file" ? "files" : "journey");
  const [changedOnly, setChangedOnly] = useState(false);
  const changedPaths = useMemo(() => journey.files.map((file) => file.path), [journey.files]);
  const homeCount = useMemo(() => {
    const counts = new Map<string, Set<ClusterId>>();
    for (const hunk of journey.hunks) {
      const homes = counts.get(hunk.path) ?? new Set<ClusterId>();
      homes.add(hunk.home);
      counts.set(hunk.path, homes);
    }
    return counts;
  }, [journey.hunks]);
  const { model: fileTree } = useFileTree({
    paths: treePaths,
    initialExpansion: 2,
    search: true,
    gitStatus: journey.files.map((file) => ({ path: file.path, status: gitStatus(file.kind) })),
    initialSelectedPaths: view.type === "file" ? [view.path] : [],
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (path) onFile(path);
    },
    renderRowDecoration: ({ item }) => {
      const homes = homeCount.get(item.path);
      return homes === undefined
        ? null
        : {
            text: String(homes.size),
            title: `${homes.size} journey ${homes.size === 1 ? "home" : "homes"}`,
          };
    },
  });

  useEffect(() => {
    fileTree.resetPaths(changedOnly ? changedPaths : treePaths, {
      initialExpandedPaths: view.type === "file" ? [view.path.split("/")[0] ?? ""] : [],
    });
    fileTree.setGitStatus(
      journey.files.map((file) => ({ path: file.path, status: gitStatus(file.kind) })),
    );
  }, [changedOnly, changedPaths, fileTree, journey.files, treePaths, view]);

  const overall = journeyProgress(journey.hunks, readState);
  return (
    <aside className="cluster-rail">
      <div className="rail-progress">
        <span>{Math.round(overall.ratio * 100)}% read</span>
        {stale && <strong>Snapshot is stale</strong>}
      </div>
      <div className="rail-modes" aria-label="Navigation mode">
        <button className={mode === "journey" ? "active" : ""} onClick={() => setMode("journey")}>
          Journey
        </button>
        <button className={mode === "files" ? "active" : ""} onClick={() => setMode("files")}>
          Files
        </button>
      </div>

      {mode === "journey" ? (
        <>
          <button
            className={view.type === "overview" ? "rail-overview active" : "rail-overview"}
            onClick={onOverview}
          >
            Overview
          </button>
          <ol>
            {journey.clusters.map((cluster) => {
              const item = clusterProgress(cluster.id, journey.hunks, readState.readFiles);
              return (
                <li key={cluster.id}>
                  <button
                    className={
                      view.type === "cluster" && view.clusterId === cluster.id ? "active" : ""
                    }
                    onClick={() => onCluster(cluster.id)}
                  >
                    <span>{String(cluster.position).padStart(2, "0")}</span>
                    <strong>{cluster.title}</strong>
                    <small>{cluster.weight}</small>
                    <small>
                      {item.read}/{item.total}
                    </small>
                  </button>
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <div className="tree-panel rail-tree">
          <div className="tree-document">
            <button onClick={onOverview}>
              <span>§</span>
              Journey overview
            </button>
            <button
              className={changedOnly ? "active" : ""}
              onClick={() => setChangedOnly((value) => !value)}
            >
              {changedOnly ? "All files" : "Changed only"}
            </button>
          </div>
          <FileTree model={fileTree} header={<strong>Repository</strong>} />
        </div>
      )}
    </aside>
  );
}
