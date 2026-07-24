import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  type AnalysisStage,
  type HarnessUsage,
  type IngestionPhase,
  type Journey,
  type JourneyId,
  type PrDetail,
  type PrRef,
} from "@app/contracts";
import { validateJourney, type JourneyViolation } from "@app/journey/coverage";
import {
  makePinnedFileLookup,
  type PinnedFile,
  type PinnedFileLookup,
} from "@app/journey/evidence";

import * as GitHub from "../github/GitHub.ts";
import {
  type AnalysisHarness,
  type AnalysisResult,
  type AnalysisTask,
  type HarnessProgressEvent,
  HarnessRunError,
  HarnessTranscriptError,
} from "../harness/AnalysisHarness.ts";
import * as JourneyStore from "../journeys/JourneyStore.ts";
import { decodeContentManifestDocument } from "../workspace/artifacts.ts";
import * as Workspaces from "../workspace/Workspaces.ts";
import {
  assembleJourney,
  type ClusterNarrationOutput,
  clusterNarrationJsonSchema,
  completePlan,
  decodeClusterNarrationOutput,
  decodeOverviewOutput,
  decodePlanOutput,
  fallbackClusterNarration,
  fallbackOverview,
  type FrozenPlan,
  type OverviewOutput,
  overviewJsonSchema,
  planJsonSchema,
  validatePlanOutput,
} from "./AnalysisOutput.ts";

const MAX_REPAIR_TURNS = 2;
const MAX_NARRATION_GENERATIONS = 2;
const textEncoder = new TextEncoder();

