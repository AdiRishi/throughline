/**
 * A tiny hand-built journey used across the validator, progress, and evidence
 * tests. Small enough to reason about line by line; shaped like a real one.
 */
import type { Cluster, ClusterId, Hunk, HunkId, SeedHunk } from "@app/contracts";

export const cluster = (input: {
  readonly id: string;
  readonly position: number;
  readonly title?: string;
  readonly buildsOn?: ReadonlyArray<string>;
  readonly fileOrder: ReadonlyArray<string>;
  readonly resurfaced?: ReadonlyArray<{ readonly hunkId: string; readonly note: string }>;
}): Cluster => ({
  id: input.id as ClusterId,
  position: input.position,
  title: input.title ?? `Cluster ${input.position}`,
  weight: "core",
  narrative: { markdown: "narrative" },
  mapEntry: { markdown: "map entry" },
  buildsOn: (input.buildsOn ?? []).map((id) => id as ClusterId),
  fileOrder: input.fileOrder,
  resurfaced: (input.resurfaced ?? []).map((entry) => ({
    hunkId: entry.hunkId as HunkId,
    note: { markdown: entry.note },
  })),
});

export const seed = (input: {
  readonly id: string;
  readonly path: string;
  readonly oldStart?: number;
  readonly oldLines?: number;
  readonly newStart?: number;
  readonly newLines?: number;
  readonly fileKind?: SeedHunk["fileKind"];
}): SeedHunk => ({
  id: input.id as HunkId,
  path: input.path,
  oldStart: input.oldStart ?? 0,
  oldLines: input.oldLines ?? 0,
  newStart: input.newStart ?? 0,
  newLines: input.newLines ?? 0,
  fileKind: input.fileKind ?? null,
});

export const hunk = (input: {
  readonly id: string;
  readonly path: string;
  readonly home: string;
  readonly seedId?: string;
  readonly oldStart?: number;
  readonly oldLines?: number;
  readonly newStart?: number;
  readonly newLines?: number;
  readonly fileKind?: Hunk["fileKind"];
}): Hunk => ({
  id: input.id as HunkId,
  path: input.path,
  oldStart: input.oldStart ?? 0,
  oldLines: input.oldLines ?? 0,
  newStart: input.newStart ?? 0,
  newLines: input.newLines ?? 0,
  fileKind: input.fileKind ?? null,
  seedId: (input.seedId ?? input.id) as HunkId,
  home: input.home as ClusterId,
});

export const file = (path: string, overrides?: { readonly binary?: boolean }) => ({
  path,
  oldPath: null,
  changeKind: "modified" as const,
  binary: overrides?.binary ?? false,
  additions: 1,
  deletions: 1,
  oldMode: "100644" as string | null,
  newMode: "100644" as string | null,
});
