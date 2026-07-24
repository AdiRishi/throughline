import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Cluster, ClusterId, FileChange, Journey, RepositoryPath } from "@app/contracts";

import { readMarkKey, useJourneyContext } from "./JourneyContext.tsx";
import { deriveJourneyViewModel, fileHomes } from "./model.ts";

const TREE_UNSAFE_CSS = `
  :host {
    --trees-fg-override: var(--secondary);
    --trees-selected-bg-override: var(--selected);
    --trees-border-color-override: transparent;
    --trees-theme-git-added-fg: var(--addition);
    --trees-theme-git-modified-fg: var(--accent);
    --trees-theme-git-deleted-fg: var(--deletion);
    --trees-theme-git-renamed-fg: var(--accent);
    background: transparent;
    font-family: var(--font-mono);
    font-size: 11px;
  }

  button[data-type="item"] {
    border-radius: 4px;
    margin-inline: 5px;
    width: calc(100% - 10px);
  }
`;

export function JourneyNavigation() {
  const context = useJourneyContext();
  const params = useParams({ strict: false }) as {
    readonly _splat?: string;
  };
  const currentCluster =
    context.currentClusterId === null
      ? null
      : (context.document.journey.clusters.find(
          (cluster) => cluster.id === context.currentClusterId,
        ) ?? null);
  const navigablePaths = [
    ...context.treePaths,
    ...context.document.journey.files.map((file) => file.path),
  ];
  const activeFile =
    params._splat === undefined ? null : safeRoutePath(params._splat, navigablePaths);

  return (
    <aside className="journey-navigation" aria-label="Journey navigation">
      <fieldset className="journey-navigation-tabs" aria-label="Navigation mode">
        <button
          type="button"
          aria-pressed={context.navigationMode === "journey"}
          onClick={() => context.setNavigationMode("journey")}
        >
          Journey
        </button>
        <button
          type="button"
          aria-pressed={context.navigationMode === "files"}
          onClick={() => context.setNavigationMode("files")}
        >
          Files
        </button>
      </fieldset>

      {context.navigationMode === "journey" ? (
        <JourneyRail currentClusterId={context.currentClusterId} />
      ) : (
        <FilesRail currentCluster={currentCluster} activeFile={activeFile} />
      )}
    </aside>
  );
}

