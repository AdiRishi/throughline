import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { Cluster, ClusterId, Hunk, HunkId, Journey, JourneyId } from "@app/contracts";

import * as ServerConfig from "../../src/config.ts";
import { JourneyStore, layer as journeyStoreLayer } from "../../src/journeys/JourneyStore.ts";

/**
 * The store's job is to make two documented guarantees true, and both are
 * transactional rather than conventional:
 *
 * - **Reanalysis replaces a journey and resets its read state, atomically.** Read
 *   marks are only meaningful against the journey they were earned in, so a
 *   half-applied reanalysis — new artifact, old marks — would silently corrupt
 *   the coverage guarantee.
 * - **An unreadable artifact is absent, never a crash.** `formatVersion` is only
 *   a real forward-compatibility mechanism if a future version degrades to
 *   "not analyzed" instead of taking the app down.
 */

const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tl-store-"));

const configLayer = (dataDir: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      return ServerConfig.layer(
        ServerConfig.make({
          appName: "Throughline",
          version: "0.0.0-test",
          startedAt,
          host: "127.0.0.1",
          port: 0,
          staticDir: undefined,
          devWebUrl: undefined,
          bootstrapToken: "test",
          dataDir,
          logDir: NodePath.join(dataDir, "logs"),
          serverTracePath: NodePath.join(dataDir, "logs", "trace.ndjson"),
          logLevel: "Error",
          traceMinLevel: "Error",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "test",
        }),
      );
    }),
  );

/**
 * A real store over a real SQLite file in a fresh temp directory. Nothing is
 * mocked: the transactional guarantees below are properties of the database, so
 * testing them against anything else would test nothing.
 *
 * The layer can fail (a migration error), and a migration that fails in a test is
 * a bug rather than a scenario — so it dies rather than widening every test's
 * error channel.
 */
const withStore = <A>(program: Effect.Effect<A, never, JourneyStore | SqlClient.SqlClient>) =>
  Effect.suspend(() => {
    const dataDir = scratch();
    return program.pipe(
      Effect.provide(
        journeyStoreLayer.pipe(
          Layer.provideMerge(configLayer(dataDir)),
          Layer.provideMerge(NodeServices.layer),
          Layer.orDie,
        ),
      ),
    );
  });

const PR = { owner: "meridian", repo: "console", number: 418 };

const cluster = (id: string, position: number): Cluster => ({
  id: id as ClusterId,
  position,
  title: `Cluster ${position}`,
  weight: "core",
  narrative: { markdown: "What this step does." },
  mapEntry: { markdown: "Compressed." },
  buildsOn: [],
  fileOrder: [`src/${id}.ts`],
  resurfaced: [],
});

const hunk = (id: string, home: string, path: string): Hunk => ({
  id: id as HunkId,
  path,
  oldStart: 0,
  oldLines: 0,
  newStart: 1,
  newLines: 3,
  seedId: id as HunkId,
  home: home as ClusterId,
});

const journeyOf = (id: string, headSha: string, analyzedAt: DateTime.Utc): Journey => ({
  formatVersion: 1,
  id: id as JourneyId,
  pr: PR,
  prWords: {
    title: "Add authentication",
    body: "",
    author: "mara",
    url: "https://github.com/meridian/console/pull/418",
    createdAt: analyzedAt,
  },
  pinned: { headSha, baseSha: "base", baseRef: "main", analyzedAt },
  provenance: { harnessKind: "claude", fallbacks: [] },
  overview: {
    brief: { markdown: "The change." },
    whereToBegin: { markdown: "Start at 1." },
    attention: [],
  },
  clusters: [cluster("c1", 1), cluster("c2", 2)],
  hunks: [hunk("h1", "c1", "src/c1.ts"), hunk("h2", "c2", "src/c2.ts")],
  files: [],
  hints: [],
});

