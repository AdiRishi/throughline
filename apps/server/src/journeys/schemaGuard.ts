/**
 * The guard that stands between an unreadable database and a dead application.
 *
 * A migrator answers exactly one question: *what is the highest migration id
 * this file has run?* It never asks whether the schema those migrations left
 * behind is the schema the running code expects. That is a safe simplification
 * only while one invariant holds — **a migration id, once shipped, always
 * produces the same schema** — and the moment an id is edited in place instead
 * of superseded, the invariant breaks and the migrator becomes an accomplice:
 * it reads `1` in the ledger, skips the work, and hands back a database whose
 * every query fails.
 *
 * That failure is the worst shape a failure can take. It is total (nothing in
 * the product works), it is silent (startup succeeds; each individual query is
 * what fails, much later), and it arrives worded as though it were transient.
 * It is also not hypothetical: it is what a released app meets when a user
 * downgrades, and what a contributor meets on every branch switch that moves a
 * migration.
 *
 * So this module asks the question the migrator does not: **can my statements
 * actually run against this file?** It compares the tables and columns present
 * on disk against what the migration record is supposed to have produced, and
 * when they disagree it displaces the file so migrations run onto a clean one.
 *
 * **Why resetting is the right recovery here, and not data loss dressed up.**
 * Nothing in this database is a source of truth. A journey is a derived artifact
 * — rebuildable, by design, from the pull request and the harness. Read progress
 * is the one genuinely costly loss, and it is bounded by a single reanalysis;
 * local marks and settings are a few fields. Against that, the alternative is an
 * app that opens and does nothing, forever, with no route out that does not
 * involve a terminal. And the old bytes are never destroyed: the file is renamed,
 * not deleted, so nothing is unrecoverable by someone who wants it back.
 *
 * The guard is deliberately conservative. A file with no migration ledger is a
 * *new* database and is left entirely alone — being empty is not a mismatch.
 *
 * @module journeys/schemaGuard
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { EXPECTED_SCHEMA, MIGRATIONS_TABLE } from "./migrations.ts";

/** What the probe found: the columns present for each table, lowercased. */
type SchemaShape = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * One missing table or column, phrased for a log line.
 *
 * Collected rather than short-circuited: when a schema is from a different
 * generation, *every* difference is diagnostic, and the first one alone rarely
 * tells you which generation you are looking at.
 */
export interface SchemaMismatch {
  readonly table: string;
  readonly missingColumns: ReadonlyArray<string>;
  readonly tableMissing: boolean;
}

export function describeMismatches(mismatches: ReadonlyArray<SchemaMismatch>): string {
  return mismatches
    .map((mismatch) =>
      mismatch.tableMissing
        ? `${mismatch.table} (table missing)`
        : `${mismatch.table}.{${mismatch.missingColumns.join(",")}}`,
    )
    .join(", ");
}

/**
 * Compare a probed schema against the expectation.
 *
 * Extra tables and extra columns are *not* mismatches. A newer build may have
 * added a column this build never reads, and refusing to open that file would
 * turn "you downgraded" into "your data is gone" — the opposite of the trade
 * this module exists to make. Only absence breaks a statement.
 */
export function findMismatches(shape: SchemaShape): ReadonlyArray<SchemaMismatch> {
  const mismatches: SchemaMismatch[] = [];
  for (const [table, columns] of Object.entries(EXPECTED_SCHEMA)) {
    const present = shape.get(table);
    if (present === undefined) {
      mismatches.push({ table, missingColumns: [...columns], tableMissing: true });
      continue;
    }
    const missingColumns = columns.filter((column) => !present.has(column.toLowerCase()));
    if (missingColumns.length > 0) {
      mismatches.push({ table, missingColumns, tableMissing: false });
    }
  }
  return mismatches;
}

/**
 * Read the tables and columns of a SQLite file.
 *
 * Uses `node:sqlite` directly rather than the Effect client, for one reason that
 * matters: this connection must be *closed* before the file can be renamed, and
 * a short explicit open/close is a far clearer way to guarantee that than
 * borrowing a layer's scope. It is also the same driver the real client uses, so
 * a file this cannot open is a file the client could not have opened either.
 */
/**
 * `name` off an introspection row. The driver types every column as
 * `SQLOutputValue`, so the narrowing has to happen somewhere; doing it here keeps
 * the probe free of casts and drops anything that is not a string rather than
 * trusting the shape.
 */
function nameRows(rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> {
  return rows.map((row) => row["name"]).filter((name): name is string => typeof name === "string");
}

const probe = (filename: string): Effect.Effect<SchemaShape | null> =>
  Effect.sync(() => {
    let database: NodeSqlite.DatabaseSync | null = null;
    try {
      // `readOnly` keeps the probe from creating the file it is inspecting, so a
      // first run stays a first run.
      database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      const tables = nameRows(
        database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all(),
      );
      const shape = new Map<string, ReadonlySet<string>>();
      for (const name of tables) {
        const columns = nameRows(
          database.prepare(`SELECT name FROM pragma_table_info(?)`).all(name),
        );
        shape.set(name, new Set(columns.map((column) => column.toLowerCase())));
      }
      return shape;
    } catch {
      // An unopenable or corrupt file is not this module's problem to diagnose:
      // returning null leaves it exactly as it was for the client to fail on,
      // with the driver's own error rather than a guess from here.
      return null;
    } finally {
      database?.close();
    }
  });

/**
 * Displace `filename` (and its WAL sidecars) to a timestamped neighbour.
 *
 * The sidecars travel with it. A `-wal` left beside a fresh database is not
 * inert: SQLite will try to recover it into a file it does not belong to.
 */
const displace = Effect.fn("journeys.schemaGuard.displace")(function* (
  filename: string,
  stamp: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const target = `${filename}.unreadable-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${filename}${suffix}`;
    if (yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false))) {
      yield* fs.rename(from, `${target}${suffix}`).pipe(Effect.orDie);
    }
  }
  return target;
});

/**
 * Ensure the file at `filename` is one this build's statements can run against,
 * displacing it if it is not. Returns the path it was moved to, or null when the
 * file was left alone — which is the overwhelmingly common case.
 *
 * `stamp` is passed in rather than read from the clock so the decision stays a
 * pure function of its inputs and the naming is testable.
 */
export const ensureReadableSchema = Effect.fn("journeys.schemaGuard.ensureReadableSchema")(
  function* (filename: string, stamp: string) {
    const shape = yield* probe(filename);
    // No file, or one this driver cannot open at all: nothing to judge.
    if (shape === null) return null;
    // No ledger means no migration has ever claimed anything about this file, so
    // there is nothing to contradict. A brand-new database lands here.
    if (!shape.has(MIGRATIONS_TABLE)) return null;

    const mismatches = findMismatches(shape);
    if (mismatches.length === 0) return null;

    const target = yield* displace(filename, stamp);
    yield* Effect.logWarning(
      "The database was written by a build with a different schema and cannot be read. " +
        "It has been set aside and a new one will be created; journeys will need to be " +
        "analyzed again.",
      {
        database: filename,
        movedTo: target,
        missing: describeMismatches(mismatches),
      },
    );
    return target;
  },
);
