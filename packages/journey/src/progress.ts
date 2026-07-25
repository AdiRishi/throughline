import type { ClusterFileReadMark, ClusterId, Hunk, Journey, ReadState } from "@app/contracts";

export interface HunkProgress {
  readonly readHunks: number;
  readonly totalHunks: number;
  readonly fraction: number;
  readonly complete: boolean;
  readonly markedFiles: number;
  readonly clusterFiles: number;
}

export interface ClusterProgress extends HunkProgress {
  readonly clusterId: ClusterId;
}

export interface JourneyProgress {
  readonly journey: HunkProgress;
  readonly clusters: readonly ClusterProgress[];
}

const markKey = (clusterId: string, path: string): string =>
  `${clusterId.length}:${clusterId}${path}`;

const progress = (hunks: readonly Hunk[], validMarks: ReadonlySet<string>): HunkProgress => {
  const homePairs = new Set<string>();
  let readHunks = 0;

  for (const hunk of hunks) {
    const key = markKey(hunk.home, hunk.path);
    homePairs.add(key);
    if (validMarks.has(key)) readHunks += 1;
  }

  let markedFiles = 0;
  for (const key of homePairs) {
    if (validMarks.has(key)) markedFiles += 1;
  }

  const totalHunks = hunks.length;
  return {
    readHunks,
    totalHunks,
    fraction: totalHunks === 0 ? 0 : readHunks / totalHunks,
    complete: totalHunks > 0 && readHunks === totalHunks,
    markedFiles,
    clusterFiles: homePairs.size,
  };
};

const readMarkSet = (
  journey: Journey,
  readState: ReadState | null | undefined,
): ReadonlySet<string> => {
  if (readState === null || readState === undefined || readState.journeyId !== journey.id) {
    return new Set();
  }

  const validHomePairs = new Set(journey.hunks.map((hunk) => markKey(hunk.home, hunk.path)));
  const marks = new Set<string>();
  for (const mark of readState.readFiles) {
    const key = markKey(mark.clusterId, mark.path);
    if (validHomePairs.has(key)) marks.add(key);
  }
  return marks;
};

export const deriveProgress = (journey: Journey, readState?: ReadState | null): JourneyProgress => {
  const marks = readMarkSet(journey, readState);
  return {
    journey: progress(journey.hunks, marks),
    clusters: journey.clusters.map((cluster) => ({
      clusterId: cluster.id,
      ...progress(
        journey.hunks.filter((hunk) => hunk.home === cluster.id),
        marks,
      ),
    })),
  };
};

export const deriveHunkProgress = (
  hunks: readonly Hunk[],
  readFiles: readonly ClusterFileReadMark[],
): HunkProgress => {
  const validHomePairs = new Set(hunks.map((hunk) => markKey(hunk.home, hunk.path)));
  const marks = new Set<string>();
  for (const mark of readFiles) {
    const key = markKey(mark.clusterId, mark.path);
    if (validHomePairs.has(key)) marks.add(key);
  }
  return progress(hunks, marks);
};
