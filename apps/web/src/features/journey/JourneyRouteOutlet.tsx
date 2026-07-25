import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ClusterId,
  DisplayMode,
  IngestionJob,
  JourneyDocument,
  PrRef,
  RepositoryPath,
} from "@app/contracts";

import { RefreshIcon } from "../../components/Icons.tsx";
import { connectionAtoms } from "../../state/connection.ts";
import {
  makeIngestionStartRequest,
  ownsIngestionStartRequest,
  productAtoms,
} from "../../state/product.ts";
import {
  JourneyContextProvider,
  readMarkKey,
  type JourneyContextValue,
  type JourneyNavigationMode,
  type JourneyScrollTarget,
} from "./JourneyContext.tsx";
import { JourneyRouteNotice } from "./JourneyRouteNotice.tsx";
import {
  advanceIngestionRun,
  deriveIngestionStages,
  INITIAL_INGESTION_RUN_TRACKING,
  journeyWasReplaced,
  parsePrRouteParams,
  retainRetryableIngestionJob,
  resolveEvidenceTarget,
  resolveFileRoute,
  shouldAutomaticallyStartIngestion,
  shouldShowJourneyLoadFailure,
  type IngestionRunKind,
  visibleIngestionJob,
} from "./model.ts";

import "./journey.css";

const EMPTY_READ_MARKS = [] as const;
const EMPTY_TREE_PATHS: readonly RepositoryPath[] = [];
const JourneyNavigation = lazy(async () => ({
  default: (await import("./JourneyNavigation.tsx")).JourneyNavigation,
}));
const JourneyOverviewPage = lazy(async () => ({
  default: (await import("./JourneyPages.tsx")).JourneyOverviewPage,
}));
const JourneyClusterPage = lazy(async () => ({
  default: (await import("./JourneyPages.tsx")).JourneyClusterPage,
}));
const JourneyFilePage = lazy(async () => ({
  default: (await import("./JourneyPages.tsx")).JourneyFilePage,
}));
const JOURNEY_NAVIGATION_FALLBACK = <aside className="journey-navigation journey-lazy-loading" />;
const JOURNEY_PAGE_FALLBACK = <JourneyPageLoading />;

export function JourneyLayoutRoute() {
  const params = useParams({ strict: false }) as {
    readonly owner?: string;
    readonly repo?: string;
    readonly number?: string;
  };
  const pr = useMemo(
    () =>
      parsePrRouteParams({
        owner: params.owner,
        repo: params.repo,
        number: params.number,
      }),
    [params.number, params.owner, params.repo],
  );

  if (pr === null) {
    return (
      <main className="journey-route-notice">
        <p className="eyebrow">Invalid pull request</p>
        <h1>This address doesn’t identify a GitHub pull request.</h1>
        <Link to="/">Return to your reviews</Link>
      </main>
    );
  }

  return <JourneyResolver key={`${pr.owner}/${pr.repo}#${pr.number}`} pr={pr} />;
}

