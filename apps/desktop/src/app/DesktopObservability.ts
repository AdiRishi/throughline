import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import {
  makeBestEffortRotatingFileLoggerControl,
  makeBestEffortRotatingFileSink,
} from "@app/shared/rotatingLog";
import {
  DEFAULT_DIAGNOSTIC_TEXT_LIMIT,
  sanitizeDiagnosticJsonLine,
  sanitizeDiagnosticText,
} from "@app/shared/safeLog";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

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
    effect.pipe(Effect.annotateLogs({ component, ...annotations }));

  return {
    annotate,
    logDebug: (message, annotations) => annotate(Effect.logDebug(message), annotations),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  };
}

interface BackendChildSessionBoundary {
  readonly phase: "START" | "END";
  readonly pid: number;
  readonly port: number;
  readonly reason?: string;
}

export class DesktopBackendOutputLog extends Context.Service<
  DesktopBackendOutputLog,
  {
    readonly writeSessionBoundary: (boundary: BackendChildSessionBoundary) => Effect.Effect<void>;
    readonly writeOutputChunk: (
      stream: "stdout" | "stderr",
      chunk: Uint8Array,
    ) => Effect.Effect<void>;
    readonly flushOutput: (stream: "stdout" | "stderr") => Effect.Effect<void>;
  }
>()("@app/desktop/app/DesktopObservability/DesktopBackendOutputLog") {}

export class DesktopFileLog extends Context.Service<
  DesktopFileLog,
  {
    readonly logger: Logger.Logger<unknown, void>;
    readonly flush: Effect.Effect<void>;
  }
>()("@app/desktop/app/DesktopObservability/DesktopFileLog") {}

const BackendChildLogRecord = Schema.Struct({
  timestamp: Schema.String,
  level: Schema.Literals(["INFO", "ERROR"]),
  message: Schema.String,
  annotations: Schema.Record(Schema.String, Schema.Unknown),
});

const encodeBackendChildLogRecord = Schema.encodeEffect(
  Schema.fromJsonString(BackendChildLogRecord),
);

const currentDesktopRunId = Effect.gen(function* () {
  const annotations = yield* References.CurrentLogAnnotations;
  return typeof annotations.runId === "string" && annotations.runId.length > 0
    ? annotations.runId
    : "unknown";
});

interface OutputFrameState {
  readonly decoder: TextDecoder;
  buffer: string;
  droppingUntilNewline: boolean;
}

const CHILD_OUTPUT_BUFFER_LIMIT = DEFAULT_DIAGNOSTIC_TEXT_LIMIT * 2;
const outputTextEncoder = new TextEncoder();

function takeSanitizedOutputFrames(
  state: OutputFrameState,
  decoded: string,
  end: boolean,
): ReadonlyArray<string> {
  const frames: string[] = [];
  let input = decoded;

  while (input.length > 0) {
    if (state.droppingUntilNewline) {
      const newline = input.indexOf("\n");
      if (newline < 0) {
        input = "";
        break;
      }
      state.droppingUntilNewline = false;
      input = input.slice(newline + 1);
      continue;
    }

    state.buffer += input;
    input = "";
    while (!state.droppingUntilNewline) {
      const newline = state.buffer.indexOf("\n");
      if (newline >= 0) {
        frames.push(sanitizeDiagnosticText(state.buffer.slice(0, newline + 1)));
        state.buffer = state.buffer.slice(newline + 1);
        continue;
      }
      if (state.buffer.length > CHILD_OUTPUT_BUFFER_LIMIT) {
        frames.push(`${sanitizeDiagnosticText(state.buffer)}\n`);
        state.buffer = "";
        state.droppingUntilNewline = true;
      }
      break;
    }
  }

  if (end) {
    if (!state.droppingUntilNewline && state.buffer.length > 0) {
      frames.push(sanitizeDiagnosticText(state.buffer));
    }
    state.buffer = "";
    state.droppingUntilNewline = false;
  }

  return frames;
}

