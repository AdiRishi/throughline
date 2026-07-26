/**
 * The one SQLite database, and the migrations that shape it.
 *
 * The driver rides Node's built-in `node:sqlite`, so there is no native module
 * to rebuild and nothing to break under Electron's bundled Node. Migrations run
 * at boot, before any service that reads a table is constructed.
 *
 * @module persistence/Database
 */
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { migrations } from "../journeys/JourneyStore.ts";

export const DATABASE_FILE = "throughline.db";

/**
 * Migrations declared in code rather than loaded from the filesystem: the
 * server ships as a single bundled file, and a directory loader would have
 * nothing to read there.
 */
const migratorLayer = SqliteMigrator.layer({
  loader: Migrator.fromRecord(migrations),
  table: "throughline_migrations",
});

const databaseLayer = (filename: string) =>
  migratorLayer.pipe(Layer.provideMerge(SqliteClient.layer({ filename })));

/**
 * The database, migrated.
 *
 * A database this build does not recognise — one written by a different schema,
 * so the first migration collides with tables it did not create — is **set
 * aside, not deleted, and not used**. The app then starts on a fresh file and
 * says what it did.
 *
 * That is the same posture the journey blob already takes ("an undecodable or
 * future-versioned blob is treated as absent — re-ingest, never crash"), for
 * the same reason: everything here is derived from GitHub and re-ingestible, so
 * refusing to start would cost a reviewer their whole app to protect data that
 * can be rebuilt. What is never acceptable is running *against* a schema we did
 * not establish, which is why the migrations carry no `IF NOT EXISTS` to paper
 * over the collision.
 */
export const layer: Layer.Layer<
  SqlClient.SqlClient,
  never,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(config.dataDir, { recursive: true }).pipe(Effect.ignore);
    const filename = path.join(config.dataDir, DATABASE_FILE);

    // Probe by building the real layer and closing it again: whether the
    // migrations can run *is* the question, and a defect counts as "no" just
    // as much as a typed failure does.
    const migrated = yield* Layer.build(databaseLayer(filename)).pipe(
      Effect.as(true),
      Effect.scoped,
      Effect.catchCause(() => Effect.succeed(false)),
    );
    if (migrated) return databaseLayer(filename);

    const now = yield* DateTime.now;
    const archived = `${filename}.unrecognized-${DateTime.formatIso(now).replaceAll(":", "-")}`;
    yield* Effect.logWarning(
      "The database at the data root was not written by this build; setting it aside and starting fresh.",
      { filename, archived },
    );
    // Not ignored: if the old file cannot be moved out of the way, starting
    // anyway would mean running against it after all.
    yield* fs.rename(filename, archived);
    // SQLite's WAL companions describe the file we just moved; leaving them
    // behind would let a fresh database inherit another one's journal.
    yield* fs.rename(`${filename}-wal`, `${archived}-wal`).pipe(Effect.ignore);
    yield* fs.rename(`${filename}-shm`, `${archived}-shm`).pipe(Effect.ignore);

    return databaseLayer(filename);
  }),
).pipe(Layer.orDie);