function JourneyResolver({ pr }: { readonly pr: PrRef }) {
  const navigate = useNavigate();
  const journeyAtoms = useMemo(() => productAtoms.journeyDocument(pr), [pr]);
  const ingestionAtoms = useMemo(() => productAtoms.ingestionJob(pr), [pr]);
  const document = useAtomValue(journeyAtoms.value);
  const journeyHydrated = useAtomValue(journeyAtoms.hydrated);
  const documentResult = useAtomValue(journeyAtoms.result);
  const job = useAtomValue(ingestionAtoms.value);
  const ingestionHydrated = useAtomValue(ingestionAtoms.hydrated);
  const startResult = useAtomValue(productAtoms.startIngestion);
  const activeStartRequestId = useAtomValue(productAtoms.activeIngestionStartRequestId);
  const cancelResult = useAtomValue(productAtoms.cancelIngestion);
  const serverConfig = useAtomValue(connectionAtoms.serverConfig);
  const startIngestion = useAtomSet(productAtoms.startIngestion);
  const cancelIngestion = useAtomSet(productAtoms.cancelIngestion);
  const automaticStartAttempted = useRef(false);
  const runTracking = useRef(INITIAL_INGESTION_RUN_TRACKING);
  const previousServerEpoch = useRef<number | null>(null);
  const [lostRun, setLostRun] = useState<IngestionRunKind | null>(null);
  const [retainedTerminalJob, setRetainedTerminalJob] = useState<IngestionJob | null>(null);
  const [ownedStartRequestId, setOwnedStartRequestId] = useState<number | null>(null);
  const latestJob = useRef(job);
  const suppressedJobId = useRef<IngestionJob["id"] | null>(null);
  const mountedJourneyId = useRef<JourneyDocument["journey"]["id"] | null>(null);
  const serverEpoch = serverConfig === null ? null : DateTime.toEpochMillis(serverConfig.startedAt);
  latestJob.current = job;
  const currentJob = visibleIngestionJob(job, suppressedJobId.current);
  const visibleJob = lostRun === null ? (currentJob ?? retainedTerminalJob) : null;
  const ownsStart = ownsIngestionStartRequest(ownedStartRequestId, activeStartRequestId);
  const starting = ownsStart && startResult.waiting;
  const startError =
    ownsStart && !startResult.waiting && AsyncResult.isFailure(startResult)
      ? causeMessage(startResult.cause)
      : null;

  const loseExpectedRun = useCallback(() => {
    const next = advanceIngestionRun(runTracking.current, { type: "server-replaced" });
    runTracking.current = next;
    setLostRun(next.lost);
  }, []);

  const startRun = useCallback(
    (kind: IngestionRunKind) => {
      if (startResult.waiting) return false;
      const request = makeIngestionStartRequest({ type: "ref", ref: pr });
      setOwnedStartRequestId(request.id);
      suppressedJobId.current = latestJob.current?.id ?? null;
      runTracking.current = advanceIngestionRun(runTracking.current, {
        type: "started",
        kind,
      });
      setLostRun(null);
      setRetainedTerminalJob(null);
      startIngestion(request);
      return true;
    },
    [pr, startIngestion, startResult.waiting],
  );

  useEffect(() => {
    if (document === null) return;
    if (journeyWasReplaced(mountedJourneyId.current, document.journey.id)) {
      void navigate({
        to: "/pr/$owner/$repo/$number",
        params: {
          owner: pr.owner,
          repo: pr.repo,
          number: String(pr.number),
        },
        replace: true,
      });
    }
    mountedJourneyId.current = document.journey.id;
  }, [document, navigate, pr]);

  useEffect(() => {
    if (serverEpoch === null) return;
    const previousEpoch = previousServerEpoch.current;
    previousServerEpoch.current = serverEpoch;
    if (
      previousEpoch === null ||
      previousEpoch === serverEpoch ||
      runTracking.current.expected === null
    ) {
      return;
    }
    loseExpectedRun();
  }, [loseExpectedRun, serverEpoch]);

  useEffect(() => {
    if (job === null || job.id !== suppressedJobId.current) {
      suppressedJobId.current = null;
    }
    setRetainedTerminalJob((retained) => retainRetryableIngestionJob(retained, job));
    if (job === null) return;
    const previous = runTracking.current;
    const next = advanceIngestionRun(previous, {
      type: "job-observed",
      terminal: terminalIngestion(job),
      kindWhenActive: document === null ? "initial" : "reanalysis",
    });
    runTracking.current = next;
    if (previous.lost !== null) return;

    automaticStartAttempted.current = true;
    setLostRun(next.lost);
  }, [document, job]);

  useEffect(() => {
    if (!AsyncResult.isSuccess(documentResult)) return;
    if (
      !shouldAutomaticallyStartIngestion({
        serverReady: serverEpoch !== null,
        journeyHydrated,
        hasJourney: document !== null,
        ingestionHydrated,
        hasJob: job !== null,
        attempted: automaticStartAttempted.current,
        runTracking: runTracking.current,
      })
    ) {
      return;
    }
    if (startRun("initial")) {
      automaticStartAttempted.current = true;
    }
  }, [document, documentResult, ingestionHydrated, job, journeyHydrated, serverEpoch, startRun]);

  const retry = useCallback(() => {
    startRun(document === null ? "initial" : "reanalysis");
  }, [document, startRun]);

  const lostRunMessage =
    lostRun === null
      ? null
      : lostRun === "initial"
        ? "The local server restarted before this analysis run reappeared. Retry to begin a new run."
        : "The local server restarted before the reanalysis run reappeared. The pinned journey remains available.";

  if (
    document === null &&
    shouldShowJourneyLoadFailure(visibleJob, AsyncResult.isFailure(documentResult))
  ) {
    return (
      <JourneyRouteNotice
        eyebrow="Journey unavailable"
        title="The pinned journey could not be opened."
        detail={
          AsyncResult.isFailure(documentResult)
            ? causeMessage(documentResult.cause)
            : "The journey could not be opened."
        }
        action="Reload"
        onAction={() => window.location.reload()}
      />
    );
  }

  if (document === null && (activeIngestion(visibleJob) || !terminalIngestion(visibleJob))) {
    return (
      <IngestionTransition
        pr={pr}
        job={visibleJob}
        starting={starting}
        error={lostRunMessage ?? startError}
        cancelError={AsyncResult.isFailure(cancelResult) ? causeMessage(cancelResult.cause) : null}
        onCancel={
          visibleJob === null || !activeIngestion(visibleJob)
            ? null
            : () => cancelIngestion(visibleJob.id)
        }
        onRetry={retry}
      />
    );
  }

  if (document === null) {
    return (
      <IngestionTransition
        pr={pr}
        job={visibleJob}
        starting={starting}
        error={visibleJob?.failure?.message ?? lostRunMessage ?? startError}
        cancelError={AsyncResult.isFailure(cancelResult) ? causeMessage(cancelResult.cause) : null}
        onCancel={null}
        onRetry={retry}
      />
    );
  }

  return (
    <LoadedJourney
      key={document.journey.id}
      pr={pr}
      document={document}
      runIssue={
        lostRunMessage ??
        (visibleJob?.phase === "failed"
          ? (visibleJob.failure?.message ?? "The latest reanalysis did not complete.")
          : visibleJob?.phase === "cancelled"
            ? "The latest reanalysis was cancelled. The pinned journey remains available."
            : startError !== null
              ? startError
              : AsyncResult.isFailure(cancelResult)
                ? causeMessage(cancelResult.cause)
                : null)
      }
      activeReanalysis={activeIngestion(visibleJob) ? visibleJob : null}
      startingReanalysis={starting}
      reanalysisDisabled={startResult.waiting}
      cancellingReanalysis={cancelResult.waiting}
      onCancelReanalysis={
        visibleJob === null || !activeIngestion(visibleJob)
          ? null
          : () => cancelIngestion(visibleJob.id)
      }
      onReanalyze={retry}
    />
  );
}

