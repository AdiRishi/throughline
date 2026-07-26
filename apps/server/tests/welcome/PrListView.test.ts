/**
 * A refresh that reaches GitHub has to reach the screen.
 *
 * The welcome screen renders from `changes`, not from `refresh`'s return value,
 * so a refresh that only updated the held answer was invisible: a reviewer
 * pushed a commit, focus refreshed the list, the server learned the journey was
 * stale — and the screen went on saying it was current. The RPC response was
 * right the whole time, which is exactly why this needs a test.
 */
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  JOURNEY_FORMAT_VERSION,
  type Journey,
  type JourneyId,
  type PrDetail,
  type PrRef,
  type PrListStreamEvent,
  type PrSummary,
  type ReadState,
} from "@app/contracts";

import { Ingestion } from "../../src/analysis/Ingestion.ts";
import { GitHub, type PrListSource } from "../../src/github/GitHub.ts";
import { JourneyStore } from "../../src/journeys/JourneyStore.ts";
import * as PrListViewModule from "../../src/welcome/PrListView.ts";

const PR: PrRef = { owner: "acme", repo: "widget", number: 7 };
const PINNED = "1111111111111111111111111111111111111111";
const MOVED = "2222222222222222222222222222222222222222";
const JOURNEY_ID = "acme-widget-7-1" as JourneyId;

const summaryAt = (headSha: string, at: DateTime.Utc): PrSummary => ({
  ref: PR,
  title: "Add a widget",
  authorLogin: "someone",
  url: "https://github.com/acme/widget/pull/7",
  state: "open",
  isDraft: false,
  createdAt: at,
  updatedAt: at,
  mergedAt: null,
  headSha,
  baseRefName: "main",
  headRefName: "feat/widget",
  changedFiles: 1,
  additions: 1,
  deletions: 0,
});

const prose = (markdown: string) => ({ markdown });

const journeyAt = (at: DateTime.Utc): Journey => ({
  formatVersion: JOURNEY_FORMAT_VERSION,
  id: JOURNEY_ID,
  pr: PR,
  prSnapshot: {
    title: "Add a widget",
    body: "",
    authorLogin: "someone",
    url: "https://github.com/acme/widget/pull/7",
  },
  pinned: { headSha: PINNED, baseSha: "0".repeat(40), analyzedAt: at },
  provenance: {
    harnessKind: "codex",
    model: null,
    usage: null,
    fallbacks: [],
    runId: "run-1",
  },
  overview: { brief: prose("A widget."), whereToBegin: prose("At the widget.") },
  clusters: [
    {
      id: "c1" as Journey["clusters"][number]["id"],
      position: 1,
      title: "The widget",
      weight: "core",
      narrative: prose("It is a widget."),
      mapEntry: prose("It is a widget."),
      buildsOn: [],
      fileOrder: ["src/widget.ts"],
      resurfaced: [],
    },
  ],
  hunks: [
    {
      id: "h1" as Journey["hunks"][number]["id"],
      seedId: "h1" as Journey["hunks"][number]["seedId"],
      path: "src/widget.ts",
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      home: "c1" as Journey["clusters"][number]["id"],
      fileKind: null,
    },
  ],
  files: [
    {
      path: "src/widget.ts",
      changeKind: "added",
      oldPath: null,
      binary: false,
      oldMode: null,
      newMode: "100644",
      additions: 1,
      deletions: 0,
    },
  ],
  hints: [],
});

const emptyReadStateAt = (at: DateTime.Utc): ReadState => ({
  journeyId: JOURNEY_ID,
  readFiles: [],
  displayMode: "inline",
  updatedAt: at,
});

/**
 * The real `PrListView` over stand-ins whose only interesting behaviour is a
 * head that can move, the way a push moves one.
 */
const harness = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const head = yield* Ref.make(PINNED);
  const refreshes = yield* Ref.make(0);
  const journey = journeyAt(now);

  const source = (headSha: string): PrListSource => ({
    viewer: { login: "someone", ghInstalled: true, authenticated: true, host: "github.com" },
    // The list comes from GitHub's *search* index, which lags a push — so it
    // deliberately keeps reporting the old head. Only `pr()` moves.
    open: [summaryAt(PINNED, now)],
    merged: [],
    fetchedAt: now,
  });

  const github = Layer.mock(GitHub)({
    identity: Effect.succeed(source(PINNED).viewer),
    prs: Effect.succeed(source(PINNED)),
    refreshPrs: Ref.update(refreshes, (value) => value + 1).pipe(Effect.as(source(PINNED))),
    pr: () =>
      Ref.get(head).pipe(
        Effect.map((headSha): PrDetail => ({ summary: summaryAt(headSha, now), body: "" })),
      ),
  });

  const revision = yield* SubscriptionRef.make(0);
  const store = Layer.mock(JourneyStore)({
    revision,
    rows: Effect.succeed([
      {
        pr: PR,
        journeyId: JOURNEY_ID,
        headSha: PINNED,
        baseSha: "0".repeat(40),
        analyzedAt: now,
        harness: "codex",
        runId: "run-1",
      },
    ]),
    journeyFor: () => Effect.succeed(journey),
    readState: () => Effect.succeed(emptyReadStateAt(now)),
    localPrState: Effect.succeed({ reviewed: [], hidden: [], dismissedMerged: [] }),
  });

  const ingestion = Layer.mock(Ingestion)({
    activePrs: Effect.succeed(new Set<string>()),
  });

  const view = yield* PrListViewModule.PrListView.pipe(
    Effect.provide(
      PrListViewModule.layer.pipe(Layer.provide(Layer.mergeAll(github, store, ingestion))),
    ),
  );
  return { view, head } as const;
});

/** The `stale` flag for our pull request, out of a stream event. */
const staleIn = (event: { readonly view: { readonly repos: ReadonlyArray<unknown> } }): boolean => {
  const repos = event.view.repos as ReadonlyArray<{
    readonly entries: ReadonlyArray<{ readonly journey: { readonly stale: boolean } | null }>;
  }>;
  return repos[0]?.entries[0]?.journey?.stale === true;
};

/** Let forked fibers run until `check` holds, or give up. */
const settle = <A>(read: Effect.Effect<A>, check: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = yield* read;
      if (check(value)) return value;
      yield* Effect.sleep("5 millis");
    }
    return yield* read;
  });

describe("PrListView", () => {
  it.live("tells subscribers when a refresh finds the pull request moved ahead", () =>
    Effect.gen(function* () {
      const { view, head } = yield* harness;

      const seen = yield* Ref.make<ReadonlyArray<PrListStreamEvent>>([]);
      yield* Effect.forkScoped(
        view.changes.pipe(
          Stream.runForEach((event) => Ref.update(seen, (events) => [...events, event])),
        ),
      );

      // Wait for the stream to go quiet, so anything that arrives afterwards is
      // attributable to the refresh and nothing else.
      const before = yield* settle(Ref.get(seen), (events) => events.length > 0);
      assert.strictEqual(before[0]!.type, "snapshot");
      assert.isFalse(staleIn(before[0]!), "the journey is not stale before the push");
      yield* Effect.sleep("50 millis");
      const quiet = yield* Ref.get(seen);

      // The push, and the focus-refresh that follows it.
      yield* Ref.set(head, MOVED);
      yield* view.refresh;

      const after = yield* settle(Ref.get(seen), (events) => events.length > quiet.length);
      assert.isAbove(
        after.length,
        quiet.length,
        "a refresh that reached GitHub must emit, not only answer its caller",
      );
      assert.isTrue(staleIn(after.at(-1)!), "and what it emits must say the journey is stale");
    }),
  );
});
