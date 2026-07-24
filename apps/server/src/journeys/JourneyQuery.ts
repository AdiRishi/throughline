import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  JourneyFileNotFoundError,
  JourneyNotFoundError,
  type FileContent,
  type GitHubParkedError,
  type GitHubReadError,
  type JourneyDocument,
  type JourneyFilePatch,
  type JourneyId,
  type JourneyTree,
  type PrRef,
  type RepositoryPath,
} from "@app/contracts";

import * as GitHub from "../github/GitHub.ts";
import * as Workspaces from "../workspace/Workspaces.ts";
import * as JourneyStore from "./JourneyStore.ts";
import { derivePullRequestJourneyState } from "./journeyView.ts";

export type JourneyQueryGetError =
  | JourneyNotFoundError
  | JourneyStore.JourneyStoreError
  | GitHubReadError
  | GitHubParkedError;

export type JourneyQueryArtifactError =
  | JourneyNotFoundError
  | JourneyStore.JourneyStoreError
  | Workspaces.WorkspaceError;

export type JourneyQueryFileError = JourneyFileNotFoundError | JourneyQueryArtifactError;

export type JourneyQueryError = JourneyQueryGetError | JourneyQueryFileError;

export class JourneyQuery extends Context.Service<
  JourneyQuery,
  {
    readonly get: (pr: PrRef) => Effect.Effect<JourneyDocument, JourneyQueryGetError>;
    readonly filePatch: (
      journeyId: JourneyId,
      path: RepositoryPath,
    ) => Effect.Effect<JourneyFilePatch, JourneyQueryFileError>;
    readonly fileContent: (
      journeyId: JourneyId,
      path: RepositoryPath,
    ) => Effect.Effect<FileContent, JourneyQueryFileError>;
    readonly tree: (journeyId: JourneyId) => Effect.Effect<JourneyTree, JourneyQueryArtifactError>;
  }
>()("@app/server/journeys/JourneyQuery") {}

const samePr = (left: PrRef, right: PrRef): boolean =>
  left.owner === right.owner && left.repo === right.repo && left.number === right.number;

export const make = Effect.gen(function* () {
  const store = yield* JourneyStore.JourneyStore;
  const github = yield* GitHub.GitHub;
  const workspaces = yield* Workspaces.Workspaces;

  const requireByPr = (pr: PrRef) =>
    store.getByPr(pr).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new JourneyNotFoundError({ pr }),
          onSome: (stored) =>
            samePr(stored.journey.pr, pr)
              ? Effect.succeed(stored)
              : new JourneyNotFoundError({ pr }),
        }),
      ),
    );

  const requireById = (journeyId: JourneyId) =>
    store.getById(journeyId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new JourneyNotFoundError({ journeyId }),
          onSome: (stored) =>
            stored.journey.id === journeyId
              ? Effect.succeed(stored)
              : new JourneyNotFoundError({ journeyId }),
        }),
      ),
    );

  const mapTreeError =
    (journeyId: JourneyId) =>
    (error: Workspaces.WorkspaceError): Workspaces.WorkspaceError | JourneyNotFoundError =>
      error.reason === "artifact-not-found" || error.reason === "artifact-corrupt"
        ? new JourneyNotFoundError({ journeyId })
        : error;

  const runFor = (stored: JourneyStore.StoredJourney): Workspaces.WorkspaceRunRef => ({
    pr: stored.journey.pr,
    runId: stored.runId,
  });

  const failFileRead = (
    stored: JourneyStore.StoredJourney,
    path: RepositoryPath,
    error: Workspaces.WorkspaceError,
  ): Effect.Effect<
    never,
    Workspaces.WorkspaceError | JourneyNotFoundError | JourneyFileNotFoundError
  > => {
    if (error.reason === "artifact-corrupt") {
      return Effect.fail(new JourneyNotFoundError({ journeyId: stored.journey.id }));
    }
    if (error.reason !== "artifact-not-found") {
      return Effect.fail(error);
    }
    if (stored.journey.files.some((file) => file.path === path)) {
      return Effect.fail(new JourneyNotFoundError({ journeyId: stored.journey.id }));
    }
    return workspaces.tree(runFor(stored)).pipe(
      Effect.mapError(mapTreeError(stored.journey.id)),
      Effect.flatMap((paths) =>
        Effect.fail(
          paths.includes(path)
            ? new JourneyNotFoundError({ journeyId: stored.journey.id })
            : new JourneyFileNotFoundError({
                journeyId: stored.journey.id,
                path,
              }),
        ),
      ),
    );
  };

  return JourneyQuery.of({
    get: (pr) =>
      Effect.gen(function* () {
        const stored = yield* requireByPr(pr);
        const [pullRequest, readState] = yield* Effect.all(
          [github.pr(stored.journey.pr), store.getReadState(stored.journey.id)],
          { concurrency: 2 },
        );
        if (!samePr(pullRequest.ref, stored.journey.pr)) {
          return yield* new JourneyNotFoundError({ pr });
        }

        return {
          journey: stored.journey,
          pullRequest: {
            ...pullRequest,
            journey: derivePullRequestJourneyState(
              stored.journey,
              Option.getOrNull(readState),
              pullRequest.headSha,
            ),
          },
        };
      }),

    filePatch: (journeyId, path) =>
      Effect.gen(function* () {
        const stored = yield* requireById(journeyId);
        const patch = yield* workspaces
          .filePatch(runFor(stored), path)
          .pipe(Effect.catch((error) => failFileRead(stored, path, error)));
        return { path, patch };
      }),

    fileContent: (journeyId, path) =>
      Effect.gen(function* () {
        const stored = yield* requireById(journeyId);
        return yield* workspaces
          .fileContent(runFor(stored), path)
          .pipe(Effect.catch((error) => failFileRead(stored, path, error)));
      }),

    tree: (journeyId) =>
      Effect.gen(function* () {
        const stored = yield* requireById(journeyId);
        const paths = yield* workspaces
          .tree(runFor(stored))
          .pipe(Effect.mapError(mapTreeError(journeyId)));
        return { paths };
      }),
  });
});

export const layer = Layer.effect(JourneyQuery, make);