function LoadedJourney({
  pr,
  document,
  runIssue,
  activeReanalysis,
  startingReanalysis,
  reanalysisDisabled,
  cancellingReanalysis,
  onCancelReanalysis,
  onReanalyze,
}: {
  readonly pr: PrRef;
  readonly document: JourneyDocument;
  readonly runIssue: string | null;
  readonly activeReanalysis: IngestionJob | null;
  readonly startingReanalysis: boolean;
  readonly reanalysisDisabled: boolean;
  readonly cancellingReanalysis: boolean;
  readonly onCancelReanalysis: (() => void) | null;
  readonly onReanalyze: () => void;
}) {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    readonly clusterId?: string;
    readonly _splat?: string;
  };
  const journey = document.journey;
  const readAtoms = useMemo(() => productAtoms.readState(journey.id), [journey.id]);
  const readState = useAtomValue(readAtoms.value);
  const readStateResult = useAtomValue(readAtoms.result);
  const treeAtom = useMemo(() => productAtoms.tree(journey.id), [journey.id]);
  const treeResult = useAtomValue(treeAtom);
  const markResult = useAtomValue(productAtoms.markRead);
  const unmarkResult = useAtomValue(productAtoms.unmarkRead);
  const displayResult = useAtomValue(productAtoms.setDisplayMode);
  const pullRequestList = useAtomValue(productAtoms.pullRequestList);
  const markRead = useAtomSet(productAtoms.markRead);
  const unmarkRead = useAtomSet(productAtoms.unmarkRead);
  const persistDisplayMode = useAtomSet(productAtoms.setDisplayMode);
  const refreshPullRequests = useAtomSet(productAtoms.refreshPullRequests);
  const refreshJourneyDocument = useAtomSet(productAtoms.refreshJourneyDocument);
  const [navigationMode, setNavigationMode] = useState<JourneyNavigationMode>("journey");
  const [currentClusterId, setCurrentClusterId] = useState<ClusterId | null>(() => {
    const routeCluster = params.clusterId;
    return routeCluster === undefined
      ? null
      : (journey.clusters.find((cluster) => cluster.id === routeCluster)?.id ?? null);
  });
  const [displayOverride, setDisplayOverride] = useState<DisplayMode | null>(null);
  const [lastDiffMode, setLastDiffMode] = useState<Exclude<DisplayMode, "just-the-code">>("inline");
  const [scrollTarget, setScrollTarget] = useState<JourneyScrollTarget | null>(null);
  const nextScrollKey = useRef(0);
  const [openFiles, setOpenFiles] = useState<readonly RepositoryPath[]>([]);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;

  const tree = Option.getOrNull(AsyncResult.value(treeResult));
  const treePaths = tree?.paths ?? EMPTY_TREE_PATHS;
  const treeReady = AsyncResult.isSuccess(treeResult);
  const treeError = AsyncResult.isFailure(treeResult) ? causeMessage(treeResult.cause) : null;
  const serverMarks = readState?.readFiles ?? EMPTY_READ_MARKS;
  const readFiles = useMemo(
    () => new Set(serverMarks.map((mark) => readMarkKey(mark.clusterId, mark.path))),
    [serverMarks],
  );
  const displayMode = displayOverride ?? readState?.displayMode ?? "inline";
  const currentPullRequest = pullRequestList.pullRequests.find(
    (pullRequest) =>
      pullRequest.ref.owner === pr.owner &&
      pullRequest.ref.repo === pr.repo &&
      pullRequest.ref.number === pr.number,
  );
  const currentHeadSha = currentPullRequest?.headSha ?? document.pullRequest.headSha;
  const stale = currentHeadSha !== journey.pinned.headSha;

  useEffect(() => {
    const routeCluster = params.clusterId;
    if (routeCluster === undefined) return;
    const cluster = journey.clusters.find((candidate) => candidate.id === routeCluster);
    if (cluster !== undefined) setCurrentClusterId(cluster.id);
  }, [journey.clusters, params.clusterId]);

  useEffect(() => {
    const refreshOnFocus = () => {
      if (window.document.visibilityState !== "visible") return;
      refreshPullRequests(undefined);
      refreshJourneyDocument(pr);
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [pr, refreshJourneyDocument, refreshPullRequests]);
  useEffect(() => {
    if (
      displayOverride !== null &&
      (AsyncResult.isFailure(displayResult) || displayOverride === readState?.displayMode)
    ) {
      setDisplayOverride(null);
    }
  }, [displayOverride, displayResult, readState?.displayMode]);

  useEffect(() => {
    if (displayMode !== "just-the-code") setLastDiffMode(displayMode);
  }, [displayMode]);

  useEffect(() => {
    if (params._splat === undefined) return;
    const resolved = resolveFileRoute(journey, treePaths, params._splat);
    if (resolved === null) return;
    setNavigationMode("files");
    setOpenFiles((current) =>
      current.includes(resolved.path) ? current : [...current, resolved.path],
    );
  }, [journey, params._splat, treePaths]);

  const routeParams = useMemo(
    () => ({
      owner: pr.owner,
      repo: pr.repo,
      number: String(pr.number),
    }),
    [pr.number, pr.owner, pr.repo],
  );

  const navigateOverview = useCallback(() => {
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: routeParams,
    });
  }, [navigate, routeParams]);
  const navigateCluster = useCallback(
    (clusterId: ClusterId) => {
      setNavigationMode("journey");
      setCurrentClusterId(clusterId);
      void navigate({
        to: "/pr/$owner/$repo/$number/cluster/$clusterId",
        params: { ...routeParams, clusterId },
      });
    },
    [navigate, routeParams],
  );
  const navigateFile = useCallback(
    (path: RepositoryPath) => {
      setNavigationMode("files");
      setOpenFiles((current) => (current.includes(path) ? current : [...current, path]));
      void navigate({
        to: "/pr/$owner/$repo/$number/file/$",
        params: { ...routeParams, _splat: path },
      });
    },
    [navigate, routeParams],
  );
  const closeFile = useCallback(
    (path: RepositoryPath) => {
      const remaining = openFilesRef.current.filter((candidate) => candidate !== path);
      setOpenFiles(remaining);
      if (params._splat !== path) return;
      const next = remaining.at(-1);
      if (next === undefined) navigateOverview();
      else navigateFile(next);
    },
    [navigateFile, navigateOverview, params._splat],
  );
  const requestScroll = useCallback(
    (path: RepositoryPath, lineNumber?: number, side?: "old" | "new", symbol?: string) => {
      nextScrollKey.current += 1;
      setScrollTarget({
        key: nextScrollKey.current,
        path,
        ...(lineNumber === undefined ? {} : { lineNumber }),
        ...(side === undefined ? {} : { side }),
        ...(symbol === undefined ? {} : { symbol }),
      });
    },
    [],
  );
  const clearScrollTarget = useCallback((key: number) => {
    setScrollTarget((current) => (current?.key === key ? null : current));
  }, []);
  const navigateEvidence = useCallback(
    (uri: string) => {
      const target = resolveEvidenceTarget(journey, uri);
      if (target === null) return;
      if (target.kind === "hunk") {
        navigateCluster(target.clusterId);
        if (target.anchor !== null) {
          requestScroll(target.path, target.anchor.startLine, target.anchor.side);
        } else {
          requestScroll(target.path);
        }
      } else if (target.kind === "file") {
        navigateFile(target.path);
      } else {
        navigateFile(target.path);
        requestScroll(target.path, undefined, undefined, target.symbol);
      }
    },
    [journey, navigateCluster, navigateFile, requestScroll],
  );
  const toggleRead = useCallback(
    (clusterId: ClusterId, path: RepositoryPath) => {
      const key = readMarkKey(clusterId, path);
      const active = !readFiles.has(key);
      const input = { journeyId: journey.id, clusterId, path };
      if (active) markRead(input);
      else unmarkRead(input);
    },
    [journey.id, markRead, readFiles, unmarkRead],
  );
  const setDisplayMode = useCallback(
    (mode: DisplayMode) => {
      setDisplayOverride(mode);
      persistDisplayMode({ journeyId: journey.id, displayMode: mode });
    },
    [journey.id, persistDisplayMode],
  );

  const actionError =
    firstFailure(markResult, unmarkResult, displayResult) ??
    (AsyncResult.isFailure(readStateResult) ? causeMessage(readStateResult.cause) : null) ??
    runIssue;
  const context = useMemo<JourneyContextValue>(
    () => ({
      pr,
      document,
      stale,
      navigationMode,
      currentClusterId,
      readView: {
        displayMode,
        readFiles,
        readMarks: serverMarks,
      },
      treePaths,
      treeReady,
      treeError,
      openFiles,
      scrollTarget,
      actionError,
      setNavigationMode,
      setCurrentCluster: setCurrentClusterId,
      navigateOverview,
      navigateCluster,
      navigateFile,
      closeFile,
      navigateEvidence,
      requestScroll,
      clearScrollTarget,
      toggleRead,
      setDisplayMode,
      reanalyze: onReanalyze,
      reanalyzeDisabled: reanalysisDisabled,
    }),
    [
      actionError,
      clearScrollTarget,
      closeFile,
      currentClusterId,
      displayMode,
      document,
      navigateCluster,
      navigateEvidence,
      navigateFile,
      navigateOverview,
      navigationMode,
      onReanalyze,
      openFiles,
      pr,
      readFiles,
      reanalysisDisabled,
      serverMarks,
      requestScroll,
      scrollTarget,
      setDisplayMode,
      stale,
      treeError,
      treePaths,
      treeReady,
      toggleRead,
    ],
  );

  return (
    <JourneyContextProvider value={context}>
      <section className="journey-shell">
        <header className="journey-header">
          <button className="journey-pr-heading" type="button" onClick={navigateOverview}>
            <span>
              {pr.owner}/{pr.repo} #{pr.number}
            </span>
            <strong>{document.pullRequest.title}</strong>
          </button>
          <div className="journey-header-actions">
            {stale ? (
              <span className="journey-stale-header">
                Pinned to {journey.pinned.headSha.slice(0, 7)}
                <button type="button" disabled={reanalysisDisabled} onClick={onReanalyze}>
                  <RefreshIcon />
                  {startingReanalysis ? "Opening…" : "Reanalyze"}
                </button>
              </span>
            ) : null}
            <fieldset className="journey-view-toggle" aria-label="Code view">
              <button
                type="button"
                aria-pressed={displayMode !== "just-the-code"}
                onClick={() => setDisplayMode(lastDiffMode)}
              >
                Diff
              </button>
              <button
                type="button"
                aria-pressed={displayMode === "just-the-code"}
                onClick={() => setDisplayMode("just-the-code")}
              >
                Code
              </button>
            </fieldset>
          </div>
        </header>
        {runIssue === null && activeReanalysis === null && !startingReanalysis ? null : (
          <output
            className="journey-run-issue"
            data-running={activeReanalysis === null && !startingReanalysis ? undefined : true}
          >
            <span>
              {startingReanalysis
                ? "Opening the reanalysis run…"
                : (activeReanalysis?.activity?.currentAction ??
                  (activeReanalysis === null
                    ? runIssue
                    : `Reanalyzing · ${phaseDescription(activeReanalysis.phase)}`))}
            </span>
            {activeReanalysis !== null && onCancelReanalysis !== null ? (
              <button type="button" disabled={cancellingReanalysis} onClick={onCancelReanalysis}>
                {cancellingReanalysis ? "Cancelling…" : "Cancel reanalysis"}
              </button>
            ) : startingReanalysis ? null : (
              <button type="button" disabled={reanalysisDisabled} onClick={onReanalyze}>
                Retry reanalysis
              </button>
            )}
          </output>
        )}
        <div className="journey-workspace">
          <Suspense fallback={JOURNEY_NAVIGATION_FALLBACK}>
            <JourneyNavigation />
          </Suspense>
          <div className="journey-route-surface">
            <Outlet />
          </div>
        </div>
      </section>
    </JourneyContextProvider>
  );
}

