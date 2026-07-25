import * as Schema from "effect/Schema";

import {
  CommitSha,
  FileChange,
  NonNegativeInt,
  PrDetail,
  RepositoryPath,
  SeedHunk,
} from "@app/contracts";

const ArtifactFileName = Schema.String.check(Schema.isPattern(/^f[0-9]{6}\.(?:old|new)$/u));

export const RunDocument = Schema.Struct({
  version: Schema.Literal(1),
  pullRequest: Schema.toCodecJson(PrDetail),
  runId: Schema.String,
  baseSha: CommitSha,
  headSha: CommitSha,
});
export type RunDocument = typeof RunDocument.Type;

export const FilesDocument = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(FileChange),
});
export type FilesDocument = typeof FilesDocument.Type;

export const HunksDocument = Schema.Struct({
  version: Schema.Literal(1),
  hunks: Schema.Array(SeedHunk),
});
export type HunksDocument = typeof HunksDocument.Type;

export const TreeDocument = Schema.Struct({
  version: Schema.Literal(1),
  paths: Schema.Array(RepositoryPath),
});
export type TreeDocument = typeof TreeDocument.Type;

export const PatchManifestEntry = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^f[0-9]{6}$/u)),
  path: RepositoryPath,
  oldPath: Schema.NullOr(RepositoryPath),
  patchFile: Schema.String.check(Schema.isPattern(/^diff\/by-file\/f[0-9]{6}\.patch$/u)),
});
export type PatchManifestEntry = typeof PatchManifestEntry.Type;

export const PatchManifestDocument = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(PatchManifestEntry),
});
export type PatchManifestDocument = typeof PatchManifestDocument.Type;

const TextContentManifestEntry = Schema.Struct({
  type: Schema.Literal("text"),
  path: RepositoryPath,
  oldFile: Schema.NullOr(ArtifactFileName),
  newFile: Schema.NullOr(ArtifactFileName),
});

const ImageContentManifestEntry = Schema.Struct({
  type: Schema.Literal("image"),
  path: RepositoryPath,
  oldFile: Schema.NullOr(ArtifactFileName),
  oldMediaType: Schema.NullOr(Schema.String),
  newFile: Schema.NullOr(ArtifactFileName),
  newMediaType: Schema.NullOr(Schema.String),
});

const BinaryContentManifestEntry = Schema.Struct({
  type: Schema.Literal("binary"),
  path: RepositoryPath,
  oldSize: Schema.NullOr(NonNegativeInt),
  newSize: Schema.NullOr(NonNegativeInt),
});

export const ContentManifestEntry = Schema.Union([
  TextContentManifestEntry,
  ImageContentManifestEntry,
  BinaryContentManifestEntry,
]);
export type ContentManifestEntry = typeof ContentManifestEntry.Type;

export const ContentManifestDocument = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(ContentManifestEntry),
});
export type ContentManifestDocument = typeof ContentManifestDocument.Type;

export const decodeRunDocument = Schema.decodeUnknownEffect(RunDocument);
export const decodeTreeDocument = Schema.decodeUnknownEffect(TreeDocument);
export const decodePatchManifestDocument = Schema.decodeUnknownEffect(PatchManifestDocument);
export const decodeContentManifestDocument = Schema.decodeUnknownEffect(ContentManifestDocument);
