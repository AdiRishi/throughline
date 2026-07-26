/**
 * What every surface inside a journey shares.
 *
 * The journey artifact, the read state, and the small set of renderer-local
 * toggles (which rail, whether guidance is open, which hints are in view) —
 * held once by the layout so the pages below it can be about their own job.
 *
 * @module features/journey/context
 */
import { createContext, useContext } from "react";

import type {
  ClusterId,
  DisplayMode,
  Hint,
  Journey,
  JourneyProgress,
  ReadState,
} from "@app/contracts";

export type RailMode = "journey" | "files";

export interface JourneyContextValue {
  readonly journey: Journey;
  readonly readState: ReadState | null;
  readonly progress: JourneyProgress;
  /**
   * The pull request has moved past the commit this journey is pinned to. The
   * journey stays fully readable — it is a faithful map of an older head — but
   * it says so wherever it is shown.
   */
  readonly stale: boolean;
  readonly displayMode: DisplayMode;
  readonly setDisplayMode: (mode: DisplayMode) => void;
  readonly railMode: RailMode;
  readonly setRailMode: (mode: RailMode) => void;
  readonly guidanceOpen: boolean;
  readonly setGuidanceOpen: (open: boolean) => void;
  readonly markFile: (clusterId: ClusterId, path: string, read: boolean) => void;
  readonly isFileRead: (clusterId: ClusterId, path: string) => boolean;
  /**
   * A readable name for a hunk id, so a bare `tl:hunk/h12` reads as the code it
   * points at rather than as an internal identifier.
   */
  readonly labelForHunk: (hunkId: string) => string | null;
  /** Hints whose anchors are currently on screen, nearest first. */
  readonly visibleHints: ReadonlyArray<Hint>;
  readonly setVisibleHints: (hints: ReadonlyArray<Hint>) => void;
  /** Ask the open code surface to scroll somewhere. Set by whichever page owns it. */
  readonly requestScroll: (target: ScrollRequest) => void;
  readonly registerScrollHandler: (handler: ((target: ScrollRequest) => void) | null) => void;
  /**
   * Changed-region navigation, published by the open code surface so the page
   * footer can render "region N of M" and step through them — identically in
   * every display mode, because a region is a fact about the diff, not about
   * how it is drawn.
   */
  readonly regions: RegionCursor;
  readonly setRegions: (cursor: RegionCursor) => void;
}

export interface RegionCursor {
  readonly total: number;
  /** 1-based; 0 when nothing is in view yet. */
  readonly current: number;
  readonly go: (direction: 1 | -1) => void;
}

export const NO_REGIONS: RegionCursor = { total: 0, current: 0, go: () => {} };

export type ScrollRequest =
  | { readonly kind: "file"; readonly path: string }
  | {
      readonly kind: "line";
      readonly path: string;
      readonly side: "old" | "new";
      readonly line: number;
    }
  | { readonly kind: "hunk"; readonly hunkId: string };

const JourneyContext = createContext<JourneyContextValue | null>(null);

export const JourneyProvider = JourneyContext.Provider;

export function useJourney(): JourneyContextValue {
  const value = useContext(JourneyContext);
  if (value === null) {
    throw new Error("useJourney must be used inside a journey route.");
  }
  return value;
}
