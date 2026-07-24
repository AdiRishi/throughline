import { createContext, useContext } from "react";

import type {
  ClusterFileReadMark,
  ClusterId,
  DisplayMode,
  JourneyDocument,
  PrRef,
  RepositoryPath,
} from "@app/contracts";

export type JourneyNavigationMode = "journey" | "files";

export interface JourneyScrollTarget {
  readonly key: number;
  readonly path: RepositoryPath;
  readonly lineNumber?: number;
  readonly side?: "old" | "new";
  readonly symbol?: string;
}

export interface JourneyReadView {
  readonly displayMode: DisplayMode;
  readonly readFiles: ReadonlySet<string>;
  readonly readMarks: readonly ClusterFileReadMark[];
}

export interface JourneyContextValue {
  readonly pr: PrRef;
  readonly document: JourneyDocument;
  readonly stale: boolean;
  readonly navigationMode: JourneyNavigationMode;
  readonly currentClusterId: ClusterId | null;
  readonly readView: JourneyReadView;
  readonly treePaths: readonly RepositoryPath[];
  readonly treeReady: boolean;
  readonly treeError: string | null;
  readonly openFiles: readonly RepositoryPath[];
  readonly scrollTarget: JourneyScrollTarget | null;
  readonly actionError: string | null;
  readonly setNavigationMode: (mode: JourneyNavigationMode) => void;
  readonly setCurrentCluster: (clusterId: ClusterId) => void;
  readonly navigateOverview: () => void;
  readonly navigateCluster: (clusterId: ClusterId) => void;
  readonly navigateFile: (path: RepositoryPath) => void;
  readonly closeFile: (path: RepositoryPath) => void;
  readonly navigateEvidence: (uri: string) => void;
  readonly requestScroll: (
    path: RepositoryPath,
    lineNumber?: number,
    side?: "old" | "new",
    symbol?: string,
  ) => void;
  readonly clearScrollTarget: (key: number) => void;
  readonly toggleRead: (clusterId: ClusterId, path: RepositoryPath) => void;
  readonly setDisplayMode: (mode: DisplayMode) => void;
  readonly reanalyze: () => void;
}

const JourneyContext = createContext<JourneyContextValue | null>(null);

export const JourneyContextProvider = JourneyContext.Provider;

export function useJourneyContext(): JourneyContextValue {
  const value = useContext(JourneyContext);
  if (value === null) {
    throw new Error("Journey route components must render inside JourneyLayoutRoute.");
  }
  return value;
}

export const readMarkKey = (clusterId: ClusterId, path: RepositoryPath): string =>
  `${clusterId.length}:${clusterId}${path}`;
