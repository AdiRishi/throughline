import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  GitHubParkedError,
  GitHubReadError,
  Journey,
  PrSummary,
  TrimmedNonEmptyString,
  type GitHubPrListStreamEvent,
  type PrDetail,
  type PrRef,
  type ReadState,
} from "@app/contracts";

import * as GitHub from "../../src/github/GitHub.ts";
import * as JourneyStore from "../../src/journeys/JourneyStore.ts";
import * as PullRequestIndex from "../../src/pullRequests/PullRequestIndex.ts";
import * as Workspaces from "../../src/workspace/Workspaces.ts";

const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));
const decodePrSummary = Schema.decodeUnknownSync(Schema.toCodecJson(PrSummary));
const decodeDetail = Schema.decodeUnknownSync(TrimmedNonEmptyString);

const PINNED_HEAD = "1111111111111111111111111111111111111111";
const CURRENT_HEAD = "2222222222222222222222222222222222222222";

const makePr = (number: number, headSha = CURRENT_HEAD): PrSummary =>
  decodePrSummary({
    ref: {
      owner: "effect-ts",
      repo: "throughline-fixture",
      number,
    },
    title: `Pull request ${number}`,
    author: {
      login: "reviewer",
      avatarUrl: null,
    },
    url: `https://github.com/effect-ts/throughline-fixture/pull/${number}`,
    state: "open",
    baseRefName: "main",
    headSha,
    updatedAt: "2026-07-20T00:00:00.000Z",
    mergedAt: null,
    changedFiles: 2,
    additions: 3,
    deletions: 1,
    journey: null,
  });

const detailFor = (pullRequest: PrSummary): PrDetail => ({
  ...pullRequest,
  body: "",
  baseSha: pullRequest.headSha,
});

const makeJourney = (pullRequest: PrSummary, id: string, pinnedHead = PINNED_HEAD): Journey =>
  decodeJourney({
    formatVersion: 1,
    id,
    pr: pullRequest.ref,
    pinned: {
      headSha: pinnedHead,
      baseSha: "0000000000000000000000000000000000000000",
      analyzedAt: "2026-07-20T00:00:00.000Z",
    },
    provenance: {
      harnessKind: "codex",
    },
    overview: {
      brief: { markdown: "A weighted fixture." },
      whereToBegin: { markdown: "Begin with the core cluster." },
    },
    clusters: [
      {
        id: "cluster-core",
        position: 1,
        title: "Core behavior",
        weight: "core",
        narrative: { markdown: "Two hunks in one file." },
        mapEntry: { markdown: "The main behavior." },
        buildsOn: [],
        fileOrder: ["src/core.ts"],
        resurfaced: [],
      },
      {
        id: "cluster-support",
        position: 2,
        title: "Supporting behavior",
        weight: "supporting",
        narrative: { markdown: "One supporting hunk." },
        mapEntry: { markdown: "Builds on the core." },
        buildsOn: ["cluster-core"],
        fileOrder: ["src/support.ts"],
        resurfaced: [],
      },
    ],
    hunks: [
      {
        id: "h1",
        seedId: "s1",
        path: "src/core.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        home: "cluster-core",
      },
      {
        id: "h2",
        seedId: "s2",
        path: "src/core.ts",
        oldStart: 4,
        oldLines: 1,
        newStart: 4,
        newLines: 1,
        home: "cluster-core",
      },
      {
        id: "h3",
        seedId: "s3",
        path: "src/support.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        home: "cluster-support",
      },
    ],
    files: [
      {
        path: "src/core.ts",
        oldPath: null,
        kind: "modified",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 2,
        deletions: 1,
      },
      {
        path: "src/support.ts",
        oldPath: null,
        kind: "modified",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 1,
        deletions: 0,
      },
    ],
    hints: [],
  });

const firstPr = makePr(1);
const currentPr = makePr(2, PINNED_HEAD);
const unindexedPr = makePr(3);
const locallyPinnedPr = makePr(4);
const firstJourney = makeJourney(firstPr, "journey-first");
const currentJourney = makeJourney(currentPr, "journey-current");
const locallyPinnedJourney = makeJourney(locallyPinnedPr, "journey-locally-pinned");

