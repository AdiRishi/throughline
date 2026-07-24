import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import {
  CommitSha,
  GitHubReadError,
  Journey,
  JourneyFileNotFoundError,
  JourneyId,
  JourneyNotFoundError,
  PrDetail,
  RepositoryPath,
  TrimmedNonEmptyString,
  type FileContent,
  type PrRef,
} from "@app/contracts";

import * as GitHub from "../../src/github/GitHub.ts";
import * as JourneyQuery from "../../src/journeys/JourneyQuery.ts";
import * as JourneyStore from "../../src/journeys/JourneyStore.ts";
import * as Workspaces from "../../src/workspace/Workspaces.ts";

const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));
const decodeJourneyId = Schema.decodeUnknownSync(JourneyId);
const decodeCommitSha = Schema.decodeUnknownSync(CommitSha);
const decodePrDetail = Schema.decodeUnknownSync(Schema.toCodecJson(PrDetail));
const decodeRepositoryPath = Schema.decodeUnknownSync(RepositoryPath);
const decodeTrimmedString = Schema.decodeUnknownSync(TrimmedNonEmptyString);

const journey = decodeJourney({
  formatVersion: 1,
  id: "journey-query-fixture",
  pr: {
    owner: "effect-ts",
    repo: "throughline-fixture",
    number: 42,
  },
  pinned: {
    headSha: "2222222222222222222222222222222222222222",
    baseSha: "1111111111111111111111111111111111111111",
    analyzedAt: "2026-07-20T00:00:00.000Z",
  },
  provenance: {
    harnessKind: "codex",
  },
  overview: {
    brief: { markdown: "This PR introduces a focused behavior." },
    whereToBegin: { markdown: "Begin with the core cluster." },
  },
  clusters: [
    {
      id: "core",
      position: 1,
      title: "Core behavior",
      weight: "core",
      narrative: { markdown: "The behavior under review." },
      mapEntry: { markdown: "Introduces the behavior." },
      buildsOn: [],
      fileOrder: ["src/first.ts", "src/second.ts"],
      resurfaced: [],
    },
  ],
  hunks: [
    {
      id: "h1",
      seedId: "s1",
      path: "src/first.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      home: "core",
    },
    {
      id: "h2",
      seedId: "s2",
      path: "src/second.ts",
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      home: "core",
    },
  ],
  files: [
    {
      path: "src/first.ts",
      oldPath: null,
      kind: "modified",
      oldMode: null,
      newMode: null,
      binary: false,
      additions: 1,
      deletions: 1,
    },
    {
      path: "src/second.ts",
      oldPath: null,
      kind: "added",
      oldMode: null,
      newMode: null,
      binary: false,
      additions: 1,
      deletions: 0,
    },
  ],
  hints: [],
});

const missingJourneyId = decodeJourneyId("journey-query-missing");
const unchangedPath = decodeRepositoryPath("README.md");

const pullRequest = (headSha: string, ref: PrRef = journey.pr): PrDetail =>
  decodePrDetail({
    ref,
    title: "Build the query seam",
    author: {
      login: "reviewer",
      avatarUrl: null,
    },
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    state: "open",
    baseRefName: "main",
    headSha,
    updatedAt: "2026-07-24T12:00:00.000Z",
    mergedAt: null,
    changedFiles: 2,
    additions: 2,
    deletions: 1,
    journey: null,
    body: "The current pull request body.",
    baseSha: "1111111111111111111111111111111111111111",
  });

const unused = <A>(): Effect.Effect<A> => Effect.die("Unexpected test collaborator call.");

const makeGitHub = (
  readPr: (ref: PrRef) => Effect.Effect<PrDetail, GitHubReadError>,
): GitHub.GitHub["Service"] =>
  GitHub.GitHub.of({
    identity: () => unused(),
    repositories: () => unused(),
    pullRequests: () => unused(),
    openPrs: () => unused(),
    recentlyMergedPrs: () => unused(),
    pr: readPr,
    refreshPrs: () => unused(),
    retry: () => unused(),
    resolveUrl: () => unused(),
    cloneCredentials: () => unused(),
  });

interface WorkspaceReads {
  readonly filePatch?: Workspaces.Workspaces["Service"]["filePatch"];
  readonly fileContent?: Workspaces.Workspaces["Service"]["fileContent"];
  readonly tree?: Workspaces.Workspaces["Service"]["tree"];
}

const makeWorkspaces = (reads: WorkspaceReads = {}): Workspaces.Workspaces["Service"] =>
  Workspaces.Workspaces.of({
    prepare: () => unused(),
    finalize: () => unused(),
    abandon: () => unused(),
    reapFailedRuns: () => unused(),
    filePatch: reads.filePatch ?? (() => unused()),
    fileContent: reads.fileContent ?? (() => unused()),
    tree: reads.tree ?? (() => unused()),
    evictCache: () => unused(),
    removeRun: () => unused(),
  });