export class AnalysisPipelineError extends Schema.TaggedErrorClass<AnalysisPipelineError>()(
  "AnalysisPipelineError",
  {
    code: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AnalysisPipelineCallbacks {
  readonly onPhase: (
    phase: Exclude<IngestionPhase, "queued" | "complete" | "cancelled" | "failed">,
  ) => Effect.Effect<void>;
  readonly onStage: (stage: AnalysisStage) => Effect.Effect<void>;
  readonly onHarnessEvent: (
    stage: AnalysisStage,
    event: HarnessProgressEvent,
  ) => Effect.Effect<void>;
}

export interface AnalysisPipelineInput {
  readonly pr: PrRef;
  readonly runId: string;
  readonly journeyId: JourneyId;
  readonly harness: AnalysisHarness;
  readonly callbacks: AnalysisPipelineCallbacks;
}

export interface AnalysisPipelineResult {
  readonly journey: Journey;
}

export class AnalysisPipeline extends Context.Service<
  AnalysisPipeline,
  {
    readonly run: (
      input: AnalysisPipelineInput,
    ) => Effect.Effect<AnalysisPipelineResult, AnalysisPipelineError, Scope.Scope>;
  }
>()("@app/server/analysis/AnalysisPipeline") {}

const pipelineError = (code: string, detail: string, cause?: unknown): AnalysisPipelineError =>
  new AnalysisPipelineError({
    code,
    detail: detail.trim() || "Analysis failed.",
    ...(cause === undefined ? {} : { cause }),
  });

const isIngestible = (detail: PrDetail, now: DateTime.Utc): boolean => {
  if (detail.state === "open") return true;
  if (detail.state !== "merged" || detail.mergedAt === null) return false;
  return (
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(detail.mergedAt) <=
    7 * 24 * 60 * 60 * 1_000
  );
};

const violationsText = (violations: ReadonlyArray<JourneyViolation>): string =>
  violations.map((violation) => `${violation.code}: ${violation.message}`).join("\n");

const planningPrompt = (detail: PrDetail): string => `You are planning a Throughline review journey.

Pull request: ${detail.ref.owner}/${detail.ref.repo}#${detail.ref.number}
Title: ${detail.title}

Work only inside the supplied world directory. Inspect repository/ and the immutable inputs:
- inputs/hunks.json
- inputs/files.json
- inputs/tree.json
- inputs/diff/full.patch
- inputs/diff/by-file/

Return a complete structured plan. Every seed hunk must be assigned exactly once, either whole or
as a lossless ordered split. Clusters must be in review order, buildsOn may name only earlier
clusters, and fileOrder must contain exactly the files homed in that cluster. Do not narrate yet.`;

const overviewPrompt = (
  detail: PrDetail,
  plan: FrozenPlan,
): string => `Write the overview for a Throughline review journey.

Pull request: ${detail.ref.owner}/${detail.ref.repo}#${detail.ref.number}
Title: ${detail.title}

The plan below is frozen. Do not change it:
${JSON.stringify(plan, null, 2)}

Inspect repository/ and inputs/ for evidence. Return only the requested structured overview.
Evidence links must use tl:hunk/<id>, tl:file/<percent-encoded-path>, or
tl:symbol/<percent-encoded-path>#<percent-encoded-symbol>. Use only evidence you observed.`;

const clusterPrompt = (detail: PrDetail, plan: FrozenPlan, clusterIndex: number): string => {
  const cluster = plan.clusters[clusterIndex]!;
  return `Narrate one cluster in a frozen Throughline review journey.

Pull request: ${detail.ref.owner}/${detail.ref.repo}#${detail.ref.number}
Target cluster: ${cluster.id} (${cluster.title})

Frozen plan:
${JSON.stringify(plan, null, 2)}

Return structured output only for target cluster ${cluster.id}. Inspect repository/ and inputs/.
Explain intent, mechanics, and consequences with observed evidence. A resurfaced hunk must belong
to an earlier cluster. Cross-file resurfacing is supported: planned home files stay first, then
foreign files follow the first occurrence of their hunks in the resurfaced list. Hints must use
this target cluster id and valid line anchors. Evidence links must use tl:hunk/<id>,
tl:file/<percent-encoded-path>, or
tl:symbol/<percent-encoded-path>#<percent-encoded-symbol>.`;
};

const repairPrompt = (
  stage: string,
  originalPrompt: string,
  violations: ReadonlyArray<JourneyViolation>,
): string => `${originalPrompt}

Your prior ${stage} output was structurally decoded but failed validation. Return a corrected,
complete replacement. Do not merely describe the corrections.

Validation failures:
${violationsText(violations)}`;

interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  sawCached: boolean;
}

const addUsage = (total: UsageTotal, usage: HarnessUsage | undefined): void => {
  if (usage === undefined) return;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  if (usage.cachedInputTokens !== undefined) {
    total.cachedInputTokens += usage.cachedInputTokens;
    total.sawCached = true;
  }
};

const usageValue = (total: UsageTotal): HarnessUsage | undefined =>
  total.inputTokens === 0 && total.outputTokens === 0 && !total.sawCached
    ? undefined
    : {
        inputTokens: total.inputTokens,
        outputTokens: total.outputTokens,
        ...(total.sawCached ? { cachedInputTokens: total.cachedInputTokens } : {}),
      };

interface StructuredAttempt<A> {
  readonly value: A;
  readonly continuation: string;
}

const jsonLine = (value: unknown): Uint8Array => textEncoder.encode(`${JSON.stringify(value)}\n`);

export const make = Effect.gen(function* () {
  const github = yield* GitHub.GitHub;
  const workspaces = yield* Workspaces.Workspaces;
  const store = yield* JourneyStore.JourneyStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadPinnedFiles = (
    prepared: Workspaces.PreparedWorkspace,
  ): Effect.Effect<PinnedFileLookup, AnalysisPipelineError> =>
    Effect.gen(function* () {
      const manifestPath = path.join(prepared.inputsDir, "contents.json");
      const raw = yield* fileSystem
        .readFileString(manifestPath)
        .pipe(
          Effect.mapError((cause) =>
            pipelineError("artifact-read", `Could not read ${manifestPath}.`, cause),
          ),
        );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw) as unknown,
        catch: (cause) =>
          pipelineError("artifact-corrupt", `${manifestPath} is not valid JSON.`, cause),
      });
      const manifest = yield* decodeContentManifestDocument(parsed).pipe(
        Effect.mapError((cause) =>
          pipelineError("artifact-corrupt", `${manifestPath} has an invalid shape.`, cause),
        ),
      );
      const pinned = new Map<string, PinnedFile>();

      for (const entry of manifest.entries) {
        if (entry.type !== "text") {
          pinned.set(entry.path, {
            old: null,
            new: null,
            headExists: entry.type === "image" ? entry.newFile !== null : entry.newSize !== null,
          });
          continue;
        }
        const readSide = (filename: string | null) =>
          filename === null
            ? Effect.succeed(null)
            : fileSystem
                .readFileString(path.join(prepared.inputsDir, "content", filename))
                .pipe(
                  Effect.mapError((cause) =>
                    pipelineError(
                      "artifact-read",
                      `Could not read pinned content ${filename}.`,
                      cause,
                    ),
                  ),
                );
        pinned.set(entry.path, {
          old: yield* readSide(entry.oldFile),
          new: yield* readSide(entry.newFile),
          headExists: entry.newFile !== null,
        });
      }

      return makePinnedFileLookup(pinned);
    });

  const appendFallback = (
    prepared: Workspaces.PreparedWorkspace,
    record: Readonly<Record<string, unknown>>,
  ): Effect.Effect<void, AnalysisPipelineError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(path.join(prepared.stagingRunDir, "fallbacks.jsonl"), {
          flag: "a",
        });
        yield* file.writeAll(jsonLine(record));
      }),
    ).pipe(
      Effect.mapError((cause) =>
        pipelineError("fallback-log", "Could not write the analysis fallback log.", cause),
      ),
    );

  const run = Effect.fn("AnalysisPipeline.run")(function* (input: AnalysisPipelineInput) {
    const usage: UsageTotal = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      sawCached: false,
    };
    let prepared: Workspaces.PreparedWorkspace | undefined;
    let committed = false;
    let saved = false;
    let transcriptIndex = 0;

    const pipeline = Effect.gen(function* () {
      yield* input.callbacks.onPhase("resolving");
      let detail = yield* github
        .pr(input.pr)
        .pipe(
          Effect.mapError((cause) =>
            pipelineError("github", "Could not resolve the pull request for analysis.", cause),
          ),
        );
      const resolvedAt = yield* DateTime.now;
      if (!isIngestible(detail, resolvedAt)) {
        return yield* pipelineError(
          "pull-request-state",
          "The pull request is no longer open or recently merged.",
        );
      }

      yield* input.callbacks.onPhase("cloning");
      prepared = yield* workspaces
        .prepare({
          pr: input.pr,
          runId: input.runId,
          baseTipSha: detail.baseSha,
          headSha: detail.headSha,
        })
        .pipe(
          Effect.catchTag("WorkspaceError", (error) => {
            if (error.reason !== "pinned-head-mismatch") return Effect.fail(error);
            return Effect.gen(function* () {
              const refreshed = yield* github.pr(input.pr);
              const refreshedAt = yield* DateTime.now;
              if (!isIngestible(refreshed, refreshedAt)) {
                return yield* pipelineError(
                  "pull-request-state",
                  "The pull request is no longer open or recently merged.",
                );
              }
              detail = refreshed;
              return yield* workspaces.prepare({
                pr: input.pr,
                runId: input.runId,
                baseTipSha: refreshed.baseSha,
                headSha: refreshed.headSha,
              });
            });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            cause instanceof AnalysisPipelineError
              ? cause
              : pipelineError(
                  "workspace",
                  "Could not prepare the pinned analysis workspace.",
                  cause,
                ),
          ),
        );

      yield* input.callbacks.onPhase("diffing");
      const pinnedFile = yield* loadPinnedFiles(prepared);

      const runStructured = <A>(
        stage: AnalysisStage,
        name: string,
        task: Omit<AnalysisTask<A>, "world" | "onEvent" | "transcript">,
      ): Effect.Effect<Option.Option<StructuredAttempt<A>>, AnalysisPipelineError, Scope.Scope> =>
        Effect.gen(function* () {
          transcriptIndex += 1;
          const transcriptPath = path.join(
            prepared!.stagingRunDir,
            `transcript-${String(transcriptIndex).padStart(3, "0")}-${name}.jsonl`,
          );
          const transcriptGate = yield* Semaphore.make(1);
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const transcriptFile = yield* fileSystem.open(transcriptPath, { flag: "a" });
              return yield* input.harness.run({
                ...task,
                world: prepared!.worldDir,
                onEvent: (event) => input.callbacks.onHarnessEvent(stage, event),
                transcript: {
                  write: (entry) =>
                    transcriptGate
                      .withPermits(1)(transcriptFile.writeAll(jsonLine(entry)))
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new HarnessTranscriptError({
                              detail: `Could not write ${transcriptPath}.`,
                              cause,
                            }),
                        ),
                      ),
                },
              });
            }),
          ).pipe(
            Effect.mapError((cause) =>
              cause instanceof HarnessRunError
                ? cause
                : pipelineError("transcript", `Could not open or write ${transcriptPath}.`, cause),
            ),
            Effect.matchEffect({
              onFailure: (cause) =>
                cause instanceof HarnessRunError && cause.reason === "invalid-output"
                  ? Effect.succeed(Option.none<StructuredAttempt<A>>())
                  : Effect.fail(
                      cause instanceof AnalysisPipelineError
                        ? cause
                        : pipelineError(
                            "harness",
                            `The ${input.harness.kind} analysis harness failed: ${cause.detail}`,
                            cause,
                          ),
                    ),
              onSuccess: (value: AnalysisResult<A>) => {
                addUsage(usage, value.usage);
                return Effect.succeed(
                  Option.some({ value: value.value, continuation: value.continuation }),
                );
              },
            }),
          );
          return result;
        });

      const repair = <A>(
        stage: AnalysisStage,
        name: string,
        prompt: string,
        outputSchema: Readonly<Record<string, unknown>>,
        decode: (value: unknown) => Effect.Effect<A, unknown>,
        validate: (value: A) => ReadonlyArray<JourneyViolation>,
      ): Effect.Effect<
        {
          readonly value: A | undefined;
          readonly violations: ReadonlyArray<JourneyViolation>;
          readonly reason: "valid" | "invalid-output" | "invalid";
        },
        AnalysisPipelineError,
        Scope.Scope
      > =>
        Effect.gen(function* () {
          let continuation: string | undefined;
          let lastValue: A | undefined;
          let lastViolations: ReadonlyArray<JourneyViolation> = [];

          for (let turn = 0; turn <= MAX_REPAIR_TURNS; turn += 1) {
            const attempted = yield* runStructured(stage, `${name}-${turn + 1}`, {
              prompt: turn === 0 ? prompt : repairPrompt(name, prompt, lastViolations),
              outputSchema,
              decode,
              ...(continuation === undefined ? {} : { continuation }),
            });
            if (Option.isNone(attempted)) {
              return {
                value: lastValue,
                violations: lastViolations,
                reason: "invalid-output" as const,
              };
            }
            lastValue = attempted.value.value;
            continuation = attempted.value.continuation;
            lastViolations = validate(lastValue);
            if (lastViolations.length === 0) {
              return {
                value: lastValue,
                violations: [],
                reason: "valid" as const,
              };
            }
          }

          return {
            value: lastValue,
            violations: lastViolations,
            reason: "invalid" as const,
          };
        });

      yield* input.callbacks.onPhase("analyzing");
      yield* input.callbacks.onStage("planning");
      const planAttempt = yield* repair(
        "planning",
        "plan",
        planningPrompt(detail),
        planJsonSchema,
        decodePlanOutput,
        (candidate) => validatePlanOutput(candidate, prepared!.hunks, prepared!.files),
      );
      const plan = completePlan(planAttempt.value, prepared.hunks, prepared.files);
      if (planAttempt.reason !== "valid") {
        yield* appendFallback(prepared, {
          at: String(yield* DateTime.now),
          stage: "planning",
          reason: planAttempt.reason,
          violations: planAttempt.violations,
          action: "deterministic-completion",
        });
      }

      const analyzedAt = yield* DateTime.now;
      const narrations = new Map(
        plan.clusters.map((cluster) => [cluster.id as string, fallbackClusterNarration(cluster)]),
      );
      let overview = fallbackOverview(plan.clusters);

      yield* input.callbacks.onStage("narrating");
      const makeCandidateJourney = (
        candidateOverview: OverviewOutput["overview"],
        candidateNarrations: ReadonlyMap<string, ClusterNarrationOutput>,
      ) =>
        assembleJourney({
          id: input.journeyId,
          pr: input.pr,
          headSha: prepared!.headSha,
          baseSha: prepared!.baseSha,
          analyzedAt,
          harnessKind: input.harness.kind,
          files: prepared!.files,
          plan,
          overview: candidateOverview,
          narrations: candidateNarrations,
        });

      for (let generation = 0; generation < MAX_NARRATION_GENERATIONS; generation += 1) {
        const overviewAttempt = yield* repair(
          "narrating",
          `overview-g${generation + 1}`,
          overviewPrompt(detail, plan),
          overviewJsonSchema,
          decodeOverviewOutput,
          (candidate) =>
            validateJourney(makeCandidateJourney(candidate.overview, narrations), {
              seeds: prepared!.hunks,
              pinnedFile,
            }),
        );
        if (overviewAttempt.reason === "valid" && overviewAttempt.value !== undefined) {
          overview = overviewAttempt.value.overview;
          break;
        }
        if (generation === MAX_NARRATION_GENERATIONS - 1) {
          yield* appendFallback(prepared, {
            at: String(yield* DateTime.now),
            stage: "overview",
            reason: overviewAttempt.reason,
            violations: overviewAttempt.violations,
            action: "deterministic-narrative",
          });
        }
      }

      for (let clusterIndex = 0; clusterIndex < plan.clusters.length; clusterIndex += 1) {
        const cluster = plan.clusters[clusterIndex]!;
        let accepted = false;
        for (let generation = 0; generation < MAX_NARRATION_GENERATIONS; generation += 1) {
          const clusterAttempt = yield* repair(
            "narrating",
            `cluster-${clusterIndex + 1}-g${generation + 1}`,
            clusterPrompt(detail, plan, clusterIndex),
            clusterNarrationJsonSchema,
            decodeClusterNarrationOutput,
            (candidate) => {
              const trial = new Map(narrations);
              trial.set(cluster.id, candidate);
              const violations = validateJourney(makeCandidateJourney(overview, trial), {
                seeds: prepared!.hunks,
                pinnedFile,
              });
              if (candidate.clusterId !== cluster.id) {
                return [
                  ...violations,
                  {
                    code: "cluster-target-mismatch",
                    clusterId: candidate.clusterId,
                    message: `Expected narration for ${cluster.id}, received ${candidate.clusterId}.`,
                  },
                ];
              }
              return violations;
            },
          );
          if (clusterAttempt.reason === "valid" && clusterAttempt.value !== undefined) {
            narrations.set(cluster.id, clusterAttempt.value);
            accepted = true;
            break;
          }
          if (generation === MAX_NARRATION_GENERATIONS - 1) {
            yield* appendFallback(prepared, {
              at: String(yield* DateTime.now),
              stage: "cluster",
              clusterId: cluster.id,
              reason: clusterAttempt.reason,
              violations: clusterAttempt.violations,
              action: "deterministic-narrative",
            });
          }
        }
        if (!accepted) narrations.set(cluster.id, fallbackClusterNarration(cluster));
      }

      yield* input.callbacks.onPhase("validating");
      const finalUsage = usageValue(usage);
      const journey = assembleJourney({
        id: input.journeyId,
        pr: input.pr,
        headSha: prepared.headSha,
        baseSha: prepared.baseSha,
        analyzedAt,
        harnessKind: input.harness.kind,
        ...(finalUsage === undefined ? {} : { usage: finalUsage }),
        files: prepared.files,
        plan,
        overview,
        narrations,
      });
      const finalViolations = validateJourney(journey, {
        seeds: prepared.hunks,
        pinnedFile,
      });
      if (finalViolations.length > 0) {
        return yield* pipelineError(
          "deterministic-completion",
          `Deterministic completion produced an invalid journey: ${violationsText(finalViolations)}`,
        );
      }

      yield* input.callbacks.onPhase("saving");
      yield* workspaces
        .finalize(prepared)
        .pipe(
          Effect.mapError((cause) =>
            pipelineError("workspace-finalize", "Could not finalize the analysis run.", cause),
          ),
        );
      committed = true;
      const previous = yield* store
        .replace({ journey, runId: input.runId })
        .pipe(
          Effect.mapError((cause) =>
            pipelineError("journey-save", "Could not atomically save the journey.", cause),
          ),
        );
      saved = true;
      if (Option.isSome(previous)) {
        yield* workspaces
          .removeRun({ pr: previous.value.pr, runId: previous.value.runId })
          .pipe(Effect.ignore({ log: true }));
      }
      return { journey } satisfies AnalysisPipelineResult;
    });

    return yield* pipeline.pipe(
      Effect.onExit(() => {
        if (prepared === undefined || saved) return Effect.void;
        return committed
          ? workspaces
              .removeRun({ pr: prepared.pr, runId: prepared.runId })
              .pipe(Effect.ignore({ log: true }))
          : workspaces.abandon(prepared).pipe(Effect.ignore({ log: true }));
      }),
    );
  });

  return AnalysisPipeline.of({ run });
});

export const layer = Layer.effect(AnalysisPipeline, make);
