import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  request as rpcRequest,
  requestOnEachSession,
  requestOnEachSessionAndAfter,
  subscribe as rpcSubscribe,
} from "@app/client-runtime/rpc";
import type {
  ClusterId,
  GitHubPrListStreamEvent,
  HarnessSelection,
  HarnessStatus,
  IngestionJob,
  IngestionSource,
  JourneyDocument,
  JourneyId,
  LocalPrState,
  PrRef,
  ReadState,
  RepositoryPath,
  Settings,
  Viewer,
} from "@app/contracts";

import { connectionRuntime } from "./connection.ts";

const EMPTY_LOCAL_PR_STATE: LocalPrState = {
  reviewed: [],
  hidden: [],
  dismissedMerged: [],
};

export interface PullRequestListView {
  readonly ready: boolean;
  readonly sequence: number;
  readonly pullRequests: GitHubPrListStreamEvent["pullRequests"];
  readonly refreshedAt: GitHubPrListStreamEvent["refreshedAt"] | null;
}

export interface IngestionStartRequest {
  readonly id: number;
  readonly source: IngestionSource;
}

export interface IngestionStartAcceptance {
  readonly requestId: number;
  readonly job: IngestionJob;
}

let nextIngestionStartRequestId = 0;

export const makeIngestionStartRequest = (source: IngestionSource): IngestionStartRequest => ({
  id: ++nextIngestionStartRequestId,
  source,
});

export const ownsIngestionStartRequest = (
  requestId: number | null,
  activeRequestId: number | null,
): boolean => requestId !== null && requestId === activeRequestId;

export const acceptedIngestionJobForRequest = (
  requestId: number | null,
  acceptance: IngestionStartAcceptance | null,
): IngestionJob | null =>
  requestId !== null && acceptance?.requestId === requestId ? acceptance.job : null;

export const INITIAL_PULL_REQUEST_LIST: PullRequestListView = {
  ready: false,
  sequence: 0,
  pullRequests: [],
  refreshedAt: null,
};

export const applyPullRequestListEvent = (
  _current: PullRequestListView,
  event: GitHubPrListStreamEvent,
): PullRequestListView => ({
  ready: true,
  sequence: event.sequence,
  pullRequests: event.pullRequests,
  refreshedAt: event.refreshedAt,
});

const viewerResultAtom = connectionRuntime.atom(
  requestOnEachSession(() => rpcRequest("github.viewer", {})),
);

const viewerAtom = Atom.make((get): Viewer | null =>
  Option.getOrNull(AsyncResult.value(get(viewerResultAtom))),
).pipe(Atom.withLabel("github-viewer"));

const pullRequestListResultAtom = connectionRuntime.atom(
  rpcSubscribe("github.prs", {}).pipe(
    Stream.scan(INITIAL_PULL_REQUEST_LIST, applyPullRequestListEvent),
  ),
  { initialValue: INITIAL_PULL_REQUEST_LIST },
);

const pullRequestListAtom = Atom.make(
  (get): PullRequestListView =>
    Option.getOrElse(
      AsyncResult.value(get(pullRequestListResultAtom)),
      () => INITIAL_PULL_REQUEST_LIST,
    ),
).pipe(Atom.withLabel("github-pull-requests"));

const localPrStateValueAtom = Atom.make<LocalPrState>(EMPTY_LOCAL_PR_STATE);
const localPrStateSyncResultAtom = connectionRuntime.atom((get) =>
  requestOnEachSession(() => rpcRequest("prState.get", {})).pipe(
    Stream.tap((state) => Effect.sync(() => get.set(localPrStateValueAtom, state))),
  ),
);
const localPrStateAtom = Atom.make((get): LocalPrState => {
  get(localPrStateSyncResultAtom);
  return get(localPrStateValueAtom);
}).pipe(Atom.withLabel("local-pr-state"));

