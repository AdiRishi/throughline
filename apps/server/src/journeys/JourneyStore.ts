import { SqliteMigrator } from "@effect/sql-sqlite-node";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  Journey,
  JourneyId,
  JourneyNotFoundError,
  LocalPrState,
  ReadState as ReadStateSchema,
  Settings as SettingsSchema,
  type ClusterId,
  type DisplayMode,
  type Journey as JourneyType,
  type PrRef,
  type PrStateAction,
  type ReadState,
  type ReadStateStreamEvent,
  type Settings,
} from "@app/contracts";

import * as ServerConfig from "../config.ts";

const JourneyJson = Schema.fromJsonString(Schema.toCodecJson(Journey));
const LocalPrStateJson = Schema.fromJsonString(Schema.toCodecJson(LocalPrState));
const ReadStateJson = Schema.fromJsonString(Schema.toCodecJson(ReadStateSchema));
const SettingsJson = Schema.fromJsonString(Schema.toCodecJson(SettingsSchema));

const decodeJourney = Schema.decodeUnknownEffect(JourneyJson);
const decodeLocalPrState = Schema.decodeUnknownEffect(LocalPrStateJson);
const encodeJourney = Schema.encodeUnknownEffect(JourneyJson);
const decodeReadState = Schema.decodeUnknownEffect(ReadStateJson);
const encodeReadState = Schema.encodeUnknownEffect(ReadStateJson);
const decodeSettings = Schema.decodeUnknownEffect(SettingsJson);
const encodeSettings = Schema.encodeUnknownEffect(SettingsJson);

interface JourneyRow {
  readonly artifact_json: string;
  readonly run_dir: string;
}

interface LegacyJourneyRow {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly journey_id: string;
  readonly run_id: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly analyzed_at: string;
  readonly harness_kind: string;
  readonly journey_json: string;
}

interface LegacyPrStateRow {
  readonly state_json: string;
}

interface TableColumnRow {
  readonly name: string;
}

interface PrStateRow {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly kind: "reviewed" | "hidden" | "dismissedMerged";
}

interface ReadStateRow {
  readonly state_json: string;
}

interface SettingsRow {
  readonly settings_json: string;
}

interface ReadBusState {
  readonly sequence: number;
}

export interface StoredJourney {
  readonly journey: JourneyType;
  readonly runDir: string;
}

export class JourneyStore extends Context.Service<
  JourneyStore,
  {
    readonly get: (pr: PrRef) => Effect.Effect<StoredJourney, JourneyNotFoundError>;
    readonly getById: (journeyId: JourneyId) => Effect.Effect<StoredJourney, JourneyNotFoundError>;
    readonly list: Effect.Effect<ReadonlyArray<StoredJourney>>;
    readonly save: (stored: StoredJourney) => Effect.Effect<void>;
    readonly getReadState: (journeyId: JourneyId) => Effect.Effect<ReadState, JourneyNotFoundError>;
    readonly markFile: (input: {
      readonly journeyId: JourneyId;
      readonly clusterId: ClusterId;
      readonly path: string;
      readonly read: boolean;
    }) => Effect.Effect<ReadState, JourneyNotFoundError>;
    readonly setDisplayMode: (input: {
      readonly journeyId: JourneyId;
      readonly displayMode: DisplayMode;
    }) => Effect.Effect<ReadState, JourneyNotFoundError>;
    readonly readStateChanges: (
      journeyId: JourneyId,
    ) => Stream.Stream<ReadStateStreamEvent, JourneyNotFoundError>;
    readonly getPrState: Effect.Effect<LocalPrState>;
    readonly setPrState: (
      kind: PrStateRow["kind"],
      action: PrStateAction,
    ) => Effect.Effect<LocalPrState>;
    readonly getSettings: Effect.Effect<Settings>;
    readonly updateSettings: (settings: Settings) => Effect.Effect<Settings>;
  }
>()("@app/server/journeys/JourneyStore") {}

const createJourneysTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE journeys (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      journey_id TEXT NOT NULL UNIQUE,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      analyzed_at TEXT NOT NULL,
      harness_kind TEXT NOT NULL,
      run_dir TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      PRIMARY KEY (owner, repo, pr_number)
    )
  `;
  yield* sql`CREATE INDEX journeys_analyzed_at ON journeys(analyzed_at DESC)`;
});

const createReadStateTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE read_state (
      journey_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    )
  `;
});

const createPrStateTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE pr_state (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (owner, repo, pr_number, kind)
    )
  `;
});

const createSettingsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL
    )
  `;
});

const initialMigration = Effect.gen(function* () {
  yield* createJourneysTable;
  yield* createReadStateTable;
  yield* createPrStateTable;
  yield* createSettingsTable;
});

const productSchemaMigration = (path: Path.Path, dataDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journeyColumns = yield* sql<TableColumnRow>`PRAGMA table_info(journeys)`;
    const hasProductJourneys = journeyColumns.some(
      (column) => column.name === "pr_number" || column.name === "artifact_json",
    );
    if (!hasProductJourneys) {
      const legacyJourneys = yield* sql<LegacyJourneyRow>`SELECT
        owner, repo, number, journey_id, run_id, head_sha, base_sha,
        analyzed_at, harness_kind, journey_json
        FROM journeys`;
      const readStateColumns = yield* sql<TableColumnRow>`PRAGMA table_info(read_state)`;

      yield* sql`DROP INDEX IF EXISTS journeys_analyzed_at`;
      if (readStateColumns.length > 0) {
        yield* sql`ALTER TABLE read_state RENAME TO legacy_read_state_v1`;
      }
      yield* sql`ALTER TABLE journeys RENAME TO legacy_journeys_v1`;
      yield* createJourneysTable;
      yield* createReadStateTable;

      for (const row of legacyJourneys) {
        const runDir = path.join(
          dataDir,
          "runs",
          row.owner,
          row.repo,
          String(row.number),
          row.run_id,
        );
        yield* sql`INSERT INTO journeys (
          owner, repo, pr_number, journey_id, head_sha, base_sha,
          analyzed_at, harness_kind, run_dir, artifact_json
        ) VALUES (
          ${row.owner}, ${row.repo}, ${row.number}, ${row.journey_id},
          ${row.head_sha}, ${row.base_sha}, ${row.analyzed_at},
          ${row.harness_kind}, ${runDir}, ${row.journey_json}
        )`;
      }
      if (readStateColumns.length > 0) {
        yield* sql`INSERT INTO read_state (journey_id, state_json)
          SELECT journey_id, state_json
          FROM legacy_read_state_v1
          WHERE journey_id IN (SELECT journey_id FROM journeys)`;
        yield* sql`DROP TABLE legacy_read_state_v1`;
      }
      yield* sql`DROP TABLE legacy_journeys_v1`;
    }

    const prStateColumns = yield* sql<TableColumnRow>`PRAGMA table_info(pr_state)`;
    const hasProductPrState = prStateColumns.some((column) => column.name === "owner");
    if (!hasProductPrState) {
      const legacyRows = yield* sql<LegacyPrStateRow>`SELECT state_json FROM pr_state WHERE id = 1`;
      const legacyState =
        legacyRows[0] === undefined
          ? { reviewed: [], hidden: [], dismissedMerged: [] }
          : yield* decodeLocalPrState(legacyRows[0].state_json).pipe(
              Effect.orElseSucceed(() => ({
                reviewed: [],
                hidden: [],
                dismissedMerged: [],
              })),
            );

      yield* sql`ALTER TABLE pr_state RENAME TO legacy_pr_state_v1`;
      yield* createPrStateTable;
      for (const kind of ["reviewed", "hidden", "dismissedMerged"] as const) {
        for (const pr of legacyState[kind]) {
          yield* sql`INSERT INTO pr_state (owner, repo, pr_number, kind)
            VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${kind})`;
        }
      }
      yield* sql`DROP TABLE legacy_pr_state_v1`;
    }
  });