const readState = (journey: Journey, complete = false): ReadState => ({
  journeyId: journey.id,
  readFiles: [
    {
      clusterId: journey.clusters[0]!.id,
      path: journey.files[0]!.path,
    },
    ...(complete
      ? [
          {
            clusterId: journey.clusters[1]!.id,
            path: journey.files[1]!.path,
          },
        ]
      : []),
  ],
  displayMode: "inline",
  updatedAt: DateTime.makeUnsafe(0),
});

const metadata = (
  journey: Journey,
  state: Option.Option<ReadState>,
): JourneyStore.JourneyMetadata => ({
  journey,
  runId: `run-${journey.id}`,
  readState: state,
});

interface ControlledGitHubOptions {
  readonly pullRequests: (
    call: number,
  ) => Effect.Effect<ReadonlyArray<PrSummary>, GitHubReadError | GitHubParkedError>;
  readonly pr?: (
    ref: PrRef,
    call: number,
  ) => Effect.Effect<PrDetail, GitHubReadError | GitHubParkedError>;
  readonly retry?: (call: number) => Effect.Effect<void, GitHubParkedError>;
}

const makeControlledGitHub = (options: ControlledGitHubOptions) =>
  Effect.gen(function* () {
    const pullCalls = yield* Ref.make(0);
    const prCalls = yield* Ref.make(0);
    const retryCalls = yield* Ref.make(0);

    const service = GitHub.GitHub.of({
      identity: () =>
        Effect.succeed({
          auth: "authenticated",
          login: decodeDetail("reviewer"),
          name: null,
          avatarUrl: null,
        }),
      repositories: () => Effect.succeed([]),
      pullRequests: () =>
        Ref.updateAndGet(pullCalls, (calls) => calls + 1).pipe(
          Effect.flatMap(options.pullRequests),
        ),
      openPrs: () => Effect.succeed([]),
      recentlyMergedPrs: () => Effect.succeed([]),
      pr: (ref) =>
        Ref.updateAndGet(prCalls, (calls) => calls + 1).pipe(
          Effect.flatMap((call) =>
            options.pr === undefined
              ? Effect.die("Unexpected GitHub.pr test call.")
              : options.pr(ref, call),
          ),
        ),
      refreshPrs: () => Effect.void,
      retry: () =>
        Ref.updateAndGet(retryCalls, (calls) => calls + 1).pipe(
          Effect.flatMap((call) =>
            options.retry === undefined ? Effect.void : options.retry(call),
          ),
        ),
      resolveUrl: () => Effect.die("Unused GitHub.resolveUrl test seam."),
      cloneCredentials: () =>
        Effect.succeed({
          username: "x-access-token",
          password: "fixture-token",
        }),
    });

    return { service, prCalls, pullCalls, retryCalls };
  });

interface ControlledStoreOptions {
  readonly listMetadata?: (
    current: ReadonlyArray<JourneyStore.JourneyMetadata>,
    call: number,
  ) => Effect.Effect<ReadonlyArray<JourneyStore.JourneyMetadata>, JourneyStore.JourneyStoreError>;
}

const makeControlledStore = (
  initial: ReadonlyArray<JourneyStore.JourneyMetadata>,
  options: ControlledStoreOptions = {},
) =>
  Effect.gen(function* () {
    const storedMetadata = yield* Ref.make(initial);
    const listCalls = yield* Ref.make(0);
    const localPrState = {
      reviewed: [],
      hidden: [],
      dismissedMerged: [],
    };

    const service = JourneyStore.JourneyStore.of({
      listMetadata: Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(listCalls, (calls) => calls + 1);
        const current = yield* Ref.get(storedMetadata);
        return options.listMetadata === undefined
          ? current
          : yield* options.listMetadata(current, call);
      }),
      listRunReferences: Effect.succeed([]),
      getByPr: () => Effect.succeedNone,
      getById: () => Effect.succeedNone,
      replace: () => Effect.succeedNone,
      remove: () => Effect.succeedNone,
      getReadState: () => Effect.succeedNone,
      setDisplayMode: () => Effect.die("Unused setDisplayMode test seam."),
      setReadMark: () => Effect.die("Unused setReadMark test seam."),
      getLocalPrState: Effect.succeed(localPrState),
      setReviewed: () => Effect.succeed(localPrState),
      setHidden: () => Effect.succeed(localPrState),
      setDismissedMerged: () => Effect.succeed(localPrState),
      getSettings: Effect.succeed({}),
      setHarness: (harness) => Effect.succeed(harness === undefined ? {} : { harness }),
    });

    return { service, storedMetadata, listCalls };
  });