describe("committing and reading a journey", () => {
  it.effect("round-trips the artifact through its own contract schema", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        const found = yield* store.journey(PR).pipe(Effect.orDie);
        assert.isTrue(Option.isSome(found));
        if (Option.isSome(found)) {
          assert.equal(found.value.id, "j1");
          assert.equal(found.value.clusters.length, 2);
          assert.equal(found.value.hunks.length, 2);
          // The DateTime survived the JSON round trip as a DateTime.
          assert.equal(
            DateTime.toEpochMillis(found.value.pinned.analyzedAt),
            DateTime.toEpochMillis(now),
          );
        }
      }),
    ),
  );

  it.effect("finds a journey by id and resolves its pull request", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        const byId = yield* store.journeyById("j1" as JourneyId).pipe(Effect.orDie);
        assert.isTrue(Option.isSome(byId));
        const ref = yield* store.refForJourney("j1" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(Option.getOrNull(ref), PR);
      }),
    ),
  );

  it.effect("lists indexed metadata without decoding artifacts", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        const summaries = yield* store.summaries.pipe(Effect.orDie);
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.journeyId, "j1");
        assert.equal(summaries[0]?.clusterCount, 2);
        assert.equal(summaries[0]?.hunkCount, 2);
        assert.equal(summaries[0]?.headSha, "head-1");
      }),
    ),
  );

  it.effect("an absent journey reads as none", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const found = yield* store.journey(PR).pipe(Effect.orDie);
        assert.isTrue(Option.isNone(found));
      }),
    ),
  );
});

describe("reanalysis", () => {
  it.effect("replaces the journey AND resets read state, in one transaction", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;

        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);
        yield* store
          .markFile({
            journeyId: "j1" as JourneyId,
            clusterId: "c1" as ClusterId,
            path: "src/c1.ts",
            read: true,
          })
          .pipe(Effect.orDie);

        const before = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.equal(before.readFiles.length, 1);

        // A rebuilt journey is a NEW journey; progress starts fresh.
        yield* store.commit(journeyOf("j2", "head-2", now)).pipe(Effect.orDie);

        const current = yield* store.journey(PR).pipe(Effect.orDie);
        assert.equal(Option.getOrNull(current)?.id, "j2");

        const fresh = yield* store.readState("j2" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(fresh.readFiles, [], "a new journey starts with no marks");

        const orphaned = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(
          orphaned.readFiles,
          [],
          "the previous journey's marks are gone, not merely unreachable",
        );

        const summaries = yield* store.summaries.pipe(Effect.orDie);
        assert.equal(summaries.length, 1, "one PR, one journey, one row");
      }),
    ),
  );

  it.effect("marks made against one journey never count for another", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);
        yield* store
          .markFile({
            journeyId: "j1" as JourneyId,
            clusterId: "c1" as ClusterId,
            path: "src/c1.ts",
            read: true,
          })
          .pipe(Effect.orDie);
        const other = yield* store.readState("j-other" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(other.readFiles, []);
      }),
    ),
  );
});

describe("read state", () => {
  it.effect("marking is idempotent and unmarking is exact", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);
        const mark = (read: boolean, path: string) =>
          store
            .markFile({
              journeyId: "j1" as JourneyId,
              clusterId: "c1" as ClusterId,
              path,
              read,
            })
            .pipe(Effect.orDie);

        yield* mark(true, "src/c1.ts");
        yield* mark(true, "src/c1.ts");
        const twice = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.equal(twice.readFiles.length, 1, "marking twice is one mark");

        yield* mark(true, "src/other.ts");
        yield* mark(false, "src/c1.ts");
        const after = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(
          after.readFiles.map((entry) => entry.path),
          ["src/other.ts"],
          "unmarking removes exactly one mark",
        );
      }),
    ),
  );

  it.effect("display mode is sticky per journey", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        const initial = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.equal(initial.displayMode, "inline", "inline is the default");

        yield* store
          .setDisplayMode({ journeyId: "j1" as JourneyId, displayMode: "just-the-code" })
          .pipe(Effect.orDie);
        const sticky = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.equal(sticky.displayMode, "just-the-code");

        // Setting the mode must not disturb the marks it sits beside.
        yield* store
          .markFile({
            journeyId: "j1" as JourneyId,
            clusterId: "c1" as ClusterId,
            path: "src/c1.ts",
            read: true,
          })
          .pipe(Effect.orDie);
        yield* store
          .setDisplayMode({ journeyId: "j1" as JourneyId, displayMode: "split" })
          .pipe(Effect.orDie);
        const both = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.equal(both.displayMode, "split");
        assert.equal(both.readFiles.length, 1);
      }),
    ),
  );
});