const settingsValueAtom = Atom.make<Settings>({});
const settingsSyncResultAtom = connectionRuntime.atom((get) =>
  requestOnEachSession(() => rpcRequest("settings.get", {})).pipe(
    Stream.tap((settings) => Effect.sync(() => get.set(settingsValueAtom, settings))),
  ),
);
const settingsAtom = Atom.make((get): Settings => {
  get(settingsSyncResultAtom);
  return get(settingsValueAtom);
}).pipe(Atom.withLabel("settings"));

const harnessStatusResultAtom = connectionRuntime.atom(
  requestOnEachSession(() => rpcRequest("harness.status", {})),
);
const harnessesAtom = Atom.make(
  (get): ReadonlyArray<HarnessStatus> =>
    Option.match(AsyncResult.value(get(harnessStatusResultAtom)), {
      onNone: () => [],
      onSome: (result) => result.harnesses,
    }),
).pipe(Atom.withLabel("harness-statuses"));

const refreshPullRequestsAtom = connectionRuntime.fn(() => rpcRequest("github.refreshPrs", {}));
const refreshHarnessesAtom = connectionRuntime.fn((_input: void, get) =>
  Effect.sync(() => get.refresh(harnessStatusResultAtom)),
);
const retryGitHubAtom = connectionRuntime.fn((_input: void, get) =>
  rpcRequest("github.retry", {}).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        get.refresh(viewerResultAtom);
        get.refresh(pullRequestListResultAtom);
      }),
    ),
  ),
);
const activeIngestionStartRequestIdAtom = Atom.make<number | null>(null);
const startIngestionAtom = connectionRuntime.fn((request: IngestionStartRequest, get) =>
  Effect.sync(() => get.set(activeIngestionStartRequestIdAtom, request.id)).pipe(
    Effect.andThen(rpcRequest("ingestion.start", { source: request.source })),
    Effect.map(
      (job): IngestionStartAcceptance => ({
        requestId: request.id,
        job,
      }),
    ),
  ),
);
const cancelIngestionAtom = connectionRuntime.fn((jobId: IngestionJob["id"]) =>
  rpcRequest("ingestion.cancel", { jobId }),
);

const setReviewedAtom = connectionRuntime.fn(
  (input: { readonly pr: PrRef; readonly active: boolean }, get) =>
    rpcRequest("prState.reviewed", input).pipe(
      Effect.tap((state) => Effect.sync(() => get.set(localPrStateValueAtom, state))),
    ),
);
const setHiddenAtom = connectionRuntime.fn(
  (input: { readonly pr: PrRef; readonly active: boolean }, get) =>
    rpcRequest("prState.hide", input).pipe(
      Effect.tap((state) => Effect.sync(() => get.set(localPrStateValueAtom, state))),
    ),
);
const setDismissedMergedAtom = connectionRuntime.fn(
  (input: { readonly pr: PrRef; readonly active: boolean }, get) =>
    rpcRequest("prState.dismissMerged", input).pipe(
      Effect.tap((state) => Effect.sync(() => get.set(localPrStateValueAtom, state))),
    ),
);
const setHarnessAtom = connectionRuntime.fn((harness: HarnessSelection | null, get) =>
  rpcRequest("settings.update", { harness }).pipe(
    Effect.tap((settings) => Effect.sync(() => get.set(settingsValueAtom, settings))),
  ),
);

const prReferences = new Map<string, PrRef>();
const prKey = (pr: PrRef): string => JSON.stringify([pr.owner, pr.repo, pr.number]);
const rememberPr = (pr: PrRef): string => {
  const key = prKey(pr);
  prReferences.set(key, pr);
  return key;
};
const recalledPr = (key: string): PrRef => {
  const pr = prReferences.get(key);
  if (pr === undefined) {
    throw new Error(`Missing memoized PR reference for ${key}.`);
  }
  return pr;
};

interface HydratedValue<A> {
  readonly hydrated: boolean;
  readonly value: A;
}

const unhydrated = <A>(value: A): HydratedValue<A> => ({
  hydrated: false,
  value,
});

const hydrated = <A>(value: A): HydratedValue<A> => ({
  hydrated: true,
  value,
});

