import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../src/config.ts";
import { JourneyStore, layer as journeyStoreLayer } from "../../src/journeys/JourneyStore.ts";

interface LegacyDatabaseFixture {
  readonly root: string;
  readonly database: string;
}

const reviewedPr = { owner: "owner", repo: "repo", number: 7 } as const;

function createLegacyDatabase(): LegacyDatabaseFixture {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "throughline-store-test-"));
  const database = NodePath.join(root, "throughline.db");
  const sqlite = new NodeSqlite.DatabaseSync(database);
  sqlite.exec(`
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at DATETIME NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    );
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES (1, 'initial');
    CREATE TABLE journeys (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      journey_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      harness_kind TEXT NOT NULL,
      journey_json TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    );
    CREATE INDEX journeys_analyzed_at ON journeys (analyzed_at DESC);
    CREATE TABLE read_state (
      journey_id TEXT NOT NULL PRIMARY KEY,
      state_json TEXT NOT NULL,
      FOREIGN KEY (journey_id) REFERENCES journeys (journey_id) ON DELETE CASCADE
    );
    CREATE TABLE pr_state (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL
    );
    INSERT INTO pr_state (id, state_json) VALUES (
      1,
      '{"reviewed":[{"owner":"owner","repo":"repo","number":7}],"hidden":[],"dismissedMerged":[]}'
    );
    CREATE TABLE settings (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL
    );
    INSERT INTO settings (id, settings_json) VALUES (1, '{}');
  `);
  sqlite.close();
  return { root, database };
}

function layerFor(fixture: LegacyDatabaseFixture) {
  const config = ServerConfig.layer(
    ServerConfig.make({
      appName: "Throughline Test",
      version: "0.0.0-test",
      startedAt: DateTime.makeUnsafe(0),
      host: "127.0.0.1",
      port: 0,
      staticDir: undefined,
      devWebUrl: undefined,
      bootstrapToken: "test",
      dataDir: fixture.root,
      logDir: NodePath.join(fixture.root, "logs"),
      serverTracePath: NodePath.join(fixture.root, "logs", "server.trace.ndjson"),
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: false,
      traceBatchWindowMs: 1,
      traceMaxBytes: 1024,
      traceMaxFiles: 1,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 1000,
      otlpServiceName: "throughline-test",
    }),
  );
  const database = SqliteClient.layer({ filename: fixture.database }).pipe(
    Layer.provide(NodeServices.layer),
  );
  return journeyStoreLayer.pipe(
    Layer.provide(Layer.mergeAll(config, database, NodeServices.layer)),
  );
}

describe("JourneyStore", () => {
  it.effect("migrates the previous desktop schema without losing local review state", () =>
    Effect.acquireUseRelease(
      Effect.sync(createLegacyDatabase),
      (fixture) =>
        Effect.gen(function* () {
          const store = yield* JourneyStore;

          assert.deepEqual(yield* store.list, []);
          assert.deepEqual(yield* store.getPrState, {
            reviewed: [reviewedPr],
            hidden: [],
            dismissedMerged: [],
          });
          assert.deepEqual(yield* store.getSettings, {});

          const updated = yield* store.setPrState("hidden", {
            pr: reviewedPr,
            value: true,
          });
          assert.deepEqual(updated.hidden, [reviewedPr]);
        }).pipe(Effect.provide(layerFor(fixture))),
      (fixture) =>
        Effect.sync(() => {
          NodeFS.rmSync(fixture.root, { recursive: true, force: true });
        }),
    ),
  );
});
