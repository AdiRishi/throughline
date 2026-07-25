import { useAtom, useAtomValue } from "@effect/atom-react";
import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
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
import { clusterProgress } from "@app/journey/progress";

import { WindowControls } from "../components/AppChrome.tsx";
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
  onCluster,
  onEvidence,
}: {
  readonly journey: Journey;
  readonly readState: ReadState;
  readonly onCluster: (clusterId: ClusterId) => void;
  readonly onEvidence: (focus: CodeFocus, clusterId?: ClusterId) => void;
}) {
  return (
    <section className="journey-overview">
      <section className="overview-section overview-brief">
        <p className="eyebrow">The change, in brief</p>
        <div className="overview-copy">
          <Narrative
            markdown={journey.overview.brief.markdown}
            journey={journey}
            onEvidence={onEvidence}
          />
        </div>
      </section>

      <section className="overview-section">
        <p className="eyebrow">The map of the journey</p>
        <ol className="journey-map">
          {journey.clusters.map((cluster) => {
            const item = clusterProgress(cluster.id, journey.hunks, readState.readFiles);
            const owned = journey.hunks.filter((hunk) => hunk.home === cluster.id);
            return (
              <li key={cluster.id}>
                <button onClick={() => onCluster(cluster.id)}>
                  <span>{cluster.position}</span>
                  <div>
                    <header>
                      <h2>{cluster.title}</h2>
                      <small>{cluster.weight}</small>
                      <span>
                        {cluster.fileOrder.length}{" "}
                        {cluster.fileOrder.length === 1 ? "file" : "files"} · {owned.length}{" "}
                        {owned.length === 1 ? "hunk" : "hunks"}
                        <i>
                          <span style={{ width: `${item.ratio * 100}%` }} />
                        </i>
                      </span>
                    </header>
                    <Narrative
                      markdown={cluster.mapEntry.markdown}
                      journey={journey}
                      onEvidence={onEvidence}
                    />
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="overview-section where-to-begin">
        <p className="eyebrow">Where to begin</p>
        <Narrative
          markdown={journey.overview.whereToBegin.markdown}
          journey={journey}
          onEvidence={onEvidence}
        />
        <div className="overview-route">
          {journey.clusters.map((cluster, index) => (
            <div key={cluster.id}>
              <button onClick={() => onCluster(cluster.id)}>
                <span>{cluster.position}</span>
                {cluster.weight === "core"
                  ? "read closely"
                  : cluster.weight === "mechanical"
                    ? "walk quickly"
                    : "read deliberately"}
              </button>
              {index < journey.clusters.length - 1 && <CaretRight size={11} aria-hidden />}
            </div>
          ))}
        </div>
      </section>

      <details className="pr-words">
        <summary>
          <CaretRight size={11} weight="bold" aria-hidden />
          The PR’s own words — title, description, author, link
          <span>collapsed</span>
        </summary>
        <div>
          <h2>{journey.prMetadata.title}</h2>
          <p>
            {journey.prMetadata.author} · {journey.prMetadata.headBranch} into{" "}
            {journey.prMetadata.baseBranch}
          </p>
          <ReactMarkdown>{journey.prMetadata.body || "_No description provided._"}</ReactMarkdown>
        </div>
      </details>
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
  readonly onMark: ((path: string) => void) | undefined;
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
      if (event.key === "r" && onMark !== undefined) {
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

function hintLabel(kind: Journey["hints"][number]["kind"]): string {
  switch (kind) {
    case "ripple":
      return "Ripple context";
    case "pattern-echo":
      return "Pattern echo";
    case "behavior":
      return "Behavioral before / after";
    case "resurfacing":
      return "Resurfacing note";
    case "complexity":
      return "Complexity companion";
    default:
      return "Connection";
  }
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
  const [optimisticReadState, setOptimisticReadState] = useState<ReadState | null>(null);
  const [focus, setFocus] = useState<CodeFocus | null>(null);
  const [visiblePath, setVisiblePath] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<ReadonlyArray<string>>([]);
  const [narrativeOpen, setNarrativeOpen] = useState(false);
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
      setVisiblePath(desiredPaths[0] ?? null);
    }
  }, [desiredPaths, journey.id, loadFiles]);
  useEffect(() => {
    if (filePath !== null) {
      setOpenFiles((current) => (current.includes(filePath) ? current : [...current, filePath]));
    }
  }, [filePath]);

  const tree = resultValue(treeResult);
  const filesCandidate = resultValue(filesResult);
  const files: JourneyFiles | null =
    filesCandidate !== null &&
    filesCandidate.journeyId === journey.id &&
    desiredPaths.every((path) => filesCandidate.patches.some((patch) => patch.path === path))
      ? filesCandidate
      : null;
  const treePaths = useMemo(
    () =>
      tree?.entries.filter((entry) => entry.kind !== "directory").map((entry) => entry.path) ?? [],
    [tree],
  );
  const readState = optimisticReadState;
  const latestPullRequest = pullRequests.pullRequests.find(
    (pr) =>
      pr.ref.owner === journey.pr.owner &&
      pr.ref.repo === journey.pr.repo &&
      pr.ref.number === journey.pr.number,
  );
  const stale =
    latestPullRequest !== undefined && latestPullRequest.headSha !== journey.pinned.headSha;

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
  const visibleHints =
    selectedCluster === null
      ? []
      : journey.hints.filter(
          (hint) =>
            hint.clusterId === selectedCluster.id &&
            (filePath === null || hint.anchor.path === filePath) &&
            (filePath !== null || visiblePath === null || hint.anchor.path === visiblePath) &&
            !(readState.displayMode === "just-the-code" && hint.anchor.side === "old"),
        );
  return (
    <main className="journey-page">
      <header className="journey-header">
        <div className="journey-header-leading">
          <WindowControls />
          <span className="journey-repo">
            {journey.pr.owner}/{journey.pr.repo} · #{journey.pr.number}
          </span>
          <h1>{journey.prMetadata.title}</h1>
        </div>
        {location.view.type !== "overview" && (
          <DisplayControls mode={readState.displayMode} onChange={changeMode} />
        )}
      </header>

      {actionError && <div className="state-error">{actionError}</div>}
      {location.view.type === "overview" ? (
        <div className="overview-workspace">
          <JourneyNavigation
            journey={journey}
            readState={readState}
            view={location.view}
            treePaths={treePaths}
            stale={stale}
            onOverview={onOverview}
            onCluster={onCluster}
            onFile={onFile}
          />
          <JourneyOverview
            journey={journey}
            readState={readState}
            onCluster={onCluster}
            onEvidence={openEvidence}
          />
        </div>
      ) : (
        <div className={guidanceOpen ? "reading-workspace" : "reading-workspace guidance-closed"}>
          <JourneyNavigation
            journey={journey}
            readState={readState}
            view={location.view}
            treePaths={treePaths}
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
                    <div className="cluster-title-row">
                      <span>{selectedCluster.position}</span>
                      <h2>{selectedCluster.title}</h2>
                      <small>{selectedCluster.weight}</small>
                      <span className="cluster-scale">
                        {selectedCluster.fileOrder.length}{" "}
                        {selectedCluster.fileOrder.length === 1 ? "file" : "files"} ·{" "}
                        {journey.hunks.filter((hunk) => hunk.home === selectedCluster.id).length}{" "}
                        hunks
                      </span>
                    </div>
                    <div
                      className={
                        narrativeOpen ? "cluster-narrative open" : "cluster-narrative collapsed"
                      }
                    >
                      <div className="cluster-narrative-heading">
                        <span>
                          Narrative <small>· read ✓</small>
                        </span>
                        <button
                          className="narrative-toggle"
                          onClick={() => setNarrativeOpen((value) => !value)}
                        >
                          {narrativeOpen ? "collapse" : "expand"}
                          <CaretDown size={10} weight="bold" />
                        </button>
                      </div>
                      <div className="cluster-narrative-body">
                        <Narrative
                          markdown={selectedCluster.narrative.markdown}
                          journey={journey}
                          onEvidence={openEvidence}
                        />
                      </div>
                    </div>
                  </header>
                ) : (
                  <>
                    <nav className="file-tabs" aria-label="Open files">
                      {openFiles.map((path) => (
                        <div key={path} className={path === filePath ? "active" : ""}>
                          <button className="file-tab-open" onClick={() => onFile(path)}>
                            {path.split("/").at(-1)}
                          </button>
                          <button
                            className="file-tab-close"
                            aria-label={`Close ${path}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              const remaining = openFiles.filter((candidate) => candidate !== path);
                              setOpenFiles(remaining);
                              if (path === filePath) {
                                const replacement = remaining.at(-1);
                                if (replacement === undefined) onOverview();
                                else onFile(replacement);
                              }
                            }}
                          >
                            <X size={10} weight="bold" />
                          </button>
                        </div>
                      ))}
                    </nav>
                    <div className="file-breadcrumb">
                      {filePath?.split("/").map((part, index, parts) => (
                        <span key={`${part}-${index}`}>
                          {part}
                          {index < parts.length - 1 && <CaretRight size={9} aria-hidden />}
                        </span>
                      ))}
                    </div>
                  </>
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
                      onMarkFile={
                        view.type === "cluster" ? (path) => mark(selectedCluster, path) : undefined
                      }
                      onModeChange={changeMode}
                      onOpenCluster={onCluster}
                      onVisiblePath={setVisiblePath}
                    />
                    {view.type === "file" && filePath !== null && (
                      <div className="file-home-actions">
                        <span>{filePath}</span>
                        {journey.clusters
                          .filter((cluster) => cluster.fileOrder.includes(filePath))
                          .map((cluster) => {
                            const read = readState.readFiles.some(
                              (entry) => entry.clusterId === cluster.id && entry.path === filePath,
                            );
                            return (
                              <button key={cluster.id} onClick={() => mark(cluster, filePath)}>
                                {read ? "read" : "mark read"} · {cluster.position} {cluster.title}
                              </button>
                            );
                          })}
                      </div>
                    )}
                    <ReadingControls
                      journey={journey}
                      cluster={selectedCluster}
                      paths={desiredPaths}
                      readState={readState}
                      focus={focus}
                      onFocus={setFocus}
                      onMark={
                        view.type === "cluster" ? (path) => mark(selectedCluster, path) : undefined
                      }
                    />
                  </>
                )}
              </>
            )}
          </section>

          {guidanceOpen ? (
            <aside className="guidance-rail">
              <div className="guidance-heading">
                <p>
                  Guidance <span>· following your position</span>
                </p>
                <button aria-label="Collapse guidance" onClick={() => setGuidanceOpen(false)}>
                  <CaretRight size={11} weight="bold" />
                </button>
              </div>
              {visibleHints.length === 0 ? (
                <p className="guidance-empty">
                  No extra guidance here. The cluster narrative and code are complete on their own.
                </p>
              ) : (
                visibleHints.map((hint, index) => (
                  <button
                    key={hint.id}
                    className={index === 0 ? "guidance-hint active" : "guidance-hint"}
                    onClick={() =>
                      setFocus({
                        path: hint.anchor.path,
                        lineNumber: hint.anchor.startLine,
                        side: hint.anchor.side === "old" ? "deletions" : "additions",
                      })
                    }
                  >
                    <span>{hintLabel(hint.kind)}</span>
                    <ReactMarkdown>{hint.body.markdown}</ReactMarkdown>
                    <code>
                      {hint.anchor.path} · L{hint.anchor.startLine}
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