const ingestionJobFamily = Atom.family((key: string) => {
  const pr = recalledPr(key);
  const result = connectionRuntime.atom(
    rpcSubscribe("ingestion.subscribe", { pr }).pipe(Stream.map((event) => hydrated(event.job))),
    { initialValue: unhydrated<IngestionJob | null>(null) },
  );
  return {
    result,
    hydrated: Atom.make((get): boolean =>
      Option.match(AsyncResult.value(get(result)), {
        onNone: () => false,
        onSome: (snapshot) => snapshot.hydrated,
      }),
    ).pipe(Atom.withLabel(`ingestion-hydrated:${key}`)),
    value: Atom.make((get): IngestionJob | null =>
      Option.match(AsyncResult.value(get(result)), {
        onNone: () => null,
        onSome: (snapshot) => snapshot.value,
      }),
    ).pipe(Atom.withLabel(`ingestion:${key}`)),
  } as const;
});

const journeyDocumentFamily = Atom.family((key: string) => {
  const pr = recalledPr(key);
  const getJourney = () =>
    rpcRequest("journey.get", { pr }).pipe(
      Effect.map((document): JourneyDocument | null => document),
      Effect.catchTag("JourneyNotFoundError", () => Effect.succeed(null)),
    );
  const afterCompletion = rpcSubscribe("ingestion.subscribe", { pr }).pipe(
    Stream.filter((event) => event.type === "updated" && event.job.phase === "complete"),
  );
  const result = connectionRuntime.atom(
    requestOnEachSessionAndAfter(afterCompletion, getJourney).pipe(Stream.map(hydrated)),
    { initialValue: unhydrated<JourneyDocument | null>(null) },
  );
  return {
    result,
    hydrated: Atom.make((get): boolean =>
      Option.match(AsyncResult.value(get(result)), {
        onNone: () => false,
        onSome: (snapshot) => snapshot.hydrated,
      }),
    ).pipe(Atom.withLabel(`journey-hydrated:${key}`)),
    value: Atom.make((get): JourneyDocument | null =>
      Option.match(AsyncResult.value(get(result)), {
        onNone: () => null,
        onSome: (snapshot) => snapshot.value,
      }),
    ).pipe(Atom.withLabel(`journey:${key}`)),
  } as const;
});
const refreshJourneyDocumentAtom = connectionRuntime.fn((pr: PrRef, get) =>
  Effect.sync(() => get.refresh(journeyDocumentFamily(rememberPr(pr)).result)),
);

const readStateFamily = Atom.family((journeyId: JourneyId) => {
  const state = Atom.make<ReadState | null>(null);
  const result = connectionRuntime.atom((get) =>
    rpcSubscribe("readState.subscribe", { journeyId }).pipe(
      Stream.map((event) => event.state),
      Stream.tap((readState) => Effect.sync(() => get.set(state, readState))),
    ),
  );
  return {
    result,
    state,
    value: Atom.make((get): ReadState | null => {
      get(result);
      return get(state);
    }).pipe(Atom.withLabel(`read-state:${journeyId}`)),
  } as const;
});

interface JourneyFileKey {
  readonly journeyId: JourneyId;
  readonly path: RepositoryPath;
}

const fileInputs = new Map<string, JourneyFileKey>();
const rememberFile = (input: JourneyFileKey): string => {
  const key = JSON.stringify([input.journeyId, input.path]);
  fileInputs.set(key, input);
  return key;
};
const recalledFile = (key: string): JourneyFileKey => {
  const input = fileInputs.get(key);
  if (input === undefined) {
    throw new Error(`Missing memoized journey file for ${key}.`);
  }
  return input;
};

const filePatchFamily = Atom.family((key: string) => {
  const input = recalledFile(key);
  return connectionRuntime.atom(requestOnEachSession(() => rpcRequest("journey.filePatch", input)));
});
const fileContentFamily = Atom.family((key: string) => {
  const input = recalledFile(key);
  return connectionRuntime.atom(
    requestOnEachSession(() => rpcRequest("journey.fileContent", input)),
  );
});
const treeFamily = Atom.family((journeyId: JourneyId) =>
  connectionRuntime.atom(requestOnEachSession(() => rpcRequest("journey.tree", { journeyId }))),
);

