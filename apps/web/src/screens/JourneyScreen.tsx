import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import type {
  Cluster,
  ClusterId,
  DisplayMode,
  Journey,
  JourneyFiles,
  PrRef,
  ReadState,
} from "@app/contracts";
import { clusterProgress, journeyProgress } from "@app/journey/progress";

import { productAtoms } from "../state/product.ts";
import { CodeSurface, type CodeFocus } from "./journey/CodeSurface.tsx";
import { JourneyNavigation, type JourneyView } from "./journey/JourneyNavigation.tsx";

export interface JourneyScreenLocation {
  readonly pr: PrRef;
  readonly view: JourneyView;
}

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
  readonly onEvidence: (focus: CodeFocus, clusterId?: ClusterId) => void;
}) {
  return (
    <ReactMarkdown
      urlTransform={(url) => url}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              if (!href?.startsWith("tl:")) return;
              event.preventDefault();
              if (href.startsWith("tl:file/")) {
                onEvidence({ path: href.slice("tl:file/".length) });
                return;
              }
              if (href.startsWith("tl:symbol/")) {
                const target = href.slice("tl:symbol/".length);
                onEvidence({ path: target.slice(0, target.lastIndexOf("#")) });
                return;
              }
              if (!href.startsWith("tl:hunk/")) return;
              const hunk = journey.hunks.find(
                (candidate) => candidate.id === href.slice("tl:hunk/".length),
              );
              if (hunk) {
                onEvidence(
                  {
                    path: hunk.path,
                    lineNumber: Math.max(1, hunk.newStart),
                    side: "additions",
                  },
                  hunk.home,
                );
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
  onCluster,
  onEvidence,
}: {
  readonly journey: Journey;
  readonly readState: ReadState;
  readonly onBegin: () => void;
  readonly onCluster: (clusterId: ClusterId) => void;
  readonly onEvidence: (focus: CodeFocus, clusterId?: ClusterId) => void;
}) {
  const progress = journeyProgress(journey.hunks, readState);
  return (
    <section className="journey-overview">
      <div className="overview-hero">
        <p className="eyebrow">Journey overview</p>
        <h1>{journey.prMetadata.title}</h1>
        <div className="overview-copy">
          <Narrative
            markdown={journey.overview.brief.markdown}
            journey={journey}
            onEvidence={onEvidence}
          />
        </div>
        <div className="where-to-begin">
          <span>Where to begin</span>
          <Narrative
            markdown={journey.overview.whereToBegin.markdown}
            journey={journey}
            onEvidence={onEvidence}
          />
        </div>
        <button className="primary-button" onClick={onBegin}>
          {progress.read > 0 ? "Continue the journey" : "Begin the journey"} →
        </button>
      </div>
      <ol className="journey-map">
        {journey.clusters.map((cluster) => {
          const item = clusterProgress(cluster.id, journey.hunks, readState.readFiles);
          const owned = journey.hunks.filter((hunk) => hunk.home === cluster.id);
          return (
            <li key={cluster.id}>
              <button onClick={() => onCluster(cluster.id)}>
                <span>{String(cluster.position).padStart(2, "0")}</span>
                <div>
                  <h2>{cluster.title}</h2>
                  <Narrative
                    markdown={cluster.mapEntry.markdown}
                    journey={journey}
                    onEvidence={onEvidence}
                  />
                  <small>
                    {cluster.fileOrder.length} {cluster.fileOrder.length === 1 ? "file" : "files"} ·{" "}
                    {owned.length} {owned.length === 1 ? "hunk" : "hunks"} · {item.read}/
                    {item.total} read
                  </small>
                </div>
                <strong>{cluster.weight}</strong>
              </button>
            </li>
          );
        })}
      </ol>
      <details className="pr-words">
        <summary>The pull request’s own words</summary>
        <h2>{journey.prMetadata.title}</h2>
        <p>
          {journey.prMetadata.author} · {journey.prMetadata.headBranch} into{" "}
          {journey.prMetadata.baseBranch}
        </p>
        <ReactMarkdown>{journey.prMetadata.body || "_No description provided._"}</ReactMarkdown>
      </details>
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

function DisplayControls({
  mode,
  onChange,
}: {
  readonly mode: DisplayMode;
  readonly onChange: (mode: DisplayMode) => void;
}) {
  return (
    <div className="display-controls" aria-label="Code display">
      <button
        className={mode !== "just-the-code" ? "active" : ""}
        onClick={() => onChange("inline")}
      >
        Diff
      </button>
      <button
        className={mode === "just-the-code" ? "active" : ""}
        onClick={() => onChange("just-the-code")}
      >
        Code
      </button>
    </div>
  );
}

function ReadingControls({
  journey,
  cluster,
  paths,
  readState,
  focus,
  onFocus,
  onMark,
}: {
  readonly journey: Journey;
  readonly cluster: Cluster;
  readonly paths: ReadonlyArray<string>;
  readonly readState: ReadState;
  readonly focus: CodeFocus | null;
  readonly onFocus: (focus: CodeFocus) => void;
  readonly onMark: (path: string) => void;
}) {
  const changes = useMemo(
    () =>
      journey.hunks
        .filter((hunk) => paths.includes(hunk.path))
        .toSorted(
          (left, right) =>
            paths.indexOf(left.path) - paths.indexOf(right.path) ||
            left.newStart - right.newStart ||
            left.oldStart - right.oldStart,
        ),
    [journey.hunks, paths],
  );
  const focusedFileIndex = Math.max(
    0,
    focus === null ? 0 : paths.findIndex((path) => path === focus.path),
  );
  const focusedChangeIndex =
    focus === null
      ? -1
      : changes.findIndex(
          (hunk) =>
            hunk.path === focus.path &&
            (focus.lineNumber === undefined || hunk.newStart === focus.lineNumber),
        );
  const goToChange = useCallback(
    (index: number) => {
      const hunk = changes[index];
      if (hunk === undefined) return;
      onFocus({
        path: hunk.path,
        lineNumber: Math.max(1, hunk.newStart),
        side: "additions",
      });
    },
    [changes, onFocus],
  );
  const goToFile = (index: number) => {
    const path = paths[index];
    if (path !== undefined) onFocus({ path });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            ["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)))
      ) {
        return;
      }
      if (event.key === "r") {
        const path =
          (focus !== null && paths.includes(focus.path) ? focus.path : undefined) ??
          paths.find(
            (candidate) =>
              !readState.readFiles.some(
                (entry) => entry.clusterId === cluster.id && entry.path === candidate,
              ),
          ) ??
          paths[0];
        if (path !== undefined) {
          event.preventDefault();
          onMark(path);
        }
      } else if (event.key === "[") {
        event.preventDefault();
        goToChange(focusedChangeIndex <= 0 ? 0 : focusedChangeIndex - 1);
      } else if (event.key === "]") {
        event.preventDefault();
        goToChange(
          focusedChangeIndex < 0 ? 0 : Math.min(changes.length - 1, focusedChangeIndex + 1),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    changes,
    cluster.id,
    focus,
    focusedChangeIndex,
    goToChange,
    onMark,
    paths,
    readState.readFiles,
  ]);

  return (
    <nav className="change-navigation" aria-label="Reading position">
      <button disabled={focusedFileIndex <= 0} onClick={() => goToFile(focusedFileIndex - 1)}>
        ← Previous file
      </button>
      <div>
        <button
          title="Previous changed region ([)"
          disabled={changes.length === 0 || focusedChangeIndex === 0}
          onClick={() => goToChange(focusedChangeIndex <= 0 ? 0 : focusedChangeIndex - 1)}
        >
          ← Change
        </button>
        <span>
          Region {focusedChangeIndex < 0 ? "—" : focusedChangeIndex + 1} of {changes.length}
        </span>
        <button
          title="Next changed region (])"
          disabled={changes.length === 0 || focusedChangeIndex === changes.length - 1}
          onClick={() =>
            goToChange(
              focusedChangeIndex < 0 ? 0 : Math.min(changes.length - 1, focusedChangeIndex + 1),
            )
          }
        >
          Change →
        </button>
      </div>
      <button
        disabled={focusedFileIndex >= paths.length - 1}
        onClick={() => goToFile(focusedFileIndex + 1)}
      >
        Next file →
      </button>
    </nav>
  );
}

function LoadedJourney({
  journey,
  location,
}: {
  readonly journey: Journey;
  readonly location: JourneyScreenLocation;
}) {
  const navigate = useNavigate();
  const pullRequests = useAtomValue(productAtoms.pullRequests);
  const readResult = useAtomValue(productAtoms.readState(journey.id));
  const [treeResult, loadTree] = useAtom(productAtoms.loadTree);
  const [filesResult, loadFiles] = useAtom(productAtoms.loadFiles);
  const [markResult, markFile] = useAtom(productAtoms.markFile);
  const [displayResult, setDisplayMode] = useAtom(productAtoms.setDisplayMode);
  const updatePrState = useAtomSet(productAtoms.updatePrState);
  const startIngestion = useAtomSet(productAtoms.startIngestion);
  const [optimisticReadState, setOptimisticReadState] = useState<ReadState | null>(null);
  const [focus, setFocus] = useState<CodeFocus | null>(null);
  const [narrativeOpen, setNarrativeOpen] = useState(true);
  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);

  const params = {
    owner: journey.pr.owner,
    repo: journey.pr.repo,
    number: String(journey.pr.number),
  };
  const onOverview = () =>
    navigate({
      to: "/pr/$owner/$repo/$number",
      params,
    });
  const onCluster = (clusterId: ClusterId) =>
    navigate({
      to: "/pr/$owner/$repo/$number/cluster/$clusterId",
      params: { ...params, clusterId },
    });
  const onFile = (path: string) =>
    navigate({
      to: "/pr/$owner/$repo/$number/file/$",
      params: { ...params, _splat: path },
    });

  const loadedReadState = resultValue(readResult);
  useEffect(() => {
    if (loadedReadState !== null) setOptimisticReadState(loadedReadState);
  }, [loadedReadState]);
  useEffect(() => {
    loadTree(journey.id);
  }, [journey.id, loadTree]);

  const view = location.view;
  const clusterId = view.type === "cluster" ? view.clusterId : null;
  const filePath = view.type === "file" ? view.path : null;
  const selectedCluster =
    clusterId !== null
      ? (journey.clusters.find((cluster) => cluster.id === clusterId) ?? null)
      : filePath !== null
        ? (journey.clusters.find((cluster) => cluster.fileOrder.includes(filePath)) ??
          journey.clusters[0] ??
          null)
        : null;
  const desiredPaths = useMemo(
    () =>
      view.type === "cluster"
        ? (selectedCluster?.fileOrder ?? [])
        : filePath !== null
          ? [filePath]
          : [],
    [filePath, selectedCluster?.fileOrder, view.type],
  );
  useEffect(() => {
    if (desiredPaths.length > 0) {
      loadFiles({ journeyId: journey.id, paths: desiredPaths });
    }
  }, [desiredPaths, journey.id, loadFiles]);

  const tree = resultValue(treeResult);
  const filesCandidate = resultValue(filesResult);
  const files: JourneyFiles | null =
    filesCandidate !== null &&
    filesCandidate.journeyId === journey.id &&
    desiredPaths.every((path) => filesCandidate.patches.some((patch) => patch.path === path))
      ? filesCandidate
      : null;
  const readState = optimisticReadState;
  const stale =
    pullRequests.pullRequests.find(
      (pr) =>
        pr.ref.owner === journey.pr.owner &&
        pr.ref.repo === journey.pr.repo &&
        pr.ref.number === journey.pr.number,
    )?.journey.stale ?? false;

  useEffect(() => {
    if (AsyncResult.isFailure(markResult) || AsyncResult.isFailure(displayResult)) {
      setOptimisticReadState(loadedReadState);
      setActionError(
        "That reading-state change could not be saved. Your last saved state is restored.",
      );
    }
  }, [displayResult, loadedReadState, markResult]);

  if (readState === null || tree === null) {
    return <main className="journey-loading">Restoring your reading position…</main>;
  }

  const progress = journeyProgress(journey.hunks, readState);
  const mark = (cluster: Cluster, path: string) => {
    const read = readState.readFiles.some(
      (entry) => entry.clusterId === cluster.id && entry.path === path,
    );
    const remaining = readState.readFiles.filter(
      (entry) => !(entry.clusterId === cluster.id && entry.path === path),
    );
    setActionError(null);
    setOptimisticReadState({
      ...readState,
      readFiles: read ? remaining : [...remaining, { clusterId: cluster.id, path }],
    });
    markFile({ journeyId: journey.id, clusterId: cluster.id, path, read: !read });
  };
  const changeMode = (mode: DisplayMode) => {
    setActionError(null);
    setOptimisticReadState({ ...readState, displayMode: mode });
    setDisplayMode({ journeyId: journey.id, displayMode: mode });
  };
  const openEvidence = (nextFocus: CodeFocus, clusterId?: ClusterId) => {
    const targetCluster =
      clusterId === undefined
        ? journey.clusters.find((cluster) => cluster.fileOrder.includes(nextFocus.path))
        : journey.clusters.find((cluster) => cluster.id === clusterId);
    if (targetCluster === undefined) {
      onFile(nextFocus.path);
      return;
    }
    setFocus(nextFocus);
    onCluster(targetCluster.id);
  };
  const firstUnread =
    journey.clusters.find((cluster) => {
      const item = clusterProgress(cluster.id, journey.hunks, readState.readFiles);
      return item.read < item.total;
    }) ?? journey.clusters[0];

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
          {stale && (
            <button className="stale-action" onClick={() => startIngestion({ pr: journey.pr })}>
              Rebuild for latest head
            </button>
          )}
          <button onClick={() => updatePrState({ kind: "reviewed", pr: journey.pr, value: true })}>
            Mark reviewed
          </button>
          <button
            onClick={() => {
              updatePrState({ kind: "hidden", pr: journey.pr, value: true });
              navigate({ to: "/" });
            }}
          >
            Hide
          </button>
          <a href={journey.prMetadata.url} target="_blank" rel="noreferrer">
            Open on GitHub ↗
          </a>
          <span className="journey-total-progress">
            <span style={{ width: `${progress.ratio * 100}%` }} />
          </span>
          <strong>{Math.round(progress.ratio * 100)}%</strong>
        </div>
      </header>

      {actionError && <div className="state-error">{actionError}</div>}
      {location.view.type === "overview" ? (
        <JourneyOverview
          journey={journey}
          readState={readState}
          onCluster={onCluster}
          onEvidence={openEvidence}
          onBegin={() => {
            if (firstUnread) onCluster(firstUnread.id);
          }}
        />
      ) : (
        <div className={guidanceOpen ? "reading-workspace" : "reading-workspace guidance-closed"}>
          <JourneyNavigation
            journey={journey}
            readState={readState}
            view={location.view}
            treePaths={tree.entries
              .filter((entry) => entry.kind !== "directory")
              .map((entry) => entry.path)}
            stale={stale}
            onOverview={onOverview}
            onCluster={onCluster}
            onFile={onFile}
          />

          <section className="reading-stage">
            {selectedCluster === null ? (
              <div className="error-panel">
                <h2>This journey location no longer exists.</h2>
                <button onClick={onOverview}>Return to the overview</button>
              </div>
            ) : (
              <>
                {view.type === "cluster" ? (
                  <header className="cluster-story">
                    <div>
                      <p className="eyebrow">
                        Cluster {selectedCluster.position} · {selectedCluster.weight}
                      </p>
                      <h2>{selectedCluster.title}</h2>
                    </div>
                    <div>
                      <DisplayControls mode={readState.displayMode} onChange={changeMode} />
                      <button
                        className="narrative-toggle"
                        onClick={() => setNarrativeOpen((value) => !value)}
                      >
                        {narrativeOpen ? "Collapse narrative" : "Open narrative"}
                      </button>
                    </div>
                    {narrativeOpen && (
                      <div className="cluster-narrative">
                        <Narrative
                          markdown={selectedCluster.narrative.markdown}
                          journey={journey}
                          onEvidence={openEvidence}
                        />
                      </div>
                    )}
                  </header>
                ) : (
                  <header className="free-file-header">
                    <div>
                      <p className="eyebrow">Free reading</p>
                      <h2>{filePath}</h2>
                    </div>
                    <DisplayControls mode={readState.displayMode} onChange={changeMode} />
                    <div className="file-home-actions">
                      {journey.clusters
                        .filter(
                          (cluster) => filePath !== null && cluster.fileOrder.includes(filePath),
                        )
                        .map((cluster) => {
                          const read = readState.readFiles.some(
                            (entry) => entry.clusterId === cluster.id && entry.path === filePath,
                          );
                          return (
                            <button
                              key={cluster.id}
                              onClick={() => {
                                if (filePath !== null) mark(cluster, filePath);
                              }}
                            >
                              {read ? "Read" : "Mark read"} · {cluster.title}
                            </button>
                          );
                        })}
                    </div>
                  </header>
                )}
                {files === null ? (
                  <div className="diff-placeholder">Loading pinned files…</div>
                ) : (
                  <>
                    <CodeSurface
                      journey={journey}
                      cluster={selectedCluster}
                      files={files}
                      paths={desiredPaths}
                      mode={readState.displayMode}
                      readState={readState}
                      focus={focus}
                      onMarkFile={(path) => mark(selectedCluster, path)}
                      onModeChange={changeMode}
                      onOpenCluster={onCluster}
                    />
                    <ReadingControls
                      journey={journey}
                      cluster={selectedCluster}
                      paths={desiredPaths}
                      readState={readState}
                      focus={focus}
                      onFocus={setFocus}
                      onMark={(path) => mark(selectedCluster, path)}
                    />
                  </>
                )}
                {view.type === "cluster" && (
                  <footer className="reading-navigation">
                    <button
                      disabled={selectedCluster.position <= 1}
                      onClick={() => {
                        const previous = journey.clusters[selectedCluster.position - 2];
                        if (previous) onCluster(previous.id);
                      }}
                    >
                      ← Previous cluster
                    </button>
                    <button
                      disabled={selectedCluster.position >= journey.clusters.length}
                      onClick={() => {
                        const next = journey.clusters[selectedCluster.position];
                        if (next) onCluster(next.id);
                      }}
                    >
                      Next cluster →
                    </button>
                  </footer>
                )}
              </>
            )}
          </section>

          {guidanceOpen ? (
            <aside className="guidance-rail">
              <div>
                <p className="eyebrow">Guidance</p>
                <button aria-label="Collapse guidance" onClick={() => setGuidanceOpen(false)}>
                  ×
                </button>
              </div>
              {selectedCluster === null ||
              journey.hints.filter((hint) => hint.clusterId === selectedCluster.id).length === 0 ? (
                <p className="guidance-empty">
                  No extra guidance here. The cluster narrative and code are complete on their own.
                </p>
              ) : (
                journey.hints
                  .filter(
                    (hint) =>
                      hint.clusterId === selectedCluster.id &&
                      (filePath === null || hint.anchor.path === filePath) &&
                      !(readState.displayMode === "just-the-code" && hint.anchor.side === "old"),
                  )
                  .map((hint) => (
                    <button
                      key={hint.id}
                      className="guidance-hint"
                      onClick={() =>
                        setFocus({
                          path: hint.anchor.path,
                          lineNumber: hint.anchor.startLine,
                          side: hint.anchor.side === "old" ? "deletions" : "additions",
                        })
                      }
                    >
                      <span>{hint.kind.replace("-", " ")}</span>
                      <ReactMarkdown>{hint.body.markdown}</ReactMarkdown>
                      <code>
                        {hint.anchor.path}:{hint.anchor.startLine}
                      </code>
                    </button>
                  ))
              )}
            </aside>
          ) : (
            <button className="guidance-reopen" onClick={() => setGuidanceOpen(true)}>
              Guidance
            </button>
          )}
        </div>
      )}
    </main>
  );
}

export function JourneyScreen({ location }: { readonly location: JourneyScreenLocation }) {
  const [journeyResult, loadJourney] = useAtom(productAtoms.loadJourney);
  const { number, owner, repo } = location.pr;
  useEffect(() => {
    loadJourney({ number, owner, repo });
  }, [loadJourney, number, owner, repo]);

  const journey = resultValue(journeyResult);
  const belongsToRoute =
    journey !== null &&
    journey.pr.owner === location.pr.owner &&
    journey.pr.repo === location.pr.repo &&
    journey.pr.number === location.pr.number;
  if (!belongsToRoute) {
    return (
      <main className="journey-loading">
        <ErrorPanel result={journeyResult} />
        {!AsyncResult.isFailure(journeyResult) && <span>Opening the journey…</span>}
      </main>
    );
  }
  return <LoadedJourney key={journey.id} journey={journey} location={location} />;
}
