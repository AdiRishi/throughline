import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PrRef,
  RepositoryPath,
  type Cluster,
  type ClusterId,
  type FileChange,
  type FileLevelHunkKind,
  type Hunk,
  type HunkId,
  type IngestionJob,
  type Journey,
  type JourneyId,
  type ReadState,
} from "@app/contracts";
import { parseEvidenceLink } from "@app/journey/evidence";
import { deriveProgress, type ClusterProgress, type HunkProgress } from "@app/journey/progress";

export interface PrRouteParams {
  readonly owner: unknown;
  readonly repo: unknown;
  readonly number: unknown;
}

export interface FileHomeViewModel {
  readonly cluster: Cluster;
  readonly hunks: readonly Hunk[];
}

export interface ClusterViewModel {
  readonly cluster: Cluster;
  readonly progress: ClusterProgress;
  readonly homedHunks: readonly Hunk[];
  readonly touchedFileCount: number;
}

export interface ChangedFileViewModel {
  readonly change: FileChange;
  readonly homes: readonly FileHomeViewModel[];
}

export interface JourneyViewModel {
  readonly progress: HunkProgress;
  readonly clusters: readonly ClusterViewModel[];
  readonly changedFiles: readonly ChangedFileViewModel[];
  readonly clusterById: ReadonlyMap<ClusterId, ClusterViewModel>;
  readonly changedFileByPath: ReadonlyMap<RepositoryPath, ChangedFileViewModel>;
}

export interface ResolvedFileRoute {
  readonly path: RepositoryPath;
  readonly change: FileChange | null;
  readonly homes: readonly FileHomeViewModel[];
}

export interface ChangedLineRange {
  readonly side: "old" | "new";
  readonly startLine: number;
  readonly endLine: number;
}

export interface ChangedRegion {
  readonly hunkId: HunkId;
  readonly path: RepositoryPath;
  readonly clusterId: ClusterId;
  readonly fileKind: FileLevelHunkKind | null;
  readonly oldRange: ChangedLineRange | null;
  readonly newRange: ChangedLineRange | null;
  readonly navigation: ChangedLineRange | null;
}

export type EvidenceNavigationTarget =
  | {
      readonly kind: "hunk";
      readonly uri: string;
      readonly hunkId: HunkId;
      readonly clusterId: ClusterId;
      readonly path: RepositoryPath;
      readonly anchor: ChangedLineRange | null;
    }
  | {
      readonly kind: "file";
      readonly uri: string;
      readonly path: RepositoryPath;
    }
  | {
      readonly kind: "symbol";
      readonly uri: string;
      readonly path: RepositoryPath;
      readonly symbol: string;
    };

export type IngestionStageId = "repository" | "change" | "journey";
export type IngestionStageState = "pending" | "queued" | "active" | "complete" | "unknown";
export type IngestionOutcome = "queued" | "running" | "complete" | "cancelled" | "failed";

export interface IngestionStageView {
  readonly id: IngestionStageId;
  readonly title: string;
  readonly state: IngestionStageState;
}

export interface IngestionStagesView {
  readonly outcome: IngestionOutcome;
  readonly phase: IngestionJob["phase"];
  readonly stages: readonly IngestionStageView[];
  readonly queuePosition: number | null;
  readonly activity: IngestionJob["activity"];
  readonly failure: IngestionJob["failure"];
}

const decodePrRef = Schema.decodeUnknownOption(PrRef);
const decodeRepositoryPath = Schema.decodeUnknownOption(RepositoryPath);

export function parsePrRouteParams(params: PrRouteParams): PrRef | null {
  if (
    typeof params.owner !== "string" ||
    typeof params.repo !== "string" ||
    typeof params.number !== "string" ||
    params.owner.trim() !== params.owner ||
    params.repo.trim() !== params.repo ||
    !/^[1-9]\d*$/u.test(params.number)
  ) {
    return null;
  }

  const number = Number(params.number);
  if (!Number.isSafeInteger(number)) {
    return null;
  }

  return Option.getOrNull(
    decodePrRef({
      owner: params.owner,
      repo: params.repo,
      number,
    }),
  );
}