export interface ReadMarkInput {
  readonly journeyId: JourneyId;
  readonly clusterId: ClusterId;
  readonly path: RepositoryPath;
}

const sameReadMark = (mark: ReadState["readFiles"][number], input: ReadMarkInput): boolean =>
  mark.clusterId === input.clusterId && mark.path === input.path;

export const applyOptimisticReadMark = (
  state: ReadState,
  input: ReadMarkInput,
  read: boolean,
): ReadState => {
  const withoutMark = state.readFiles.filter((mark) => !sameReadMark(mark, input));
  return {
    ...state,
    readFiles: read
      ? [...withoutMark, { clusterId: input.clusterId, path: input.path }]
      : withoutMark,
  };
};

const mutateReadState = (input: ReadMarkInput, read: boolean, get: Atom.FnContext) => {
  const family = readStateFamily(input.journeyId);
  const previous = get(family.state);
  const optimistic = previous === null ? null : applyOptimisticReadMark(previous, input, read);

  if (optimistic !== null) {
    get.set(family.state, optimistic);
  }

  const request = read
    ? rpcRequest("readState.markFile", input)
    : rpcRequest("readState.unmarkFile", input);

  return request.pipe(
    Effect.tap((confirmed) =>
      Effect.sync(() => {
        if (optimistic === null || get(family.state) === optimistic) {
          get.set(family.state, confirmed);
        }
      }),
    ),
    Effect.tapError(() =>
      Effect.sync(() => {
        if (optimistic !== null && get(family.state) === optimistic) {
          get.set(family.state, previous);
        }
      }),
    ),
  );
};

const markReadAtom = connectionRuntime.fn((input: ReadMarkInput, get) =>
  mutateReadState(input, true, get),
);
const unmarkReadAtom = connectionRuntime.fn((input: ReadMarkInput, get) =>
  mutateReadState(input, false, get),
);
const setDisplayModeAtom = connectionRuntime.fn(
  (input: { readonly journeyId: JourneyId; readonly displayMode: ReadState["displayMode"] }) =>
    rpcRequest("readState.setDisplayMode", input),
);

export const productAtoms = {
  viewer: viewerAtom,
  viewerResult: viewerResultAtom,
  pullRequestList: pullRequestListAtom,
  pullRequestListResult: pullRequestListResultAtom,
  localPrState: localPrStateAtom,
  localPrStateSyncResult: localPrStateSyncResultAtom,
  settings: settingsAtom,
  settingsSyncResult: settingsSyncResultAtom,
  harnesses: harnessesAtom,
  harnessStatusResult: harnessStatusResultAtom,
  refreshHarnesses: refreshHarnessesAtom,
  refreshPullRequests: refreshPullRequestsAtom,
  retryGitHub: retryGitHubAtom,
  startIngestion: startIngestionAtom,
  activeIngestionStartRequestId: activeIngestionStartRequestIdAtom,
  cancelIngestion: cancelIngestionAtom,
  setReviewed: setReviewedAtom,
  setHidden: setHiddenAtom,
  setDismissedMerged: setDismissedMergedAtom,
  setHarness: setHarnessAtom,
  ingestionJob: (pr: PrRef) => ingestionJobFamily(rememberPr(pr)),
  journeyDocument: (pr: PrRef) => journeyDocumentFamily(rememberPr(pr)),
  refreshJourneyDocument: refreshJourneyDocumentAtom,
  readState: (journeyId: JourneyId) => readStateFamily(journeyId),
  filePatch: (input: JourneyFileKey) => filePatchFamily(rememberFile(input)),
  fileContent: (input: JourneyFileKey) => fileContentFamily(rememberFile(input)),
  tree: (journeyId: JourneyId) => treeFamily(journeyId),
  markRead: markReadAtom,
  unmarkRead: unmarkReadAtom,
  setDisplayMode: setDisplayModeAtom,
} as const;
