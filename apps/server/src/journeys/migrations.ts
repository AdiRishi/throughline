/**
 * Schema migrations, as an in-code record.
 *
 * `fromRecord` rather than `fromFileSystem` on purpose: the file-system loader
 * dynamic-imports migration files at runtime, which means shipping real files
 * next to `dist/bin.mjs` and keeping the bundler's hands off them. An in-code
 * record has nothing for a bundler to resolve, which matters because this server
 * runs from a single bundled file under Electron's Node.
 *
 * Two rules that keep the record honest: keys must match `<id>_<name>`, and an
 * id may never be renumbered or inserted below one that has shipped — ids at or
 * below the recorded latest are skipped, so a lower number would silently never
 * run.
 *
 * @module journeys/migrations
 */
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const MIGRATIONS_TABLE = "throughline_migrations";

export const migrations = SqliteMigrator.fromRecord({
  /**
   * The four tables the specification names. The journey stays a JSON blob
   * beside indexed metadata columns: it is immutable and read whole, so
   * decomposing it into rows would buy schema-migration surface with no query
   * workload to justify it.
   */
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE journeys (
        pr_key TEXT PRIMARY KEY NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        journey_id TEXT NOT NULL UNIQUE,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        harness_kind TEXT NOT NULL,
        cluster_count INTEGER NOT NULL,
        hunk_count INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        format_version INTEGER NOT NULL,
        artifact TEXT NOT NULL
      )
    `;
    yield* sql`CREATE INDEX journeys_analyzed_at ON journeys (analyzed_at DESC)`;

    yield* sql`
      CREATE TABLE read_state (
        journey_id TEXT PRIMARY KEY NOT NULL,
        document TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;

    // Single-row tables: the local marks and the app settings are each one
    // small document, and a document is exactly what the contract schema
    // decodes. `id = 1` is the whole primary key.
    yield* sql`
      CREATE TABLE pr_state (
        id INTEGER PRIMARY KEY NOT NULL,
        document TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE settings (
        id INTEGER PRIMARY KEY NOT NULL,
        document TEXT NOT NULL
      )
    `;
  }),
});
