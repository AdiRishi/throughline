/**
 * The shell's observability.
 *
 * Same model as the server (see `apps/server/src/observability`): pretty logs
 * to stdout for humans, `Logger.tracerLogger` so logs ride along as span events,
 * and a local file tracer that writes completed spans as NDJSON to
 * `logDir/desktop.trace.ndjson`, with an optional OTLP delegate.
 *
 * On top of that, the shell owns one artifact the server cannot write for
 * itself: `logDir/server-child.log`. The spawned backend's stdout/stderr is
 * piped here and recorded as NDJSON, which is the only evidence left when the
 * child dies before its own Effect runtime (and its own tracer) exists. In
 * development the raw chunk is also echoed to the shell's stdout, so the
 * terminal that ran `pnpm dev:desktop` still shows the server's output inline.
 *
 * @module app/DesktopObservability
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Tracer from "effect/Tracer";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { makeLocalFileTracer, makeTraceSink } from "@app/shared/observability";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const DESKTOP_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const DESKTOP_LOG_FILE_MAX_FILES = 10;
const DESKTOP_TRACE_BATCH_WINDOW_MS = 200;
const DESKTOP_BACKEND_CHILD_LOG_FIBER_ID = "#backend-child";
const BACKEND_CHILD_LOG_FILE_NAME = "server-child.log";
const DESKTOP_TRACE_FILE_NAME = "desktop.trace.ndjson";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── Component loggers ───────────────────────────────────────────────────────

export type DesktopLogAnnotations = Record<string, unknown>;

export interface DesktopComponentLogger {
  readonly annotate: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<A, E, R>;
  readonly logDebug: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logInfo: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
  readonly logWarning: (
    message: string,
    annotations?: DesktopLogAnnotations,
  ) => Effect.Effect<void>;
  readonly logError: (message: string, annotations?: DesktopLogAnnotations) => Effect.Effect<void>;
}

export function makeComponentLogger(component: string): DesktopComponentLogger {
  const annotate: DesktopComponentLogger["annotate"] = (effect, annotations) =>
    effect.pipe(
      Effect.annotateLogs({
        component,
        ...annotations,
      }),
    );

  return {
    annotate,
    logDebug: (message, annotations) => annotate(Effect.logDebug(message), annotations),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  };
}

// ── Rotating log file writer ────────────────────────────────────────────────

export interface RotatingLogFileWriter {
  readonly writeBytes: (chunk: Uint8Array) => Effect.Effect<void>;
  readonly writeText: (chunk: string) => Effect.Effect<void>;
}

class DesktopLogFileWriterConfigurationError extends Schema.TaggedErrorClass<DesktopLogFileWriterConfigurationError>()(
  "DesktopLogFileWriterConfigurationError",
  {
    option: Schema.Literals(["maxBytes", "maxFiles"]),
    value: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.option} must be >= 1 (received ${this.value})`;
  }
}

type DesktopLogFileWriterError =
  | DesktopLogFileWriterConfigurationError
  | PlatformError.PlatformError;

const refreshFileSize = (
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<number> =>
  fileSystem.stat(filePath).pipe(
    Effect.map((stat) => Number(stat.size)),
    Effect.orElseSucceed(() => 0),
  );

/**
 * An append-only file that rotates to `<path>.1 … <path>.N` once it would
 * exceed `maxBytes`.
 *
 * Uses Effect's `FileSystem` rather than the sync `RotatingFileSink` in
 * `@app/shared/logging`, because the shell writes child output from a fiber
 * draining a stream: a `Semaphore(1)` serializes writes, and every failure path
 * re-reads the real file size so a transient error (or an external truncate)
 * cannot wedge rotation. Write failures are swallowed — losing a log line must
 * never take the shell down.
 */
