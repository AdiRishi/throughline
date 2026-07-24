import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  type GitHubParkedError,
  type GitHubPrListSnapshotEvent,
  type GitHubPrListStreamEvent,
  type GitHubPrListUpdatedEvent,
  type GitHubReadError,
  type PrRef,
  type PrSummary,
} from "@app/contracts";

import * as GitHub from "../github/GitHub.ts";
import * as JourneyStore from "../journeys/JourneyStore.ts";
import { derivePullRequestJourneyState } from "../journeys/journeyView.ts";

export type PullRequestIndexError =
  | GitHubReadError
  | GitHubParkedError
  | JourneyStore.JourneyStoreError;

export class PullRequestIndex extends Context.Service<
  PullRequestIndex,
  {
    readonly subscribe: Stream.Stream<GitHubPrListStreamEvent, PullRequestIndexError>;
    readonly refresh: () => Effect.Effect<GitHubPrListUpdatedEvent, PullRequestIndexError>;
    readonly retry: () => Effect.Effect<GitHubPrListUpdatedEvent, PullRequestIndexError>;
    readonly recompute: () => Effect.Effect<
      Option.Option<GitHubPrListUpdatedEvent>,
      JourneyStore.JourneyStoreError
    >;
  }
>()("@app/server/pullRequests/PullRequestIndex") {}

interface IdleIndexState {
  readonly _tag: "Idle";
  readonly sequence: number;
}

interface ReadyIndexState {
  readonly _tag: "Ready";
  readonly sequence: number;
  readonly rawPullRequests: ReadonlyArray<PrSummary>;
  readonly pullRequests: ReadonlyArray<PrSummary>;
  readonly refreshedAt: DateTime.Utc;
}

type IndexState = IdleIndexState | ReadyIndexState;

interface FlightClaim {
  readonly deferred: Deferred.Deferred<GitHubPrListUpdatedEvent, PullRequestIndexError>;
  readonly owner: boolean;
}

const prKey = (pr: PrRef): string => `${pr.owner.length}:${pr.owner}/${pr.repo}#${pr.number}`;

