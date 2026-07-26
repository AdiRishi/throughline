/**
 * `JourneyStore` — everything durable, in one SQLite database.
 *
 * The split is hybrid, blob-style: the database holds *state*, and bulk
 * non-queryable artifacts (materialized diffs, harness transcripts, clone
 * workspaces) stay files beside it. What SQLite buys over flat files is exactly
 * what grows with the app — transactions (reanalysis replaces a journey row and
 * deletes its read state atomically), indexed listing for the welcome screen,
 * and one writer that will not degrade into a directory of many small files.
 *
 * The journey artifact is stored as JSON in a `TEXT` column and decoded through
 * its own contract schema on read. An undecodable or future-versioned blob is
 * treated as **absent** — re-ingest, never crash — which is what makes
 * `formatVersion` a real forward-compatibility mechanism rather than a comment.
 *
 * @module journeys/JourneyStore
 */
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-node/SqliteMigrator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  AppSettings,
  DEFAULT_DISPLAY_MODE,
  Journey,
  LocalPrState,
  ReadState,
  type ClusterId,
  type DisplayMode,
  type HarnessKind,
  type JourneyId,
  type PrRef,
  type UpdateSettingsInput,
} from "@app/contracts";

import * as ServerConfig from "../config.ts";
import { MIGRATIONS_TABLE, migrations } from "./migrations.ts";

// ── Row codecs, compiled once at module scope ───────────────────────────────

const JourneyRow = Schema.Struct({
  pr_key: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  journey_id: Schema.String,
  head_sha: Schema.String,
  base_sha: Schema.String,
  analyzed_at: Schema.String,
  harness_kind: Schema.String,
  cluster_count: Schema.Int,
  hunk_count: Schema.Int,
  file_count: Schema.Int,
  format_version: Schema.Int,
  artifact: Schema.String,
});
type JourneyRow = typeof JourneyRow.Type;

const decodeJourneyRows = Schema.decodeUnknownEffect(Schema.Array(JourneyRow));
const decodeJourneyArtifact = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Journey)),
);
const encodeJourneyArtifact = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Journey)),
);

const DocumentRow = Schema.Struct({ document: Schema.String });
const decodeDocumentRows = Schema.decodeUnknownEffect(Schema.Array(DocumentRow));

const ReadStateJson = Schema.fromJsonString(Schema.toCodecJson(ReadState));
const decodeReadState = Schema.decodeUnknownEffect(ReadStateJson);
const encodeReadState = Schema.encodeUnknownEffect(ReadStateJson);

const LocalPrStateJson = Schema.fromJsonString(Schema.toCodecJson(LocalPrState));
const decodeLocalPrState = Schema.decodeUnknownEffect(LocalPrStateJson);
const encodeLocalPrState = Schema.encodeUnknownEffect(LocalPrStateJson);

const AppSettingsJson = Schema.fromJsonString(Schema.toCodecJson(AppSettings));
const decodeAppSettings = Schema.decodeUnknownEffect(AppSettingsJson);
const encodeAppSettings = Schema.encodeUnknownEffect(AppSettingsJson);

// ── Public shapes ───────────────────────────────────────────────────────────

/** Indexed metadata, for the welcome screen's list without decoding artifacts. */
export interface JourneySummaryRow {
  readonly ref: PrRef;
  readonly journeyId: JourneyId;
  readonly headSha: string;
  readonly analyzedAt: DateTime.Utc;
  readonly harnessKind: HarnessKind;
  readonly clusterCount: number;
  readonly hunkCount: number;
  readonly fileCount: number;
}

/** What changed, so subscribers can re-derive without polling. */
export type StoreChange =
  | { readonly _tag: "journey"; readonly ref: PrRef }
  | { readonly _tag: "readState"; readonly journeyId: JourneyId }
  | { readonly _tag: "prState" }
  | { readonly _tag: "settings" };

export const prKey = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;