const makeRotatingLogFileWriter = Effect.fn("makeRotatingLogFileWriter")(function* (input: {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
}): Effect.fn.Return<
  RotatingLogFileWriter,
  DesktopLogFileWriterError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = input.maxBytes ?? DESKTOP_LOG_FILE_MAX_BYTES;
  const maxFiles = input.maxFiles ?? DESKTOP_LOG_FILE_MAX_FILES;
  const directory = path.dirname(input.filePath);
  const baseName = path.basename(input.filePath);

  if (maxBytes < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxBytes",
      value: maxBytes,
    });
  }
  if (maxFiles < 1) {
    return yield* new DesktopLogFileWriterConfigurationError({
      option: "maxFiles",
      value: maxFiles,
    });
  }

  yield* fileSystem.makeDirectory(directory, { recursive: true });

  const withSuffix = (index: number) => `${input.filePath}.${index}`;
  const currentSize = yield* Ref.make(yield* refreshFileSize(fileSystem, input.filePath));
  const mutex = yield* Semaphore.make(1);

  // Drops backups left behind by a previous run configured with a larger
  // maxFiles, so lowering the setting actually reclaims disk.
  const pruneOverflowBackups = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      if (!entry.startsWith(`${baseName}.`)) continue;
      const suffix = Number(entry.slice(baseName.length + 1));
      if (!Number.isInteger(suffix) || suffix <= maxFiles) continue;
      yield* fileSystem.remove(path.join(directory, entry), { force: true }).pipe(Effect.ignore);
    }
  });

  const rotate = Effect.gen(function* () {
    yield* fileSystem.remove(withSuffix(maxFiles), { force: true }).pipe(Effect.ignore);
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = withSuffix(index);
      const sourceExists = yield* fileSystem.exists(source).pipe(Effect.orElseSucceed(() => false));
      if (sourceExists) {
        yield* fileSystem.rename(source, withSuffix(index + 1));
      }
    }
    const currentExists = yield* fileSystem
      .exists(input.filePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (currentExists) {
      yield* fileSystem.rename(input.filePath, withSuffix(1));
    }
    yield* Ref.set(currentSize, 0);
  }).pipe(
    Effect.catch(() =>
      refreshFileSize(fileSystem, input.filePath).pipe(
        Effect.flatMap((size) => Ref.set(currentSize, size)),
      ),
    ),
  );

  const writeBytes = (chunk: Uint8Array): Effect.Effect<void> => {
    if (chunk.byteLength === 0) return Effect.void;

    return mutex.withPermits(1)(
      Effect.gen(function* () {
        const beforeSize = yield* Ref.get(currentSize);
        if (beforeSize > 0 && beforeSize + chunk.byteLength > maxBytes) {
          yield* rotate;
        }

        yield* fileSystem.writeFile(input.filePath, chunk, { flag: "a" });
        const afterSize = (yield* Ref.get(currentSize)) + chunk.byteLength;
        yield* Ref.set(currentSize, afterSize);

        if (afterSize > maxBytes) {
          yield* rotate;
        }
      }).pipe(
        Effect.catch(() =>
          refreshFileSize(fileSystem, input.filePath).pipe(
            Effect.flatMap((size) => Ref.set(currentSize, size)),
          ),
        ),
      ),
    );
  };

  yield* pruneOverflowBackups;

  return {
    writeBytes,
    writeText: (chunk) => writeBytes(textEncoder.encode(chunk)),
  } satisfies RotatingLogFileWriter;
});

// ── Backend child output log ────────────────────────────────────────────────

export interface DesktopBackendOutputLogShape {
  readonly writeSessionBoundary: (input: {
    readonly phase: "START" | "END";
    readonly details: string;
  }) => Effect.Effect<void>;
  readonly writeOutputChunk: (
    streamName: "stdout" | "stderr",
    chunk: Uint8Array,
  ) => Effect.Effect<void>;
}

export class DesktopBackendOutputLog extends Context.Service<
  DesktopBackendOutputLog,
  DesktopBackendOutputLogShape
>()("@app/desktop/app/DesktopObservability/DesktopBackendOutputLog") {}

const sanitizeLogValue = (value: string): string => value.replace(/\s+/g, " ").trim();

// Same field set as a `Logger.formatStructured` record, so `server-child.log`
// can be read with the same tooling as the trace file.
const DesktopBackendChildLogRecord = Schema.Struct({
  message: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  timestamp: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
  spans: Schema.Record(Schema.String, Schema.Unknown),
  fiberId: Schema.String,
});

const encodeDesktopBackendChildLogRecord = Schema.encodeEffect(
  Schema.fromJsonString(DesktopBackendChildLogRecord),
);

export const DesktopBackendOutputLogNoop: DesktopBackendOutputLogShape = {
  writeSessionBoundary: () => Effect.void,
  writeOutputChunk: () => Effect.void,
};

const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  const runId = annotations["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : "unknown";
});

const writeBackendChildLogRecord = Effect.fn("desktop.observability.writeBackendChildLogRecord")(
  function* (
    logFile: RotatingLogFileWriter,
    input: {
      readonly message: string;
      readonly level: "INFO" | "ERROR";
      readonly annotations: Record<string, unknown>;
    },
  ): Effect.fn.Return<void> {
    return yield* Effect.gen(function* () {
      const timestamp = DateTime.formatIso(yield* DateTime.now);
      const encoded = yield* encodeDesktopBackendChildLogRecord({
        message: input.message,
        level: input.level,
        timestamp,
        annotations: input.annotations,
        spans: {},
        fiberId: DESKTOP_BACKEND_CHILD_LOG_FIBER_ID,
      });
      yield* logFile.writeText(`${encoded}\n`);
    }).pipe(Effect.ignore({ log: true }));
  },
);

