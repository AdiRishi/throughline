import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  Journey,
  JourneyId,
  type ClusterFileReadMark,
  type ReadState,
  type ReadStateStreamEvent,
} from "@app/contracts";

import * as JourneyState from "../../src/journeys/JourneyState.ts";
import * as JourneyStore from "../../src/journeys/JourneyStore.ts";

const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));
const decodeJourneyId = Schema.decodeUnknownSync(JourneyId);

const makeJourney = (id: string, clusterId: string, path: string, number: number): Journey =>
  decodeJourney({
    formatVersion: 1,
    id,
    pr: {
      owner: "effect-ts",
      repo: "throughline-fixture",
      number,
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
      brief: { markdown: "A focused change." },
      whereToBegin: { markdown: "Begin with its only cluster." },
    },
    clusters: [
      {
        id: clusterId,
        position: 1,
        title: "Core behavior",
        weight: "core",
        narrative: { markdown: "The behavior under review." },
        mapEntry: { markdown: "Introduces the behavior." },
        buildsOn: [],
        fileOrder: [path],
        resurfaced: [],
      },
      {
        id: `${clusterId}-other`,
        position: 2,
        title: "Supporting behavior",
        weight: "supporting",
        narrative: { markdown: "Supporting work under review." },
        mapEntry: { markdown: "Builds on the core behavior." },
        buildsOn: [clusterId],
        fileOrder: [`fixtures/${id}.ts`],
        resurfaced: [],
      },
    ],
    hunks: [
      {
        id: "h1",
        seedId: "s1",
        path,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        home: clusterId,
      },
      {
        id: "h2",
        seedId: "s2",
        path: `fixtures/${id}.ts`,
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        home: `${clusterId}-other`,
      },
    ],
    files: [
      {
        path,
        oldPath: null,
        kind: "modified",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 1,
        deletions: 1,
      },
      {
        path: `fixtures/${id}.ts`,
        oldPath: null,
        kind: "modified",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 1,
        deletions: 1,
      },
    ],
    hints: [],
  });

const firstJourney = makeJourney("journey-first", "cluster-first", "src/first.ts", 1);
const secondJourney = makeJourney("journey-second", "cluster-second", "src/second.ts", 2);

interface ReadMarkCall {
  readonly journeyId: Journey["id"];
  readonly mark: ClusterFileReadMark;
  readonly read: boolean;
}

interface ControlledStoreOptions {
  readonly readState?: (
    journeyId: Journey["id"],
    current: Option.Option<ReadState>,
  ) => Effect.Effect<Option.Option<ReadState>>;
}

const makeControlledStore = (
  journeys: ReadonlyArray<Journey>,
  options: ControlledStoreOptions = {},
) =>
  Effect.gen(function* () {
    const storedJourneys = new Map(
      journeys.map((journey) => [journey.id, { journey, runId: `run-${journey.id}` }]),
    );
    const readStates = yield* Ref.make<ReadonlyMap<Journey["id"], ReadState>>(new Map());
    const readMarkCalls = yield* Ref.make<ReadonlyArray<ReadMarkCall>>([]);

    const mutateReadState = (
      journeyId: Journey["id"],
      mutate: (state: ReadState, now: DateTime.Utc) => ReadState,
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return yield* Ref.modify(readStates, (states) => {
          const current = states.get(journeyId) ?? {
            journeyId,
            readFiles: [],
            displayMode: "inline",
            updatedAt: now,
          };
          const state = mutate(current, now);
          const next = new Map(states);
          next.set(journeyId, state);
          return [state, next] as const;
        });
      });

    const localPrState = {
      reviewed: [],
      hidden: [],
      dismissedMerged: [],
    };

    const service = JourneyStore.JourneyStore.of({
      listMetadata: Effect.succeed([]),
      listRunReferences: Effect.succeed([]),
      getByPr: (pr) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            [...storedJourneys.values()].find(
              ({ journey }) =>
                journey.pr.owner === pr.owner &&
                journey.pr.repo === pr.repo &&
                journey.pr.number === pr.number,
            ),
          ),
        ),
      getById: (journeyId) => Effect.succeed(Option.fromUndefinedOr(storedJourneys.get(journeyId))),
      replace: () => Effect.succeedNone,
      remove: () => Effect.succeedNone,
      getReadState: (journeyId) =>
        Effect.gen(function* () {
          const states = yield* Ref.get(readStates);
          const current = Option.fromUndefinedOr(states.get(journeyId));
          return options.readState === undefined
            ? current
            : yield* options.readState(journeyId, current);
        }),
      setDisplayMode: (journeyId, displayMode) =>
        mutateReadState(journeyId, (state, updatedAt) => ({
          ...state,
          displayMode,
          updatedAt,
        })),
      setReadMark: (journeyId, mark, read) =>
        Effect.gen(function* () {
          yield* Ref.update(readMarkCalls, (calls) => [...calls, { journeyId, mark, read }]);
          return yield* mutateReadState(journeyId, (state, updatedAt) => {
            const matches = (entry: ClusterFileReadMark) =>
              entry.clusterId === mark.clusterId && entry.path === mark.path;
            return {
              ...state,
              readFiles: read
                ? state.readFiles.some(matches)
                  ? state.readFiles
                  : [...state.readFiles, mark]
                : state.readFiles.filter((entry) => !matches(entry)),
              updatedAt,
            };
          });
        }),
      getLocalPrState: Effect.succeed(localPrState),
      setReviewed: () => Effect.succeed(localPrState),
      setHidden: () => Effect.succeed(localPrState),
      setDismissedMerged: () => Effect.succeed(localPrState),
      getSettings: Effect.succeed({}),
      setHarness: (harness) => Effect.succeed(harness === undefined ? {} : { harness }),
    });

    return { service, readMarkCalls, readStates };
  });

