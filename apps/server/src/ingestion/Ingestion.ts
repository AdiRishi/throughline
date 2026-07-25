import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  GitHubUnavailableError,
  IngestionDoorError,
  IngestionJobNotFoundError,
  type HarnessKind,
  type IngestionJob,
  type IngestionJobId,
  type IngestionPhase,
  type IngestionStreamEvent,
  type JourneyId,
  type PrRef,
} from "@app/contracts";

import { JourneyAnalysis } from "../analysis/JourneyAnalysis.ts";
import { GitHub } from "../github/GitHub.ts";
import { AnalysisHarness } from "../harness/AnalysisHarness.ts";
import { JourneyStore } from "../journeys/JourneyStore.ts";
import { Workspaces } from "../workspace/Workspaces.ts";

interface IngestionState {
  readonly sequence: number;
  readonly jobs: ReadonlyArray<IngestionJob>;
  readonly fibers: ReadonlyMap<IngestionJobId, Fiber.Fiber<void, never>>;
}

type StartInput = { readonly pr: PrRef } | { readonly url: string };

export class Ingestion extends Context.Service<
  Ingestion,
  {
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<IngestionJob, IngestionDoorError | GitHubUnavailableError>;
    readonly cancel: (id: IngestionJobId) => Effect.Effect<void, IngestionJobNotFoundError>;
    readonly changes: Stream.Stream<IngestionStreamEvent>;
  }
>()("@app/server/ingestion/Ingestion") {}

function isTerminal(phase: IngestionPhase): boolean {
  return phase.type === "complete" || phase.type === "failed" || phase.type === "cancelled";
}

