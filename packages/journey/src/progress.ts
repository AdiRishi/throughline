import type { ClusterId, Hunk, ReadFile, ReadState } from "@app/contracts";

export interface Progress {
  readonly read: number;
  readonly total: number;
  readonly ratio: number;
}

function result(read: number, total: number): Progress {
  return { read, total, ratio: total === 0 ? 1 : read / total };
}

export function clusterProgress(
  clusterId: ClusterId,
  hunks: ReadonlyArray<Hunk>,
  readFiles: ReadonlyArray<ReadFile>,
): Progress {
  const homed = hunks.filter((hunk) => hunk.home === clusterId);
  const readPaths = new Set(
    readFiles.filter((entry) => entry.clusterId === clusterId).map((entry) => entry.path),
  );
  return result(homed.filter((hunk) => readPaths.has(hunk.path)).length, homed.length);
}

export function journeyProgress(
  hunks: ReadonlyArray<Hunk>,
  readState: Pick<ReadState, "readFiles">,
): Progress {
  const readPairs = new Set(
    readState.readFiles.map((entry) => `${entry.clusterId}\0${entry.path}`),
  );
  return result(
    hunks.filter((hunk) => readPairs.has(`${hunk.home}\0${hunk.path}`)).length,
    hunks.length,
  );
}