const makeWorkspaces = (
  pullRequest: Workspaces.Workspaces["Service"]["pullRequest"] = () =>
    Effect.die("Unexpected Workspaces.pullRequest test call."),
): Workspaces.Workspaces["Service"] =>
  Workspaces.Workspaces.of({
    prepare: () => Effect.die("Unused Workspaces.prepare test seam."),
    finalize: () => Effect.die("Unused Workspaces.finalize test seam."),
    abandon: () => Effect.die("Unused Workspaces.abandon test seam."),
    reapFailedRuns: () => Effect.die("Unused Workspaces.reapFailedRuns test seam."),
    filePatch: () => Effect.die("Unused Workspaces.filePatch test seam."),
    fileContent: () => Effect.die("Unused Workspaces.fileContent test seam."),
    tree: () => Effect.die("Unused Workspaces.tree test seam."),
    pullRequest,
    evictCache: () => Effect.die("Unused Workspaces.evictCache test seam."),
    removeRun: () => Effect.die("Unused Workspaces.removeRun test seam."),
  });

const makeIndex = (
  github: GitHub.GitHub["Service"],
  store: JourneyStore.JourneyStore["Service"],
  workspaces = makeWorkspaces(),
) =>
  PullRequestIndex.make.pipe(
    Effect.provideService(GitHub.GitHub, github),
    Effect.provideService(JourneyStore.JourneyStore, store),
    Effect.provideService(Workspaces.Workspaces, workspaces),
  );

const eventSummary = (event: GitHubPrListStreamEvent) => ({
  sequence: event.sequence,
  type: event.type,
  journeys: event.pullRequests.map((pullRequest) => pullRequest.journey),
});