function JourneyRail({ currentClusterId }: { readonly currentClusterId: ClusterId | null }) {
  const { document, stale, readView, navigateOverview, navigateCluster, reanalyze } =
    useJourneyContext();
  const { journey } = document;
  const view = useMemo(
    () =>
      deriveJourneyViewModel(journey, {
        journeyId: journey.id,
        readFiles: readView.readMarks,
        displayMode: readView.displayMode,
        updatedAt: journey.pinned.analyzedAt,
      }),
    [journey, readView],
  );

  return (
    <div className="journey-rail">
      <section className="journey-overall-progress" aria-label="Journey progress">
        <div>
          <span>Journey</span>
          <span>
            {Math.round(view.progress.fraction * 100)}% · {view.progress.markedFiles} of{" "}
            {view.progress.clusterFiles} files
          </span>
        </div>
        <progress value={view.progress.readHunks} max={Math.max(1, view.progress.totalHunks)} />
        {stale ? (
          <div className="journey-stale-rail">
            <span>Stale snapshot</span>
            <button type="button" onClick={reanalyze}>
              Reanalyze
            </button>
          </div>
        ) : null}
      </section>

      <nav className="journey-cluster-list" aria-label="Journey clusters">
        <button
          className="journey-overview-link"
          type="button"
          data-selected={currentClusterId === null}
          onClick={navigateOverview}
        >
          <span aria-hidden>§</span>
          <strong>Overview</strong>
        </button>
        {view.clusters.map(({ cluster, progress }) => {
          return (
            <button
              className="journey-cluster-link"
              type="button"
              key={cluster.id}
              data-selected={cluster.id === currentClusterId}
              data-complete={progress.complete}
              onClick={() => navigateCluster(cluster.id)}
            >
              <span className="journey-cluster-position">{cluster.position}</span>
              <span className="journey-cluster-link-copy">
                <strong>{cluster.title}</strong>
                <small>{weightLabel(cluster.weight)}</small>
              </span>
              <span className="journey-cluster-file-progress">
                {progress.complete ? "✓ " : ""}
                {progress.markedFiles}/{progress.clusterFiles}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

function FilesRail({
  currentCluster,
  activeFile,
}: {
  readonly currentCluster: Cluster | null;
  readonly activeFile: RepositoryPath | null;
}) {
  const context = useJourneyContext();
  const [changedOnly, setChangedOnly] = useState(false);
  const changedPaths = useMemo(
    () => context.document.journey.files.map((file) => file.path),
    [context.document.journey.files],
  );
  const displayedPaths = changedOnly ? changedPaths : context.treePaths;
  const displayedPathsRef = useRef<readonly RepositoryPath[]>(displayedPaths);
  const decorationRef = useRef({
    currentClusterId: currentCluster?.id ?? null,
    readFiles: context.readView.readFiles,
    homes: fileHomeClusters(context.document.journey),
  });
  const navigateFileRef = useRef(context.navigateFile);
  navigateFileRef.current = context.navigateFile;
  displayedPathsRef.current = displayedPaths;
  decorationRef.current = {
    currentClusterId: currentCluster?.id ?? null,
    readFiles: context.readView.readFiles,
    homes: fileHomeClusters(context.document.journey),
  };

  const onSelectionChange = useCallback((selected: readonly string[]) => {
    const selectedPath = selected.at(-1);
    if (
      selectedPath === undefined ||
      !displayedPathsRef.current.includes(selectedPath as RepositoryPath)
    ) {
      return;
    }
    navigateFileRef.current(selectedPath as RepositoryPath);
  }, []);

  const renderRowDecoration = useCallback(
    ({
      item,
    }: {
      readonly item: { readonly path: string; readonly kind: "directory" | "file" };
    }) => {
      if (item.kind === "directory") return null;
      const path = item.path as RepositoryPath;
      const homes = decorationRef.current.homes.get(path) ?? [];
      if (homes.length > 1) {
        return {
          text: `${homes.length} homes`,
          title: `This file has hunks in ${homes.length} clusters`,
        };
      }
      const clusterId = decorationRef.current.currentClusterId;
      if (clusterId !== null && decorationRef.current.readFiles.has(readMarkKey(clusterId, path))) {
        return { text: "read", title: "Read in the current cluster" };
      }
      return null;
    },
    [],
  );

  const { model } = useFileTree({
    paths: displayedPaths,
    initialExpansion: 1,
    flattenEmptyDirectories: true,
    density: "compact",
    gitStatus: gitStatuses(context.document.journey.files),
    onSelectionChange,
    renderRowDecoration,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    model.resetPaths(displayedPaths);
    model.setGitStatus(gitStatuses(context.document.journey.files));
  }, [context.document.journey.files, context.readView.readFiles, displayedPaths, model]);

  useEffect(() => {
    if (activeFile === null) return;
    const item = model.getItem(activeFile);
    if (item === null) return;
    item.select();
    model.scrollToPath(activeFile, { focus: false, offset: "nearest" });
  }, [activeFile, model]);

  return (
    <div className="journey-files-rail">
      <button className="journey-pinned-overview" type="button" onClick={context.navigateOverview}>
        <span aria-hidden>§</span>
        <span>
          <strong>Overview</strong>
          {currentCluster === null ? null : (
            <small>
              {currentCluster.position} · {currentCluster.title}
            </small>
          )}
        </span>
      </button>
      {!context.treeReady ? (
        <p className="journey-tree-state" role={context.treeError === null ? "status" : "alert"}>
          {context.treeError ?? "Reading the pinned repository tree…"}
        </p>
      ) : null}
      <FileTree className="journey-file-tree" model={model} aria-label="Repository files" />
      <label className="journey-changed-filter">
        <input
          type="checkbox"
          checked={changedOnly}
          onChange={(event) => setChangedOnly(event.currentTarget.checked)}
        />
        <span aria-hidden />
        Changed files only
      </label>
    </div>
  );
}

function fileHomeClusters(journey: Journey): ReadonlyMap<RepositoryPath, readonly ClusterId[]> {
  return new Map(
    [...new Set(journey.hunks.map((hunk) => hunk.path))].map((path) => [
      path,
      fileHomes(journey, path).map((home) => home.cluster.id),
    ]),
  );
}

function gitStatuses(files: readonly FileChange[]): readonly GitStatusEntry[] {
  return files.map((file) => ({
    path: file.path,
    status:
      file.kind === "added"
        ? "added"
        : file.kind === "deleted"
          ? "deleted"
          : file.kind === "renamed"
            ? "renamed"
            : "modified",
  }));
}

function weightLabel(weight: Cluster["weight"]): string {
  return weight[0]!.toUpperCase() + weight.slice(1);
}

function safeRoutePath(value: string, available: readonly RepositoryPath[]): RepositoryPath | null {
  return available.includes(value as RepositoryPath) ? (value as RepositoryPath) : null;
}
