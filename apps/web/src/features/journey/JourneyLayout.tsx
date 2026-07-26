import { useAtomValue } from "@effect/atom-react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import type { DisplayMode, Journey, JourneyEnvelope, ReadState } from "@app/contracts";
import { computeJourneyProgress, type JourneyProgress } from "@app/journey/progress";

import {
  jobForAtom,
  journeyAtom,
  journeyValueAtom,
  prListAtom,
  readStateAtom,
  refKey,
} from "../../state/journeyState.ts";
import { IngestionTransition } from "../ingestion/IngestionTransition.tsx";
import { JourneyRail } from "./JourneyRail.tsx";
import { JourneyTopBar } from "./JourneyTopBar.tsx";

/**
 * The frame.
 *
 * ```
 * ┌────────────┬──────────────────────────────┬──────────────┐
 * │ Navigation │  The code                    │  Guidance    │
 * │ (journey   │  (diff, or just the file)    │  (hints,     │
 * │  or files) │                              │   scroll-    │
 * └────────────┴──────────────────────────────┴──────────────┘
 * ```
 *
 * Two responsibilities, both structural.
 *
 * First, **the frame recedes when reading begins.** The left rail keeps only what
 * the reviewer navigates by; the top bar keeps only the display-mode toggle. What
 * remains is close to a plain editor, because sometimes the reviewer just wants to
 * read code and nothing about being in a review tool should take that away.
 *
 * Second, **it decides whether there is a journey to read at all.** While an
 * ingestion is running — or before one has ever run — it renders the transition
 * in place of its children. The URL is already the journey's, which is what makes
 * the wait leavable: coming back lands in the right place whether the analysis
 * finished or not.
 *
 * @module features/journey/JourneyLayout
 */

export interface JourneyContextValue {
  readonly envelope: JourneyEnvelope;
  readonly journey: Journey;
  readonly readState: ReadState | null;
  readonly progress: JourneyProgress;
  /**
   * Whether the pinned head still matches the pull request's.
   *
   * Derived here rather than read off the envelope, because staleness is *never
   * stored* — it is a comparison made at the moment of display. The envelope
   * carries the answer as of the moment it was fetched, and the journey artifact
   * is immutable and cached forever, so a journey opened before a push would
   * otherwise keep claiming to be current. The live PR list is the freshest view
   * the renderer has, so it wins whenever it knows this pull request.
   */
  readonly stale: boolean;
  readonly displayMode: DisplayMode;
  /** The right rail is collapsible, and reading with it closed is complete. */
  readonly guidanceOpen: boolean;
  readonly setGuidanceOpen: (open: boolean) => void;
  /** Which left-rail mode is showing: the journey, or the project's file tree. */
  readonly railMode: "journey" | "files";
  readonly setRailMode: (mode: "journey" | "files") => void;
  readonly changedOnly: boolean;
  readonly setChangedOnly: (value: boolean) => void;
}

const JourneyContext = createContext<JourneyContextValue | null>(null);

/** Every journey surface reads its journey from here; none of them fetch it. */
export function useJourney(): JourneyContextValue {
  const value = useContext(JourneyContext);
  if (value === null) {
    throw new Error("A journey surface was rendered outside the journey layout.");
  }
  return value;
}

export function JourneyLayout() {
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const navigate = useNavigate();
  const ref = useMemo(
    () => ({
      owner: params.owner,
      repo: params.repo,
      number: Number.parseInt(params.number, 10),
    }),
    [params.owner, params.repo, params.number],
  );
  const key = refKey(ref);

  const result = useAtomValue(journeyAtom(key));
  const envelope = useAtomValue(journeyValueAtom(key));
  const job = useAtomValue(jobForAtom(key));
  const prList = useAtomValue(prListAtom);

  const journeyId = envelope?.journey.id ?? null;
  const readState = useAtomValue(readStateAtom(journeyId ?? "none"));

  // Renderer-local ephemera, and nothing else. None of this belongs in the URL:
  // a reload should land the reviewer back in the code, not in whatever rail
  // mode they happened to leave open.
  const [railMode, setRailMode] = useState<"journey" | "files">("journey");
  const [guidanceOpen, setGuidanceOpen] = useState(true);
  const [changedOnly, setChangedOnly] = useState(false);

  const context = useMemo<JourneyContextValue | null>(() => {
    if (envelope === null) return null;
    const liveHeadSha =
      prList === null
        ? null
        : ([...prList.groups.flatMap((group) => group.entries), ...prList.merged].find(
            (entry) =>
              entry.pr.ref.owner === ref.owner &&
              entry.pr.ref.repo === ref.repo &&
              entry.pr.ref.number === ref.number,
          )?.pr.headSha ?? null);
    return {
      envelope,
      journey: envelope.journey,
      readState,
      progress: computeJourneyProgress(envelope.journey, readState),
      stale:
        liveHeadSha === null ? envelope.stale : liveHeadSha !== envelope.journey.pinned.headSha,
      displayMode: readState?.displayMode ?? "inline",
      guidanceOpen,
      setGuidanceOpen,
      railMode,
      setRailMode,
      changedOnly,
      setChangedOnly,
    };
  }, [envelope, readState, prList, ref, guidanceOpen, railMode, changedOnly]);

  // A live job always wins: even a readable journey should show its reanalysis
  // rather than pretend the old artifact is current.
  const running = job !== null && isLivePhase(job.phase);
  if (running || (context === null && !AsyncResult.isSuccess(result))) {
    return (
      <IngestionTransition
        ref={ref}
        job={job}
        onBack={() => void navigate({ to: "/" })}
        onOpen={() => void navigate({ to: "/pr/$owner/$repo/$number", params })}
      />
    );
  }

  if (context === null) {
    return (
      <IngestionTransition
        ref={ref}
        job={job}
        onBack={() => void navigate({ to: "/" })}
        onOpen={() => void navigate({ to: "/pr/$owner/$repo/$number", params })}
      />
    );
  }

  return (
    <JourneyContext.Provider value={context}>
      <div className="flex h-full flex-col overflow-hidden">
        <JourneyTopBar />
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-card">
            <JourneyRail />
          </aside>
          <Outlet />
        </div>
      </div>
    </JourneyContext.Provider>
  );
}

function isLivePhase(phase: string): boolean {
  return phase !== "complete" && phase !== "failed" && phase !== "cancelled";
}

/** The middle+right panel shell every journey screen renders into. */
export function ReadingPanels({
  middle,
  right,
  rightClassName,
}: {
  readonly middle: ReactNode;
  readonly right?: ReactNode;
  /**
   * Overrides the right panel's reading width. Guidance collapses to a strip, and
   * a strip that kept a panel's width would take the room from the code — so the
   * collapsed rail stays in the panel it belongs to instead of moving house.
   */
  readonly rightClassName?: string;
}) {
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{middle}</main>
      {right !== undefined && (
        <aside
          className={`flex shrink-0 flex-col overflow-hidden border-l border-border bg-card ${
            rightClassName ?? "w-[320px]"
          }`}
        >
          {right}
        </aside>
      )}
    </>
  );
}