const makeState = (store: JourneyStore.JourneyStore["Service"]) =>
  JourneyState.make.pipe(Effect.provideService(JourneyStore.JourneyStore, store));

const firstMark: ClusterFileReadMark = {
  clusterId: firstJourney.clusters[0]!.id,
  path: firstJourney.files[0]!.path,
};

const eventSummary = (event: ReadStateStreamEvent) => ({
  journeyId: event.state.journeyId,
  readFiles: event.state.readFiles,
  displayMode: event.state.displayMode,
  sequence: event.sequence,
  type: event.type,
});

describe("JourneyState", () => {
  it.effect("synthesizes default state only for an existing journey", () =>
    Effect.gen(function* () {
      const controlled = yield* makeControlledStore([firstJourney]);
      const state = yield* makeState(controlled.service);

      const current = yield* state.get(firstJourney.id);
      assert.strictEqual(current.journeyId, firstJourney.id);
      assert.deepStrictEqual(current.readFiles, []);
      assert.strictEqual(current.displayMode, "inline");
      assert.isTrue(
        Option.isNone(
          Option.fromUndefinedOr((yield* Ref.get(controlled.readStates)).get(firstJourney.id)),
        ),
      );

      const missing = yield* state.get(decodeJourneyId("journey-missing")).pipe(Effect.flip);
      assert.instanceOf(missing, JourneyState.JourneyStateNotFoundError);
    }),
  );

  it.effect("rejects marks that are not actual cluster home pairs", () =>
    Effect.gen(function* () {
      const controlled = yield* makeControlledStore([firstJourney, secondJourney]);
      const state = yield* makeState(controlled.service);
      const invalidMark: ClusterFileReadMark = {
        clusterId: firstJourney.clusters[0]!.id,
        path: firstJourney.files[1]!.path,
      };

      const markResult = yield* state.mark(firstJourney.id, invalidMark).pipe(Effect.flip);
      const unmarkResult = yield* state.unmark(firstJourney.id, invalidMark).pipe(Effect.flip);

      assert.instanceOf(markResult, JourneyState.InvalidReadMarkError);
      assert.instanceOf(unmarkResult, JourneyState.InvalidReadMarkError);
      assert.deepStrictEqual(yield* Ref.get(controlled.readMarkCalls), []);
    }),
  );

  it.effect("persists idempotent mutations and publishes every success in order", () =>
    Effect.gen(function* () {
      const controlled = yield* makeControlledStore([firstJourney]);
      const state = yield* makeState(controlled.service);
      const snapshotSeen = yield* Deferred.make<void>();
      const collector = yield* state.subscribe(firstJourney.id).pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
        ),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(snapshotSeen);

      const firstMarkResult = yield* state.mark(firstJourney.id, firstMark);
      const repeatedMarkResult = yield* state.mark(firstJourney.id, firstMark);
      const firstUnmarkResult = yield* state.unmark(firstJourney.id, firstMark);
      const repeatedUnmarkResult = yield* state.unmark(firstJourney.id, firstMark);
      const displayModeResult = yield* state.setDisplayMode(firstJourney.id, "split");

      assert.deepStrictEqual(firstMarkResult.readFiles, [firstMark]);
      assert.deepStrictEqual(repeatedMarkResult.readFiles, [firstMark]);
      assert.deepStrictEqual(firstUnmarkResult.readFiles, []);
      assert.deepStrictEqual(repeatedUnmarkResult.readFiles, []);
      assert.strictEqual(displayModeResult.displayMode, "split");

      const events = yield* Fiber.join(collector);
      assert.deepStrictEqual(
        events.map((event) => [event.sequence, event.type]),
        [
          [0, "snapshot"],
          [1, "updated"],
          [2, "updated"],
          [3, "updated"],
          [4, "updated"],
          [5, "updated"],
        ],
      );
      assert.deepStrictEqual(
        (yield* Ref.get(controlled.readMarkCalls)).map(({ read }) => read),
        [true, true, false, false],
      );
      assert.strictEqual(events[5]!.state.displayMode, "split");
    }).pipe(Effect.scoped),
  );

  it.effect("does not lose a mutation that completes during the snapshot read", () =>
    Effect.gen(function* () {
      const snapshotStarted = yield* Deferred.make<void>();
      const releaseSnapshot = yield* Deferred.make<void>();
      const controlled = yield* makeControlledStore([firstJourney], {
        readState: (journeyId, current) =>
          journeyId === firstJourney.id
            ? Deferred.succeed(snapshotStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSnapshot)),
                Effect.as(current),
              )
            : Effect.succeed(current),
      });
      const state = yield* makeState(controlled.service);
      const collector = yield* state
        .subscribe(firstJourney.id)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* Deferred.await(snapshotStarted);
      const mutation = yield* state.mark(firstJourney.id, firstMark).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseSnapshot, undefined);
      yield* Fiber.join(mutation);

      const events = yield* Fiber.join(collector);
      assert.deepStrictEqual(events.map(eventSummary), [
        {
          journeyId: firstJourney.id,
          readFiles: [],
          displayMode: "inline",
          sequence: 0,
          type: "snapshot",
        },
        {
          journeyId: firstJourney.id,
          readFiles: [firstMark],
          displayMode: "inline",
          sequence: 1,
          type: "updated",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("isolates journeys while keeping every window consistent", () =>
    Effect.gen(function* () {
      const controlled = yield* makeControlledStore([firstJourney, secondJourney]);
      const state = yield* makeState(controlled.service);
      const firstWindowReady = yield* Deferred.make<void>();
      const secondWindowReady = yield* Deferred.make<void>();
      const otherJourneyReady = yield* Deferred.make<void>();

      const collect = (journeyId: Journey["id"], ready: Deferred.Deferred<void>) =>
        state.subscribe(journeyId).pipe(
          Stream.tap((event) =>
            event.type === "snapshot" ? Deferred.succeed(ready, undefined) : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

      const firstWindow = yield* collect(firstJourney.id, firstWindowReady);
      const secondWindow = yield* collect(firstJourney.id, secondWindowReady);
      const otherJourneyWindow = yield* collect(secondJourney.id, otherJourneyReady);
      yield* Effect.all([
        Deferred.await(firstWindowReady),
        Deferred.await(secondWindowReady),
        Deferred.await(otherJourneyReady),
      ]);

      yield* state.mark(firstJourney.id, firstMark);
      yield* state.setDisplayMode(secondJourney.id, "just-the-code");

      const [firstEvents, secondEvents, otherEvents] = yield* Effect.all([
        Fiber.join(firstWindow),
        Fiber.join(secondWindow),
        Fiber.join(otherJourneyWindow),
      ]);
      assert.deepStrictEqual(firstEvents.map(eventSummary), secondEvents.map(eventSummary));
      assert.deepStrictEqual(firstEvents.map(eventSummary), [
        {
          journeyId: firstJourney.id,
          readFiles: [],
          displayMode: "inline",
          sequence: 0,
          type: "snapshot",
        },
        {
          journeyId: firstJourney.id,
          readFiles: [firstMark],
          displayMode: "inline",
          sequence: 1,
          type: "updated",
        },
      ]);
      assert.deepStrictEqual(otherEvents.map(eventSummary), [
        {
          journeyId: secondJourney.id,
          readFiles: [],
          displayMode: "inline",
          sequence: 0,
          type: "snapshot",
        },
        {
          journeyId: secondJourney.id,
          readFiles: [],
          displayMode: "just-the-code",
          sequence: 1,
          type: "updated",
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
