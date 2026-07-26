/**
 * The welcome screen's view, assembled server-side.
 *
 * Staleness and progress are derivations over data the renderer would otherwise
 * have to fetch per row, so they are computed here — once, against the decoded
 * journeys the store already holds.
 *
 * The no-polling rule is a rule for this module too. GitHub's answer is held in
 * a ref and re-read only when the reviewer asks for it (app focus, explicit
 * refresh). Local changes — a file marked read, a PR hidden, a run finishing —
 * rebuild the view from the *held* answer and issue no request at all.
 *
 * @module welcome/PrListView
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  MERGED_LINGER_DAYS,
  prRefKey,
  type PrJourneyState,
  type PrListEntry,
  type PrListStatus,
  type PrListStreamEvent,
  type PrListView as PrListViewShape,
  type PrMarks,
  type PrSummary,
  type RepoPrGroup,
  type Viewer,
} from "@app/contracts";
import { clusterFractions, computeJourneyProgress } from "@app/journey/progress";

import { Ingestion } from "../analysis/Ingestion.ts";
import { GitHub, type PrListSource } from "../github/GitHub.ts";
import { JourneyStore } from "../journeys/JourneyStore.ts";

export class PrListView extends Context.Service<
  PrListView,
  {
    /** The current view, from the held GitHub answer. Never issues a request. */
    readonly current: Effect.Effect<PrListViewShape>;
    /** Explicit refresh — the only thing that goes back to GitHub. */
    readonly refresh: Effect.Effect<PrListViewShape>;
    /** Snapshot then live; re-emits whenever anything it derives from changes. */
    readonly changes: Stream.Stream<PrListStreamEvent>;
  }
>()("@app/server/welcome/PrListView") {}

interface Held {
  readonly source: PrListSource | null;
  readonly status: PrListStatus;
  /**
   * Current head per pull request that has a journey, from the single-PR view.
   *
   * The list query is GitHub's *search* index, and that index lags a push by
   * seconds to minutes — long enough for a journey to look fresh after the
   * pull request moved on. The single-PR endpoint is authoritative, so
   * staleness is decided from it. Only journeyed pull requests are looked up,
   * only when the list is (re)loaded, and every call is cached and gated like
   * any other.
   */
  readonly heads: ReadonlyMap<string, string>;
}

const EMPTY_VIEWER: Viewer = {
  login: null,
  ghInstalled: false,
  authenticated: false,
  host: null,
};

