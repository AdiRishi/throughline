import * as NodeServices from "@effect/platform-node/NodeServices";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Reactivity } from "effect/unstable/reactivity";

import { Journey } from "@app/contracts";

import * as JourneyStore from "../../src/journeys/JourneyStore.ts";

const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));

const makeJourney = (
  id: string,
  headSha: string,
  analyzedAt: string,
  pr: { readonly owner: string; readonly repo: string; readonly number: number } = {
    owner: "effect-ts",
    repo: "throughline-fixture",
    number: 42,
  },
): Journey =>
  decodeJourney({
    formatVersion: 1,
    id,
    pr,
    pinned: {
      headSha,
      baseSha: "1111111111111111111111111111111111111111",
      analyzedAt,
    },
    provenance: {
      harnessKind: "codex",
      model: "gpt-fixture",
    },
    overview: {
      brief: { markdown: "This PR changes two related paths." },
      whereToBegin: { markdown: "Begin with the core cluster." },
    },
    clusters: [
      {
        id: "c1",
        position: 1,
        title: "Core behavior",
        weight: "core",
        narrative: { markdown: "The first behavior." },
        mapEntry: { markdown: "Introduces the core behavior." },
        buildsOn: [],
        fileOrder: ["src/shared.ts", "src/other.ts"],
        resurfaced: [],
      },
      {
        id: "c2",
        position: 2,
        title: "Follow-up behavior",
        weight: "supporting",
        narrative: { markdown: "The second behavior." },
        mapEntry: { markdown: "Builds on the core behavior." },
        buildsOn: ["c1"],
        fileOrder: ["src/shared.ts"],
        resurfaced: [],
      },
    ],
    hunks: [
      {
        id: "h1",
        seedId: "s1",
        path: "src/shared.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        home: "c1",
      },
      {
        id: "h2",
        seedId: "s2",
        path: "src/other.ts",
        oldStart: 2,
        oldLines: 0,
        newStart: 2,
        newLines: 1,
        home: "c1",
      },
      {
        id: "h3",
        seedId: "s3",
        path: "src/shared.ts",
        oldStart: 4,
        oldLines: 1,
        newStart: 4,
        newLines: 1,
        home: "c2",
      },
    ],
    files: [
      {
        path: "src/shared.ts",
        oldPath: null,
        kind: "modified",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 2,
        deletions: 2,
      },
      {
        path: "src/other.ts",
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

const firstJourney = makeJourney(
  "journey-1",
  "2222222222222222222222222222222222222222",
  "2026-07-20T00:00:00.000Z",
);
const replacementJourney = makeJourney(
  "journey-2",
  "3333333333333333333333333333333333333333",
  "2026-07-21T00:00:00.000Z",
);

const otherJourney = makeJourney(
  "journey-other",
  "4444444444444444444444444444444444444444",
  "2026-07-22T00:00:00.000Z",
  { owner: "effect-ts", repo: "another-repository", number: 7 },
);
const conflictingJourney = makeJourney(
  otherJourney.id,
  "5555555555555555555555555555555555555555",
  "2026-07-23T00:00:00.000Z",
);

const withStore = <A, E, R>(
  filename: string,
  use: (store: JourneyStore.JourneyStore["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.flatMap(JourneyStore.JourneyStore, use).pipe(
    Effect.provide(JourneyStore.layerAt(filename)),
  );

const temporaryDatabase = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "throughline-journey-store-",
  });
  return `${directory}/throughline.db`;
});

it.layer(NodeServices.layer)("JourneyStore", (it) => {
  it.effect("persists journeys and read state across a store restart", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.replace({ journey: firstJourney, runId: "run-1" });
          yield* store.setDisplayMode(firstJourney.id, "split");
          yield* store.setReadMark(
            firstJourney.id,
            {
              clusterId: firstJourney.clusters[0]!.id,
              path: firstJourney.files[0]!.path,
            },
            true,
          );
        }),
      );

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          const byPr = yield* store.getByPr(firstJourney.pr);
          assert.isTrue(Option.isSome(byPr));
          if (Option.isSome(byPr)) {
            assert.strictEqual(byPr.value.journey.id, firstJourney.id);
            assert.strictEqual(byPr.value.runId, "run-1");
          }

          const readState = yield* store.getReadState(firstJourney.id);
          assert.isTrue(Option.isSome(readState));
          if (Option.isSome(readState)) {
            assert.strictEqual(readState.value.displayMode, "split");
            assert.deepStrictEqual(readState.value.readFiles, [
              {
                clusterId: firstJourney.clusters[0]!.id,
                path: firstJourney.files[0]!.path,
              },
            ]);
          }

          const metadata = yield* store.listMetadata;
          assert.lengthOf(metadata, 1);
          assert.strictEqual(metadata[0]!.journey.id, firstJourney.id);
          assert.isTrue(Option.isSome(metadata[0]!.readState));
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("atomically replaces a journey, resets its read state, and returns the old run", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          const firstResult = yield* store.replace({
            journey: firstJourney,
            runId: "run-1",
          });
          assert.isTrue(Option.isNone(firstResult));
          yield* store.setReadMark(
            firstJourney.id,
            {
              clusterId: firstJourney.clusters[0]!.id,
              path: firstJourney.files[0]!.path,
            },
            true,
          );

          const replaced = yield* store.replace({
            journey: replacementJourney,
            runId: "run-2",
          });
          assert.isTrue(Option.isSome(replaced));
          if (Option.isSome(replaced)) {
            assert.strictEqual(replaced.value.journeyId, firstJourney.id);
            assert.strictEqual(replaced.value.runId, "run-1");
          }

          const oldJourney = yield* store.getById(firstJourney.id);
          assert.isTrue(Option.isNone(oldJourney));

          const currentJourney = yield* store.getByPr(firstJourney.pr);
          assert.isTrue(Option.isSome(currentJourney));
          if (Option.isSome(currentJourney)) {
            assert.strictEqual(currentJourney.value.journey.id, replacementJourney.id);
          }

          assert.isTrue(Option.isNone(yield* store.getReadState(firstJourney.id)));
          assert.isTrue(Option.isNone(yield* store.getReadState(replacementJourney.id)));

          const removed = yield* store.remove(firstJourney.pr);
          assert.isTrue(Option.isSome(removed));
          if (Option.isSome(removed)) {
            assert.strictEqual(removed.value.runId, "run-2");
          }
          assert.deepStrictEqual(yield* store.listRunReferences, []);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps read marks independent by cluster and path", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.replace({ journey: firstJourney, runId: "run-1" });
          const sharedPath = firstJourney.files[0]!.path;
          const otherPath = firstJourney.files[1]!.path;
          const firstCluster = firstJourney.clusters[0]!.id;
          const secondCluster = firstJourney.clusters[1]!.id;

          yield* store.setReadMark(
            firstJourney.id,
            { clusterId: firstCluster, path: sharedPath },
            true,
          );
          yield* store.setReadMark(
            firstJourney.id,
            { clusterId: firstCluster, path: sharedPath },
            true,
          );
          yield* store.setReadMark(
            firstJourney.id,
            { clusterId: secondCluster, path: sharedPath },
            true,
          );
          yield* store.setReadMark(
            firstJourney.id,
            { clusterId: firstCluster, path: otherPath },
            true,
          );
          const final = yield* store.setReadMark(
            firstJourney.id,
            { clusterId: firstCluster, path: sharedPath },
            false,
          );

          assert.deepStrictEqual(final.readFiles, [
            { clusterId: secondCluster, path: sharedPath },
            { clusterId: firstCluster, path: otherPath },
          ]);
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rolls back the read-state reset when replacement cannot commit", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.replace({ journey: firstJourney, runId: "run-1" });
          yield* store.setReadMark(
            firstJourney.id,
            {
              clusterId: firstJourney.clusters[0]!.id,
              path: firstJourney.files[0]!.path,
            },
            true,
          );
          yield* store.replace({ journey: otherJourney, runId: "run-other" });

          const failed = yield* store
            .replace({ journey: conflictingJourney, runId: "run-conflict" })
            .pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(failed));

          const current = yield* store.getByPr(firstJourney.pr);
          assert.isTrue(Option.isSome(current));
          if (Option.isSome(current)) {
            assert.strictEqual(current.value.journey.id, firstJourney.id);
            assert.strictEqual(current.value.runId, "run-1");
          }

          const readState = yield* store.getReadState(firstJourney.id);
          assert.isTrue(Option.isSome(readState));
          if (Option.isSome(readState)) {
            assert.lengthOf(readState.value.readFiles, 1);
          }
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("persists independent local PR verbs and the harness setting", () =>
    Effect.gen(function* () {
      const filename = yield* temporaryDatabase;

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          yield* store.setReviewed(firstJourney.pr, true);
          yield* store.setHidden(firstJourney.pr, true);
          yield* store.setDismissedMerged(otherJourney.pr, true);
          yield* store.setReviewed(firstJourney.pr, false);
          yield* store.setHarness("claude");
        }),
      );

      yield* withStore(filename, (store) =>
        Effect.gen(function* () {
          const localState = yield* store.getLocalPrState;
          assert.deepStrictEqual(localState.reviewed, []);
          assert.deepStrictEqual(localState.hidden, [firstJourney.pr]);
          assert.deepStrictEqual(localState.dismissedMerged, [otherJourney.pr]);
          assert.deepStrictEqual(yield* store.getSettings, { harness: "claude" });

          assert.deepStrictEqual(yield* store.setHarness(undefined), {});
          assert.deepStrictEqual(yield* store.getSettings, {});
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "treats an invalid or future journey blob as absent without losing cleanup metadata",
    () =>
      Effect.gen(function* () {
        const filename = yield* temporaryDatabase;

        yield* withStore(filename, (store) =>
          store.replace({ journey: firstJourney, runId: "run-1" }),
        );

        yield* Effect.gen(function* () {
          const sql = yield* SqliteClient.make({ filename });
          yield* sql`
          UPDATE journeys
          SET journey_json = ${JSON.stringify({ formatVersion: 2 })}
          WHERE journey_id = ${firstJourney.id}
        `;
        }).pipe(Effect.scoped, Effect.provide(Reactivity.layer));

        yield* withStore(filename, (store) =>
          Effect.gen(function* () {
            assert.isTrue(Option.isNone(yield* store.getByPr(firstJourney.pr)));
            assert.deepStrictEqual(yield* store.listMetadata, []);

            const references = yield* store.listRunReferences;
            assert.lengthOf(references, 1);
            assert.strictEqual(references[0]!.journeyId, firstJourney.id);
            assert.strictEqual(references[0]!.runId, "run-1");
          }),
        );
      }).pipe(Effect.scoped),
  );
});