// Dev only: echo the child's bytes to the shell's own streams so the terminal
// running `pnpm dev:desktop` shows server output inline, exactly as it did when
// the child inherited stdio.
const writeDevelopmentConsoleOutput = (
  streamName: "stdout" | "stderr",
  chunk: Uint8Array,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const output = streamName === "stderr" ? process.stderr : process.stdout;
    output.write(chunk);
  }).pipe(Effect.ignore);

const makeBackendOutputLogShape = (
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  sink: Option.Option<RotatingLogFileWriter>,
): DesktopBackendOutputLogShape =>
  Option.match(sink, {
    // A log file we could not open must not disable the dev terminal echo —
    // that is the one channel a developer is actually watching.
    onNone: () => ({
      writeSessionBoundary: () => Effect.void,
      writeOutputChunk: (streamName, chunk) =>
        environment.isDevelopment ? writeDevelopmentConsoleOutput(streamName, chunk) : Effect.void,
    }),
    onSome: (logFile) =>
      ({
        writeSessionBoundary: Effect.fn("desktop.observability.backendOutput.writeSessionBoundary")(
          function* ({ phase, details }) {
            const runId = yield* currentDesktopRunId;
            yield* writeBackendChildLogRecord(logFile, {
              message: `backend child process session ${phase.toLowerCase()}`,
              level: "INFO",
              annotations: {
                component: "desktop-backend-child",
                runId,
                phase,
                details: sanitizeLogValue(details),
              },
            });
          },
        ),
        writeOutputChunk: Effect.fn("desktop.observability.backendOutput.writeOutputChunk")(
          function* (streamName, chunk) {
            if (environment.isDevelopment) {
              yield* writeDevelopmentConsoleOutput(streamName, chunk);
            }
            const runId = yield* currentDesktopRunId;
            yield* writeBackendChildLogRecord(logFile, {
              message: "backend child process output",
              level: streamName === "stderr" ? "ERROR" : "INFO",
              annotations: {
                component: "desktop-backend-child",
                runId,
                stream: streamName,
                text: textDecoder.decode(chunk),
              },
            });
          },
        ),
      }) satisfies DesktopBackendOutputLogShape,
  });

const backendOutputLogLayer = Layer.effect(
  DesktopBackendOutputLog,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const sink = yield* makeRotatingLogFileWriter({
      filePath: environment.path.join(environment.logDir, BACKEND_CHILD_LOG_FILE_NAME),
    }).pipe(Effect.option);
    return DesktopBackendOutputLog.of(makeBackendOutputLogShape(environment, sink));
  }),
);

// ── Logger + tracer ─────────────────────────────────────────────────────────

const desktopLoggerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return Layer.mergeAll(
      Logger.layer([Logger.consolePretty(), Logger.tracerLogger], { mergeWithExisting: false }),
      Layer.succeed(References.MinimumLogLevel, environment.logLevel),
    );
  }),
);

const tracerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const tracePath = environment.path.join(environment.logDir, DESKTOP_TRACE_FILE_NAME);
    const sink = yield* makeTraceSink({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
    });
    const delegate = Option.isNone(environment.otlpTracesUrl)
      ? undefined
      : yield* OtlpTracer.make({
          url: environment.otlpTracesUrl.value,
          exportInterval: `${environment.otlpExportIntervalMs} millis`,
          resource: {
            serviceName: "throughline-desktop",
            attributes: {
              "service.runtime": "throughline-desktop",
              "service.mode": environment.isDevelopment ? "development" : "packaged",
              "service.version": environment.appVersion,
            },
          },
        });
    const tracer = yield* makeLocalFileTracer({
      filePath: tracePath,
      maxBytes: DESKTOP_LOG_FILE_MAX_BYTES,
      maxFiles: DESKTOP_LOG_FILE_MAX_FILES,
      batchWindowMs: DESKTOP_TRACE_BATCH_WINDOW_MS,
      sink,
      ...(delegate ? { delegate } : {}),
    });

    return Layer.succeed(Tracer.Tracer, tracer);
  }),
).pipe(Layer.provideMerge(OtlpSerialization.layerJson));

export const layer = Layer.mergeAll(
  backendOutputLogLayer,
  desktopLoggerLayer,
  tracerLayer,
  Layer.succeed(Tracer.MinimumTraceLevel, "Info"),
  Layer.succeed(References.TracerTimingEnabled, true),
);
