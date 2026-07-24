import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { HarnessStatus, type HarnessUsage } from "@app/contracts";

export type JsonSchema = Readonly<Record<string, unknown>>;

export type HarnessProgressEvent =
  | { readonly type: "started" }
  | {
      readonly type: "activity";
      readonly action: string;
      readonly path?: string;
      readonly counters?: Readonly<Record<string, number>>;
    }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly detail: string };

export interface HarnessTranscriptEntry {
  readonly source: "event" | "stderr";
  readonly contents: string;
}

export interface HarnessTranscriptSink {
  readonly write: (entry: HarnessTranscriptEntry) => Effect.Effect<void, HarnessTranscriptError>;
}

export interface AnalysisTask<A> {
  readonly world: string;
  readonly prompt: string;
  readonly outputSchema: JsonSchema;
  readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
  readonly continuation?: string;
  readonly onEvent: (event: HarnessProgressEvent) => Effect.Effect<void>;
  readonly transcript: HarnessTranscriptSink;
}

export interface AnalysisResult<A> {
  readonly value: A;
  readonly continuation: string;
  readonly usage?: HarnessUsage;
}

export interface AnalysisHarness {
  readonly kind: string;
  readonly detect: Effect.Effect<HarnessStatus>;
  readonly run: <A>(
    task: AnalysisTask<A>,
  ) => Effect.Effect<AnalysisResult<A>, HarnessRunError, Scope.Scope>;
}

export class HarnessTranscriptError extends Schema.TaggedErrorClass<HarnessTranscriptError>()(
  "HarnessTranscriptError",
  {
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class HarnessRunError extends Schema.TaggedErrorClass<HarnessRunError>()("HarnessRunError", {
  kind: Schema.String,
  reason: Schema.Literals([
    "unavailable",
    "unauthenticated",
    "invalid-output",
    "execution",
    "safety",
  ]),
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class HarnessSelectionError extends Schema.TaggedErrorClass<HarnessSelectionError>()(
  "HarnessSelectionError",
  {
    kind: Schema.NullOr(Schema.String),
    detail: Schema.String,
  },
) {}

export class HarnessAdapters extends Context.Service<
  HarnessAdapters,
  ReadonlyArray<AnalysisHarness>
>()("@app/server/harness/HarnessAdapters") {}

export class AnalysisHarnessRegistry extends Context.Service<
  AnalysisHarnessRegistry,
  {
    readonly statuses: Effect.Effect<ReadonlyArray<HarnessStatus>>;
    readonly status: (kind: string) => Effect.Effect<HarnessStatus>;
    readonly select: (
      explicitKind?: string,
    ) => Effect.Effect<AnalysisHarness, HarnessSelectionError>;
  }
>()("@app/server/harness/AnalysisHarnessRegistry") {}

const unknownStatus = (kind: string): HarnessStatus => ({
  kind,
  installed: false,
  version: null,
  auth: "unknown",
});

export const makeRegistry = (
  adapters: ReadonlyArray<AnalysisHarness>,
): AnalysisHarnessRegistry["Service"] => {
  const byKind = new Map(adapters.map((adapter) => [adapter.kind, adapter]));

  const status = (kind: string) =>
    Option.fromNullishOr(byKind.get(kind)).pipe(
      Option.match({
        onNone: () => Effect.succeed(unknownStatus(kind)),
        onSome: (adapter) => adapter.detect,
      }),
    );

  return AnalysisHarnessRegistry.of({
    statuses: Effect.forEach(adapters, (adapter) => adapter.detect, {
      concurrency: "unbounded",
    }),

    status,

    select: (explicitKind) => {
      if (explicitKind !== undefined) {
        const adapter = byKind.get(explicitKind);
        if (adapter === undefined) {
          return Effect.fail(
            new HarnessSelectionError({
              kind: explicitKind,
              detail: `Harness "${explicitKind}" is unavailable.`,
            }),
          );
        }
        return adapter.detect.pipe(
          Effect.flatMap((detected) =>
            detected.installed && detected.auth === "authenticated"
              ? Effect.succeed(adapter)
              : Effect.fail(
                  new HarnessSelectionError({
                    kind: explicitKind,
                    detail: detected.installed
                      ? `Harness "${explicitKind}" is not authenticated.`
                      : `Harness "${explicitKind}" is unavailable.`,
                  }),
                ),
          ),
        );
      }

      return Effect.findFirst(adapters, (adapter) =>
        adapter.detect.pipe(
          Effect.map((detected) => detected.installed && detected.auth === "authenticated"),
        ),
      ).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new HarnessSelectionError({
                  kind: null,
                  detail: "No authenticated analysis harness is available.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    },
  });
};

export const registryLayer = Layer.effect(
  AnalysisHarnessRegistry,
  Effect.map(HarnessAdapters, makeRegistry),
);

export const adaptersLayer = (adapters: ReadonlyArray<AnalysisHarness>) =>
  Layer.succeed(HarnessAdapters, adapters);

export const decodeOutput = <A>(
  kind: string,
  task: AnalysisTask<A>,
  value: unknown,
): Effect.Effect<A, HarnessRunError> =>
  task.decode(value).pipe(
    Effect.mapError(
      (cause) =>
        new HarnessRunError({
          kind,
          reason: "invalid-output",
          detail: `${kind} returned structured output that does not match the requested schema.`,
          cause,
        }),
    ),
  );

export const emitProgress = (
  task: AnalysisTask<unknown>,
  event: HarnessProgressEvent,
): Promise<void> => Effect.runPromise(task.onEvent(event));

export const writeTranscript = (
  task: AnalysisTask<unknown>,
  entry: HarnessTranscriptEntry,
): Promise<void> => Effect.runPromise(task.transcript.write(entry));
