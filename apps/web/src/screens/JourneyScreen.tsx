import { useAtom, useAtomSet } from "@effect/atom-react";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import {
  type Cluster,
  type ClusterId,
  type DisplayMode,
  type FileContent,
  type FilePatch,
  type Journey,
  type ReadState,
} from "@app/contracts";
import { clusterProgress, journeyProgress } from "@app/journey/progress";

import { journeyRoute } from "../router.tsx";
import { productAtoms } from "../state/product.ts";

type JourneySection = "overview" | "cluster" | "files";

function resultValue<A>(result: AsyncResult.AsyncResult<A, unknown>): A | null {
  return AsyncResult.isSuccess(result) ? result.value : null;
}

function ErrorPanel({ result }: { readonly result: AsyncResult.AsyncResult<unknown, unknown> }) {
  if (!AsyncResult.isFailure(result)) return null;
  return (
    <div className="error-panel">
      <h2>Couldn’t open this journey.</h2>
      <p>{String(result.cause)}</p>
    </div>
  );
}

function Narrative({
  markdown,
  journey,
  onEvidence,
}: {
  readonly markdown: string;
  readonly journey: Journey;
  readonly onEvidence: (path: string) => void;
}) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              if (!href?.startsWith("tl:")) return;
              event.preventDefault();
              if (href.startsWith("tl:file/")) {
                onEvidence(href.slice("tl:file/".length));
              } else if (href.startsWith("tl:hunk/")) {
                const hunk = journey.hunks.find(
                  (candidate) => candidate.id === href.slice("tl:hunk/".length),
                );
                if (hunk) onEvidence(hunk.path);
              }
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function JourneyOverview({
  journey,
  readState,
  onBegin,
}: {
  readonly journey: Journey;
  readonly readState: ReadState | null;
  readonly onBegin: () => void;
}) {
  const progress = journeyProgress(journey.hunks, readState ?? { readFiles: [] });
  return (
    <section className="journey-overview">
      <div className="overview-hero">
        <p className="eyebrow">Journey overview</p>
        <h1>{journey.prMetadata.title}</h1>
        <div className="overview-copy">
          <ReactMarkdown>{journey.overview.brief.markdown}</ReactMarkdown>
        </div>
        <div className="where-to-begin">
          <span>Where to begin</span>
          <ReactMarkdown>{journey.overview.whereToBegin.markdown}</ReactMarkdown>
        </div>
        <button className="primary-button" onClick={onBegin}>
          {progress.read > 0 ? "Continue the journey" : "Begin the journey"} →
        </button>
      </div>
      <ol className="journey-map">
        {journey.clusters.map((cluster) => (
          <li key={cluster.id}>
            <span>{String(cluster.position).padStart(2, "0")}</span>
            <div>
              <h2>{cluster.title}</h2>
              <ReactMarkdown>{cluster.mapEntry.markdown}</ReactMarkdown>
            </div>
            <small>{cluster.weight}</small>
          </li>
        ))}
      </ol>
      <footer className="overview-stats">
        <span>{journey.clusters.length} clusters</span>
        <span>{journey.files.length} files</span>
        <span>
          {journey.pinned.headSha.slice(0, 8)} against {journey.pinned.baseSha.slice(0, 8)}
        </span>
        <span>{Math.round(progress.ratio * 100)}% read</span>
      </footer>
    </section>
  );
}

function DiffViewer({
  patch,
  content,
  mode,
}: {
  readonly patch: FilePatch | null;
  readonly content: FileContent | null;
  readonly mode: DisplayMode;
}) {
  if (mode === "just-the-code") {
    const text = content?.newEncoding === "text" ? content.newContent : null;
    return (
      <pre className="code-only">
        <code>{text ?? "This file cannot be rendered as text."}</code>
      </pre>
    );
  }
  if (!patch) return <div className="diff-placeholder">Loading pinned diff…</div>;
  if (patch.patch.trim() === "") {
    return <div className="diff-placeholder">No textual diff is available for this file.</div>;
  }
  return (
    <PatchDiff
      patch={patch.patch}
      options={{
        diffStyle: mode === "split" ? "split" : "unified",
        theme: { dark: "github-dark-default", light: "github-light-default" },
        overflow: "scroll",
        diffIndicators: "bars",
      }}
      disableWorkerPool
    />
  );
}

