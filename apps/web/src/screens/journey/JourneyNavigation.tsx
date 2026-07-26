import { ArrowLeft, ArrowRight, FileText } from "@phosphor-icons/react";
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
    initialExpansion: "open",
    search: false,
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
  const selectedCluster =
    view.type === "cluster"
      ? journey.clusters.find((cluster) => cluster.id === view.clusterId)
      : view.type === "file"
        ? journey.clusters.find((cluster) => cluster.fileOrder.includes(view.path))
        : undefined;
  const previousCluster =
    selectedCluster === undefined ? undefined : journey.clusters[selectedCluster.position - 2];
  const nextCluster =
    selectedCluster === undefined ? undefined : journey.clusters[selectedCluster.position];
  const overviewLabel =
    selectedCluster === undefined
      ? "Overview"
      : `Overview — ${selectedCluster.position} · ${selectedCluster.title}`;
  return (
    <aside className="cluster-rail">
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
          <div className="rail-progress">
            <span>Journey</span>
            <span>
              {Math.round(overall.ratio * 100)}% · {overall.read} of {overall.total} hunks
            </span>
            <i>
              <span style={{ width: `${overall.ratio * 100}%` }} />
            </i>
            {stale && <strong>Snapshot is stale</strong>}
          </div>
          <button
            className={view.type === "overview" ? "rail-overview active" : "rail-overview"}
            onClick={onOverview}
          >
            <FileText size={13} weight="bold" />
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
          {selectedCluster !== undefined && (
            <footer className="rail-neighbors">
              <button
                disabled={previousCluster === undefined}
                onClick={() => {
                  if (previousCluster !== undefined) onCluster(previousCluster.id);
                }}
              >
                <ArrowLeft size={11} weight="bold" />
                <span>{previousCluster?.position ?? ""}</span>
                <span>{previousCluster?.title ?? "Start"}</span>
              </button>
              <button
                disabled={nextCluster === undefined}
                onClick={() => {
                  if (nextCluster !== undefined) onCluster(nextCluster.id);
                }}
              >
                <span>{nextCluster?.position ?? ""}</span>
                <ArrowRight size={11} weight="bold" />
              </button>
            </footer>
          )}
        </>
      ) : (
        <div className="tree-panel rail-tree">
          <div className="tree-document">
            <button onClick={onOverview}>
              <FileText size={13} weight="bold" />
              <span>{overviewLabel}</span>
            </button>
          </div>
          <FileTree model={fileTree} style={{ height: "100%", minHeight: 0 }} />
          <button
            className={changedOnly ? "tree-filter active" : "tree-filter"}
            onClick={() => setChangedOnly((value) => !value)}
          >
            <span aria-hidden />
            Changed files only
          </button>
        </div>
      )}
    </aside>
  );
}