export function fileHomes(journey: Journey, path: RepositoryPath): readonly FileHomeViewModel[] {
  const hunksByCluster = new Map<ClusterId, Hunk[]>();

  for (const hunk of journey.hunks) {
    if (hunk.path !== path) continue;
    const hunks = hunksByCluster.get(hunk.home);
    if (hunks === undefined) {
      hunksByCluster.set(hunk.home, [hunk]);
    } else {
      hunks.push(hunk);
    }
  }

  return journey.clusters.flatMap((cluster) => {
    const hunks = hunksByCluster.get(cluster.id);
    return hunks === undefined ? [] : [{ cluster, hunks }];
  });
}

export function isClusterHomePath(
  journey: Journey,
  clusterId: ClusterId,
  path: RepositoryPath,
): boolean {
  return journey.hunks.some((hunk) => hunk.home === clusterId && hunk.path === path);
}

export function deriveJourneyViewModel(
  journey: Journey,
  readState?: ReadState | null,
): JourneyViewModel {
  const progress = deriveProgress(journey, readState);
  const clusters = journey.clusters.map((cluster, index): ClusterViewModel => {
    const homedHunks = journey.hunks.filter((hunk) => hunk.home === cluster.id);
    return {
      cluster,
      progress: progress.clusters[index]!,
      homedHunks,
      touchedFileCount: cluster.fileOrder.length,
    };
  });
  const changedFiles = journey.files.map(
    (change): ChangedFileViewModel => ({
      change,
      homes: fileHomes(journey, change.path),
    }),
  );

  return {
    progress: progress.journey,
    clusters,
    changedFiles,
    clusterById: new Map(clusters.map((cluster) => [cluster.cluster.id, cluster])),
    changedFileByPath: new Map(changedFiles.map((file) => [file.change.path, file])),
  };
}

export function resolveClusterRoute(journey: Journey, clusterId: string): Cluster | null {
  return journey.clusters.find((cluster) => cluster.id === clusterId) ?? null;
}

export function journeyWasReplaced(
  previousJourneyId: JourneyId | null,
  nextJourneyId: JourneyId,
): boolean {
  return previousJourneyId !== null && previousJourneyId !== nextJourneyId;
}

export function resolveFileRoute(
  journey: Journey,
  treePaths: readonly RepositoryPath[],
  routePath: unknown,
): ResolvedFileRoute | null {
  const path = Option.getOrNull(decodeRepositoryPath(routePath));
  if (path === null) return null;

  const change = journey.files.find((file) => file.path === path) ?? null;
  if (change === null && !treePaths.includes(path)) return null;

  return {
    path,
    change,
    homes: fileHomes(journey, path),
  };
}

const changedLineRange = (
  side: "old" | "new",
  startLine: number,
  lineCount: number,
): ChangedLineRange | null =>
  lineCount === 0
    ? null
    : {
        side,
        startLine,
        endLine: startLine + lineCount - 1,
      };

export function changedRegionsForPath(
  journey: Journey,
  path: RepositoryPath,
): readonly ChangedRegion[] {
  return journey.hunks
    .filter((hunk) => hunk.path === path)
    .map((hunk): ChangedRegion => {
      const oldRange = changedLineRange("old", hunk.oldStart, hunk.oldLines);
      const newRange = changedLineRange("new", hunk.newStart, hunk.newLines);
      return {
        hunkId: hunk.id,
        path: hunk.path,
        clusterId: hunk.home,
        fileKind: hunk.fileKind ?? null,
        oldRange,
        newRange,
        navigation: newRange ?? oldRange,
      };
    });
}

export function codeModeLineAnchor(hunk: Hunk, lineCount: number): number | null {
  if (lineCount === 0) return null;
  return Math.min(lineCount, Math.max(1, hunk.newStart));
}

