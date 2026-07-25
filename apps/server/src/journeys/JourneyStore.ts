import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Reactivity } from "effect/unstable/reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  DisplayMode,
  GitHubOwner,
  GitHubRepositoryName,
  HarnessSelection,
  Journey,
  JourneyId,
  LocalPrState,
  PrRef,
  PullRequestNumber,
  ReadState,
  Settings,
  type ClusterFileReadMark,
} from "@app/contracts";

import * as ServerConfig from "../config.ts";

const DATABASE_FILE = "throughline.db";

const JourneyDocument = Schema.fromJsonString(Schema.toCodecJson(Journey));
const ReadStateDocument = Schema.fromJsonString(Schema.toCodecJson(ReadState));
const LocalPrStateDocument = Schema.fromJsonString(Schema.toCodecJson(LocalPrState));
const SettingsDocument = Schema.fromJsonString(Schema.toCodecJson(Settings));

const decodeJourneyDocument = Schema.decodeUnknownEffect(JourneyDocument);
const encodeJourneyDocument = Schema.encodeUnknownEffect(JourneyDocument);
const decodeReadStateDocument = Schema.decodeUnknownEffect(ReadStateDocument);
const encodeReadStateDocument = Schema.encodeUnknownEffect(ReadStateDocument);
const decodeLocalPrStateDocument = Schema.decodeUnknownEffect(LocalPrStateDocument);
const encodeLocalPrStateDocument = Schema.encodeUnknownEffect(LocalPrStateDocument);
const decodeSettingsDocument = Schema.decodeUnknownEffect(SettingsDocument);
const encodeSettingsDocument = Schema.encodeUnknownEffect(SettingsDocument);

const PrKey = Schema.Struct({
  owner: GitHubOwner,
  repo: GitHubRepositoryName,
  number: PullRequestNumber,
});

const StoredJourneyRow = Schema.Struct({
  journeyJson: Schema.String,
  runId: Schema.String,
  readStateJson: Schema.NullOr(Schema.String),
});
type StoredJourneyRow = typeof StoredJourneyRow.Type;

const RunReferenceRow = Schema.Struct({
  owner: GitHubOwner,
  repo: GitHubRepositoryName,
  number: PullRequestNumber,
  journeyId: JourneyId,
  runId: Schema.String,
});

const JourneyIdRequest = Schema.Struct({ journeyId: JourneyId });
const SingletonDocumentRow = Schema.Struct({ document: Schema.String });

const defaultLocalPrState: LocalPrState = {
  reviewed: [],
  hidden: [],
  dismissedMerged: [],
};

const defaultSettings: Settings = {};

const initialMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
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
    )
  `;
  yield* sql`
    CREATE INDEX journeys_analyzed_at
    ON journeys (analyzed_at DESC)
  `;
  yield* sql`
    CREATE TABLE read_state (
      journey_id TEXT NOT NULL PRIMARY KEY,
      state_json TEXT NOT NULL,
      FOREIGN KEY (journey_id) REFERENCES journeys (journey_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE TABLE pr_state (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      state_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE settings (
      id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL
    )
  `;
});

const migrationLoader = SqliteMigrator.fromRecord({
  "1_initial": initialMigration,
});

export class JourneyStoreError extends Schema.TaggedErrorClass<JourneyStoreError>()(
  "JourneyStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Journey store failed to ${this.operation}.`;
  }
}

export interface StoredJourney {
  readonly journey: Journey;
  readonly runId: string;
}

export interface JourneyMetadata extends StoredJourney {
  readonly readState: Option.Option<ReadState>;
}

export interface JourneyRunReference {
  readonly pr: PrRef;
  readonly journeyId: JourneyId;
  readonly runId: string;
}

type LocalPrStateKey = "reviewed" | "hidden" | "dismissedMerged";

export class JourneyStore extends Context.Service<
  JourneyStore,
  {
    readonly listMetadata: Effect.Effect<ReadonlyArray<JourneyMetadata>, JourneyStoreError>;
    readonly listRunReferences: Effect.Effect<
      ReadonlyArray<JourneyRunReference>,
      JourneyStoreError
    >;
    readonly getByPr: (pr: PrRef) => Effect.Effect<Option.Option<StoredJourney>, JourneyStoreError>;
    readonly getById: (
      journeyId: JourneyId,
    ) => Effect.Effect<Option.Option<StoredJourney>, JourneyStoreError>;
    readonly replace: (input: {
      readonly journey: Journey;
      readonly runId: string;
    }) => Effect.Effect<Option.Option<JourneyRunReference>, JourneyStoreError>;
    readonly remove: (
      pr: PrRef,
    ) => Effect.Effect<Option.Option<JourneyRunReference>, JourneyStoreError>;
    readonly getReadState: (
      journeyId: JourneyId,
    ) => Effect.Effect<Option.Option<ReadState>, JourneyStoreError>;
    readonly setDisplayMode: (
      journeyId: JourneyId,
      displayMode: DisplayMode,
    ) => Effect.Effect<ReadState, JourneyStoreError>;
    readonly setReadMark: (
      journeyId: JourneyId,
      mark: ClusterFileReadMark,
      read: boolean,
    ) => Effect.Effect<ReadState, JourneyStoreError>;
    readonly getLocalPrState: Effect.Effect<LocalPrState, JourneyStoreError>;
    readonly setReviewed: (
      pr: PrRef,
      reviewed: boolean,
    ) => Effect.Effect<LocalPrState, JourneyStoreError>;
    readonly setHidden: (
      pr: PrRef,
      hidden: boolean,
    ) => Effect.Effect<LocalPrState, JourneyStoreError>;
    readonly setDismissedMerged: (
      pr: PrRef,
      dismissed: boolean,
    ) => Effect.Effect<LocalPrState, JourneyStoreError>;
    readonly getSettings: Effect.Effect<Settings, JourneyStoreError>;
    readonly setHarness: (
      harness: HarnessSelection | undefined,
    ) => Effect.Effect<Settings, JourneyStoreError>;
  }
>()("@app/server/journeys/JourneyStore") {}

const storeError =
  (operation: string) =>
  (cause: unknown): JourneyStoreError =>
    new JourneyStoreError({ operation, cause });

const decodeOptionalDocument = <A, E>(
  document: string | null,
  decode: (input: unknown) => Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>> =>
  document === null ? Effect.succeedNone : decode(document).pipe(Effect.option);

const samePr = (left: PrRef, right: PrRef): boolean =>
  left.owner === right.owner && left.repo === right.repo && left.number === right.number;

const updatePrRefs = (
  refs: ReadonlyArray<PrRef>,
  pr: PrRef,
  marked: boolean,
): ReadonlyArray<PrRef> => {
  const without = refs.filter((entry) => !samePr(entry, pr));
  return marked ? [...without, pr] : without;
};

const makeService = (sql: SqlClient.SqlClient): JourneyStore["Service"] => {
  const findByPr = SqlSchema.findOneOption({
    Request: PrKey,
    Result: StoredJourneyRow,
    execute: ({ number, owner, repo }) => sql`
      SELECT
        journeys.journey_json AS "journeyJson",
        journeys.run_id AS "runId",
        read_state.state_json AS "readStateJson"
      FROM journeys
      LEFT JOIN read_state
        ON read_state.journey_id = journeys.journey_id
      WHERE journeys.owner = ${owner}
        AND journeys.repo = ${repo}
        AND journeys.number = ${number}
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: JourneyIdRequest,
    Result: StoredJourneyRow,
    execute: ({ journeyId }) => sql`
      SELECT
        journeys.journey_json AS "journeyJson",
        journeys.run_id AS "runId",
        read_state.state_json AS "readStateJson"
      FROM journeys
      LEFT JOIN read_state
        ON read_state.journey_id = journeys.journey_id
      WHERE journeys.journey_id = ${journeyId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: StoredJourneyRow,
    execute: () => sql`
      SELECT
        journeys.journey_json AS "journeyJson",
        journeys.run_id AS "runId",
        read_state.state_json AS "readStateJson"
      FROM journeys
      LEFT JOIN read_state
        ON read_state.journey_id = journeys.journey_id
      ORDER BY journeys.analyzed_at DESC
    `,
  });

  const listReferenceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunReferenceRow,
    execute: () => sql`
      SELECT
        owner,
        repo,
        number,
        journey_id AS "journeyId",
        run_id AS "runId"
      FROM journeys
      ORDER BY owner, repo, number
    `,
  });

  const findReferenceByPr = SqlSchema.findOneOption({
    Request: PrKey,
    Result: RunReferenceRow,
    execute: ({ number, owner, repo }) => sql`
      SELECT
        owner,
        repo,
        number,
        journey_id AS "journeyId",
        run_id AS "runId"
      FROM journeys
      WHERE owner = ${owner}
        AND repo = ${repo}
        AND number = ${number}
    `,
  });

  const findReadState = SqlSchema.findOneOption({
    Request: JourneyIdRequest,
    Result: SingletonDocumentRow,
    execute: ({ journeyId }) => sql`
      SELECT state_json AS document
      FROM read_state
      WHERE journey_id = ${journeyId}
    `,
  });

  const findLocalPrState = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: SingletonDocumentRow,
    execute: () => sql`
      SELECT state_json AS document
      FROM pr_state
      WHERE id = 1
    `,
  });

  const findSettings = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: SingletonDocumentRow,
    execute: () => sql`
      SELECT settings_json AS document
      FROM settings
      WHERE id = 1
    `,
  });

  const decodeStoredJourney = Effect.fn("JourneyStore.decodeStoredJourney")(function* (
    row: StoredJourneyRow,
  ): Effect.fn.Return<Option.Option<StoredJourney>> {
    const journey = yield* decodeJourneyDocument(row.journeyJson).pipe(Effect.option);
    return Option.map(
      journey,
      (artifact): StoredJourney => ({
        journey: artifact,
        runId: row.runId,
      }),
    );
  });

  const decodeJourneyMetadata = Effect.fn("JourneyStore.decodeJourneyMetadata")(function* (
    row: StoredJourneyRow,
  ): Effect.fn.Return<Option.Option<JourneyMetadata>> {
    const journey = yield* decodeJourneyDocument(row.journeyJson).pipe(Effect.option);
    if (Option.isNone(journey)) {
      return Option.none();
    }
    const readState = yield* decodeOptionalDocument(row.readStateJson, decodeReadStateDocument);
    return Option.some({
      journey: journey.value,
      runId: row.runId,
      readState,
    });
  });

  const getReadState = (journeyId: JourneyId) =>
    Effect.gen(function* () {
      const row = yield* findReadState({ journeyId });
      if (Option.isNone(row)) {
        return Option.none<ReadState>();
      }
      return yield* decodeReadStateDocument(row.value.document).pipe(Effect.option);
    }).pipe(
      Effect.mapError(storeError("read read state")),
      Effect.withSpan("journeys.readState.get"),
    );

  const mutateReadState = (
    journeyId: JourneyId,
    mutate: (current: ReadState, now: DateTime.Utc) => ReadState,
  ): Effect.Effect<ReadState, JourneyStoreError> =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const current = yield* findReadState({ journeyId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.succeed<ReadState>({
                journeyId,
                readFiles: [],
                displayMode: "inline",
                updatedAt: now,
              }),
            onSome: ({ document }) =>
              decodeReadStateDocument(document).pipe(
                Effect.orElseSucceed(
                  (): ReadState => ({
                    journeyId,
                    readFiles: [],
                    displayMode: "inline",
                    updatedAt: now,
                  }),
                ),
              ),
          }),
        ),
      );
      const next = mutate(current, now);
      const document = yield* encodeReadStateDocument(next);
      yield* sql`
        INSERT INTO read_state (journey_id, state_json)
        VALUES (${journeyId}, ${document})
        ON CONFLICT (journey_id) DO UPDATE SET
          state_json = excluded.state_json
      `;
      return next;
    }).pipe(
      sql.withTransaction,
      Effect.mapError(storeError("update read state")),
      Effect.withSpan("journeys.readState.update"),
    );

  const readLocalPrState = Effect.gen(function* () {
    const row = yield* findLocalPrState(undefined);
    if (Option.isNone(row)) {
      return defaultLocalPrState;
    }
    return yield* decodeLocalPrStateDocument(row.value.document).pipe(
      Effect.orElseSucceed(() => defaultLocalPrState),
    );
  });

  const mutateLocalPrState = (
    key: LocalPrStateKey,
    pr: PrRef,
    marked: boolean,
  ): Effect.Effect<LocalPrState, JourneyStoreError> =>
    Effect.gen(function* () {
      const current = yield* readLocalPrState;
      const next: LocalPrState = {
        ...current,
        [key]: updatePrRefs(current[key], pr, marked),
      };
      const document = yield* encodeLocalPrStateDocument(next);
      yield* sql`
        INSERT INTO pr_state (id, state_json)
        VALUES (1, ${document})
        ON CONFLICT (id) DO UPDATE SET
          state_json = excluded.state_json
      `;
      return next;
    }).pipe(
      sql.withTransaction,
      Effect.mapError(storeError(`update ${key} PR state`)),
      Effect.withSpan("journeys.localPrState.update", { attributes: { key } }),
    );

  const readSettings = Effect.gen(function* () {
    const row = yield* findSettings(undefined);
    if (Option.isNone(row)) {
      return defaultSettings;
    }
    return yield* decodeSettingsDocument(row.value.document).pipe(
      Effect.orElseSucceed(() => defaultSettings),
    );
  });

  return JourneyStore.of({
    listMetadata: Effect.gen(function* () {
      const rows = yield* listRows(undefined);
      const decoded = yield* Effect.forEach(rows, decodeJourneyMetadata);
      return decoded.flatMap(Option.toArray);
    }).pipe(
      Effect.mapError(storeError("list journey metadata")),
      Effect.withSpan("journeys.listMetadata"),
    ),

    listRunReferences: listReferenceRows(undefined).pipe(
      Effect.map((rows) =>
        rows.map(
          ({ journeyId, number, owner, repo, runId }): JourneyRunReference => ({
            pr: { owner, repo, number },
            journeyId,
            runId,
          }),
        ),
      ),
      Effect.mapError(storeError("list journey run references")),
      Effect.withSpan("journeys.listRunReferences"),
    ),

    getByPr: (pr) =>
      findByPr(pr).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: decodeStoredJourney,
          }),
        ),
        Effect.mapError(storeError("get journey by PR")),
        Effect.withSpan("journeys.getByPr"),
      ),

    getById: (journeyId) =>
      findById({ journeyId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeedNone,
            onSome: decodeStoredJourney,
          }),
        ),
        Effect.mapError(storeError("get journey by id")),
        Effect.withSpan("journeys.getById"),
      ),

    replace: ({ journey, runId }) =>
      Effect.gen(function* () {
        const document = yield* encodeJourneyDocument(journey);
        const previous = yield* findReferenceByPr(journey.pr);

        if (Option.isSome(previous)) {
          yield* sql`
            DELETE FROM read_state
            WHERE journey_id = ${previous.value.journeyId}
          `;
        }

        yield* sql`
          INSERT INTO journeys (
            owner,
            repo,
            number,
            journey_id,
            run_id,
            head_sha,
            base_sha,
            analyzed_at,
            harness_kind,
            journey_json
          )
          VALUES (
            ${journey.pr.owner},
            ${journey.pr.repo},
            ${journey.pr.number},
            ${journey.id},
            ${runId},
            ${journey.pinned.headSha},
            ${journey.pinned.baseSha},
            ${DateTime.formatIso(journey.pinned.analyzedAt)},
            ${journey.provenance.harnessKind},
            ${document}
          )
          ON CONFLICT (owner, repo, number) DO UPDATE SET
            journey_id = excluded.journey_id,
            run_id = excluded.run_id,
            head_sha = excluded.head_sha,
            base_sha = excluded.base_sha,
            analyzed_at = excluded.analyzed_at,
            harness_kind = excluded.harness_kind,
            journey_json = excluded.journey_json
        `;

        if (Option.isNone(previous) || previous.value.runId === runId) {
          return Option.none<JourneyRunReference>();
        }
        return Option.some({
          pr: {
            owner: previous.value.owner,
            repo: previous.value.repo,
            number: previous.value.number,
          },
          journeyId: previous.value.journeyId,
          runId: previous.value.runId,
        });
      }).pipe(
        sql.withTransaction,
        Effect.mapError(storeError("replace journey")),
        Effect.withSpan("journeys.replace"),
      ),

    remove: (pr) =>
      Effect.gen(function* () {
        const existing = yield* findReferenceByPr(pr);
        if (Option.isNone(existing)) {
          return Option.none<JourneyRunReference>();
        }
        yield* sql`
          DELETE FROM read_state
          WHERE journey_id = ${existing.value.journeyId}
        `;
        yield* sql`
          DELETE FROM journeys
          WHERE owner = ${pr.owner}
            AND repo = ${pr.repo}
            AND number = ${pr.number}
        `;
        return Option.some({
          pr,
          journeyId: existing.value.journeyId,
          runId: existing.value.runId,
        });
      }).pipe(
        sql.withTransaction,
        Effect.mapError(storeError("remove journey")),
        Effect.withSpan("journeys.remove"),
      ),

    getReadState,

    setDisplayMode: (journeyId, displayMode) =>
      mutateReadState(journeyId, (current, now) => ({
        ...current,
        displayMode,
        updatedAt: now,
      })),

    setReadMark: (journeyId, mark, read) =>
      mutateReadState(journeyId, (current, now) => {
        const matches = (entry: ClusterFileReadMark) =>
          entry.clusterId === mark.clusterId && entry.path === mark.path;
        return {
          ...current,
          readFiles: read
            ? current.readFiles.some(matches)
              ? current.readFiles
              : [...current.readFiles, mark]
            : current.readFiles.filter((entry) => !matches(entry)),
          updatedAt: now,
        };
      }),

    getLocalPrState: readLocalPrState.pipe(
      Effect.mapError(storeError("read local PR state")),
      Effect.withSpan("journeys.localPrState.get"),
    ),

    setReviewed: (pr, reviewed) => mutateLocalPrState("reviewed", pr, reviewed),

    setHidden: (pr, hidden) => mutateLocalPrState("hidden", pr, hidden),

    setDismissedMerged: (pr, dismissed) => mutateLocalPrState("dismissedMerged", pr, dismissed),

    getSettings: readSettings.pipe(
      Effect.mapError(storeError("read settings")),
      Effect.withSpan("journeys.settings.get"),
    ),

    setHarness: (harness) =>
      Effect.gen(function* () {
        const next: Settings = harness === undefined ? {} : { harness };
        const document = yield* encodeSettingsDocument(next);
        yield* sql`
          INSERT INTO settings (id, settings_json)
          VALUES (1, ${document})
          ON CONFLICT (id) DO UPDATE SET
            settings_json = excluded.settings_json
        `;
        return next;
      }).pipe(
        sql.withTransaction,
        Effect.mapError(storeError("update settings")),
        Effect.withSpan("journeys.settings.update"),
      ),
  });
};

export const makeAt = Effect.fn("JourneyStore.makeAt")(function* (filename: string) {
  const sql = yield* SqliteClient.make({ filename });
  yield* SqliteMigrator.run({ loader: migrationLoader }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError(storeError("migrate database")),
  );
  yield* sql`PRAGMA foreign_keys = ON`.pipe(Effect.mapError(storeError("enable foreign keys")));
  return makeService(sql);
});

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .makeDirectory(config.dataDir, { recursive: true })
    .pipe(Effect.mapError(storeError("create data directory")));
  return yield* makeAt(path.join(config.dataDir, DATABASE_FILE));
});

export const layerAt = (filename: string) =>
  Layer.effect(JourneyStore, makeAt(filename)).pipe(Layer.provide(Reactivity.layer));

export const layer = Layer.effect(JourneyStore, make).pipe(Layer.provide(Reactivity.layer));