describe("PullRequestIndex", () => {
  it.effect("stays lazy until the first subscriber and keeps an idle recompute local", () =>
    Effect.gen(function* () {
      const github = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr]),
      });
      const store = yield* makeControlledStore([]);
      const index = yield* makeIndex(github.service, store.service);

      assert.strictEqual(yield* Ref.get(github.pullCalls), 0);
      assert.strictEqual(yield* Ref.get(store.listCalls), 0);
      assert.isTrue(Option.isNone(yield* index.recompute()));
      assert.strictEqual(yield* Ref.get(github.pullCalls), 0);
      assert.strictEqual(yield* Ref.get(store.listCalls), 0);

      const events = yield* index.subscribe.pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(events[0]!.type, "snapshot");
      assert.strictEqual(events[0]!.sequence, 1);
      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      assert.strictEqual(yield* Ref.get(store.listCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("shares one first load across concurrent subscribers and refreshes", () =>
    Effect.gen(function* () {
      const pullStarted = yield* Deferred.make<void>();
      const releasePull = yield* Deferred.make<void>();
      const github = yield* makeControlledGitHub({
        pullRequests: () =>
          Deferred.succeed(pullStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releasePull)),
            Effect.as([firstPr]),
          ),
      });
      const store = yield* makeControlledStore([]);
      const index = yield* makeIndex(github.service, store.service);

      const firstSubscriber = yield* index.subscribe.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(pullStarted);
      const secondSubscriber = yield* index.subscribe.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      const firstRefresh = yield* index.refresh().pipe(Effect.forkChild);
      const secondRefresh = yield* index.refresh().pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      yield* Deferred.succeed(releasePull, undefined);

      const [firstEvents, secondEvents, firstResult, secondResult] = yield* Effect.all([
        Fiber.join(firstSubscriber),
        Fiber.join(secondSubscriber),
        Fiber.join(firstRefresh),
        Fiber.join(secondRefresh),
      ]);
      assert.deepStrictEqual(firstEvents.map(eventSummary), secondEvents.map(eventSummary));
      assert.strictEqual(firstEvents[0]!.sequence, 1);
      assert.strictEqual(firstResult.sequence, 1);
      assert.strictEqual(secondResult.sequence, 1);
      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      assert.strictEqual(yield* Ref.get(store.listCalls), 1);
    }).pipe(Effect.scoped),
  );

  it.effect("enriches hunk-weighted progress and derives staleness from the current head", () =>
    Effect.gen(function* () {
      const github = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr, currentPr, unindexedPr]),
      });
      const store = yield* makeControlledStore([
        metadata(firstJourney, Option.some(readState(firstJourney))),
        metadata(currentJourney, Option.none()),
      ]);
      const index = yield* makeIndex(github.service, store.service);

      const event = yield* index.refresh();
      assert.deepStrictEqual(event.pullRequests[0]!.journey, {
        journeyId: firstJourney.id,
        progress: 2 / 3,
        markedFiles: 1,
        clusterFiles: 2,
        stale: true,
        pinnedHeadSha: PINNED_HEAD,
      });
      assert.deepStrictEqual(event.pullRequests[1]!.journey, {
        journeyId: currentJourney.id,
        progress: 0,
        markedFiles: 0,
        clusterFiles: 2,
        stale: false,
        pinnedHeadSha: PINNED_HEAD,
      });
      assert.isNull(event.pullRequests[2]!.journey);
    }),
  );

  it.effect(
    "keeps a locally pinned journey outside the affiliation list across index restarts",
    () =>
      Effect.gen(function* () {
        const github = yield* makeControlledGitHub({
          pullRequests: () => Effect.succeed([firstPr]),
          pr: (ref) =>
            Effect.succeed(
              detailFor(ref.number === locallyPinnedPr.ref.number ? locallyPinnedPr : firstPr),
            ),
        });
        const store = yield* makeControlledStore([metadata(locallyPinnedJourney, Option.none())]);

        const firstIndex = yield* makeIndex(github.service, store.service);
        const firstLoad = yield* firstIndex.refresh();
        assert.deepStrictEqual(
          firstLoad.pullRequests.map((pullRequest) => pullRequest.ref.number),
          [firstPr.ref.number, locallyPinnedPr.ref.number],
        );
        assert.deepStrictEqual(firstLoad.pullRequests[1]!.journey, {
          journeyId: locallyPinnedJourney.id,
          progress: 0,
          markedFiles: 0,
          clusterFiles: 2,
          stale: true,
          pinnedHeadSha: PINNED_HEAD,
        });

        const restartedIndex = yield* makeIndex(github.service, store.service);
        const restarted = yield* restartedIndex.subscribe.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(
          restarted[0]!.pullRequests.map((pullRequest) => pullRequest.ref.number),
          [firstPr.ref.number, locallyPinnedPr.ref.number],
        );
        assert.strictEqual(
          restarted[0]!.pullRequests[1]!.journey?.journeyId,
          locallyPinnedJourney.id,
        );
        assert.strictEqual(yield* Ref.get(github.pullCalls), 2);
        assert.strictEqual(yield* Ref.get(github.prCalls), 2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "restores a locally pinned journey after restart when GitHub can no longer read the PR",
    () =>
      Effect.gen(function* () {
        const notFound = new GitHubReadError({
          reason: "not-found",
          detail: decodeDetail("The pull request is no longer visible."),
        });
        const parked = new GitHubParkedError({
          resetAt: DateTime.makeUnsafe(10_000),
        });
        const github = yield* makeControlledGitHub({
          pullRequests: () => Effect.succeed([firstPr]),
          pr: (_ref, call) => Effect.fail(call === 1 ? notFound : parked),
        });
        const store = yield* makeControlledStore([metadata(locallyPinnedJourney, Option.none())]);
        const workspaceReads = yield* Ref.make<ReadonlyArray<Workspaces.WorkspaceRunRef>>([]);
        const pinnedDetail = detailFor(makePr(locallyPinnedPr.ref.number, PINNED_HEAD));
        const workspaces = makeWorkspaces((run) =>
          Ref.update(workspaceReads, (reads) => [...reads, run]).pipe(Effect.as(pinnedDetail)),
        );

        const firstIndex = yield* makeIndex(github.service, store.service, workspaces);
        const firstLoad = yield* firstIndex.refresh();
        assert.deepStrictEqual(
          firstLoad.pullRequests.map((pullRequest) => pullRequest.ref.number),
          [firstPr.ref.number, locallyPinnedPr.ref.number],
        );
        assert.isFalse(firstLoad.pullRequests[1]!.journey!.stale);

        const restartedIndex = yield* makeIndex(github.service, store.service, workspaces);
        const restarted = yield* restartedIndex.subscribe.pipe(Stream.take(1), Stream.runCollect);
        assert.strictEqual(
          restarted[0]!.pullRequests[1]!.journey?.journeyId,
          locallyPinnedJourney.id,
        );
        assert.deepStrictEqual(yield* Ref.get(workspaceReads), [
          {
            pr: locallyPinnedJourney.pr,
            runId: `run-${locallyPinnedJourney.id}`,
          },
          {
            pr: locallyPinnedJourney.pr,
            runId: `run-${locallyPinnedJourney.id}`,
          },
        ]);
        assert.strictEqual(yield* Ref.get(github.prCalls), 2);
      }).pipe(Effect.scoped),
  );

  it.effect("adds a newly saved local journey once and keeps later recomputes network-local", () =>
    Effect.gen(function* () {
      const github = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr]),
        pr: () => Effect.succeed(detailFor(locallyPinnedPr)),
      });
      const store = yield* makeControlledStore([]);
      const index = yield* makeIndex(github.service, store.service);
      yield* index.refresh();

      yield* Ref.set(store.storedMetadata, [metadata(locallyPinnedJourney, Option.none())]);
      const added = yield* index.recompute();
      assert.isTrue(Option.isSome(added));
      if (Option.isSome(added)) {
        assert.deepStrictEqual(
          added.value.pullRequests.map((pullRequest) => pullRequest.ref.number),
          [firstPr.ref.number, locallyPinnedPr.ref.number],
        );
      }
      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      assert.strictEqual(yield* Ref.get(github.prCalls), 1);

      yield* Ref.set(store.storedMetadata, [
        metadata(locallyPinnedJourney, Option.some(readState(locallyPinnedJourney, true))),
      ]);
      const updated = yield* index.recompute();
      assert.isTrue(Option.isSome(updated));
      if (Option.isSome(updated)) {
        assert.strictEqual(updated.value.pullRequests[1]!.journey?.progress, 1);
      }
      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      assert.strictEqual(yield* Ref.get(github.prCalls), 1);
    }),
  );

  it.effect("recomputes local journey state without another GitHub read", () =>
    Effect.gen(function* () {
      const github = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr]),
      });
      const store = yield* makeControlledStore([
        metadata(firstJourney, Option.some(readState(firstJourney))),
      ]);
      const index = yield* makeIndex(github.service, store.service);
      const loaded = yield* index.refresh();
      const snapshotSeen = yield* Deferred.make<void>();
      const collector = yield* index.subscribe.pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(snapshotSeen);

      yield* Ref.set(store.storedMetadata, [
        metadata(firstJourney, Option.some(readState(firstJourney, true))),
      ]);
      const recomputed = yield* index.recompute();
      assert.isTrue(Option.isSome(recomputed));
      if (Option.isSome(recomputed)) {
        assert.strictEqual(recomputed.value.sequence, 2);
        assert.strictEqual(recomputed.value.pullRequests[0]!.journey?.progress, 1);
        assert.strictEqual(
          DateTime.toEpochMillis(recomputed.value.refreshedAt),
          DateTime.toEpochMillis(loaded.refreshedAt),
        );
      }

      const events = yield* Fiber.join(collector);
      assert.deepStrictEqual(
        events.map((event) => [event.sequence, event.type]),
        [
          [1, "snapshot"],
          [2, "updated"],
        ],
      );
      assert.strictEqual(yield* Ref.get(github.pullCalls), 1);
      assert.strictEqual(yield* Ref.get(github.prCalls), 0);
      assert.strictEqual(events[1]!.pullRequests[0]!.journey?.progress, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves GitHub read and parked retry errors", () =>
    Effect.gen(function* () {
      const readError = new GitHubReadError({
        reason: "transport",
        detail: decodeDetail("GitHub is offline."),
      });
      const readFailure = yield* makeControlledGitHub({
        pullRequests: () => Effect.fail(readError),
      });
      const store = yield* makeControlledStore([]);
      const readIndex = yield* makeIndex(readFailure.service, store.service);

      const failedRead = yield* readIndex.subscribe.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flip,
      );
      assert.strictEqual(failedRead, readError);

      const parkedError = new GitHubParkedError({
        resetAt: DateTime.makeUnsafe(10_000),
      });
      const parked = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr]),
        retry: () => Effect.fail(parkedError),
      });
      const parkedIndex = yield* makeIndex(parked.service, store.service);

      const failedRetry = yield* parkedIndex.retry().pipe(Effect.flip);
      assert.strictEqual(failedRetry, parkedError);
      assert.strictEqual(yield* Ref.get(parked.retryCalls), 1);
      assert.strictEqual(yield* Ref.get(parked.pullCalls), 0);

      const recovered = yield* makeControlledGitHub({
        pullRequests: () => Effect.succeed([firstPr]),
      });
      const recoveredIndex = yield* makeIndex(recovered.service, store.service);
      const recoveredEvent = yield* recoveredIndex.retry();
      assert.strictEqual(recoveredEvent.sequence, 1);
      assert.strictEqual(yield* Ref.get(recovered.retryCalls), 1);
      assert.strictEqual(yield* Ref.get(recovered.pullCalls), 1);
    }),
  );

  it.effect("filters a queued load update at the snapshot boundary and keeps later updates", () =>
    Effect.gen(function* () {
      const pullStarted = yield* Deferred.make<void>();
      const releasePull = yield* Deferred.make<void>();
      const snapshotSeen = yield* Deferred.make<void>();
      const github = yield* makeControlledGitHub({
        pullRequests: () =>
          Deferred.succeed(pullStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releasePull)),
            Effect.as([firstPr]),
          ),
      });
      const store = yield* makeControlledStore([
        metadata(firstJourney, Option.some(readState(firstJourney))),
      ]);
      const index = yield* makeIndex(github.service, store.service);
      const collector = yield* index.subscribe.pipe(
        Stream.tap((event) =>
          event.type === "snapshot" ? Deferred.succeed(snapshotSeen, undefined) : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );

      // Reaching the pull proves the live subscription was registered first.
      yield* Deferred.await(pullStarted);
      yield* Deferred.succeed(releasePull, undefined);
      yield* Deferred.await(snapshotSeen);
      yield* Ref.set(store.storedMetadata, [
        metadata(firstJourney, Option.some(readState(firstJourney, true))),
      ]);
      yield* index.recompute();

      const events = yield* Fiber.join(collector);
      assert.deepStrictEqual(
        events.map((event) => [event.sequence, event.type]),
        [
          [1, "snapshot"],
          [2, "updated"],
        ],
      );
      assert.strictEqual(events[0]!.pullRequests[0]!.journey?.progress, 2 / 3);
      assert.strictEqual(events[1]!.pullRequests[0]!.journey?.progress, 1);
    }).pipe(Effect.scoped),
  );
});
