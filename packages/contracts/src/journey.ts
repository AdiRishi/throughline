import * as Schema from "effect/Schema";

import {
  NonBlankString,
  NonEmptyString,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { CommitSha, PrRef } from "./github.ts";
import { JourneyId as JourneyIdSchema } from "./productIds.ts";

export const JourneyId = JourneyIdSchema;
export type JourneyId = typeof JourneyId.Type;

export const ClusterId = TrimmedNonEmptyString.pipe(Schema.brand("ClusterId"));
export type ClusterId = typeof ClusterId.Type;

export const SeedHunkId = Schema.String.check(Schema.isPattern(/^s[1-9]\d*$/u)).pipe(
  Schema.brand("SeedHunkId"),
);
export type SeedHunkId = typeof SeedHunkId.Type;

export const HunkId = Schema.String.check(Schema.isPattern(/^h[1-9]\d*$/u)).pipe(
  Schema.brand("HunkId"),
);
export type HunkId = typeof HunkId.Type;

export const HintId = TrimmedNonEmptyString.pipe(Schema.brand("HintId"));
export type HintId = typeof HintId.Type;

export const RepositoryPath = NonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { expected: "a safe relative POSIX repository path" },
  ),
).pipe(Schema.brand("RepositoryPath"));
export type RepositoryPath = typeof RepositoryPath.Type;

export const FileChangeKind = Schema.Literals(["added", "modified", "deleted", "renamed"]);
export type FileChangeKind = typeof FileChangeKind.Type;

export const FileLevelHunkKind = Schema.Literals([
  "binary",
  "rename",
  "mode",
  "symlink",
  "submodule",
  "empty",
]);
export type FileLevelHunkKind = typeof FileLevelHunkKind.Type;

export const FileChange = Schema.Struct({
  path: RepositoryPath,
  oldPath: Schema.NullOr(RepositoryPath),
  kind: FileChangeKind,
  oldMode: Schema.NullOr(Schema.String),
  newMode: Schema.NullOr(Schema.String),
  binary: Schema.Boolean,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type FileChange = typeof FileChange.Type;

const HunkRangeFields = {
  path: RepositoryPath,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  fileKind: Schema.optionalKey(FileLevelHunkKind),
} as const;

export const SeedHunk = Schema.Struct({
  id: SeedHunkId,
  ...HunkRangeFields,
});
export type SeedHunk = typeof SeedHunk.Type;

export const Hunk = Schema.Struct({
  id: HunkId,
  ...HunkRangeFields,
  seedId: SeedHunkId,
  home: ClusterId,
});
export type Hunk = typeof Hunk.Type;

export const Narrative = Schema.Struct({
  markdown: NonBlankString,
});
export type Narrative = typeof Narrative.Type;

export const Overview = Schema.Struct({
  brief: Narrative,
  whereToBegin: Narrative,
});
export type Overview = typeof Overview.Type;

export const ClusterWeight = Schema.Literals(["core", "supporting", "mechanical"]);
export type ClusterWeight = typeof ClusterWeight.Type;

export const ResurfacedHunk = Schema.Struct({
  hunkId: HunkId,
  note: Narrative,
});
export type ResurfacedHunk = typeof ResurfacedHunk.Type;

export const Cluster = Schema.Struct({
  id: ClusterId,
  position: PositiveInt,
  title: TrimmedNonEmptyString,
  weight: ClusterWeight,
  narrative: Narrative,
  mapEntry: Narrative,
  buildsOn: Schema.Array(ClusterId),
  fileOrder: Schema.Array(RepositoryPath),
  resurfaced: Schema.Array(ResurfacedHunk),
});
export type Cluster = typeof Cluster.Type;

export const HintKind = Schema.Literals([
  "connection",
  "complexity",
  "ripple",
  "pattern-echo",
  "behavior",
  "resurfacing",
]);
export type HintKind = typeof HintKind.Type;

export const HintAnchor = Schema.Struct({
  path: RepositoryPath,
  side: Schema.Literals(["old", "new"]),
  startLine: PositiveInt,
  endLine: PositiveInt,
});
export type HintAnchor = typeof HintAnchor.Type;

export const Hint = Schema.Struct({
  id: HintId,
  clusterId: ClusterId,
  kind: HintKind,
  anchor: HintAnchor,
  body: Narrative,
});
export type Hint = typeof Hint.Type;

export const HarnessUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
});
export type HarnessUsage = typeof HarnessUsage.Type;

export const JourneyProvenance = Schema.Struct({
  harnessKind: TrimmedNonEmptyString,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  usage: Schema.optionalKey(HarnessUsage),
});
export type JourneyProvenance = typeof JourneyProvenance.Type;

export const Journey = Schema.Struct({
  formatVersion: Schema.Literal(1),
  id: JourneyId,
  pr: PrRef,
  pinned: Schema.Struct({
    headSha: CommitSha,
    baseSha: CommitSha,
    analyzedAt: Schema.DateTimeUtc,
  }),
  provenance: JourneyProvenance,
  overview: Overview,
  clusters: Schema.Array(Cluster),
  hunks: Schema.Array(Hunk),
  files: Schema.Array(FileChange),
  hints: Schema.Array(Hint),
});
export type Journey = typeof Journey.Type;

export const DisplayMode = Schema.Literals(["inline", "just-the-code", "split"]);
export type DisplayMode = typeof DisplayMode.Type;

export const ClusterFileReadMark = Schema.Struct({
  clusterId: ClusterId,
  path: RepositoryPath,
});
export type ClusterFileReadMark = typeof ClusterFileReadMark.Type;

export const ReadState = Schema.Struct({
  journeyId: JourneyId,
  readFiles: Schema.Array(ClusterFileReadMark),
  displayMode: DisplayMode,
  updatedAt: Schema.DateTimeUtc,
});
export type ReadState = typeof ReadState.Type;

export const LocalPrState = Schema.Struct({
  reviewed: Schema.Array(PrRef),
  hidden: Schema.Array(PrRef),
  dismissedMerged: Schema.Array(PrRef),
});
export type LocalPrState = typeof LocalPrState.Type;

export const HarnessSelection = Schema.Literals(["codex", "claude"]);
export type HarnessSelection = typeof HarnessSelection.Type;

export const Settings = Schema.Struct({
  harness: Schema.optionalKey(HarnessSelection),
});
export type Settings = typeof Settings.Type;

export const FileContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    path: RepositoryPath,
    old: Schema.NullOr(Schema.String),
    new: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    path: RepositoryPath,
    oldMediaType: Schema.NullOr(TrimmedNonEmptyString),
    oldBase64: Schema.NullOr(Schema.String),
    newMediaType: Schema.NullOr(TrimmedNonEmptyString),
    newBase64: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("binary"),
    path: RepositoryPath,
    oldSize: Schema.NullOr(NonNegativeInt),
    newSize: Schema.NullOr(NonNegativeInt),
  }),
]);
export type FileContent = typeof FileContent.Type;