function rowsToPrState(rows: ReadonlyArray<PrStateRow>): LocalPrState {
  const refs = (kind: PrStateRow["kind"]) =>
    rows
      .filter((row) => row.kind === kind)
      .map((row) => ({ owner: row.owner, repo: row.repo, number: row.number }));
  return {
    reviewed: refs("reviewed"),
    hidden: refs("hidden"),
    dismissedMerged: refs("dismissedMerged"),
  };
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  yield* SqliteMigrator.run({
    loader: SqliteMigrator.fromRecord({
      "1_initial": initialMigration,
      "2_product_schema": productSchemaMigration(path, config.dataDir),
    }),
  }).pipe(Effect.orDie);

  const readBusState = yield* SynchronizedRef.make<ReadBusState>({ sequence: 0 });
  const readPubSub = yield* PubSub.unbounded<ReadStateStreamEvent>();

  const decodeStored = (row: JourneyRow): Effect.Effect<StoredJourney, JourneyNotFoundError> =>
    decodeJourney(row.artifact_json).pipe(
      Effect.map((journey) => ({ journey, runDir: row.run_dir })),
      Effect.mapError(() => new JourneyNotFoundError({})),
    );

  const get = (pr: PrRef) =>
    sql<JourneyRow>`SELECT artifact_json, run_dir
      FROM journeys
      WHERE owner = ${pr.owner} AND repo = ${pr.repo} AND pr_number = ${pr.number}
      LIMIT 1`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined ? new JourneyNotFoundError({ pr }) : decodeStored(row);
      }),
      Effect.withSpan("journeys.get"),
    );

  const getById = (journeyId: JourneyId) =>
    sql<JourneyRow>`SELECT artifact_json, run_dir
      FROM journeys
      WHERE journey_id = ${journeyId}
      LIMIT 1`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined ? new JourneyNotFoundError({ journeyId }) : decodeStored(row);
      }),
      Effect.withSpan("journeys.getById"),
    );

  const list = sql<JourneyRow>`SELECT artifact_json, run_dir
    FROM journeys
    ORDER BY analyzed_at DESC`.pipe(
    Effect.orDie,
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) => decodeStored(row).pipe(Effect.option)).pipe(
        Effect.map((items) => items.flatMap(Option.toArray)),
      ),
    ),
    Effect.withSpan("journeys.list"),
  );

  const getReadState = (journeyId: JourneyId): Effect.Effect<ReadState, JourneyNotFoundError> =>
    Effect.gen(function* () {
      yield* getById(journeyId);
      const rows = yield* sql<ReadStateRow>`SELECT state_json
        FROM read_state
        WHERE journey_id = ${journeyId}
        LIMIT 1`.pipe(Effect.orDie);
      const row = rows[0];
      if (row !== undefined) {
        return yield* decodeReadState(row.state_json).pipe(
          Effect.map((state) => state as ReadState),
          Effect.mapError(() => new JourneyNotFoundError({ journeyId })),
        );
      }
      const state: ReadState = {
        journeyId,
        readFiles: [],
        displayMode: "inline",
        updatedAt: yield* DateTime.now,
      };
      return state;
    }).pipe(Effect.withSpan("journeys.getReadState"));

  const commitReadState = (
    journeyId: JourneyId,
    update: (current: ReadState) => Effect.Effect<ReadState, JourneyNotFoundError>,
  ): Effect.Effect<ReadState, JourneyNotFoundError> =>
    SynchronizedRef.modifyEffect(readBusState, (bus) =>
      Effect.gen(function* () {
        const current = yield* getReadState(journeyId);
        const next = yield* update(current);
        const stateJson = yield* encodeReadState(next).pipe(Effect.orDie);
        yield* sql`INSERT INTO read_state (journey_id, state_json)
          VALUES (${journeyId}, ${stateJson})
          ON CONFLICT(journey_id) DO UPDATE SET state_json = excluded.state_json`.pipe(
          Effect.orDie,
        );
        const event: ReadStateStreamEvent = {
          version: 1,
          sequence: bus.sequence + 1,
          type: "updated",
          state: next,
        };
        yield* PubSub.publish(readPubSub, event);
        return [next, { sequence: event.sequence }] as const;
      }),
    );

  return JourneyStore.of({
    get,
    getById,
    list,
    save: ({ journey, runDir }) =>
      Effect.gen(function* () {
        const artifactJson = yield* encodeJourney(journey).pipe(Effect.orDie);
        const analyzedAt = DateTime.formatIso(journey.pinned.analyzedAt);
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM read_state
                WHERE journey_id IN (
                  SELECT journey_id FROM journeys
                  WHERE owner = ${journey.pr.owner}
                    AND repo = ${journey.pr.repo}
                    AND pr_number = ${journey.pr.number}
                )`;
              yield* sql`INSERT INTO journeys (
                  owner, repo, pr_number, journey_id, head_sha, base_sha,
                  analyzed_at, harness_kind, run_dir, artifact_json
                ) VALUES (
                  ${journey.pr.owner}, ${journey.pr.repo}, ${journey.pr.number},
                  ${journey.id}, ${journey.pinned.headSha}, ${journey.pinned.baseSha},
                  ${analyzedAt}, ${journey.provenance.harnessKind}, ${runDir}, ${artifactJson}
                )
                ON CONFLICT(owner, repo, pr_number) DO UPDATE SET
                  journey_id = excluded.journey_id,
                  head_sha = excluded.head_sha,
                  base_sha = excluded.base_sha,
                  analyzed_at = excluded.analyzed_at,
                  harness_kind = excluded.harness_kind,
                  run_dir = excluded.run_dir,
                  artifact_json = excluded.artifact_json`;
            }),
          )
          .pipe(Effect.orDie);
      }).pipe(Effect.withSpan("journeys.save")),
    getReadState,
    markFile: ({ clusterId, journeyId, path, read }) =>
      commitReadState(journeyId, (current) =>
        DateTime.now.pipe(
          Effect.map((updatedAt): ReadState => {
            const without = current.readFiles.filter(
              (entry) => !(entry.clusterId === clusterId && entry.path === path),
            );
            return {
              ...current,
              readFiles: read ? [...without, { clusterId, path }] : without,
              updatedAt,
            };
          }),
        ),
      ),
    setDisplayMode: ({ displayMode, journeyId }) =>
      commitReadState(journeyId, (current) =>
        DateTime.now.pipe(
          Effect.map((updatedAt): ReadState => ({ ...current, displayMode, updatedAt })),
        ),
      ),
    readStateChanges: (journeyId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const liveBuffer = yield* Queue.unbounded<ReadStateStreamEvent>();
          yield* Effect.forkScoped(
            Stream.fromPubSub(readPubSub).pipe(
              Stream.filter((event) => event.state.journeyId === journeyId),
              Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
            ),
          );
          const state = yield* getReadState(journeyId);
          const bus = yield* SynchronizedRef.get(readBusState);
          const snapshot: ReadStateStreamEvent = {
            version: 1,
            sequence: bus.sequence,
            type: "snapshot",
            state,
          };
          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromQueue(liveBuffer).pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            ),
          );
        }),
      ),
    getPrState: sql<PrStateRow>`SELECT
        owner, repo, pr_number AS number, kind
      FROM pr_state
      ORDER BY owner, repo, pr_number`.pipe(Effect.orDie, Effect.map(rowsToPrState)),
    setPrState: (kind, action) =>
      Effect.gen(function* () {
        if (action.value) {
          yield* sql`INSERT OR IGNORE INTO pr_state (owner, repo, pr_number, kind)
            VALUES (${action.pr.owner}, ${action.pr.repo}, ${action.pr.number}, ${kind})`;
        } else {
          yield* sql`DELETE FROM pr_state
            WHERE owner = ${action.pr.owner}
              AND repo = ${action.pr.repo}
              AND pr_number = ${action.pr.number}
              AND kind = ${kind}`;
        }
        const rows = yield* sql<PrStateRow>`SELECT
          owner, repo, pr_number AS number, kind
          FROM pr_state
          ORDER BY owner, repo, pr_number`;
        return rowsToPrState(rows);
      }).pipe(Effect.orDie, Effect.withSpan(`journeys.prState.${kind}`)),
    getSettings: sql<SettingsRow>`SELECT settings_json
      FROM settings
      WHERE id = 1
      LIMIT 1`.pipe(
      Effect.orDie,
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row === undefined
          ? Effect.succeed({})
          : decodeSettings(row.settings_json).pipe(
              Effect.map((settings) => settings as Settings),
              Effect.orElseSucceed((): Settings => ({})),
            );
      }),
    ),
    updateSettings: (settings) =>
      Effect.gen(function* () {
        const settingsJson = yield* encodeSettings(settings).pipe(Effect.orDie);
        yield* sql`INSERT INTO settings (id, settings_json)
          VALUES (1, ${settingsJson})
          ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json`;
        return settings;
      }).pipe(Effect.orDie, Effect.withSpan("journeys.updateSettings")),
  });
});

export const layer = Layer.effect(JourneyStore, make);