export class JourneyStore extends Context.Service<
  JourneyStore,
  {
    /** The journey for a PR, or none. An unreadable artifact reads as none. */
    readonly journey: (ref: PrRef) => Effect.Effect<Option.Option<Journey>, SqlError>;
    readonly journeyById: (id: JourneyId) => Effect.Effect<Option.Option<Journey>, SqlError>;
    /** Which PR a journey belongs to — the run directory needs it. */
    readonly refForJourney: (id: JourneyId) => Effect.Effect<Option.Option<PrRef>, SqlError>;
    /** Every journey's indexed metadata. Cheap: no artifact is decoded. */
    readonly summaries: Effect.Effect<ReadonlyArray<JourneySummaryRow>, SqlError>;
    /**
     * Commit a journey. One transaction: replace the row and drop the previous
     * journey's read state, so a reanalysis resets progress atomically and a
     * half-applied reanalysis cannot exist.
     */
    readonly commit: (journey: Journey) => Effect.Effect<void, SqlError>;

    readonly readState: (id: JourneyId) => Effect.Effect<ReadState, SqlError>;
    readonly markFile: (input: {
      readonly journeyId: JourneyId;
      readonly clusterId: ClusterId;
      readonly path: string;
      readonly read: boolean;
    }) => Effect.Effect<ReadState, SqlError>;
    readonly setDisplayMode: (input: {
      readonly journeyId: JourneyId;
      readonly displayMode: DisplayMode;
    }) => Effect.Effect<ReadState, SqlError>;

    readonly prState: Effect.Effect<LocalPrState, SqlError>;
    readonly setPrFlag: (input: {
      readonly ref: PrRef;
      readonly flag: "reviewed" | "hidden" | "dismissedMerged";
      readonly value: boolean;
    }) => Effect.Effect<LocalPrState, SqlError>;

    readonly settings: Effect.Effect<AppSettings, SqlError>;
    readonly updateSettings: (input: UpdateSettingsInput) => Effect.Effect<AppSettings, SqlError>;

    /** Every durable change, so the push buses can re-publish without polling. */
    readonly changes: Stream.Stream<StoreChange>;
  }
