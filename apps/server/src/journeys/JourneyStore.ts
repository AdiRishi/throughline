/**
 * Everything durable: journeys, read state, local PR marks, settings.
 *
 * One SQLite database under the server-owned data root. The journey artifact
 * stays a JSON blob rather than relational rows because it is immutable and
 * read whole — decomposing it would buy schema-migration surface with no query
 * workload to justify it. What SQLite buys is what grows with the app:
 * transactions (reanalysis replaces a journey and drops its read state
 * atomically), indexed listing for the welcome screen, and a single-writer
 * store that will not degrade into a directory of many small files.
 *
 * Decoded journeys are cached in memory. That is safe precisely because a
 * journey is immutable: reanalysis mints a new id rather than mutating one, so
 * a cached artifact can never be stale.
 *
 * @module journeys/JourneyStore
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  Journey,
  JOURNEY_FORMAT_VERSION,
  prRefKey,
  Settings,
  type DisplayMode,
  type JourneyId,
  type LocalPrState,
  type PrRef,
  type ReadState,
  type ReadStateStreamEvent,
} from "@app/contracts";

/** The indexed columns — everything the welcome screen filters or sorts on. */
export interface JourneyRow {
  readonly pr: PrRef;
  readonly journeyId: JourneyId;
  readonly headSha: string;
  readonly baseSha: string;
  readonly analyzedAt: DateTime.Utc;
  readonly harness: string;
  readonly runId: string;
}

export class JourneyStore extends Context.Service<
  JourneyStore,
  {
    readonly journeyFor: (pr: PrRef) => Effect.Effect<Journey | null>;
    readonly journeyById: (journeyId: JourneyId) => Effect.Effect<Journey | null>;
    readonly rowFor: (pr: PrRef) => Effect.Effect<JourneyRow | null>;
    readonly rows: Effect.Effect<ReadonlyArray<JourneyRow>>;
    /**
     * Replace this PR's journey and drop the old one's read state, in one
     * transaction. A cancelled or failed run never reaches here, which is why a
     * partial journey cannot exist.
     */
    readonly saveJourney: (journey: Journey) => Effect.Effect<void>;

    readonly readState: (journeyId: JourneyId) => Effect.Effect<ReadState>;
    readonly markFile: (input: {
      readonly journeyId: JourneyId;
      readonly clusterId: string;
      readonly path: string;
      readonly read: boolean;
    }) => Effect.Effect<ReadState>;
    readonly setDisplayMode: (input: {
      readonly journeyId: JourneyId;
      readonly mode: DisplayMode;
    }) => Effect.Effect<ReadState>;
    readonly readStateChanges: (journeyId: JourneyId) => Stream.Stream<ReadStateStreamEvent>;

    readonly localPrState: Effect.Effect<LocalPrState>;
    readonly setPrMark: (input: {
      readonly pr: PrRef;
      readonly mark: "reviewed" | "hidden" | "dismissedMerged";
      readonly value: boolean;
    }) => Effect.Effect<void>;

    readonly settings: Effect.Effect<Settings>;
    readonly updateSettings: (settings: Settings) => Effect.Effect<Settings>;

    /**
     * Bumps on every durable change. The welcome screen's live view watches
     * this instead of polling, which is what keeps "nothing polls" true in the
     * UI as well as in the GitHub module.
     */
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
  }
>()("@app/server/journeys/JourneyStore") {}

const JourneyJson = Schema.fromJsonString(Schema.toCodecJson(Journey));
const decodeJourney = Schema.decodeUnknownEffect(JourneyJson);
const encodeJourney = Schema.encodeUnknownEffect(JourneyJson);

const ReadDocument = Schema.Struct({
  readFiles: Schema.Array(Schema.Struct({ clusterId: Schema.String, path: Schema.String })),
  displayMode: Schema.Literals(["inline", "just-the-code", "split"]),
});
const ReadDocumentJson = Schema.fromJsonString(ReadDocument);
const decodeReadDocument = Schema.decodeUnknownSync(ReadDocumentJson);
const encodeReadDocument = Schema.encodeUnknownSync(ReadDocumentJson);

const SettingsJson = Schema.fromJsonString(Settings);
const decodeSettings = Schema.decodeUnknownSync(SettingsJson);
const encodeSettings = Schema.encodeUnknownSync(SettingsJson);

const MARK_COLUMNS = {
  reviewed: "reviewed",
  hidden: "hidden",
  dismissedMerged: "dismissed_merged",
} as const;

const DEFAULT_DISPLAY_MODE: DisplayMode = "inline";
const JOURNEY_CACHE_CAPACITY = 32;