export const make = Effect.gen(function* () {
  const github = yield* GitHub.GitHub;
  const store = yield* JourneyStore.JourneyStore;
  const state = yield* SynchronizedRef.make<IndexState>({
    _tag: "Idle",
    sequence: 0,
  });
  const updates = yield* PubSub.unbounded<GitHubPrListUpdatedEvent>();
  const inFlight = yield* Ref.make<
    Option.Option<Deferred.Deferred<GitHubPrListUpdatedEvent, PullRequestIndexError>>
  >(Option.none());

  const enrich = (rawPullRequests: ReadonlyArray<PrSummary>) =>
    Effect.gen(function* () {
      const metadata = yield* store.listMetadata;
      const journeys = new Map(metadata.map((entry) => [prKey(entry.journey.pr), entry]));

      return rawPullRequests.map((pullRequest): PrSummary => {
        const stored = journeys.get(prKey(pullRequest.ref));
        if (stored === undefined) {
          return { ...pullRequest, journey: null };
        }
        return {
          ...pullRequest,
          journey: derivePullRequestJourneyState(
            stored.journey,
            Option.getOrNull(stored.readState),
            pullRequest.headSha,
          ),
        };
      });
    });

  const commit = (
    rawPullRequests: ReadonlyArray<PrSummary>,
    refreshedAt: DateTime.Utc,
  ): Effect.Effect<GitHubPrListUpdatedEvent, JourneyStore.JourneyStoreError> =>
    SynchronizedRef.modifyEffect(state, (current) =>
      enrich(rawPullRequests).pipe(
        Effect.flatMap((pullRequests) => {
          const event: GitHubPrListUpdatedEvent = {
            version: 1,
            sequence: current.sequence + 1,
            type: "updated",
            pullRequests,
            refreshedAt,
          };
          const next: ReadyIndexState = {
            _tag: "Ready",
            sequence: event.sequence,
            rawPullRequests,
            pullRequests,
            refreshedAt,
          };
          return PubSub.publish(updates, event).pipe(Effect.as([event, next] as const));
        }),
      ),
    );

  const load = Effect.gen(function* () {
    const pullRequests = yield* github.pullRequests();
    const refreshedAt = yield* DateTime.now;
    return yield* commit(pullRequests, refreshedAt);
  });

  const share = (
    operation: Effect.Effect<GitHubPrListUpdatedEvent, PullRequestIndexError>,
  ): Effect.Effect<GitHubPrListUpdatedEvent, PullRequestIndexError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Deferred.make<GitHubPrListUpdatedEvent, PullRequestIndexError>();
        const claim = yield* Ref.modify(
          inFlight,
          (
            current,
          ): readonly [
            FlightClaim,
            Option.Option<Deferred.Deferred<GitHubPrListUpdatedEvent, PullRequestIndexError>>,
          ] => {
            if (Option.isSome(current)) {
              return [{ deferred: current.value, owner: false }, current];
            }
            return [{ deferred: candidate, owner: true }, Option.some(candidate)];
          },
        );

        if (claim.owner) {
          yield* operation.pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Ref.update(inFlight, (current) =>
                Option.isSome(current) && current.value === candidate ? Option.none() : current,
              ).pipe(Effect.andThen(Deferred.done(candidate, exit))),
            ),
            Effect.forkDetach({ startImmediately: true }),
          );
        }

        return yield* restore(Deferred.await(claim.deferred));
      }),
    );

  const readyAsUpdated = (current: ReadyIndexState): GitHubPrListUpdatedEvent => ({
    version: 1,
    sequence: current.sequence,
    type: "updated",
    pullRequests: current.pullRequests,
    refreshedAt: current.refreshedAt,
  });

  const ensureLoaded = SynchronizedRef.get(state).pipe(
    Effect.flatMap((current) => {
      if (current._tag === "Ready") {
        return Effect.void;
      }
      return share(
        SynchronizedRef.get(state).pipe(
          Effect.flatMap((latest) =>
            latest._tag === "Ready" ? Effect.succeed(readyAsUpdated(latest)) : load,
          ),
        ),
      ).pipe(Effect.asVoid);
    }),
  );

  const recompute = (): Effect.Effect<
    Option.Option<GitHubPrListUpdatedEvent>,
    JourneyStore.JourneyStoreError
  > =>
    SynchronizedRef.modifyEffect(state, (current) => {
      if (current._tag === "Idle") {
        return Effect.succeed([Option.none(), current] as const);
      }
      return enrich(current.rawPullRequests).pipe(
        Effect.flatMap((pullRequests) => {
          const event: GitHubPrListUpdatedEvent = {
            version: 1,
            sequence: current.sequence + 1,
            type: "updated",
            pullRequests,
            refreshedAt: current.refreshedAt,
          };
          const next: ReadyIndexState = {
            ...current,
            sequence: event.sequence,
            pullRequests,
          };
          return PubSub.publish(updates, event).pipe(
            Effect.as([Option.some(event), next] as const),
          );
        }),
      );
    });

  return PullRequestIndex.of({
    subscribe: Stream.unwrap(
      Effect.gen(function* () {
        // The subscription must exist before a load or local recomputation can publish.
        const subscription = yield* PubSub.subscribe(updates);
        yield* ensureLoaded;
        const current = yield* SynchronizedRef.get(state);
        if (current._tag === "Idle") {
          return yield* Effect.die("Pull request index did not retain its successful load.");
        }
        const snapshot: GitHubPrListSnapshotEvent = {
          version: 1,
          sequence: current.sequence,
          type: "snapshot",
          pullRequests: current.pullRequests,
          refreshedAt: current.refreshedAt,
        };
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.sequence > snapshot.sequence),
        );
        return Stream.concat(Stream.make(snapshot as GitHubPrListStreamEvent), live);
      }),
    ),
    refresh: () => share(load),
    retry: () => share(github.retry().pipe(Effect.andThen(load))),
    recompute,
  });
});

export const layer = Layer.effect(PullRequestIndex, make);
