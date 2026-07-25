import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  ClusterId,
  JourneyId,
  RepositoryPath,
  type ClusterFileReadMark,
  type DisplayMode,
  type Journey,
  type ReadState,
  type ReadStateSnapshotEvent,
  type ReadStateStreamEvent,
  type ReadStateUpdatedEvent,
} from "@app/contracts";

import { fromLiveSubscription } from "../liveSubscription.ts";
import * as JourneyStore from "./JourneyStore.ts";

export class JourneyStateNotFoundError extends Schema.TaggedErrorClass<JourneyStateNotFoundError>()(
  "JourneyStateNotFoundError",
  {
    journeyId: JourneyId,
  },
) {
  override get message(): string {
    return "The requested journey no longer exists.";
  }
}

export class InvalidReadMarkError extends Schema.TaggedErrorClass<InvalidReadMarkError>()(
  "InvalidReadMarkError",
  {
    journeyId: JourneyId,
    clusterId: ClusterId,
    path: RepositoryPath,
  },
) {
  override get message(): string {
    return `The file '${this.path}' does not belong to cluster '${this.clusterId}'.`;
  }
}

export type JourneyStateError = JourneyStore.JourneyStoreError | JourneyStateNotFoundError;

export type JourneyStateMutationError = JourneyStateError | InvalidReadMarkError;

export class JourneyState extends Context.Service<
  JourneyState,
  {
    readonly get: (journeyId: JourneyId) => Effect.Effect<ReadState, JourneyStateError>;
    readonly mark: (
      journeyId: JourneyId,
      mark: ClusterFileReadMark,
    ) => Effect.Effect<ReadState, JourneyStateMutationError>;
    readonly unmark: (
      journeyId: JourneyId,
      mark: ClusterFileReadMark,
    ) => Effect.Effect<ReadState, JourneyStateMutationError>;
    readonly setDisplayMode: (
      journeyId: JourneyId,
      displayMode: DisplayMode,
    ) => Effect.Effect<ReadState, JourneyStateError>;
    readonly subscribe: (
      journeyId: JourneyId,
    ) => Stream.Stream<ReadStateStreamEvent, JourneyStateError>;
  }
>()("@app/server/journeys/JourneyState") {}

const isHomePair = (journey: Journey, mark: ClusterFileReadMark): boolean =>
  journey.hunks.some((hunk) => hunk.home === mark.clusterId && hunk.path === mark.path);

export const make = Effect.gen(function* () {
  const store = yield* JourneyStore.JourneyStore;
  const sequenceByJourney = yield* Ref.make<ReadonlyMap<JourneyId, number>>(new Map());
  const updates = yield* PubSub.unbounded<ReadStateUpdatedEvent>();
  const mutationGate = yield* Semaphore.make(1);

  const sequenceFor = (journeyId: JourneyId) =>
    Ref.get(sequenceByJourney).pipe(Effect.map((sequences) => sequences.get(journeyId) ?? 0));

  const nextSequence = (journeyId: JourneyId) =>
    Ref.modify(sequenceByJourney, (sequences) => {
      const sequence = (sequences.get(journeyId) ?? 0) + 1;
      const next = new Map(sequences);
      next.set(journeyId, sequence);
      return [sequence, next] as const;
    });

  const requireJourney = (journeyId: JourneyId): Effect.Effect<Journey, JourneyStateError> =>
    store.getById(journeyId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => new JourneyStateNotFoundError({ journeyId }),
          onSome: ({ journey }) => Effect.succeed(journey),
        }),
      ),
    );

  const get = (journeyId: JourneyId): Effect.Effect<ReadState, JourneyStateError> =>
    Effect.gen(function* () {
      yield* requireJourney(journeyId);
      const stored = yield* store.getReadState(journeyId);
      if (Option.isSome(stored)) {
        return stored.value;
      }
      const updatedAt = yield* DateTime.now;
      return {
        journeyId,
        readFiles: [],
        displayMode: "inline",
        updatedAt,
      };
    });

  const publish = (journeyId: JourneyId, state: ReadState) =>
    Effect.gen(function* () {
      const sequence = yield* nextSequence(journeyId);
      const event: ReadStateUpdatedEvent = {
        version: 1,
        sequence,
        type: "updated",
        state,
      };
      yield* PubSub.publish(updates, event);
    });

  const setReadMark = (
    journeyId: JourneyId,
    mark: ClusterFileReadMark,
    read: boolean,
  ): Effect.Effect<ReadState, JourneyStateMutationError> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        const journey = yield* requireJourney(journeyId);
        if (!isHomePair(journey, mark)) {
          return yield* new InvalidReadMarkError({
            journeyId,
            clusterId: mark.clusterId,
            path: mark.path,
          });
        }
        const state = yield* store.setReadMark(journeyId, mark, read);
        yield* publish(journeyId, state);
        return state;
      }),
    );

  const setDisplayMode = (
    journeyId: JourneyId,
    displayMode: DisplayMode,
  ): Effect.Effect<ReadState, JourneyStateError> =>
    mutationGate.withPermit(
      Effect.gen(function* () {
        yield* requireJourney(journeyId);
        const state = yield* store.setDisplayMode(journeyId, displayMode);
        yield* publish(journeyId, state);
        return state;
      }),
    );

  return JourneyState.of({
    get,
    mark: (journeyId, mark) => setReadMark(journeyId, mark, true),
    unmark: (journeyId, mark) => setReadMark(journeyId, mark, false),
    setDisplayMode,
    subscribe: (journeyId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Register first so mutations racing the snapshot read remain queued.
          const subscription = yield* PubSub.subscribe(updates);
          const [boundary, state] = yield* mutationGate.withPermit(
            Effect.all([sequenceFor(journeyId), get(journeyId)]),
          );
          const snapshot: ReadStateSnapshotEvent = {
            version: 1,
            sequence: boundary,
            type: "snapshot",
            state,
          };
          const live = fromLiveSubscription(subscription).pipe(
            Stream.filter(
              (event) => event.state.journeyId === journeyId && event.sequence > boundary,
            ),
          );
          return Stream.concat(Stream.make(snapshot as ReadStateStreamEvent), live);
        }),
      ),
  });
});

export const layer = Layer.effect(JourneyState, make);
