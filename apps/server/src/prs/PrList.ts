/**
 * The welcome screen, assembled server-side.
 *
 * This module exists because the welcome screen's content is a *fold* over four
 * sources — GitHub's PR list, the journeys on disk, their read state, and the
 * reviewer's local marks — and folding it in the renderer would mean four
 * subscriptions racing each other toward an inconsistent screen. Folding it here
 * makes every window agree by construction.
 *
 * The no-polling rule is a rule of this file too: nothing here runs on a timer.
 * Snapshots are published when something *happens* — a refresh lands, a journey
 * is committed, a mark is set, an ingestion job moves.
 *
 * @module prs/PrList
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type {
  PrJourneyState,
  PrListChangeReason,
  PrListEntry,
  PrListSnapshot,
  PrRef,
  PrRepoGroup,
  PrSummary,
} from "@app/contracts";
import { computeJourneyProgress } from "@app/journey/progress";

import { Ingestion, isLive } from "../analysis/Ingestion.ts";
import { GitHub } from "../github/GitHub.ts";
import { JourneyStore } from "../journeys/JourneyStore.ts";

/**
 * How long a merged pull request lingers. Recently merged work is still part of
 * the reviewer's mental landscape, so it settles into its own section rather
 * than vanishing — closure without clutter.
 */
const MERGED_RETENTION = Duration.days(7);

export class PrList extends Context.Service<
  PrList,
  {
    /** The current snapshot. Serves the unary read and every stream's first event. */
    readonly snapshot: Effect.Effect<PrListSnapshot>;
    /** Snapshot-then-live: every change republishes the whole (small) list. */
    readonly changes: Stream.Stream<{
      readonly reason: PrListChangeReason;
      readonly list: PrListSnapshot;
    }>;
    /** Explicit refresh. Returns false when the module's own floor said "not yet". */
    readonly refresh: Effect.Effect<boolean>;
  }
>()("@app/server/prs/PrList") {}