export const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const store = yield* JourneyStore;
  const ingestion = yield* Ingestion;

  const held = yield* Ref.make<Held>({
    source: null,
    status: { kind: "loading" },
    heads: new Map(),
  });
  const sequence = yield* Ref.make(0);

  /**
   * Bumped whenever the held GitHub answer changes.
   *
   * The welcome screen renders from `changes`, not from `refresh`'s return
   * value, so a refresh that only updated `held` would be invisible: the
   * reviewer pushes a commit, focus refreshes the list, the server learns the
   * journey is stale — and the screen goes on saying it is current.
   */
  const heldRevision = yield* SubscriptionRef.make(0);

  /** Ask GitHub, and turn every way that can go wrong into a visible state. */
  const load = Effect.fn("prListView.load")(function* (force: boolean) {
    const result = yield* (force ? github.refreshPrs : github.prs).pipe(Effect.result);
    if (result._tag === "Success") {
      const heads = yield* resolveHeads(result.success);
      yield* Ref.set(held, { source: result.success, status: { kind: "ok" }, heads });
    } else {
      const failure = result.failure;
      const status: PrListStatus =
        failure._tag === "GitHubParkedError"
          ? { kind: "parked", resetAt: failure.resetAt }
          : failure._tag === "GitHubUnavailableError"
            ? { kind: "gh-unavailable", reason: failure.reason, detail: failure.detail }
            : { kind: "error", detail: failure.detail };
      // The previously-held answer is kept: a rate limit should not blank the
      // screen a reviewer was reading a moment ago.
      yield* Ref.update(held, (current) => ({ ...current, status }));
    }
    // Both outcomes changed what the screen should say — a new head, or a new
    // reason it could not be fetched — so both wake the subscribers.
    yield* SubscriptionRef.update(heldRevision, (value) => value + 1);
  });

  /** Authoritative heads for the pull requests a journey is pinned against. */
  const resolveHeads = Effect.fn("prListView.resolveHeads")(function* (source: PrListSource) {
    const rows = yield* store.rows;
    const journeyed = new Set(rows.map((row) => prRefKey(row.pr)));
    const candidates = [...source.open, ...source.merged].filter((summary) =>
      journeyed.has(prRefKey(summary.ref)),
    );
    const resolved = yield* Effect.forEach(
      candidates,
      (summary) =>
        github.pr(summary.ref).pipe(
          Effect.map((detail) => [prRefKey(summary.ref), detail.summary.headSha] as const),
          // A head we could not resolve simply falls back to the list's own
          // value: better a possibly-late "stale" than a blocked screen.
          Effect.orElseSucceed(() => [prRefKey(summary.ref), summary.headSha] as const),
        ),
      { concurrency: 2 },
    );
    return new Map(resolved);
  });

  const build = Effect.fn("prListView.build")(function* () {
    const current = yield* Ref.get(held);
    const localState = yield* store.localPrState;
    const active = yield* ingestion.activePrs;
    const now = yield* DateTime.now;

    const marksFor = (summary: PrSummary): PrMarks => ({
      reviewed: localState.reviewed.some((ref) => prRefKey(ref) === prRefKey(summary.ref)),
      hidden: localState.hidden.some((ref) => prRefKey(ref) === prRefKey(summary.ref)),
      dismissedMerged: localState.dismissedMerged.some(
        (ref) => prRefKey(ref) === prRefKey(summary.ref),
      ),
    });

    const journeyFor = Effect.fn("prListView.journeyFor")(function* (summary: PrSummary) {
      const journey = yield* store.journeyFor(summary.ref);
      if (journey === null) return null;
      const readState = yield* store.readState(journey.id);
      const progress = computeJourneyProgress(journey, readState);
      return {
        journeyId: journey.id,
        analyzedAt: journey.pinned.analyzedAt,
        pinnedHeadSha: journey.pinned.headSha,
        // Computed at the moment of display, against the authoritative head —
        // so it can never be stale about being stale.
        stale:
          journey.pinned.headSha !== (current.heads.get(prRefKey(summary.ref)) ?? summary.headSha),
        clusterCount: journey.clusters.length,
        filesTotal: progress.filesTotal,
        filesRead: progress.filesRead,
        hunksHomed: progress.hunksHomed,
        hunksRead: progress.hunksRead,
        clusterFractions: clusterFractions(progress),
        currentClusterPosition: progress.currentClusterPosition,
        complete: progress.complete,
      } satisfies PrJourneyState;
    });

    const toEntry = Effect.fn("prListView.toEntry")(function* (summary: PrSummary) {
      return {
        pr: summary,
        journey: yield* journeyFor(summary),
        marks: marksFor(summary),
        ingesting: active.has(prRefKey(summary.ref)),
      } satisfies PrListEntry;
    });

    const openSummaries = (current.source?.open ?? []).filter(
      (summary) => !marksFor(summary).hidden,
    );
    const openEntries = yield* Effect.forEach(openSummaries, toEntry, { concurrency: 4 });

    // Repos in order of their most recently updated pull request: the list
    // should lead with what moved, not with the alphabet.
    const groups = new Map<string, PrListEntry[]>();
    for (const entry of openEntries) {
      const key = `${entry.pr.ref.owner}/${entry.pr.ref.repo}`;
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, [entry]);
      else existing.push(entry);
    }
    const repos: RepoPrGroup[] = [...groups.entries()]
      .map(([key, entries]) => {
        const [owner = "", repo = ""] = key.split("/");
        return { owner, repo, entries };
      })
      .toSorted((left, right) => latestUpdate(right.entries) - latestUpdate(left.entries));

    const cutoff = DateTime.subtractDuration(now, Duration.days(MERGED_LINGER_DAYS));
    const mergedSummaries = (current.source?.merged ?? []).filter((summary) => {
      const marks = marksFor(summary);
      if (marks.hidden || marks.dismissedMerged) return false;
      // Merged work lingers about a week, then leaves on its own.
      return summary.mergedAt !== null && DateTime.isGreaterThan(summary.mergedAt, cutoff);
    });
    const merged = yield* Effect.forEach(mergedSummaries, toEntry, { concurrency: 4 });

    return {
      viewer: current.source?.viewer ?? EMPTY_VIEWER,
      status: current.status,
      repos,
      merged: merged.toSorted((left, right) => mergedAtMillis(right.pr) - mergedAtMillis(left.pr)),
      refreshedAt: current.source?.fetchedAt ?? null,
    } satisfies PrListViewShape;
  });

  const currentView = Effect.gen(function* () {
    const state = yield* Ref.get(held);
    if (state.source === null && state.status.kind === "loading") yield* load(false);
    return yield* build();
  });

  return PrListView.of({
    current: currentView,
    refresh: load(true).pipe(Effect.andThen(build())),
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const buffer = yield* Queue.unbounded<void>();
        // Anything durable changing, and any ingestion event, re-derives the
        // view — from held data, with no request behind it.
        yield* Effect.forkScoped(
          SubscriptionRef.changes(store.revision).pipe(
            Stream.runForEach(() => Queue.offer(buffer, undefined)),
          ),
        );
        // And a refresh that actually reached GitHub, which is the only way a
        // journey learns its pull request moved ahead of it.
        yield* Effect.forkScoped(
          SubscriptionRef.changes(heldRevision).pipe(
            Stream.runForEach(() => Queue.offer(buffer, undefined)),
          ),
        );

        const first = yield* currentView;
        const seq = yield* Ref.updateAndGet(sequence, (value) => value + 1);
        const snapshot: PrListStreamEvent = {
          version: 1,
          sequence: seq,
          type: "snapshot",
          view: first,
        };
        const live = Stream.fromQueue(buffer).pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const view = yield* build();
              const next = yield* Ref.updateAndGet(sequence, (value) => value + 1);
              return {
                version: 1,
                sequence: next,
                type: "changed",
                view,
              } satisfies PrListStreamEvent;
            }),
          ),
        );
        return Stream.concat(Stream.make(snapshot), live);
      }),
    ),
  });
});

export const layer: Layer.Layer<PrListView, never, GitHub | JourneyStore | Ingestion> =
  Layer.effect(PrListView, make);

function latestUpdate(entries: ReadonlyArray<PrListEntry>): number {
  return entries.reduce(
    (latest, entry) => Math.max(latest, DateTime.toEpochMillis(entry.pr.updatedAt)),
    0,
  );
}

function mergedAtMillis(summary: PrSummary): number {
  return summary.mergedAt === null ? 0 : DateTime.toEpochMillis(summary.mergedAt);
}
