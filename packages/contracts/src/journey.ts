import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const JourneyId = TrimmedNonEmptyString.pipe(Schema.brand("JourneyId"));
export type JourneyId = typeof JourneyId.Type;

export const ClusterId = TrimmedNonEmptyString.pipe(Schema.brand("ClusterId"));
export type ClusterId = typeof ClusterId.Type;

export const HunkId = TrimmedNonEmptyString.pipe(Schema.brand("HunkId"));
export type HunkId = typeof HunkId.Type;

export const HintId = TrimmedNonEmptyString.pipe(Schema.brand("HintId"));
export type HintId = typeof HintId.Type;

export const RepositoryRef = Schema.Struct({
  owner: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  repo: TrimmedNonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
});
export type RepositoryRef = typeof RepositoryRef.Type;

export const PrRef = Schema.Struct({
  owner: RepositoryRef.fields.owner,
  repo: RepositoryRef.fields.repo,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PrRef = typeof PrRef.Type;

export const Narrative = Schema.Struct({
  markdown: Schema.String,
});
export type Narrative = typeof Narrative.Type;

export const Overview = Schema.Struct({
  brief: Narrative,
  whereToBegin: Narrative,
});
export type Overview = typeof Overview.Type;

export const ClusterWeight = Schema.Literals(["core", "supporting", "mechanical"]);
export type ClusterWeight = typeof ClusterWeight.Type;

export const FileLevelKind = Schema.Literals([
  "binary",
  "rename",
  "mode",
  "symlink",
  "submodule",
  "empty",
]);
export type FileLevelKind = typeof FileLevelKind.Type;

export const FileChangeKind = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "mode",
  "symlink",
  "submodule",
  "binary",
]);
export type FileChangeKind = typeof FileChangeKind.Type;

export const Hunk = Schema.Struct({
  id: HunkId,
  path: TrimmedNonEmptyString,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  fileKind: Schema.optionalKey(FileLevelKind),
  seedId: HunkId,
  home: ClusterId,
});
export type Hunk = typeof Hunk.Type;

export const SeedHunk = Schema.Struct({
  id: HunkId,
  path: TrimmedNonEmptyString,
  oldStart: NonNegativeInt,
  oldLines: NonNegativeInt,
  newStart: NonNegativeInt,
  newLines: NonNegativeInt,
  fileKind: Schema.optionalKey(FileLevelKind),
});
export type SeedHunk = typeof SeedHunk.Type;

export const FileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  oldPath: Schema.optionalKey(TrimmedNonEmptyString),
  kind: FileChangeKind,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type FileChange = typeof FileChange.Type;

export const ResurfacedHunk = Schema.Struct({
  hunkId: HunkId,
  note: Narrative,
});
export type ResurfacedHunk = typeof ResurfacedHunk.Type;

export const Cluster = Schema.Struct({
  id: ClusterId,
  position: Schema.Int.check(Schema.isGreaterThan(0)),
  title: TrimmedNonEmptyString,
  weight: ClusterWeight,
  narrative: Narrative,
  mapEntry: Narrative,
  buildsOn: Schema.Array(ClusterId),
  fileOrder: Schema.Array(TrimmedNonEmptyString),
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
  path: TrimmedNonEmptyString,
  side: Schema.Literals(["old", "new"]),
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
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

export const HarnessKind = Schema.Literals(["codex", "claude"]);
export type HarnessKind = typeof HarnessKind.Type;

export const HarnessUsage = Schema.Struct({
  inputTokens: Schema.optionalKey(NonNegativeInt),
  outputTokens: Schema.optionalKey(NonNegativeInt),
});
export type HarnessUsage = typeof HarnessUsage.Type;

export const JourneyProvenance = Schema.Struct({
  harnessKind: HarnessKind,
  model: Schema.optionalKey(TrimmedNonEmptyString),
  usage: Schema.optionalKey(HarnessUsage),
});
export type JourneyProvenance = typeof JourneyProvenance.Type;

export const JourneyPrMetadata = Schema.Struct({
  title: TrimmedNonEmptyString,
  body: Schema.String,
  url: TrimmedNonEmptyString,
  author: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
});
export type JourneyPrMetadata = typeof JourneyPrMetadata.Type;

export const Journey = Schema.Struct({
  formatVersion: Schema.Literal(1),
  id: JourneyId,
  pr: PrRef,
  prMetadata: JourneyPrMetadata,
  pinned: Schema.Struct({
    headSha: TrimmedNonEmptyString,
    baseSha: TrimmedNonEmptyString,
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

export const ReadFile = Schema.Struct({
  clusterId: ClusterId,
  path: TrimmedNonEmptyString,
});
export type ReadFile = typeof ReadFile.Type;

export const ReadState = Schema.Struct({
  journeyId: JourneyId,
  readFiles: Schema.Array(ReadFile),
  displayMode: DisplayMode,
  updatedAt: Schema.DateTimeUtc,
});
export type ReadState = typeof ReadState.Type;

export const ReadStateStreamEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literals(["snapshot", "updated"]),
  state: ReadState,
});
export type ReadStateStreamEvent = typeof ReadStateStreamEvent.Type;

export const FilePatch = Schema.Struct({
  journeyId: JourneyId,
  path: TrimmedNonEmptyString,
  patch: Schema.String,
});
export type FilePatch = typeof FilePatch.Type;

export const FileContent = Schema.Struct({
  journeyId: JourneyId,
  path: TrimmedNonEmptyString,
  oldContent: Schema.NullOr(Schema.String),
  newContent: Schema.NullOr(Schema.String),
  oldEncoding: Schema.Literals(["text", "base64"]),
  newEncoding: Schema.Literals(["text", "base64"]),
});
export type FileContent = typeof FileContent.Type;

export const JourneyFiles = Schema.Struct({
  journeyId: JourneyId,
  patches: Schema.Array(FilePatch),
  contents: Schema.Array(FileContent),
});
export type JourneyFiles = typeof JourneyFiles.Type;

export const TreeEntryKind = Schema.Literals(["file", "directory", "symlink", "submodule"]);
export type TreeEntryKind = typeof TreeEntryKind.Type;

export const TreeEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TreeEntryKind,
});
export type TreeEntry = typeof TreeEntry.Type;

export const JourneyTree = Schema.Struct({
  journeyId: JourneyId,
  entries: Schema.Array(TreeEntry),
});
export type JourneyTree = typeof JourneyTree.Type;

export class JourneyNotFoundError extends Schema.TaggedErrorClass<JourneyNotFoundError>()(
  "JourneyNotFoundError",
  { pr: Schema.optionalKey(PrRef), journeyId: Schema.optionalKey(JourneyId) },
) {
  override get message(): string {
    return "No journey exists for this pull request.";
  }
}

export class JourneyFileNotFoundError extends Schema.TaggedErrorClass<JourneyFileNotFoundError>()(
  "JourneyFileNotFoundError",
  { journeyId: JourneyId, path: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `No pinned file exists at ${this.path}.`;
  }
}