export function countHeadLines(contents: string | null): number {
  if (contents === null || contents.length === 0) return 0;
  const lines = contents.split(/\r\n|\r|\n/u);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

export function findSymbolLine(contents: string, symbol: string): number | null {
  const index = contents.split(/\r\n|\r|\n/u).findIndex((line) => line.includes(symbol));
  return index === -1 ? null : index + 1;
}

export function resolveEvidenceTarget(
  journey: Journey,
  uri: string,
): EvidenceNavigationTarget | null {
  const parsed = parseEvidenceLink(uri);
  if (!parsed.ok) return null;

  const link = parsed.link;
  if (link.kind === "file") {
    return link;
  }
  if (link.kind === "symbol") {
    return link;
  }

  const hunk = journey.hunks.find((candidate) => candidate.id === link.hunkId);
  if (hunk === undefined) return null;
  const region = changedRegionsForPath(journey, hunk.path).find(
    (candidate) => candidate.hunkId === hunk.id,
  )!;
  return {
    kind: "hunk",
    uri: link.uri,
    hunkId: hunk.id,
    clusterId: hunk.home,
    path: hunk.path,
    anchor: region.navigation,
  };
}

const ingestionStages = [
  { id: "repository", title: "Cloning the repository" },
  { id: "change", title: "Reading the change" },
  { id: "journey", title: "Constructing the journey" },
] as const;

const activeIngestionStage = (job: IngestionJob): number => {
  switch (job.phase) {
    case "resolving":
    case "cloning":
      return 0;
    case "diffing":
      return 1;
    case "analyzing":
      return job.activity?.stage === "narrating" ? 2 : 1;
    case "validating":
    case "saving":
      return 2;
    case "queued":
    case "complete":
    case "cancelled":
    case "failed":
      return -1;
  }
};

const ingestionOutcome = (job: IngestionJob): IngestionOutcome => {
  switch (job.phase) {
    case "queued":
      return "queued";
    case "complete":
      return "complete";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "resolving":
    case "cloning":
    case "diffing":
    case "analyzing":
    case "validating":
    case "saving":
      return "running";
  }
};

export function deriveIngestionStages(job: IngestionJob): IngestionStagesView {
  const outcome = ingestionOutcome(job);
  const activeStage = activeIngestionStage(job);
  const terminalWithoutHistory =
    outcome === "failed" || (outcome === "cancelled" && job.startedAt !== null);

  return {
    outcome,
    phase: job.phase,
    stages: ingestionStages.map(({ id, title }, index) => {
      let state: IngestionStageState = "pending";
      if (outcome === "complete") {
        state = "complete";
      } else if (terminalWithoutHistory) {
        state = "unknown";
      } else if (outcome === "queued" && index === 0) {
        state = "queued";
      } else if (index < activeStage) {
        state = "complete";
      } else if (index === activeStage) {
        state = "active";
      }
      return { id, title, state };
    }),
    queuePosition: job.queuePosition,
    activity: job.activity,
    failure: job.failure,
  };
}

const fileChangeAction = (change: FileChange): string => {
  switch (change.kind) {
    case "added":
      return "added";
    case "modified":
      return "changed";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
  }
};

export function describeFileLevelChange(fileKind: FileLevelHunkKind, change: FileChange): string {
  switch (fileKind) {
    case "binary":
      return `Binary file ${fileChangeAction(change)}`;
    case "rename":
      return change.oldPath === null
        ? `File renamed to ${change.path}`
        : `File renamed from ${change.oldPath} to ${change.path}`;
    case "mode":
      if (change.oldMode !== null && change.newMode !== null) {
        return `File mode changed from ${change.oldMode} to ${change.newMode}`;
      }
      if (change.newMode !== null) {
        return `File mode set to ${change.newMode}`;
      }
      if (change.oldMode !== null) {
        return `File mode ${change.oldMode} removed`;
      }
      return "File mode changed";
    case "symlink":
      return `Symbolic link ${fileChangeAction(change)}`;
    case "submodule":
      return `Submodule ${change.kind === "modified" ? "updated" : fileChangeAction(change)}`;
    case "empty":
      return `Empty file ${fileChangeAction(change)}`;
  }
}