describe("local marks and settings", () => {
  it.effect("PR flags toggle independently and persist", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        yield* store.setPrFlag({ ref: PR, flag: "reviewed", value: true }).pipe(Effect.orDie);
        yield* store.setPrFlag({ ref: PR, flag: "hidden", value: true }).pipe(Effect.orDie);
        yield* store.setPrFlag({ ref: PR, flag: "reviewed", value: false }).pipe(Effect.orDie);

        const marks = yield* store.prState.pipe(Effect.orDie);
        assert.deepEqual(marks.reviewed, []);
        assert.equal(marks.hidden.length, 1);
        assert.deepEqual(marks.hidden[0], PR);
      }),
    ),
  );

  it.effect("settings default to auto-select and update as a patch", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const initial = yield* store.settings.pipe(Effect.orDie);
        assert.isNull(initial.harness, "absent means auto-select");

        const chosen = yield* store.updateSettings({ harness: "claude" }).pipe(Effect.orDie);
        assert.equal(chosen.harness, "claude");

        // An empty patch leaves everything alone.
        const untouched = yield* store.updateSettings({}).pipe(Effect.orDie);
        assert.equal(untouched.harness, "claude");

        const cleared = yield* store.updateSettings({ harness: null }).pipe(Effect.orDie);
        assert.isNull(cleared.harness);
      }),
    ),
  );
});

describe("an unreadable artifact is absent, never a crash", () => {
  it.effect("a future formatVersion reads as not analyzed", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        yield* sql`UPDATE journeys SET format_version = 99`.pipe(Effect.orDie);
        const found = yield* store.journey(PR).pipe(Effect.orDie);
        assert.isTrue(Option.isNone(found), "re-ingest, never crash");
      }),
    ),
  );

  it.effect("a corrupt blob reads as not analyzed", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);

        yield* sql`UPDATE journeys SET artifact = ${"{not json"}`.pipe(Effect.orDie);
        const found = yield* store.journey(PR).pipe(Effect.orDie);
        assert.isTrue(Option.isNone(found));

        // The indexed metadata still lists it, so the app can offer a re-ingest.
        const summaries = yield* store.summaries.pipe(Effect.orDie);
        assert.equal(summaries.length, 1);
      }),
    ),
  );

  it.effect("a corrupt read-state document costs progress, never the journey", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);
        yield* store
          .markFile({
            journeyId: "j1" as JourneyId,
            clusterId: "c1" as ClusterId,
            path: "src/c1.ts",
            read: true,
          })
          .pipe(Effect.orDie);

        yield* sql`UPDATE read_state SET document = ${"nonsense"}`.pipe(Effect.orDie);
        const state = yield* store.readState("j1" as JourneyId).pipe(Effect.orDie);
        assert.deepEqual(state.readFiles, []);
        assert.equal(state.displayMode, "inline");

        const journey = yield* store.journey(PR).pipe(Effect.orDie);
        assert.isTrue(Option.isSome(journey), "the journey is unaffected");
      }),
    ),
  );
});

describe("the change bus", () => {
  it.live("publishes what changed so views can re-derive without polling", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* JourneyStore;
        const now = yield* DateTime.now;

        const collected = yield* Effect.forkChild(
          store.changes.pipe(Stream.take(3), Stream.runCollect),
        );
        // Give the subscription a moment to attach before publishing: the bus is
        // live-only, so an event published before anyone is listening is gone.
        yield* Effect.sleep("10 millis");

        yield* store.commit(journeyOf("j1", "head-1", now)).pipe(Effect.orDie);
        yield* store
          .markFile({
            journeyId: "j1" as JourneyId,
            clusterId: "c1" as ClusterId,
            path: "src/c1.ts",
            read: true,
          })
          .pipe(Effect.orDie);
        yield* store.setPrFlag({ ref: PR, flag: "reviewed", value: true }).pipe(Effect.orDie);

        const events = yield* Fiber.join(collected);
        assert.deepEqual(
          events.map((event) => event._tag),
          ["journey", "readState", "prState"],
        );
      }),
    ),
  );
});
