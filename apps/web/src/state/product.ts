import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { ConnectionSupervisor as ConnectionSupervisorService } from "@app/client-runtime/connection";
import { ConnectionSupervisor } from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type {
  GitHubPrsStreamEvent,
  IngestionJob,
  IngestionStreamEvent,
  ClusterId,
  JourneyId,
  PrRef,
  PullRequestSummary,
} from "@app/contracts";

import { connectionRuntime } from "./connection.ts";

function requestForEachSession<A, E>(
  request: Effect.Effect<A, E, ConnectionSupervisorService>,
): Stream.Stream<A, E, ConnectionSupervisorService> {
  return Stream.unwrap(
    ConnectionSupervisor.pipe(
      Effect.map((supervisor) =>
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.switchMap(
            Option.match({
              onNone: () => Stream.empty,
              onSome: () => Stream.fromEffect(request),
            }),
          ),
        ),
      ),
    ),
  );
}

export interface PullRequestView {
  readonly ready: boolean;
  readonly sequence: number;
  readonly pullRequests: ReadonlyArray<PullRequestSummary>;
}

const INITIAL_PULL_REQUESTS: PullRequestView = {
  ready: false,
  sequence: 0,
  pullRequests: [],
};

export function applyPullRequestEvent(
  _: PullRequestView,
  event: GitHubPrsStreamEvent,
): PullRequestView {
  return {
    ready: true,
    sequence: event.sequence,
    pullRequests: event.pullRequests,
  };
}

export interface IngestionView {
  readonly ready: boolean;
  readonly sequence: number;
  readonly jobs: ReadonlyArray<IngestionJob>;
}

const INITIAL_INGESTION: IngestionView = {
  ready: false,
  sequence: 0,
  jobs: [],
};

export function applyIngestionEvent(_: IngestionView, event: IngestionStreamEvent): IngestionView {
  return {
    ready: true,
    sequence: event.sequence,
    jobs: event.jobs,
  };
}

const pullRequestsResult = connectionRuntime.atom(
  rpcSubscribe("github.subscribePrs", {}).pipe(
    Stream.scan(INITIAL_PULL_REQUESTS, applyPullRequestEvent),
  ),
);
const pullRequests = Atom.make(
  (get): PullRequestView =>
    Option.getOrElse(AsyncResult.value(get(pullRequestsResult)), () => INITIAL_PULL_REQUESTS),
);

const ingestionResult = connectionRuntime.atom(
  rpcSubscribe("ingestion.subscribe", {}).pipe(Stream.scan(INITIAL_INGESTION, applyIngestionEvent)),
);
const ingestion = Atom.make(
  (get): IngestionView =>
    Option.getOrElse(AsyncResult.value(get(ingestionResult)), () => INITIAL_INGESTION),
);

const readState = Atom.family((journeyId: JourneyId) =>
  connectionRuntime.atom(
    rpcSubscribe("readState.subscribe", { journeyId }).pipe(Stream.map((event) => event.state)),
  ),
);

export const productAtoms = {
  pullRequests,
  ingestion,
  readState,
  viewer: connectionRuntime.atom(requestForEachSession(rpcRequest("github.viewer", {}))),
  prState: connectionRuntime.atom(requestForEachSession(rpcRequest("prState.get", {}))),
  harnesses: connectionRuntime.atom(requestForEachSession(rpcRequest("harness.status", {}))),
  settings: connectionRuntime.atom(requestForEachSession(rpcRequest("settings.get", {}))),
  refreshPullRequests: connectionRuntime.fn(() => rpcRequest("github.prs", { refresh: true })),
  startIngestion: connectionRuntime.fn((input: { readonly pr: PrRef } | { readonly url: string }) =>
    rpcRequest("ingestion.start", input),
  ),
  cancelIngestion: connectionRuntime.fn((id: IngestionJob["id"]) =>
    rpcRequest("ingestion.cancel", { id }),
  ),
  loadJourney: connectionRuntime.fn((pr: PrRef) => rpcRequest("journey.get", { pr })),
  loadFilePatch: connectionRuntime.fn(
    (input: { readonly journeyId: JourneyId; readonly path: string }) =>
      rpcRequest("journey.filePatch", input),
  ),
  loadFileContent: connectionRuntime.fn(
    (input: { readonly journeyId: JourneyId; readonly path: string }) =>
      rpcRequest("journey.fileContent", input),
  ),
  loadFiles: connectionRuntime.fn(
    (input: { readonly journeyId: JourneyId; readonly paths: ReadonlyArray<string> }) =>
      rpcRequest("journey.files", input),
  ),
  loadTree: connectionRuntime.fn((journeyId: JourneyId) =>
    rpcRequest("journey.tree", { journeyId }),
  ),
  loadReadState: connectionRuntime.fn((journeyId: JourneyId) =>
    rpcRequest("readState.get", { journeyId }),
  ),
  markFile: connectionRuntime.fn(
    (input: {
      readonly journeyId: JourneyId;
      readonly clusterId: ClusterId;
      readonly path: string;
      readonly read: boolean;
    }) =>
      input.read
        ? rpcRequest("readState.markFile", input)
        : rpcRequest("readState.unmarkFile", input),
  ),
  setDisplayMode: connectionRuntime.fn(
    (input: {
      readonly journeyId: JourneyId;
      readonly displayMode: "inline" | "just-the-code" | "split";
    }) => rpcRequest("readState.setDisplayMode", input),
  ),
  updatePrState: connectionRuntime.fn(
    (input: {
      readonly kind: "reviewed" | "hidden" | "dismissedMerged";
      readonly pr: PrRef;
      readonly value: boolean;
    }) => {
      const action = { pr: input.pr, value: input.value };
      switch (input.kind) {
        case "reviewed":
          return rpcRequest("prState.reviewed", action);
        case "hidden":
          return rpcRequest("prState.hide", action);
        case "dismissedMerged":
          return rpcRequest("prState.dismissMerged", action);
      }
    },
  ),
  updateSettings: connectionRuntime.fn((input: { readonly harness?: "codex" | "claude" }) =>
    rpcRequest("settings.update", input),
  ),
} as const;