const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const store = yield* JourneyStore;
  const ingestion = yield* Ingestion;

  const refreshing = yield* Ref.make(false);
  const changes = yield* PubSub.unbounded<{
    readonly reason: PrListChangeReason;
    readonly list: PrListSnapshot;
  }>();

  const sameRef = (left: PrRef, right: PrRef) =>
    left.owner === right.owner && left.repo === right.repo && left.number === right.number;

  /**
   * Derived journey state for one PR. Progress is computed from the artifact and
   * the read state every time — never stored — so the welcome screen and the
   * reading experience cannot disagree about how far along a journey is.
   */
  const journeyStateFor = Effect.fn("prList.journeyState")(function* (
    pr: PrSummary,
  ): Effect.fn.Return<PrJourneyState | null> {
    const journey = yield* store.journey(pr.ref).pipe(Effect.orElseSucceed(() => undefined));
    if (journey === undefined || journey._tag === "None") return null;
    const artifact = journey.value;
    const readState = yield* store.readState(artifact.id).pipe(
      Effect.map((state) => state),
      Effect.orElseSucceed(() => null),
    );
    const progress = computeJourneyProgress(artifact, readState);
    return {
      journeyId: artifact.id,
      analyzedAt: artifact.pinned.analyzedAt,
      pinnedHeadSha: artifact.pinned.headSha,
      // Staleness is never stored: it is this comparison, made at the moment of
      // display, so it cannot be stale about being stale.
      stale: artifact.pinned.headSha !== pr.headSha,
      clusterCount: artifact.clusters.length,
      currentClusterPosition: progress.currentClusterPosition,
      filesRead: progress.filesRead,
      filesTotal: progress.filesTotal,
      progress: progress.fraction,
      complete: progress.complete,
    };
  });

  const build = Effect.fn("prList.build")(function* () {
    const viewer = yield* github.identity;
    const health = yield* github.health;
    const listing = yield* github.prs.pipe(
      Effect.map((value) => value),
      Effect.orElseSucceed(() => null),
    );
    const marks = yield* store.prState.pipe(
      Effect.orElseSucceed(() => ({ reviewed: [], hidden: [], dismissedMerged: [] })),
    );
    const jobs = yield* ingestion.jobs;
    const now = yield* DateTime.now;
    const inFlight = yield* Ref.get(refreshing);

    const hidden = (ref: PrRef) => marks.hidden.some((entry) => sameRef(entry, ref));
    const reviewed = (ref: PrRef) => marks.reviewed.some((entry) => sameRef(entry, ref));
    const dismissed = (ref: PrRef) => marks.dismissedMerged.some((entry) => sameRef(entry, ref));
    const ingesting = (ref: PrRef) => jobs.some((job) => sameRef(job.pr, ref) && isLive(job.phase));

    const toEntry = Effect.fn("prList.entry")(function* (pr: PrSummary) {
      const journey = yield* journeyStateFor(pr);
      return {
        pr,
        journey,
        reviewed: reviewed(pr.ref),
        ingesting: ingesting(pr.ref),
      } satisfies PrListEntry;
    });

    const open = (listing?.open ?? []).filter((pr) => !hidden(pr.ref));
    const merged = (listing?.merged ?? []).filter((pr) => {
      if (hidden(pr.ref) || dismissed(pr.ref)) return false;
      if (pr.mergedAt === null) return false;
      const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(pr.mergedAt);
      return age <= Duration.toMillis(MERGED_RETENTION);
    });

    const openEntries = yield* Effect.forEach(open, toEntry, { concurrency: 8 });
    const mergedEntries = yield* Effect.forEach(merged, toEntry, { concurrency: 8 });

    // Repo-grouped, groups ordered by their most recently updated PR, so the
    // repository the reviewer is actually working in comes first.
    const grouped = new Map<string, PrListEntry[]>();
    for (const entry of openEntries) {
      const key = `${entry.pr.ref.owner}/${entry.pr.ref.repo}`;
      const group = grouped.get(key);
      if (group === undefined) grouped.set(key, [entry]);
      else group.push(entry);
    }
    const groups: PrRepoGroup[] = [...grouped.entries()]
      .map(([key, entries]) => {
        const [owner = "", repo = ""] = key.split("/");
        return {
          owner,
          repo,
          entries: entries.toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.pr.updatedAt) -
              DateTime.toEpochMillis(left.pr.updatedAt),
          ),
        };
      })
      .toSorted((left, right) => {
        const newest = (group: PrRepoGroup) =>
          Math.max(...group.entries.map((entry) => DateTime.toEpochMillis(entry.pr.updatedAt)), 0);
        return newest(right) - newest(left);
      });

    return {
      viewer,
      groups,
      merged: mergedEntries.toSorted((left, right) => {
        const at = (entry: PrListEntry) =>
          entry.pr.mergedAt === null ? 0 : DateTime.toEpochMillis(entry.pr.mergedAt);
        return at(right) - at(left);
      }),
      github: health,
      fetchedAt: listing === null ? now : DateTime.makeUnsafe(listing.fetchedAtMillis),
      refreshing: inFlight,
    } satisfies PrListSnapshot;
  });

  const publish = (reason: PrListChangeReason) =>
    Effect.gen(function* () {
      const list = yield* build();
      yield* PubSub.publish(changes, { reason, list });
    });

  // Republish whenever durable state or a job moves. This — not a timer — is
  // what keeps the welcome screen live.
  yield* Effect.forkScoped(
    store.changes.pipe(
      Stream.runForEach((change) =>
        publish(change._tag === "journey" ? "journey-changed" : "marks-changed"),
      ),
    ),
  );
  yield* Effect.forkScoped(
    ingestion.changes.pipe(Stream.runForEach(() => publish("ingestion-changed"))),
  );

  return {
    snapshot: build(),

    get changes() {
      return Stream.fromPubSub(changes);
    },

    refresh: Effect.gen(function* () {
      yield* Ref.set(refreshing, true);
      yield* publish("refreshing");
      const sent = yield* github.refreshPrs.pipe(Effect.orElseSucceed(() => false));
      yield* Ref.set(refreshing, false);
      yield* publish("refreshed");
      return sent;
    }),
  } satisfies PrList["Service"];
});

export const layer = Layer.effect(PrList, make);
