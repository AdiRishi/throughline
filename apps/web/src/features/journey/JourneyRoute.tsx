/**
 * The journey frame.
 *
 * Resolves the journey for a pull request and renders the ingestion transition
 * while one is running or absent — so every page below can assume a journey
 * exists. When one does, the frame recedes to what the product asks for: a
 * navigation rail, the code, and a margin of help.
 *
 * @module features/journey/JourneyRoute
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  prRefKey,
  type ClusterId,
  type DisplayMode,
  type Hint,
  type Journey,
  type PrRef,
} from "@app/contracts";
import { computeJourneyProgress } from "@app/journey/progress";

import { journeyRoute } from "../../router.tsx";
import { ingestionAtomsFor, ingestionActions } from "../../state/ingestion.ts";
import {
  journeyAtomsFor,
  prKeyString,
  readStateActions,
  withoutPendingMark,
  withPendingMark,
} from "../../state/journey.ts";
import { welcomeAtoms } from "../../state/welcome.ts";
import { Segmented } from "../../ui/primitives.tsx";
import { IngestionTransition } from "../ingestion/IngestionTransition.tsx";
import {
  JourneyProvider,
  NO_REGIONS,
  type RailMode,
  type RegionCursor,
  type ScrollRequest,
} from "./context.tsx";
import { FilesRail } from "./FilesRail.tsx";
import { GuidanceRail } from "./GuidanceRail.tsx";
import { JourneyRail } from "./JourneyRail.tsx";

export function JourneyRoute() {
  // Read from the journey route by id rather than by path string: the child
  // routes (cluster, and the file splat) add params of their own, and a
  // mismatch here would silently key the atom families on a different pull
  // request — which looks exactly like "this journey does not exist".
  const params = journeyRoute.useParams();
  const pr: PrRef = useMemo(
    () => ({
      owner: params.owner,
      repo: params.repo,
      number: Number.parseInt(params.number, 10),
    }),
    [params.owner, params.repo, params.number],
  );
  const key = prKeyString(pr);

  const atoms = journeyAtomsFor(key);
  const fetchedJourney = useAtomValue(atoms.journey);
  const journeyLoading = useAtomValue(atoms.journeyLoading);

  // A journey is immutable, so the one we already have stays valid while a
  // refetch is in flight — and a refetch is exactly what a finished reanalysis
  // triggers. Holding the last one means the screen never blanks mid-read.
  const [lastJourney, setLastJourney] = useState<Journey | null>(null);
  useEffect(() => {
    if (fetchedJourney !== null) setLastJourney(fetchedJourney);
  }, [fetchedJourney]);
  const journey = fetchedJourney ?? lastJourney;

  const readState = useAtomValue(atoms.readState);
  const setPending = useAtomSet(atoms.pending);

  // Derived here rather than in an atom so it always describes the journey
  // actually on screen — including the held one during a refetch.
  const progress = useMemo(
    () => (journey === null ? null : computeJourneyProgress(journey, readState)),
    [journey, readState],
  );

  const ingestion = ingestionAtomsFor(key);
  const job = useAtomValue(ingestion.job);
  const ingestionReady = useAtomValue(ingestion.ready);
  const startIngestion = useAtomSet(ingestionActions.start);

  const markFileRpc = useAtomSet(readStateActions.markFile);
  const setDisplayModeRpc = useAtomSet(readStateActions.setDisplayMode);

  // Staleness is a fact about the pull request, and the welcome view is where
  // the authoritative head already lives — so it is read from there rather
  // than fetched a second time.
  const prList = useAtomValue(welcomeAtoms.view);
  const stale =
    prList.repos
      .flatMap((repo) => repo.entries)
      .concat(prList.merged)
      .find((entry) => prRefKey(entry.pr.ref) === prRefKey(pr))?.journey?.stale === true;

  const [railMode, setRailMode] = useState<RailMode>("journey");
  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const [visibleHints, setVisibleHints] = useState<ReadonlyArray<Hint>>([]);
  const [regions, setRegions] = useState<RegionCursor>(NO_REGIONS);
  const [starting, setStarting] = useState(false);
  const scrollHandler = useRef<((target: ScrollRequest) => void) | null>(null);

  const matchRoute = useMatchRoute();
  const onOverview = matchRoute({ to: "/pr/$owner/$repo/$number" }) !== false;

  const start = useCallback(() => {
    setStarting(true);
    startIngestion({ target: { kind: "ref", pr }, reanalyze: journey !== null });
  }, [journey, pr, startIngestion]);

  // A run that finishes while the transition is on screen swaps it for the
  // journey without the reviewer doing anything — leavable in both directions.
  // The fetch itself is not triggered here: the journey atom depends on the
  // completed run, so it re-asks on its own (see `state/journey`).
  useEffect(() => {
    if (job?.phase === "complete" || job?.phase === "failed" || job?.phase === "cancelled") {
      setStarting(false);
    }
  }, [job?.phase]);

  const markFile = useCallback(
    (clusterId: ClusterId, path: string, read: boolean) => {
      if (journey === null) return;
      // Optimistic: the atom moves now, the RPC persists, the stream confirms.
      setPending((pending) => withPendingMark(pending, clusterId, path, read));
      markFileRpc({ journeyId: journey.id, clusterId, path, read });
      // The confirmation arrives on `readState.subscribe`; clearing the overlay
      // shortly after keeps a failed write from being invisible forever.
      globalThis.setTimeout(() => {
        setPending((pending) => withoutPendingMark(pending, clusterId, path));
      }, 4000);
    },
    [journey, markFileRpc, setPending],
  );

  const displayMode: DisplayMode = readState?.displayMode ?? "inline";
  const setDisplayMode = useCallback(
    (mode: DisplayMode) => {
      if (journey === null) return;
      setPending((pending) => ({ ...pending, displayMode: mode }));
      setDisplayModeRpc({ journeyId: journey.id, mode });
    },
    [journey, setDisplayModeRpc, setPending],
  );

  const isFileRead = useCallback(
    (clusterId: ClusterId, path: string) =>
      (readState?.readFiles ?? []).some(
        (mark) => mark.clusterId === clusterId && mark.path === path,
      ),
    [readState],
  );

  const labelForHunk = useCallback(
    (hunkId: string) => {
      const hunk = journey?.hunks.find(
        (candidate) => candidate.id === hunkId || candidate.seedId === hunkId,
      );
      if (hunk === undefined) return null;
      const name = hunk.path.split("/").at(-1) ?? hunk.path;
      const line = hunk.newLines > 0 ? hunk.newStart : hunk.oldStart;
      return line > 0 ? `${name}:${line}` : name;
    },
    [journey],
  );

  const requestScroll = useCallback((target: ScrollRequest) => {
    scrollHandler.current?.(target);
  }, []);
  const registerScrollHandler = useCallback((handler: ((target: ScrollRequest) => void) | null) => {
    scrollHandler.current = handler;
  }, []);

  const contextValue = useMemo(
    () =>
      journey === null || progress === null
        ? null
        : {
            journey,
            readState,
            progress,
            stale,
            displayMode,
            setDisplayMode,
            railMode,
            setRailMode,
            guidanceOpen,
            setGuidanceOpen,
            markFile,
            isFileRead,
            labelForHunk,
            visibleHints,
            setVisibleHints,
            regions,
            setRegions,
            requestScroll,
            registerScrollHandler,
          },
    [
      journey,
      progress,
      readState,
      stale,
      displayMode,
      setDisplayMode,
      railMode,
      guidanceOpen,
      markFile,
      isFileRead,
      labelForHunk,
      visibleHints,
      regions,
      requestScroll,
      registerScrollHandler,
    ],
  );

  const runIsLive =
    job !== null && job.phase !== "complete" && job.phase !== "failed" && job.phase !== "cancelled";

  const transition = (
    <IngestionTransition
      pr={pr}
      title={journey?.prSnapshot.title ?? null}
      job={job}
      // Until the job stream has spoken, there is nothing honest to offer:
      // showing "analyze this" over a run already in flight would be a lie.
      onStart={ingestionReady ? start : undefined}
      starting={starting || !ingestionReady}
    />
  );

  // A live run outranks everything, including a journey fetch in flight. The
  // fetch is re-issued whenever the session changes and again when the run
  // ends; letting it win would blank a running transition for as long as it
  // takes to answer, which reads as the app losing the run.
  if (runIsLive) return transition;

  // Only "we have never had an answer for this pull request, and nothing is
  // running" is a blank screen.
  if (journeyLoading && journey === null) {
    return <BootState />;
  }

  if (journey === null || contextValue === null) {
    return transition;
  }

  return (
    <JourneyProvider value={contextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-border px-3 select-none">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/"
              title="Back to your reviews"
              className="rounded px-1.5 py-1 text-[13px] text-muted transition-colors hover:bg-raised hover:text-foreground"
            >
              ←
            </Link>
            <span className="truncate font-mono text-[12px] text-muted">
              {pr.owner}/{pr.repo} · #{pr.number}
            </span>
            <span className="truncate text-[13px] font-medium">{journey.prSnapshot.title}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Both controls set the one journey-wide mode; placement is reach,
                not scope. Split lives in the file headers, where the eye is. */}
            <Segmented
              value={displayMode === "just-the-code" ? "just-the-code" : "diff"}
              options={[
                { value: "diff", label: "Diff" },
                { value: "just-the-code", label: "Code" },
              ]}
              onChange={(value) =>
                setDisplayMode(value === "just-the-code" ? "just-the-code" : "inline")
              }
              size="small"
            />
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border">
            <div className="p-3 pb-2">
              <Segmented
                value={railMode}
                options={[
                  { value: "journey", label: "Journey" },
                  { value: "files", label: "Files" },
                ]}
                onChange={setRailMode}
              />
            </div>
            <div className="min-h-0 flex-1">
              {railMode === "journey" ? <JourneyRail /> : <FilesRail />}
            </div>
          </aside>

          <main className="min-w-0 flex-1 overflow-hidden">
            <Outlet />
          </main>

          {/* The Overview is a document: it takes the middle and right panels
              together, because guidance is a companion to code and it has none. */}
          {!onOverview && guidanceOpen && (
            <aside className="w-[340px] shrink-0 overflow-y-auto border-l border-border">
              <GuidanceRail />
            </aside>
          )}
        </div>
      </div>
    </JourneyProvider>
  );
}

function BootState() {
  return (
    <div className="flex h-full items-center justify-center">
      <span className="tl-pulse h-2.5 w-2.5 rounded-full bg-faint" />
    </div>
  );
}