>()("@app/server/journeys/JourneyStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<StoreChange>();

  // SQLite's default is to fail immediately on a locked database. The store is
  // the only writer, but WAL sidecar files and a second window's reads make a
  // brief wait strictly better than an error.
  yield* sql`PRAGMA busy_timeout = 5000`.pipe(Effect.ignore);

  const publish = (change: StoreChange) => PubSub.publish(changes, change).pipe(Effect.asVoid);

  /**
   * Decode an artifact, treating failure as absence. This is the mechanism
   * behind "an undecodable or future-versioned blob is treated as absent":
   * the reviewer sees a not-analyzed PR and can re-ingest, instead of a crash.
   */
  const artifactOf = (row: JourneyRow): Effect.Effect<Option.Option<Journey>> =>
    row.format_version !== 1
      ? Effect.logWarning("Ignoring a journey written by a newer Throughline", {
          prKey: row.pr_key,
          formatVersion: row.format_version,
        }).pipe(Effect.as(Option.none()))
      : decodeJourneyArtifact(row.artifact).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            Effect.logWarning("Ignoring a journey artifact that could not be read", {
              prKey: row.pr_key,
              cause,
            }).pipe(Effect.as(Option.none())),
          ),
        );

  const journeyRow = (
    where: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  ): Effect.Effect<Option.Option<JourneyRow>, SqlError> =>
    where.pipe(
      Effect.flatMap((rows) => decodeJourneyRows(rows).pipe(Effect.orDie)),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const journey = (ref: PrRef) =>
    journeyRow(sql`SELECT * FROM journeys WHERE pr_key = ${prKey(ref)}`).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: artifactOf,
        }),
      ),
    );

  const journeyById = (id: JourneyId) =>
    journeyRow(sql`SELECT * FROM journeys WHERE journey_id = ${id}`).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: artifactOf,
        }),
      ),
    );

  const emptyReadState = (id: JourneyId): Effect.Effect<ReadState> =>
    DateTime.now.pipe(
      Effect.map((updatedAt) => ({
        journeyId: id,
        readFiles: [],
        displayMode: DEFAULT_DISPLAY_MODE,
        updatedAt,
      })),
    );

  const readState = (id: JourneyId): Effect.Effect<ReadState, SqlError> =>
    sql`SELECT document FROM read_state WHERE journey_id = ${id}`.pipe(
      Effect.flatMap((rows) => decodeDocumentRows(rows).pipe(Effect.orDie)),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return emptyReadState(id);
        return decodeReadState(row.document).pipe(
          // A corrupt read-state document costs progress, never the journey.
          Effect.catch(() => emptyReadState(id)),
        );
      }),
    );

  const writeReadState = (next: ReadState): Effect.Effect<ReadState, SqlError> =>
    Effect.gen(function* () {
      const document = yield* encodeReadState(next).pipe(Effect.orDie);
      const updatedAt = DateTime.formatIso(next.updatedAt);
      yield* sql`
        INSERT INTO read_state (journey_id, document, updated_at)
        VALUES (${next.journeyId}, ${document as string}, ${updatedAt})
        ON CONFLICT (journey_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at
      `;
      yield* publish({ _tag: "readState", journeyId: next.journeyId });
      return next;
    });

  const readDocument = <A>(
    query: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
    decode: (raw: string) => Effect.Effect<A, unknown>,
    fallback: A,
  ): Effect.Effect<A, SqlError> =>
    query.pipe(
      Effect.flatMap((rows) => decodeDocumentRows(rows).pipe(Effect.orDie)),
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) return Effect.succeed(fallback);
        return decode(row.document).pipe(Effect.orElseSucceed(() => fallback));
      }),
    );

  const EMPTY_PR_STATE: LocalPrState = { reviewed: [], hidden: [], dismissedMerged: [] };
  const DEFAULT_SETTINGS: AppSettings = { harness: null };

  const prState = readDocument(
    sql`SELECT document FROM pr_state WHERE id = 1`,
    decodeLocalPrState,
    EMPTY_PR_STATE,
  );

  const settings = readDocument(
    sql`SELECT document FROM settings WHERE id = 1`,
    decodeAppSettings,
    DEFAULT_SETTINGS,
  );

  const sameRef = (left: PrRef, right: PrRef) =>
    left.owner === right.owner && left.repo === right.repo && left.number === right.number;

  return {
    journey,
    journeyById,

    refForJourney: (id) =>
      journeyRow(sql`SELECT * FROM journeys WHERE journey_id = ${id}`).pipe(
        Effect.map(Option.map((row) => ({ owner: row.owner, repo: row.repo, number: row.number }))),
      ),

    summaries: sql`
      SELECT * FROM journeys ORDER BY analyzed_at DESC
    `.pipe(
      Effect.flatMap((rows) => decodeJourneyRows(rows).pipe(Effect.orDie)),
      Effect.map((rows) =>
        rows.flatMap((row): ReadonlyArray<JourneySummaryRow> => {
          const analyzedAt = DateTime.make(row.analyzed_at);
          if (Option.isNone(analyzedAt)) return [];
          return [
            {
              ref: { owner: row.owner, repo: row.repo, number: row.number },
              journeyId: row.journey_id as JourneyId,
              headSha: row.head_sha,
              analyzedAt: analyzedAt.value,
              harnessKind: row.harness_kind as HarnessKind,
              clusterCount: row.cluster_count,
              hunkCount: row.hunk_count,
              fileCount: row.file_count,
            },
          ];
        }),
      ),
    ),

    commit: (artifact) =>
      Effect.gen(function* () {
        const encoded = yield* encodeJourneyArtifact(artifact).pipe(Effect.orDie);
        const key = prKey(artifact.pr);

        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Reanalysis is a replacement: the previous journey's read state has
            // to go with it, in the same transaction, or progress could survive
            // into a journey it was never earned in.
            const previous = yield* journeyRow(sql`SELECT * FROM journeys WHERE pr_key = ${key}`);
            if (Option.isSome(previous)) {
              yield* sql`DELETE FROM read_state WHERE journey_id = ${previous.value.journey_id}`;
            }
            yield* sql`
              INSERT INTO journeys (
                pr_key, owner, repo, number, journey_id, head_sha, base_sha,
                analyzed_at, harness_kind, cluster_count, hunk_count, file_count,
                format_version, artifact
              ) VALUES (
                ${key}, ${artifact.pr.owner}, ${artifact.pr.repo}, ${artifact.pr.number},
                ${artifact.id}, ${artifact.pinned.headSha}, ${artifact.pinned.baseSha},
                ${DateTime.formatIso(artifact.pinned.analyzedAt)}, ${artifact.provenance.harnessKind},
                ${artifact.clusters.length}, ${artifact.hunks.length}, ${artifact.files.length},
                ${artifact.formatVersion}, ${encoded as string}
              )
              ON CONFLICT (pr_key) DO UPDATE SET
                journey_id = excluded.journey_id,
                head_sha = excluded.head_sha,
                base_sha = excluded.base_sha,
                analyzed_at = excluded.analyzed_at,
                harness_kind = excluded.harness_kind,
                cluster_count = excluded.cluster_count,
                hunk_count = excluded.hunk_count,
                file_count = excluded.file_count,
                format_version = excluded.format_version,
                artifact = excluded.artifact
            `;
          }),
        );

        yield* publish({ _tag: "journey", ref: artifact.pr });
      }).pipe(Effect.withSpan("journeyStore.commit")),

    readState,

    markFile: (input) =>
      Effect.gen(function* () {
        const current = yield* readState(input.journeyId);
        const without = current.readFiles.filter(
          (mark) => !(mark.clusterId === input.clusterId && mark.path === input.path),
        );
        const updatedAt = yield* DateTime.now;
        return yield* writeReadState({
          ...current,
          readFiles: input.read
            ? [...without, { clusterId: input.clusterId, path: input.path }]
            : without,
          updatedAt,
        });
      }),

    setDisplayMode: (input) =>
      Effect.gen(function* () {
        const current = yield* readState(input.journeyId);
        const updatedAt = yield* DateTime.now;
        return yield* writeReadState({
          ...current,
          displayMode: input.displayMode,
          updatedAt,
        });
      }),

    prState,

    setPrFlag: (input) =>
      Effect.gen(function* () {
        const current = yield* prState;
        const list = current[input.flag];
        const without = list.filter((ref) => !sameRef(ref, input.ref));
        const next: LocalPrState = {
          ...current,
          [input.flag]: input.value ? [...without, input.ref] : without,
        };
        const document = yield* encodeLocalPrState(next).pipe(Effect.orDie);
        yield* sql`
          INSERT INTO pr_state (id, document) VALUES (1, ${document as string})
          ON CONFLICT (id) DO UPDATE SET document = excluded.document
        `;
        yield* publish({ _tag: "prState" });
        return next;
      }),

    settings,

    updateSettings: (input) =>
      Effect.gen(function* () {
        const current = yield* settings;
        const next: AppSettings = {
          harness: input.harness === undefined ? current.harness : input.harness,
        };
        const document = yield* encodeAppSettings(next).pipe(Effect.orDie);
        yield* sql`
          INSERT INTO settings (id, document) VALUES (1, ${document as string})
          ON CONFLICT (id) DO UPDATE SET document = excluded.document
        `;
        yield* publish({ _tag: "settings" });
        return next;
      }),

    get changes() {
      return Stream.fromPubSub(changes);
    },
  } satisfies JourneyStore["Service"];
});

/**
 * The client layer. The driver rides Node's built-in `node:sqlite`, so there is
 * no native module to rebuild — the property that lets the same bundle run under
 * Electron's Node. The parent directory is created first, because an unopenable
 * path fails as a *defect* rather than a typed error.
 */
const clientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(config.dataDir, "throughline.db");
    yield* fs.makeDirectory(path.dirname(filename), { recursive: true }).pipe(Effect.orDie);
    return SqliteClient.layer({ filename });
  }),
);

/** Client + migrations. Migrations run once, during layer construction. */
export const databaseLayer = SqliteMigrator.layer({
  loader: migrations,
  table: MIGRATIONS_TABLE,
}).pipe(Layer.provideMerge(clientLayer));

/**
 * `provideMerge` rather than `provide`: the SQL client is exposed alongside the
 * store so tests can assert against the real database — corrupting a row is the
 * only honest way to test that an unreadable artifact reads as absent. Nothing in
 * the application reaches for `SqlClient` directly; the store is the only writer.
 */
export const layer = Layer.effect(JourneyStore, make).pipe(Layer.provideMerge(databaseLayer));
