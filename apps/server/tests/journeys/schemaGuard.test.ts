import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { JourneyStore, layer as journeyStoreLayer } from "../../src/journeys/JourneyStore.ts";
import { MIGRATIONS_TABLE } from "../../src/journeys/migrations.ts";
import { ensureReadableSchema } from "../../src/journeys/schemaGuard.ts";
import { configLayer, scratchDir } from "../support/config.ts";

/**
 * These tests exist because the failure they describe actually happened, in the
 * packaged app, against a database written six hours earlier by a build whose
 * `1_initial` had a different shape. The migrator read `1` in the ledger, skipped
 * its work, and every query afterwards failed with `no such column: pr_key` —
 * total, silent, and reported to the reviewer as "try again in a moment".
 *
 * So the schema below is not invented for the test. It is the real prior schema,
 * transcribed from the file that broke: `journeys` keyed by owner/repo/number
 * with no `pr_key`, and `pr_state` as a row-per-pull-request table rather than
 * the single document the current code reads.
 *
 * @module tests/journeys/schemaGuard
 */

/** The schema that actually shipped in an earlier build and broke on upgrade. */
const PRIOR_SCHEMA: ReadonlyArray<string> = [
  `CREATE TABLE ${MIGRATIONS_TABLE} (
     migration_id INTEGER PRIMARY KEY NOT NULL,
     created_at TEXT NOT NULL,
     name TEXT NOT NULL
   )`,
  `INSERT INTO ${MIGRATIONS_TABLE} (migration_id, created_at, name)
     VALUES (1, '2026-07-26 06:01:37', 'initial')`,
  `CREATE TABLE journeys (
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     journey_id TEXT NOT NULL UNIQUE,
     head_sha TEXT NOT NULL,
     base_sha TEXT NOT NULL,
     analyzed_at TEXT NOT NULL,
     harness TEXT NOT NULL,
     run_id TEXT NOT NULL,
     format_version INTEGER NOT NULL,
     artifact TEXT NOT NULL,
     PRIMARY KEY (owner, repo, number)
   )`,
  `CREATE TABLE read_state (
     journey_id TEXT PRIMARY KEY,
     document TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE TABLE pr_state (
     owner TEXT NOT NULL,
     repo TEXT NOT NULL,
     number INTEGER NOT NULL,
     reviewed INTEGER NOT NULL DEFAULT 0,
     hidden INTEGER NOT NULL DEFAULT 0,
     dismissed_merged INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (owner, repo, number)
   )`,
  `CREATE TABLE settings (
     id INTEGER PRIMARY KEY NOT NULL,
     document TEXT NOT NULL
   )`,
];

function writeDatabase(filename: string, statements: ReadonlyArray<string>): void {
  const database = new NodeSqlite.DatabaseSync(filename);
  try {
    for (const statement of statements) database.exec(statement);
  } finally {
    database.close();
  }
}

describe("journeys/schemaGuard", () => {
  it.effect("leaves a database whose schema matches alone", () =>
    Effect.gen(function* () {
      const dataDir = scratchDir("tl-schema-guard-");
      const filename = NodePath.join(dataDir, "throughline.db");

      // Let the real migrations create it, which is the only honest way to
      // produce "a schema this build agrees with".
      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* JourneyStore;
          yield* store.settings;
        }),
        journeyStoreLayer.pipe(
          Layer.provide(configLayer(dataDir)),
          Layer.provide(NodeServices.layer),
        ),
      );

      const displaced = yield* ensureReadableSchema(filename, "stamp");
      assert.strictEqual(displaced, null, "a matching schema must not be displaced");
      assert.isTrue(NodeFS.existsSync(filename));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a database with no migration ledger alone", () =>
    Effect.gen(function* () {
      const dataDir = scratchDir("tl-schema-guard-");
      const filename = NodePath.join(dataDir, "throughline.db");
      // No ledger: nothing has claimed anything about this file, so there is
      // nothing to contradict. Emptiness is not a mismatch.
      writeDatabase(filename, [`CREATE TABLE unrelated (x INTEGER)`]);

      const displaced = yield* ensureReadableSchema(filename, "stamp");
      assert.strictEqual(displaced, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a path that does not exist alone", () =>
    Effect.gen(function* () {
      const filename = NodePath.join(scratchDir("tl-schema-guard-"), "throughline.db");
      const displaced = yield* ensureReadableSchema(filename, "stamp");
      assert.strictEqual(displaced, null);
      assert.isFalse(NodeFS.existsSync(filename), "the probe must not create the file it inspects");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("displaces a database written by a build with a different schema", () =>
    Effect.gen(function* () {
      const dataDir = scratchDir("tl-schema-guard-");
      const filename = NodePath.join(dataDir, "throughline.db");
      writeDatabase(filename, PRIOR_SCHEMA);
      // A sidecar must travel with the file it belongs to: left behind, SQLite
      // would try to recover it into the fresh database.
      NodeFS.writeFileSync(`${filename}-wal`, "");

      const displaced = yield* ensureReadableSchema(filename, "stamp");

      assert.strictEqual(displaced, `${filename}.unreadable-stamp`);
      assert.isFalse(NodeFS.existsSync(filename), "the unreadable file must be moved aside");
      assert.isTrue(
        NodeFS.existsSync(`${filename}.unreadable-stamp`),
        "the old bytes must be kept, never deleted",
      );
      assert.isTrue(NodeFS.existsSync(`${filename}.unreadable-stamp-wal`));
      assert.isFalse(NodeFS.existsSync(`${filename}-wal`));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tolerates columns this build does not know about", () =>
    Effect.gen(function* () {
      const dataDir = scratchDir("tl-schema-guard-");
      const filename = NodePath.join(dataDir, "throughline.db");

      yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* JourneyStore;
          yield* store.settings;
        }),
        journeyStoreLayer.pipe(
          Layer.provide(configLayer(dataDir)),
          Layer.provide(NodeServices.layer),
        ),
      );
      // A *newer* build's database: everything this build needs, plus something
      // it has never heard of. Displacing that would turn "you downgraded" into
      // "your journeys are gone", which is the opposite of the trade the guard
      // exists to make.
      writeDatabase(filename, [`ALTER TABLE journeys ADD COLUMN future_thing TEXT`]);

      const displaced = yield* ensureReadableSchema(filename, "stamp");
      assert.strictEqual(displaced, null);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("makes the store usable again after an unreadable database", () =>
    Effect.gen(function* () {
      const dataDir = scratchDir("tl-schema-guard-");
      const filename = NodePath.join(dataDir, "throughline.db");
      writeDatabase(filename, PRIOR_SCHEMA);

      // The whole point, end to end: the store opens on a database it could not
      // have read, and works — because the layer displaced it and migrated fresh.
      const settings = yield* Effect.provide(
        Effect.gen(function* () {
          const store = yield* JourneyStore;
          const state = yield* store.prState;
          assert.deepStrictEqual(state.hidden, []);
          return yield* store.settings;
        }),
        journeyStoreLayer.pipe(
          Layer.provide(configLayer(dataDir)),
          Layer.provide(NodeServices.layer),
        ),
      );

      assert.strictEqual(settings.harness, null);
      const displacedFiles = NodeFS.readdirSync(dataDir).filter((name) =>
        name.includes(".unreadable-"),
      );
      assert.strictEqual(displacedFiles.length, 1, "exactly one file should be set aside");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