function key(pr: PrRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export const make = Effect.gen(function* () {
  const github = yield* GitHub;
  const harness = yield* AnalysisHarness;
  const analysis = yield* JourneyAnalysis;
  const workspaces = yield* Workspaces;
  const journeys = yield* JourneyStore;
  const lifetime = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const state = yield* SynchronizedRef.make<IngestionState>({
    sequence: 0,
    jobs: [],
    fibers: new Map(),
  });
  const pubSub = yield* PubSub.unbounded<IngestionStreamEvent>();

  const update = (
    id: IngestionJobId,
    phase: IngestionPhase,
  ): Effect.Effect<IngestionJob | undefined> =>
    SynchronizedRef.modifyEffect(state, (current) =>
      DateTime.now.pipe(
        Effect.flatMap((updatedAt) => {
          let updated: IngestionJob | undefined;
          const jobs = current.jobs.map((job) => {
            if (job.id !== id) return job;
            updated = { ...job, phase, updatedAt };
            return updated;
          });
          const event: IngestionStreamEvent = {
            version: 1,
            sequence: current.sequence + 1,
            type: "updated",
            jobs,
          };
          return PubSub.publish(pubSub, event).pipe(
            Effect.as([
              updated,
              {
                ...current,
                sequence: event.sequence,
                jobs,
              },
            ] as const),
          );
        }),
      ),
    );

  const run = (
    id: IngestionJobId,
    pr: PrRef,
    selectedHarness: HarnessKind,
  ): Effect.Effect<void, never> =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        yield* update(id, { type: "resolving" });
        const detail = yield* github.pr(pr, true);
        yield* update(id, { type: "cloning" });
        const journeyId = crypto.randomUUID() as JourneyId;
        const workspace = yield* workspaces.prepare(detail, journeyId);
        yield* update(id, { type: "diffing" });
        yield* update(id, {
          type: "analyzing",
          stage: "planning",
          detail: {
            action: "Mapping changes into a review journey",
            recent: workspace.files.slice(0, 5).map((file) => file.path),
            filesWalked: workspace.files.length,
            symbolsTraced: 0,
            callSitesFollowed: 0,
          },
        });
        const journey = yield* analysis.analyze({
          journeyId,
          detail,
          workspace,
          harness: selectedHarness,
        });
        yield* update(id, {
          type: "analyzing",
          stage: "narrating",
          detail: {
            action: "Writing the journey narrative",
            recent: journey.clusters.slice(0, 5).map((cluster) => cluster.title),
            filesWalked: workspace.files.length,
            symbolsTraced: 0,
            callSitesFollowed: 0,
          },
        });
        yield* update(id, { type: "validating" });
        yield* update(id, { type: "saving" });
        yield* journeys.save({ journey, runDir: workspace.runDir });
        yield* workspace.cleanup;
        yield* update(id, { type: "complete", journeyId });
      }).pipe(
        Effect.catch((error) =>
          update(id, {
            type: "failed",
            detail:
              error instanceof GitHubUnavailableError
                ? error.detail
                : "detail" in error && typeof error.detail === "string"
                  ? error.detail
                  : String(error),
            retryable: true,
          }).pipe(Effect.asVoid),
        ),
        Effect.onInterrupt(() => update(id, { type: "cancelled" }).pipe(Effect.asVoid)),
        Effect.ensuring(
          SynchronizedRef.update(state, (current) => {
            const fibers = new Map(current.fibers);
            fibers.delete(id);
            return { ...current, fibers };
          }),
        ),
      ),
    );

  return Ingestion.of({
    start: (input) =>
      Effect.gen(function* () {
        const pr = "pr" in input ? input.pr : yield* github.resolveUrl(input.url);
        const existing = (yield* SynchronizedRef.get(state)).jobs.find(
          (job) => key(job.pr) === key(pr) && !isTerminal(job.phase),
        );
        if (existing !== undefined) return existing;

        const viewer = yield* github.identity();
        if (viewer.state !== "authenticated") {
          return yield* new IngestionDoorError({
            reason: viewer.state === "unavailable" ? "gh-unavailable" : "gh-unavailable",
            detail: viewer.setupInstructions ?? "Authenticate the GitHub CLI before ingestion.",
          });
        }
        const detail = yield* github.pr(pr, true).pipe(
          Effect.mapError(
            (error) =>
              new IngestionDoorError({
                reason: error.reason === "gh-unavailable" ? "gh-unavailable" : "not-found",
                detail: error.detail,
              }),
          ),
        );
        if (detail.state !== "open") {
          return yield* new IngestionDoorError({
            reason: "not-open",
            detail: "Only open pull requests can be ingested.",
          });
        }
        const settings = yield* journeys.getSettings;
        const statuses = yield* harness.statuses;
        const selectedHarness =
          settings.harness === undefined
            ? (statuses.find((status) => status.kind === "codex" && status.auth === "authenticated")
                ?.kind ?? statuses.find((status) => status.auth === "authenticated")?.kind)
            : statuses.find(
                (status) => status.kind === settings.harness && status.auth === "authenticated",
              )?.kind;
        if (selectedHarness === undefined) {
          return yield* new IngestionDoorError({
            reason: "no-harness",
            detail: "Install and authenticate Codex or Claude Code before ingestion.",
          });
        }

        const now = yield* DateTime.now;
        const id = crypto.randomUUID() as IngestionJobId;
        const current = yield* SynchronizedRef.get(state);
        const activeAhead = current.jobs.filter((job) => !isTerminal(job.phase)).length;
        const job: IngestionJob = {
          id,
          pr,
          phase: { type: "queued", position: activeAhead + 1 },
          startedAt: now,
          updatedAt: now,
        };
        yield* SynchronizedRef.updateEffect(state, (before) => {
          const jobs = [...before.jobs.filter((item) => item.id !== id), job];
          const event: IngestionStreamEvent = {
            version: 1,
            sequence: before.sequence + 1,
            type: "updated",
            jobs,
          };
          return PubSub.publish(pubSub, event).pipe(
            Effect.as({ ...before, sequence: event.sequence, jobs }),
          );
        });
        const fiber = yield* Effect.forkIn(run(id, pr, selectedHarness), lifetime);
        yield* SynchronizedRef.update(state, (before) => ({
          ...before,
          fibers: new Map(before.fibers).set(id, fiber),
        }));
        return job;
      }).pipe(Effect.withSpan("ingestion.start")),
    cancel: (id) =>
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(state);
        const job = current.jobs.find((item) => item.id === id);
        if (job === undefined || isTerminal(job.phase)) {
          return yield* new IngestionJobNotFoundError({ id });
        }
        const fiber = current.fibers.get(id);
        if (fiber === undefined) {
          yield* update(id, { type: "cancelled" });
        } else {
          yield* Fiber.interrupt(fiber);
        }
      }).pipe(Effect.withSpan("ingestion.cancel")),
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const buffer = yield* Queue.unbounded<IngestionStreamEvent>();
        yield* Effect.forkScoped(
          Stream.fromPubSub(pubSub).pipe(Stream.runForEach((event) => Queue.offer(buffer, event))),
        );
        const current = yield* SynchronizedRef.get(state);
        const snapshot: IngestionStreamEvent = {
          version: 1,
          sequence: current.sequence,
          type: "snapshot",
          jobs: current.jobs,
        };
        return Stream.concat(
          Stream.make(snapshot),
          Stream.fromQueue(buffer).pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          ),
        );
      }),
    ),
  });
});

export const layer = Layer.effect(Ingestion, make);