export function JourneyScreen() {
  const params = journeyRoute.useParams();
  const pr = {
    owner: params.owner,
    repo: params.repo,
    number: Number(params.number),
  };
  const [journeyResult, loadJourney] = useAtom(productAtoms.loadJourney);
  const [readResult, loadReadState] = useAtom(productAtoms.loadReadState);
  const [treeResult, loadTree] = useAtom(productAtoms.loadTree);
  const [patchResult, loadPatch] = useAtom(productAtoms.loadFilePatch);
  const [contentResult, loadContent] = useAtom(productAtoms.loadFileContent);
  const markFile = useAtomSet(productAtoms.markFile);
  const setDisplayMode = useAtomSet(productAtoms.setDisplayMode);
  const setReviewed = useAtomSet(productAtoms.reviewed);
  const hide = useAtomSet(productAtoms.hide);
  const [section, setSection] = useState<JourneySection>("overview");
  const [clusterIndex, setClusterIndex] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [optimisticReadState, setOptimisticReadState] = useState<ReadState | null>(null);

  useEffect(() => {
    loadJourney(pr);
  }, [params.owner, params.repo, params.number]);

  const journey = resultValue(journeyResult);
  useEffect(() => {
    if (!journey) return;
    loadReadState(journey.id);
    loadTree(journey.id);
  }, [journey?.id]);

  const loadedReadState = resultValue(readResult);
  useEffect(() => {
    if (loadedReadState) setOptimisticReadState(loadedReadState);
  }, [loadedReadState]);

  const selectedCluster = journey?.clusters[clusterIndex] ?? null;
  useEffect(() => {
    if (section !== "cluster" || !selectedCluster || selectedPath) return;
    setSelectedPath(selectedCluster.fileOrder[0] ?? null);
  }, [section, selectedCluster?.id]);

  useEffect(() => {
    if (!journey || !selectedPath) return;
    loadPatch({ journeyId: journey.id, path: selectedPath });
    loadContent({ journeyId: journey.id, path: selectedPath });
  }, [journey?.id, selectedPath]);

  const tree = resultValue(treeResult);
  const treePaths = useMemo(
    () =>
      tree?.entries.filter((entry) => entry.kind !== "directory").map((entry) => entry.path) ?? [],
    [tree],
  );
  const { model: fileTree } = useFileTree({
    paths: treePaths,
    initialExpansion: 2,
    search: true,
    initialSelectedPaths: selectedPath ? [selectedPath] : [],
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (path) setSelectedPath(path);
    },
  });

  if (!journey) {
    return (
      <main className="journey-loading">
        <ErrorPanel result={journeyResult} />
        {!AsyncResult.isFailure(journeyResult) && <span>Opening the journey…</span>}
      </main>
    );
  }

  const readState = optimisticReadState;
  const displayMode = readState?.displayMode ?? "inline";
  const progress = journeyProgress(journey.hunks, readState ?? { readFiles: [] });
  const selectedIsRead =
    selectedCluster !== null &&
    selectedPath !== null &&
    (readState?.readFiles.some(
      (entry) => entry.clusterId === selectedCluster.id && entry.path === selectedPath,
    ) ??
      false);
  const patch = resultValue(patchResult);
  const content = resultValue(contentResult);

  const openEvidence = (path: string) => {
    setSelectedPath(path);
    setSection("cluster");
  };
  const markSelected = () => {
    if (!readState || !selectedCluster || !selectedPath) return;
    const without = readState.readFiles.filter(
      (entry) => !(entry.clusterId === selectedCluster.id && entry.path === selectedPath),
    );
    const next: ReadState = {
      ...readState,
      readFiles: selectedIsRead
        ? without
        : [...without, { clusterId: selectedCluster.id, path: selectedPath }],
    };
    setOptimisticReadState(next);
    markFile({
      journeyId: journey.id,
      clusterId: selectedCluster.id,
      path: selectedPath,
      read: !selectedIsRead,
    });
  };

  return (
    <main className="journey-page">
      <header className="journey-header">
        <div>
          <span className="journey-repo">
            {journey.pr.owner}/{journey.pr.repo} · #{journey.pr.number}
          </span>
          <h1>{journey.prMetadata.title}</h1>
        </div>
        <div className="journey-header-actions">
          <button onClick={() => setReviewed({ pr: journey.pr, value: true })}>
            Mark reviewed
          </button>
          <button onClick={() => hide({ pr: journey.pr, value: true })}>Hide</button>
          <a href={journey.prMetadata.url} target="_blank" rel="noreferrer">
            Open on GitHub ↗
          </a>
          <span className="journey-total-progress">
            <span style={{ width: `${progress.ratio * 100}%` }} />
          </span>
          <strong>{Math.round(progress.ratio * 100)}%</strong>
        </div>
      </header>

      {section === "overview" ? (
        <JourneyOverview
          journey={journey}
          readState={readState}
          onBegin={() => {
            setSection("cluster");
            setClusterIndex(
              Math.max(
                0,
                journey.clusters.findIndex((cluster) => {
                  const item = clusterProgress(
                    cluster.id,
                    journey.hunks,
                    readState?.readFiles ?? [],
                  );
                  return item.read < item.total;
                }),
              ),
            );
          }}
        />
      ) : (
        <div className="reading-workspace">
          <aside className="cluster-rail">
            <button className="rail-overview" onClick={() => setSection("overview")}>
              ← Overview
            </button>
            <ol>
              {journey.clusters.map((cluster, index) => {
                const item = clusterProgress(cluster.id, journey.hunks, readState?.readFiles ?? []);
                return (
                  <li key={cluster.id}>
                    <button
                      className={section === "cluster" && clusterIndex === index ? "active" : ""}
                      onClick={() => {
                        setSection("cluster");
                        setClusterIndex(index);
                        setSelectedPath(cluster.fileOrder[0] ?? null);
                      }}
                    >
                      <span>{String(cluster.position).padStart(2, "0")}</span>
                      <strong>{cluster.title}</strong>
                      <small>
                        {item.read}/{item.total}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ol>
            <button
              className={`rail-files ${section === "files" ? "active" : ""}`}
              onClick={() => setSection("files")}
            >
              Files <span>{journey.files.length}</span>
            </button>
          </aside>

          {section === "files" ? (
            <section className="files-workspace">
              <div className="tree-panel">
                <FileTree model={fileTree} header={<strong>Repository</strong>} />
              </div>
              <div className="file-stage">
                <header>
                  <h2>{selectedPath ?? "Select a file"}</h2>
                  <DisplayControls
                    mode={displayMode}
                    onChange={(mode) => {
                      setOptimisticReadState(
                        readState ? { ...readState, displayMode: mode } : readState,
                      );
                      setDisplayMode({ journeyId: journey.id, displayMode: mode });
                    }}
                  />
                </header>
                {selectedPath && <DiffViewer patch={patch} content={content} mode={displayMode} />}
              </div>
            </section>
          ) : (
            <section className="cluster-stage">
              <div className="cluster-content">
                <p className="eyebrow">
                  Cluster {selectedCluster?.position} · {selectedCluster?.weight}
                </p>
                <h2>{selectedCluster?.title}</h2>
                {selectedCluster && (
                  <div className="cluster-narrative">
                    <Narrative
                      markdown={selectedCluster.narrative.markdown}
                      journey={journey}
                      onEvidence={openEvidence}
                    />
                  </div>
                )}
                <div className="cluster-files">
                  {selectedCluster?.fileOrder.map((path) => {
                    const read =
                      readState?.readFiles.some(
                        (entry) => entry.clusterId === selectedCluster.id && entry.path === path,
                      ) ?? false;
                    return (
                      <button
                        key={path}
                        className={selectedPath === path ? "active" : ""}
                        onClick={() => setSelectedPath(path)}
                      >
                        <span className={read ? "read-dot read" : "read-dot"} />
                        {path}
                      </button>
                    );
                  })}
                </div>
                {selectedPath && (
                  <div className="diff-card">
                    <header>
                      <code>{selectedPath}</code>
                      <DisplayControls
                        mode={displayMode}
                        onChange={(mode) => {
                          setOptimisticReadState(
                            readState ? { ...readState, displayMode: mode } : readState,
                          );
                          setDisplayMode({ journeyId: journey.id, displayMode: mode });
                        }}
                      />
                    </header>
                    <DiffViewer patch={patch} content={content} mode={displayMode} />
                    <footer>
                      <button className="secondary-button" onClick={markSelected}>
                        {selectedIsRead ? "Mark unread" : "Mark file read"}
                      </button>
                    </footer>
                  </div>
                )}
              </div>
              <aside className="map-rail">
                <p>Journey map</p>
                <ol>
                  {journey.clusters.map((cluster, index) => (
                    <li key={cluster.id} className={clusterIndex === index ? "active" : ""}>
                      <span />
                      {cluster.title}
                    </li>
                  ))}
                </ol>
                {selectedCluster && (
                  <button
                    className="primary-button"
                    disabled={clusterIndex >= journey.clusters.length - 1}
                    onClick={() => {
                      const next = Math.min(clusterIndex + 1, journey.clusters.length - 1);
                      setClusterIndex(next);
                      setSelectedPath(journey.clusters[next]?.fileOrder[0] ?? null);
                    }}
                  >
                    Next cluster →
                  </button>
                )}
              </aside>
            </section>
          )}
        </div>
      )}
    </main>
  );
}

function DisplayControls({
  mode,
  onChange,
}: {
  readonly mode: DisplayMode;
  readonly onChange: (mode: DisplayMode) => void;
}) {
  return (
    <div className="display-controls" aria-label="Diff display">
      {(
        [
          ["inline", "Inline"],
          ["just-the-code", "Code"],
          ["split", "Split"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          className={mode === value ? "active" : ""}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