/**
 * Migrations are declared without `IF NOT EXISTS` on purpose. The migrator
 * already records which of these have run, so the guard would add no
 * idempotence — it would only turn "this database has a schema I do not
 * understand" from a loud failure at boot into a silent, wrong one at request
 * time. Failing to start is the better outcome.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "1_initial": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE journeys (
        owner       TEXT    NOT NULL,
        repo        TEXT    NOT NULL,
        number      INTEGER NOT NULL,
        journey_id  TEXT    NOT NULL UNIQUE,
        head_sha    TEXT    NOT NULL,
        base_sha    TEXT    NOT NULL,
        analyzed_at TEXT    NOT NULL,
        harness     TEXT    NOT NULL,
        run_id      TEXT    NOT NULL,
        format_version INTEGER NOT NULL,
        artifact    TEXT    NOT NULL,
        PRIMARY KEY (owner, repo, number)
      )
    `;
    yield* sql`CREATE INDEX journeys_analyzed_at ON journeys (analyzed_at DESC)`;
    yield* sql`
      CREATE TABLE read_state (
        journey_id TEXT PRIMARY KEY,
        document   TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE pr_state (
        owner            TEXT    NOT NULL,
        repo             TEXT    NOT NULL,
        number           INTEGER NOT NULL,
        reviewed         INTEGER NOT NULL DEFAULT 0,
        hidden           INTEGER NOT NULL DEFAULT 0,
        dismissed_merged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner, repo, number)
      )
    `;
    yield* sql`
      CREATE TABLE settings (
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        document TEXT NOT NULL
      )
    `;
  }),
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const revision = yield* SubscriptionRef.make(0);
  const readEvents: PubSub.PubSub<ReadStateStreamEvent> =
    yield* PubSub.unbounded<ReadStateStreamEvent>();
  const sequence = yield* Ref.make(0);

  const bump = SubscriptionRef.update(revision, (value) => value + 1);

  /**
   * A blob that will not decode — corrupt, or written by a future version — is
   * treated as absent. Re-ingest, never crash.
   */
  const loadJourney = Effect.fn("journeyStore.loadJourney")(function* (where: {
    readonly pr?: PrRef;
    readonly journeyId?: JourneyId;
  }) {
    const rows =
      where.pr !== undefined
        ? yield* sql<{ artifact: string; format_version: number }>`
            SELECT artifact, format_version FROM journeys
            WHERE owner = ${where.pr.owner} AND repo = ${where.pr.repo} AND number = ${where.pr.number}
          `
        : yield* sql<{ artifact: string; format_version: number }>`
            SELECT artifact, format_version FROM journeys WHERE journey_id = ${where.journeyId ?? ""}
          `;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.format_version !== JOURNEY_FORMAT_VERSION) {
      yield* Effect.logWarning("Ignoring a journey written by a different format version.", {
        formatVersion: row.format_version,
      });
      return null;
    }
    return yield* decodeJourney(row.artifact).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Ignoring an undecodable journey artifact; re-ingest to replace it.", {
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  });

  // Journeys are immutable, so a decoded artifact can never go stale: the only
  // way to change a PR's journey is to mint a new id.
  const journeyCache = yield* Cache.makeWith(
    (key: string) =>
      key.startsWith("id:")
        ? loadJourney({ journeyId: key.slice(3) as JourneyId })
        : loadJourney({ pr: parsePrKey(key) }),
    {
      capacity: JOURNEY_CACHE_CAPACITY,
      // Absence is not cacheable — a PR with no journey acquires one.
      timeToLive: (exit) =>
        exit._tag === "Success" && exit.value !== null ? Duration.infinity : Duration.zero,
      requireServicesAt: "construction",
    },
  );

  const rowOf = (row: {
    owner: string;
    repo: string;
    number: number;
    journey_id: string;
    head_sha: string;
    base_sha: string;
    analyzed_at: string;
    harness: string;
    run_id: string;
  }): JourneyRow => ({
    pr: { owner: row.owner, repo: row.repo, number: row.number },
    journeyId: row.journey_id as JourneyId,
    headSha: row.head_sha,
    baseSha: row.base_sha,
    analyzedAt: DateTime.makeUnsafe(row.analyzed_at),
    harness: row.harness,
    runId: row.run_id,
  });

  const readStateOf = Effect.fn("journeyStore.readState")(function* (journeyId: JourneyId) {
    const rows = yield* sql<{ document: string; updated_at: string }>`
      SELECT document, updated_at FROM read_state WHERE journey_id = ${journeyId}
    `;
    const row = rows[0];
    const now = yield* DateTime.now;
    if (row === undefined) {
      return {
        journeyId,
        readFiles: [],
        displayMode: DEFAULT_DISPLAY_MODE,
        updatedAt: now,
      } satisfies ReadState;
    }
    try {
      const document = decodeReadDocument(row.document);
      return {
        journeyId,
        readFiles: document.readFiles.map((mark) => ({
          clusterId: mark.clusterId as ReadState["readFiles"][number]["clusterId"],
          path: mark.path,
        })),
        displayMode: document.displayMode,
        updatedAt: DateTime.makeUnsafe(row.updated_at),
      } satisfies ReadState;
    } catch {
      return {
        journeyId,
        readFiles: [],
        displayMode: DEFAULT_DISPLAY_MODE,
        updatedAt: now,
      } satisfies ReadState;
    }
  });

  const writeReadState = Effect.fn("journeyStore.writeReadState")(function* (state: ReadState) {
    const document = encodeReadDocument({
      readFiles: state.readFiles.map((mark) => ({ clusterId: mark.clusterId, path: mark.path })),
      displayMode: state.displayMode,
    });
    const updatedAt = DateTime.formatIso(state.updatedAt);
    yield* sql`
      INSERT INTO read_state (journey_id, document, updated_at)
      VALUES (${state.journeyId}, ${document}, ${updatedAt})
      ON CONFLICT (journey_id) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at
    `;
    const next = yield* Ref.updateAndGet(sequence, (value) => value + 1);
    const event: ReadStateStreamEvent = {
      version: 1,
      sequence: next,
      type: "changed",
      state,
    };
    yield* PubSub.publish(readEvents, event);
    yield* bump;
    return state;
  });

  const mutateReadState = Effect.fn("journeyStore.mutateReadState")(function* (
    journeyId: JourneyId,
    mutate: (state: ReadState) => ReadState,
  ) {
    const current = yield* readStateOf(journeyId);
    const now = yield* DateTime.now;
    const next = { ...mutate(current), updatedAt: now };
    return yield* writeReadState(next);
  });

  return JourneyStore.of({
    journeyFor: (pr) => Cache.get(journeyCache, prKey(pr)).pipe(Effect.orDie),
    journeyById: (journeyId) => Cache.get(journeyCache, `id:${journeyId}`).pipe(Effect.orDie),

    rowFor: (pr) =>
      sql<JourneyRowShape>`
        SELECT owner, repo, number, journey_id, head_sha, base_sha, analyzed_at, harness, run_id
        FROM journeys WHERE owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}
      `.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : rowOf(rows[0]))),
        Effect.orDie,
      ),

    rows: sql<JourneyRowShape>`
      SELECT owner, repo, number, journey_id, head_sha, base_sha, analyzed_at, harness, run_id
      FROM journeys ORDER BY analyzed_at DESC
    `.pipe(
      Effect.map((rows) => rows.map(rowOf)),
      Effect.orDie,
    ),

    saveJourney: (journey) =>
      Effect.gen(function* () {
        const artifact = yield* encodeJourney(journey).pipe(Effect.orDie);
        yield* Effect.gen(function* () {
          // Read state is paired to a journey id, so dropping the previous
          // row is what makes "reanalysis resets progress" automatic rather
          // than a rule someone has to remember.
          yield* sql`
            DELETE FROM read_state WHERE journey_id IN (
              SELECT journey_id FROM journeys
              WHERE owner = ${journey.pr.owner} AND repo = ${journey.pr.repo} AND number = ${journey.pr.number}
            )
          `;
          yield* sql`
            INSERT INTO journeys (owner, repo, number, journey_id, head_sha, base_sha, analyzed_at, harness, run_id, format_version, artifact)
            VALUES (
              ${journey.pr.owner}, ${journey.pr.repo}, ${journey.pr.number}, ${journey.id},
              ${journey.pinned.headSha}, ${journey.pinned.baseSha},
              ${DateTime.formatIso(journey.pinned.analyzedAt)},
              ${journey.provenance.harnessKind}, ${journey.provenance.runId},
              ${journey.formatVersion}, ${artifact}
            )
            ON CONFLICT (owner, repo, number) DO UPDATE SET
              journey_id = excluded.journey_id,
              head_sha = excluded.head_sha,
              base_sha = excluded.base_sha,
              analyzed_at = excluded.analyzed_at,
              harness = excluded.harness,
              run_id = excluded.run_id,
              format_version = excluded.format_version,
              artifact = excluded.artifact
          `;
        }).pipe(sql.withTransaction, Effect.orDie);

        yield* Cache.invalidate(journeyCache, prKey(journey.pr));
        yield* bump;
      }),

    readState: (journeyId) => readStateOf(journeyId).pipe(Effect.orDie),

    markFile: (input) =>
      mutateReadState(input.journeyId, (state) => {
        const without = state.readFiles.filter(
          (mark) => !(mark.clusterId === input.clusterId && mark.path === input.path),
        );
        return input.read
          ? {
              ...state,
              readFiles: [
                ...without,
                {
                  clusterId: input.clusterId as ReadState["readFiles"][number]["clusterId"],
                  path: input.path,
                },
              ],
            }
          : { ...state, readFiles: without };
      }).pipe(Effect.orDie),

    setDisplayMode: (input) =>
      mutateReadState(input.journeyId, (state) => ({ ...state, displayMode: input.mode })).pipe(
        Effect.orDie,
      ),

    readStateChanges: (journeyId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Buffer live events before reading the snapshot, so a change that
          // lands between the two is delivered rather than dropped.
          const buffer = yield* Queue.unbounded<ReadStateStreamEvent>();
          yield* Effect.forkScoped(
            Stream.fromPubSub<ReadStateStreamEvent>(readEvents).pipe(
              Stream.filter((event) => event.state.journeyId === journeyId),
              Stream.runForEach((event) => Queue.offer(buffer, event)),
            ),
          );
          const state = yield* readStateOf(journeyId).pipe(Effect.orDie);
          const current = yield* Ref.get(sequence);
          const snapshot: ReadStateStreamEvent = {
            version: 1,
            sequence: current,
            type: "snapshot",
            state,
          };
          return Stream.concat(
            Stream.make(snapshot),
            Stream.fromQueue(buffer).pipe(
              Stream.filter((event) => event.sequence > snapshot.sequence),
            ),
          );
        }),
      ),

    localPrState: sql<{
      owner: string;
      repo: string;
      number: number;
      reviewed: number;
      hidden: number;
      dismissed_merged: number;
    }>`SELECT owner, repo, number, reviewed, hidden, dismissed_merged FROM pr_state`.pipe(
      Effect.map((rows): LocalPrState => {
        const pick = (predicate: (row: (typeof rows)[number]) => boolean) =>
          rows
            .filter(predicate)
            .map((row) => ({ owner: row.owner, repo: row.repo, number: row.number }));
        return {
          reviewed: pick((row) => row.reviewed === 1),
          hidden: pick((row) => row.hidden === 1),
          dismissedMerged: pick((row) => row.dismissed_merged === 1),
        };
      }),
      Effect.orDie,
    ),

    setPrMark: (input) =>
      Effect.gen(function* () {
        const column = MARK_COLUMNS[input.mark];
        const value = input.value ? 1 : 0;
        yield* sql`
          INSERT INTO pr_state (owner, repo, number, reviewed, hidden, dismissed_merged)
          VALUES (${input.pr.owner}, ${input.pr.repo}, ${input.pr.number}, 0, 0, 0)
          ON CONFLICT (owner, repo, number) DO NOTHING
        `;
        yield* sql`
          UPDATE pr_state SET ${sql(column)} = ${value}
          WHERE owner = ${input.pr.owner} AND repo = ${input.pr.repo} AND number = ${input.pr.number}
        `;
        yield* bump;
      }).pipe(Effect.orDie),

    settings: sql<{ document: string }>`SELECT document FROM settings WHERE id = 1`.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        if (row === undefined) return { harness: null } satisfies Settings;
        try {
          return decodeSettings(row.document);
        } catch {
          return { harness: null } satisfies Settings;
        }
      }),
      Effect.orDie,
    ),

    updateSettings: (next) =>
      Effect.gen(function* () {
        const document = encodeSettings(next);
        yield* sql`
          INSERT INTO settings (id, document) VALUES (1, ${document})
          ON CONFLICT (id) DO UPDATE SET document = excluded.document
        `;
        yield* bump;
        return next;
      }).pipe(Effect.orDie),

    revision,
  });
});

interface JourneyRowShape {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly journey_id: string;
  readonly head_sha: string;
  readonly base_sha: string;
  readonly analyzed_at: string;
  readonly harness: string;
  readonly run_id: string;
}

export const layer: Layer.Layer<JourneyStore, never, SqlClient.SqlClient> = Layer.effect(
  JourneyStore,
  make,
);

function prKey(pr: PrRef): string {
  return prRefKey(pr);
}

function parsePrKey(key: string): PrRef {
  const [repoPart = "", numberPart = "0"] = key.split("#");
  const [owner = "", repo = ""] = repoPart.split("/");
  return { owner, repo, number: Number.parseInt(numberPart, 10) };
}

/** Kept exported for the store's tests, which assert absence handling. */
export const readStateDefaults = { displayMode: DEFAULT_DISPLAY_MODE } as const;