const temporaryDatabase = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "throughline-journey-query-",
  });
  return `${directory}/throughline.db`;
});

const withQuery = <A, E, R>(
  filename: string,
  github: GitHub.GitHub["Service"],
  workspaces: Workspaces.Workspaces["Service"],
  use: (
    query: JourneyQuery.JourneyQuery["Service"],
    store: JourneyStore.JourneyStore["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* JourneyStore.JourneyStore;
    const query = yield* JourneyQuery.make;
    return yield* use(query, store);
  }).pipe(
    Effect.provideService(GitHub.GitHub, github),
    Effect.provideService(Workspaces.Workspaces, workspaces),
    Effect.provide(JourneyStore.layerAt(filename)),
  );

it.layer(NodeServices.layer)("JourneyQuery", (it) => {
  it.effect("returns contract errors for missing journeys, ids, and files", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      let githubCalled = false;
      const fileMissing = new Workspaces.WorkspaceError({
        reason: "artifact-not-found",
        detail: "The requested path is not in the immutable run.",
      });
      const workspaces = makeWorkspaces({
        filePatch: () => Effect.fail(fileMissing),
        fileContent: () => Effect.fail(fileMissing),
        tree: () => Effect.succeed([]),
      });

      yield* withQuery(
        filename,
        makeGitHub(() => {
          githubCalled = true;
          return Effect.succeed(pullRequest(journey.pinned.headSha));
        }),
        workspaces,
        (query, store) =>
          Effect.gen(function* () {
            const missingByPr = yield* query.get(journey.pr).pipe(Effect.flip);
            assert.instanceOf(missingByPr, JourneyNotFoundError);
            assert.deepStrictEqual(missingByPr.pr, journey.pr);
            assert.isFalse(githubCalled);

            const missingById = yield* query.tree(missingJourneyId).pipe(Effect.flip);
            assert.instanceOf(missingById, JourneyNotFoundError);
            assert.strictEqual(missingById.journeyId, missingJourneyId);

            yield* store.replace({ journey, runId: "immutable-run" });
            const missingPatch = yield* query
              .filePatch(journey.id, unchangedPath)
              .pipe(Effect.flip);
            const missingContent = yield* query
              .fileContent(journey.id, unchangedPath)
              .pipe(Effect.flip);

            assert.instanceOf(missingPatch, JourneyFileNotFoundError);
            assert.deepStrictEqual(
              {
                journeyId: missingPatch.journeyId,
                path: missingPatch.path,
              },
              {
                journeyId: journey.id,
                path: unchangedPath,
              },
            );
            assert.instanceOf(missingContent, JourneyFileNotFoundError);
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("delegates every artifact read through the immutable stored run", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      const calls: Array<{
        readonly operation: "patch" | "content" | "tree";
        readonly run: Workspaces.WorkspaceRunRef;
        readonly path?: string;
      }> = [];
      const content: FileContent = {
        type: "text",
        path: journey.files[0]!.path,
        old: "before\n",
        new: "after\n",
      };
      const workspaces = makeWorkspaces({
        filePatch: (run, path) =>
          Effect.sync(() => {
            calls.push({ operation: "patch", run, path });
            return "diff --git a/src/first.ts b/src/first.ts\n";
          }),
        fileContent: (run, path) =>
          Effect.sync(() => {
            calls.push({ operation: "content", run, path });
            return content;
          }),
        tree: (run) =>
          Effect.sync(() => {
            calls.push({ operation: "tree", run });
            return [unchangedPath, ...journey.files.map((file) => file.path)];
          }),
      });

      yield* withQuery(
        filename,
        makeGitHub(() => Effect.succeed(pullRequest(journey.pinned.headSha))),
        workspaces,
        (query, store) =>
          Effect.gen(function* () {
            yield* store.replace({ journey, runId: "immutable-run" });

            assert.deepStrictEqual(yield* query.filePatch(journey.id, journey.files[0]!.path), {
              path: journey.files[0]!.path,
              patch: "diff --git a/src/first.ts b/src/first.ts\n",
            });
            assert.deepStrictEqual(
              yield* query.fileContent(journey.id, journey.files[0]!.path),
              content,
            );
            assert.deepStrictEqual(yield* query.tree(journey.id), {
              paths: [unchangedPath, ...journey.files.map((file) => file.path)],
            });

            assert.deepStrictEqual(
              calls.map(({ operation, path, run }) => ({
                operation,
                path,
                run,
              })),
              [
                {
                  operation: "patch",
                  path: journey.files[0]!.path,
                  run: { pr: journey.pr, runId: "immutable-run" },
                },
                {
                  operation: "content",
                  path: journey.files[0]!.path,
                  run: { pr: journey.pr, runId: "immutable-run" },
                },
                {
                  operation: "tree",
                  path: undefined,
                  run: { pr: journey.pr, runId: "immutable-run" },
                },
              ],
            );
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("enriches current PR detail with fresh and stale journey progress", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      let currentHead = journey.pinned.headSha;
      const requestedRefs: PrRef[] = [];

      yield* withQuery(
        filename,
        makeGitHub((ref) =>
          Effect.sync(() => {
            requestedRefs.push(ref);
            return pullRequest(currentHead);
          }),
        ),
        makeWorkspaces(),
        (query, store) =>
          Effect.gen(function* () {
            yield* store.replace({ journey, runId: "immutable-run" });
            yield* store.setReadMark(
              journey.id,
              {
                clusterId: journey.clusters[0]!.id,
                path: journey.files[0]!.path,
              },
              true,
            );

            const fresh = yield* query.get(journey.pr);
            assert.strictEqual(fresh.journey.id, journey.id);
            assert.deepStrictEqual(fresh.pullRequest.journey, {
              journeyId: journey.id,
              progress: 0.5,
              markedFiles: 1,
              clusterFiles: 2,
              stale: false,
              pinnedHeadSha: journey.pinned.headSha,
            });

            currentHead = decodeCommitSha("3333333333333333333333333333333333333333");
            const stale = yield* query.get(journey.pr);
            assert.strictEqual(stale.pullRequest.headSha, currentHead);
            assert.deepStrictEqual(stale.pullRequest.journey, {
              journeyId: journey.id,
              progress: 0.5,
              markedFiles: 1,
              clusterFiles: 2,
              stale: true,
              pinnedHeadSha: journey.pinned.headSha,
            });
            assert.deepStrictEqual(requestedRefs, [journey.pr, journey.pr]);
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a current PR response with a different canonical identity", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      const differentPr = {
        owner: journey.pr.owner,
        repo: "renamed-repository",
        number: journey.pr.number,
      } as PrRef;

      yield* withQuery(
        filename,
        makeGitHub(() => Effect.succeed(pullRequest(journey.pinned.headSha, differentPr))),
        makeWorkspaces(),
        (query, store) =>
          Effect.gen(function* () {
            yield* store.replace({ journey, runId: "immutable-run" });
            const error = yield* query.get(journey.pr).pipe(Effect.flip);

            assert.instanceOf(error, JourneyNotFoundError);
            assert.deepStrictEqual(error.pr, journey.pr);
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("maps corrupt run artifacts while preserving operational workspace failures", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      const corrupt = new Workspaces.WorkspaceError({
        reason: "artifact-corrupt",
        detail: "tree.json did not match its schema.",
      });
      const missingArtifact = new Workspaces.WorkspaceError({
        reason: "artifact-not-found",
        detail: "The immutable patch artifact is missing.",
      });
      const operational = new Workspaces.WorkspaceError({
        reason: "io",
        detail: "The run directory could not be read.",
      });
      const workspaces = makeWorkspaces({
        filePatch: () => Effect.fail(missingArtifact),
        fileContent: () => Effect.fail(corrupt),
        tree: () => Effect.fail(operational),
      });

      yield* withQuery(
        filename,
        makeGitHub(() => Effect.succeed(pullRequest(journey.pinned.headSha))),
        workspaces,
        (query, store) =>
          Effect.gen(function* () {
            yield* store.replace({ journey, runId: "immutable-run" });

            const missingArtifactError = yield* query
              .filePatch(journey.id, journey.files[0]!.path)
              .pipe(Effect.flip);
            assert.instanceOf(missingArtifactError, JourneyNotFoundError);
            assert.strictEqual(missingArtifactError.journeyId, journey.id);

            const corruptError = yield* query
              .fileContent(journey.id, journey.files[0]!.path)
              .pipe(Effect.flip);
            assert.instanceOf(corruptError, JourneyNotFoundError);
            assert.strictEqual(corruptError.journeyId, journey.id);

            const operationalError = yield* query.tree(journey.id).pipe(Effect.flip);
            assert.strictEqual(operationalError, operational);
          }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("preserves GitHub failures from the current PR lookup", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;
      const failure = new GitHubReadError({
        reason: "transport",
        detail: decodeTrimmedString("GitHub could not be reached."),
      });

      yield* withQuery(
        filename,
        makeGitHub(() => Effect.fail(failure)),
        makeWorkspaces(),
        (query, store) =>
          Effect.gen(function* () {
            yield* store.replace({ journey, runId: "immutable-run" });
            const error = yield* query.get(journey.pr).pipe(Effect.flip);
            assert.strictEqual(error, failure);
          }),
      );
    }).pipe(Effect.scoped),
  );
});