const backendOutputLayer = Layer.effect(
  DesktopBackendOutputLog,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const stdio = yield* Stdio.Stdio;
    const sink = yield* makeBestEffortRotatingFileSink({
      filePath: environment.path.join(environment.logDir, "server-child.log"),
    });

    const persist = (record: typeof BackendChildLogRecord.Type) =>
      encodeBackendChildLogRecord(record).pipe(
        Effect.flatMap((encoded) => sink.append(`${encoded}\n`)),
        Effect.catch((error) =>
          Effect.logError("failed to persist server child diagnostics").pipe(
            Effect.annotateLogs({
              component: "desktop-backend-child",
              errorType: error._tag,
            }),
          ),
        ),
      );

    const mirrorToTerminal = (stream: "stdout" | "stderr", text: string) =>
      environment.isDevelopment
        ? Stream.make(outputTextEncoder.encode(text)).pipe(
            Stream.run(
              stream === "stderr"
                ? stdio.stderr({ endOnDone: false })
                : stdio.stdout({ endOnDone: false }),
            ),
            Effect.ignore,
          )
        : Effect.void;

    const states: Record<"stdout" | "stderr", OutputFrameState> = {
      stdout: {
        decoder: new TextDecoder(),
        buffer: "",
        droppingUntilNewline: false,
      },
      stderr: {
        decoder: new TextDecoder(),
        buffer: "",
        droppingUntilNewline: false,
      },
    };

    const persistOutputFrame = (stream: "stdout" | "stderr", text: string) =>
      Effect.gen(function* () {
        yield* mirrorToTerminal(stream, text);
        const runId = yield* currentDesktopRunId;
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        yield* persist({
          timestamp,
          level: stream === "stderr" ? "ERROR" : "INFO",
          message: "backend child process output",
          annotations: {
            component: "desktop-backend-child",
            runId,
            stream,
            text,
          },
        });
      });

    const persistOutputFrames = (stream: "stdout" | "stderr", frames: ReadonlyArray<string>) =>
      Effect.forEach(frames, (frame) => persistOutputFrame(stream, frame), { discard: true });

    const service = DesktopBackendOutputLog.of({
      writeSessionBoundary: (boundary) =>
        Effect.gen(function* () {
          const runId = yield* currentDesktopRunId;
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          yield* persist({
            timestamp,
            level: "INFO",
            message: `backend child process session ${boundary.phase.toLowerCase()}`,
            annotations: {
              component: "desktop-backend-child",
              runId,
              phase: boundary.phase,
              pid: boundary.pid,
              port: boundary.port,
              ...(boundary.reason === undefined
                ? {}
                : { reason: sanitizeDiagnosticText(boundary.reason) }),
            },
          });
        }),
      writeOutputChunk: (stream, chunk) =>
        persistOutputFrames(
          stream,
          takeSanitizedOutputFrames(
            states[stream],
            states[stream].decoder.decode(chunk, { stream: true }),
            false,
          ),
        ),
      flushOutput: (stream) =>
        persistOutputFrames(
          stream,
          takeSanitizedOutputFrames(states[stream], states[stream].decoder.decode(), true),
        ),
    });

    yield* Effect.addFinalizer(() =>
      service.flushOutput("stdout").pipe(Effect.andThen(service.flushOutput("stderr"))),
    );
    return service;
  }),
);

const desktopFileLogLayer = Layer.effect(
  DesktopFileLog,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* makeBestEffortRotatingFileLoggerControl({
      filePath: environment.path.join(environment.logDir, "desktop.log"),
      transform: sanitizeDiagnosticJsonLine,
    });
  }),
);

const terminalLogger = Logger.withConsoleLog(
  Logger.map(Logger.formatLogFmt, sanitizeDiagnosticText),
);

const desktopLoggerLayer = Logger.layer(
  [terminalLogger, DesktopFileLog.pipe(Effect.map((fileLog) => fileLog.logger))],
  { mergeWithExisting: false },
).pipe(Layer.provideMerge(desktopFileLogLayer));

export const layer = Layer.mergeAll(
  desktopLoggerLayer,
  backendOutputLayer,
  Layer.succeed(References.MinimumLogLevel, "Info"),
);
