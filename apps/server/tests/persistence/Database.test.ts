/**
 * A desktop app must not be bricked by a file it does not recognise.
 *
 * These pin both halves of that: an unrecognized database is set aside rather
 * than used or deleted, and a database this build did write is opened again
 * without disturbing anything in it.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../../src/config.ts";
import { DATABASE_FILE, layer as databaseLayer } from "../../src/persistence/Database.ts";

const configFor = (dataDir: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      return ServerConfig.layer(
        ServerConfig.make({
          appName: "Test App",
          version: "0.0.0-test",
          startedAt,
          host: "127.0.0.1",
          port: 0,
          staticDir: undefined,
          devWebUrl: undefined,
          bootstrapToken: "boot",
          dataDir,
          logDir: dataDir,
          serverTracePath: `${dataDir}/trace.ndjson`,
          logLevel: "Info",
          traceMinLevel: "Info",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "throughline-test",
        }),
      );
    }),
  );

/** Open the database once and report the tables it ended up with. */
const openAndListTables = (dataDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      name: string;
    }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
    return rows.map((row) => row.name);
  }).pipe(Effect.provide(databaseLayer.pipe(Layer.provide(configFor(dataDir)))), Effect.orDie);

it.layer(NodeServices.layer)("Database", (it) => {
  describe("an unrecognized database", () => {
    it.effect("is set aside rather than used or deleted", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dataDir = yield* fs.makeTempDirectoryScoped();
        const filename = path.join(dataDir, DATABASE_FILE);

        // A `journeys` table this build did not write, and no record of our
        // migrations — exactly the shape a different implementation leaves.
        const foreign = new NodeSqlite.DatabaseSync(filename);
        foreign.exec("CREATE TABLE journeys (something_else TEXT)");
        foreign.exec("INSERT INTO journeys VALUES ('keep me')");
        foreign.close();

        const tables = yield* openAndListTables(dataDir);

        // The app started, on its own schema.
        assert.includeMembers(tables, ["journeys", "read_state", "pr_state", "settings"]);

        // And the reviewer's old file is still there, under a new name.
        const entries = yield* fs.readDirectory(dataDir);
        const archived = entries.filter((entry) =>
          entry.startsWith(`${DATABASE_FILE}.unrecognized-`),
        );
        assert.lengthOf(archived, 1);
      }).pipe(Effect.scoped),
    );

    it.effect("opens a database this build wrote without disturbing it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dataDir = yield* fs.makeTempDirectoryScoped();

        const first = yield* openAndListTables(dataDir);
        const second = yield* openAndListTables(dataDir);

        assert.deepEqual(first, second);
        const entries = yield* fs.readDirectory(dataDir);
        assert.isFalse(entries.some((entry) => entry.includes("unrecognized")));
      }).pipe(Effect.scoped),
    );
  });
});