export function JourneyOverviewRoute() {
  return (
    <Suspense fallback={JOURNEY_PAGE_FALLBACK}>
      <JourneyOverviewPage />
    </Suspense>
  );
}

export function JourneyClusterRoute() {
  return (
    <Suspense fallback={JOURNEY_PAGE_FALLBACK}>
      <JourneyClusterPage />
    </Suspense>
  );
}

export function JourneyFileRoute() {
  return (
    <Suspense fallback={JOURNEY_PAGE_FALLBACK}>
      <JourneyFilePage />
    </Suspense>
  );
}

function JourneyPageLoading() {
  return (
    <div className="journey-page-loading" aria-live="polite">
      Opening the pinned journey…
    </div>
  );
}

function IngestionTransition({
  pr,
  job,
  starting,
  error,
  cancelError,
  onCancel,
  onRetry,
}: {
  readonly pr: PrRef;
  readonly job: IngestionJob | null;
  readonly starting: boolean;
  readonly error: string | null;
  readonly cancelError: string | null;
  readonly onCancel: (() => void) | null;
  readonly onRetry: () => void;
}) {
  const view = job === null ? null : deriveIngestionStages(job);
  const failed =
    view?.outcome === "failed" || view?.outcome === "cancelled" || (job === null && error !== null);
  const title =
    view?.outcome === "queued"
      ? "Your journey is in line."
      : view?.outcome === "failed"
        ? "The run hit an operational fault."
        : view?.outcome === "cancelled"
          ? "The run was cancelled."
          : "Building a way through the change.";

  return (
    <main className="ingestion-transition">
      <div className="ingestion-atmosphere" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <section className="ingestion-card" aria-live="polite">
        <header>
          <p className="eyebrow">
            {pr.owner}/{pr.repo} #{pr.number}
          </p>
          <h1>{title}</h1>
          <p>
            {failed
              ? "Nothing partial was saved. The run can be started again when you’re ready."
              : "You can leave this page. The run continues locally, and this view catches up when you return."}
          </p>
        </header>

        <ol className="ingestion-stages">
          {(
            view?.stages ?? [
              { id: "repository", title: "Cloning the repository", state: "pending" },
              { id: "change", title: "Reading the change", state: "pending" },
              { id: "journey", title: "Constructing the journey", state: "pending" },
            ]
          ).map((stage, index) => (
            <li key={stage.id} data-state={stage.state}>
              <span className="ingestion-stage-mark">
                {stage.state === "complete" ? "✓" : index + 1}
              </span>
              <span>
                <strong>{stage.title}</strong>
                <small>{stageStatus(stage.state)}</small>
              </span>
            </li>
          ))}
        </ol>

        {view?.queuePosition === null || view?.queuePosition === undefined ? null : (
          <p className="ingestion-queue">Queue position {view.queuePosition}</p>
        )}

        {view?.activity === null || view?.activity === undefined ? (
          <div className="ingestion-current-action">
            <span className="ingestion-pulse" aria-hidden />
            <span>
              {starting || job === null ? "Opening the analysis run…" : phaseDescription(job.phase)}
            </span>
          </div>
        ) : (
          <section className="ingestion-activity">
            <div className="ingestion-current-action">
              <span className="ingestion-pulse" aria-hidden />
              <span>
                {view.activity.currentAction}
                {view.activity.currentFile === null ? null : (
                  <code>{view.activity.currentFile}</code>
                )}
              </span>
            </div>
            <div className="ingestion-counters">
              <span>
                <strong>{view.activity.counters.filesWalked}</strong> files walked
              </span>
              <span>
                <strong>{view.activity.counters.symbolsTraced}</strong> symbols traced
              </span>
              <span>
                <strong>{view.activity.counters.callSitesFollowed}</strong> call sites followed
              </span>
            </div>
            {view.activity.recentActions.length === 0 ? null : (
              <ul className="ingestion-recent-actions">
                {recentActionEntries(view.activity.recentActions).map(({ action, key }) => (
                  <li key={key}>{action}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        {error === null && cancelError === null ? null : (
          <p className="journey-inline-error" role="alert">
            {error ?? cancelError}
          </p>
        )}

        <footer>
          <Link to="/">Back to reviews</Link>
          {failed ? (
            <button className="journey-primary-action" type="button" onClick={onRetry}>
              Retry analysis
            </button>
          ) : onCancel === null ? null : (
            <button className="journey-secondary-action" type="button" onClick={onCancel}>
              Cancel run
            </button>
          )}
        </footer>
      </section>
    </main>
  );
}

const activeIngestion = (job: IngestionJob | null): boolean =>
  job !== null && job.phase !== "complete" && job.phase !== "cancelled" && job.phase !== "failed";

function recentActionEntries(
  actions: readonly string[],
): ReadonlyArray<{ readonly action: string; readonly key: string }> {
  const occurrences = new Map<string, number>();
  return actions.slice(0, 3).map((action) => {
    const occurrence = occurrences.get(action) ?? 0;
    occurrences.set(action, occurrence + 1);
    return { action, key: `${action}:${occurrence}` };
  });
}

const terminalIngestion = (job: IngestionJob | null): boolean =>
  job !== null && (job.phase === "complete" || job.phase === "cancelled" || job.phase === "failed");

const stageStatus = (state: string): string => {
  switch (state) {
    case "complete":
      return "Complete";
    case "active":
      return "In progress";
    case "queued":
      return "Waiting";
    case "unknown":
      return "Stopped before completion";
    default:
      return "Waiting";
  }
};

const phaseDescription = (phase: IngestionJob["phase"]): string => {
  switch (phase) {
    case "queued":
      return "Waiting for a local analysis slot…";
    case "resolving":
      return "Resolving the pull request and analysis harness…";
    case "cloning":
      return "Cloning the pinned repository revisions…";
    case "diffing":
      return "Reading the complete change…";
    case "analyzing":
      return "Tracing the change through the codebase…";
    case "validating":
      return "Checking coverage and evidence links…";
    case "saving":
      return "Saving the completed journey…";
    case "complete":
      return "Opening the completed journey…";
    case "cancelled":
      return "The analysis run was cancelled.";
    case "failed":
      return "The analysis run stopped.";
  }
};

function firstFailure(
  ...results: readonly AsyncResult.AsyncResult<unknown, unknown>[]
): string | null {
  const failure = results.find(AsyncResult.isFailure);
  return failure === undefined ? null : causeMessage(failure.cause);
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request did not complete. Try again when the local server is ready.";
}
