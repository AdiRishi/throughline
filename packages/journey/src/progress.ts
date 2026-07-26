import type { Cluster, ClusterId, Hunk, Journey, ReadState } from "@app/contracts";

import { hunkPaths } from "./hunks.ts";

/**
 * Progress arithmetic — derived, never stored.
 *
 * Read state is what makes the coverage guarantee tangible: the journey's
 * progress reaching 100% *is* the proof that every changed line was presented at
 * its home and acknowledged there. Because that claim has to hold, the numbers
 * behind it are computed from the artifact every time rather than kept in a
 * column that could drift.
 *
 * The rule that shapes every function here: **resurfaced hunks count nowhere but
 * home.** A cluster's progress is its homed hunks in read files over its homed
 * hunks, and nothing else.
 *
 * @module progress
 */

export interface FileProgress {
  readonly path: string;
  /** Hunks homed to this cluster in this file. Zero for resurfaced-only files. */
  readonly homedHunks: number;
  readonly read: boolean;
  /** True when this file only appears here as a revisit; it needs no marking. */
  readonly resurfacedOnly: boolean;
}

export interface ClusterProgress {
  readonly clusterId: ClusterId;
  readonly position: number;
  readonly files: ReadonlyArray<FileProgress>;
  readonly filesTotal: number;
  readonly filesRead: number;
  readonly hunksTotal: number;
  readonly hunksRead: number;
  /** 0–1. A cluster with no homed hunks reads as complete rather than dividing by zero. */
  readonly fraction: number;
  readonly complete: boolean;
}

export interface JourneyProgress {
  readonly clusters: ReadonlyArray<ClusterProgress>;
  readonly filesTotal: number;
  readonly filesRead: number;
  readonly hunksTotal: number;
  readonly hunksRead: number;
  readonly fraction: number;
  readonly complete: boolean;
  /** The first incomplete cluster's position — where "resume" points. Null when done. */
  readonly currentClusterPosition: number | null;
}

/**
 * A read mark is a (cluster, path) pair, and the pair has to survive being used
 * as a `Set` key. The separator is NUL because a file path may legitimately
 * contain a space, a colon, or a slash — but never a NUL byte. Always build keys
 * through `markKey`; never hand-assemble one.
 */
const KEY_SEPARATOR = "\u0000";

export function markKey(clusterId: ClusterId, path: string): string {
  return `${clusterId}${KEY_SEPARATOR}${path}`;
}

/** The set of (cluster, path) keys a read state marks. */
export function readMarkKeys(readState: Pick<ReadState, "readFiles">): ReadonlySet<string> {
  return new Set(readState.readFiles.map((mark) => markKey(mark.clusterId, mark.path)));
}

export function isFileRead(
  marks: ReadonlySet<string>,
  clusterId: ClusterId,
  path: string,
): boolean {
  return marks.has(markKey(clusterId, path));
}

/**
 * One cluster's progress. `fileOrder` drives iteration so the returned files are
 * in narrative order — the same order the reading surface renders them.
 */
export function computeClusterProgress(
  cluster: Cluster,
  hunks: ReadonlyArray<Hunk>,
  marks: ReadonlySet<string>,
): ClusterProgress {
  const homed = hunks.filter((hunk) => hunk.home === cluster.id);
  const homedByPath = new Map<string, number>();
  for (const hunk of homed) {
    homedByPath.set(hunk.path, (homedByPath.get(hunk.path) ?? 0) + 1);
  }

  // `fileOrder` is authoritative, but a cluster whose fileOrder is incomplete
  // must still account for every homed hunk — progress can never quietly shrink
  // its own denominator.
  const paths = [...cluster.fileOrder];
  for (const path of hunkPaths(homed)) {
    if (!paths.includes(path)) paths.push(path);
  }

  const files: FileProgress[] = paths.map((path) => {
    const homedHunks = homedByPath.get(path) ?? 0;
    return {
      path,
      homedHunks,
      read: isFileRead(marks, cluster.id, path),
      resurfacedOnly: homedHunks === 0,
    };
  });

  const countable = files.filter((file) => !file.resurfacedOnly);
  const filesRead = countable.filter((file) => file.read).length;
  const hunksTotal = homed.length;
  const hunksRead = countable
    .filter((file) => file.read)
    .reduce((total, file) => total + file.homedHunks, 0);

  return {
    clusterId: cluster.id,
    position: cluster.position,
    files,
    filesTotal: countable.length,
    filesRead,
    hunksTotal,
    hunksRead,
    fraction: hunksTotal === 0 ? 1 : hunksRead / hunksTotal,
    complete: hunksRead === hunksTotal,
  };
}

/**
 * The whole journey. Aggregation is over hunks, not over cluster fractions: a
 * five-hunk cluster and a five-hundred-hunk cluster must not weigh the same, or
 * "100%" would stop meaning "every line acknowledged".
 */
export function computeJourneyProgress(
  journey: Pick<Journey, "clusters" | "hunks">,
  readState: Pick<ReadState, "readFiles"> | null,
): JourneyProgress {
  const marks = readState === null ? new Set<string>() : readMarkKeys(readState);
  const clusters = [...journey.clusters]
    .toSorted((left, right) => left.position - right.position)
    .map((cluster) => computeClusterProgress(cluster, journey.hunks, marks));

  const hunksTotal = clusters.reduce((total, cluster) => total + cluster.hunksTotal, 0);
  const hunksRead = clusters.reduce((total, cluster) => total + cluster.hunksRead, 0);
  const filesTotal = clusters.reduce((total, cluster) => total + cluster.filesTotal, 0);
  const filesRead = clusters.reduce((total, cluster) => total + cluster.filesRead, 0);
  const incomplete = clusters.find((cluster) => !cluster.complete);

  return {
    clusters,
    filesTotal,
    filesRead,
    hunksTotal,
    hunksRead,
    fraction: hunksTotal === 0 ? 1 : hunksRead / hunksTotal,
    complete: incomplete === undefined,
    currentClusterPosition: incomplete?.position ?? null,
  };
}

/** Scale figures for the Overview map — derived at render time, never stored. */
export interface ClusterScale {
  readonly clusterId: ClusterId;
  readonly filesTouched: number;
  readonly hunksHomed: number;
  readonly resurfacedCount: number;
}

export function computeClusterScales(
  journey: Pick<Journey, "clusters" | "hunks">,
): ReadonlyArray<ClusterScale> {
  return journey.clusters.map((cluster) => {
    const homed = journey.hunks.filter((hunk) => hunk.home === cluster.id);
    return {
      clusterId: cluster.id,
      filesTouched: hunkPaths(homed).length,
      hunksHomed: homed.length,
      resurfacedCount: cluster.resurfaced.length,
    };
  });
}

/** Round a 0–1 fraction to whole percent for display. */
export function toPercent(fraction: number): number {
  return Math.round(fraction * 100);
}
