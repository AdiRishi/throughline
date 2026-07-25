import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

export const DEFAULT_ROTATING_LOG_MAX_BYTES = 8 * 1024 * 1024;

export interface RotatingFileSinkOptions {
  readonly filePath: string;
  readonly previousFilePath?: string;
  readonly maxBytes?: number;
}

export interface RotatingFileSink {
  readonly filePath: string;
  readonly previousFilePath: string;
  readonly maxBytes: number;
  readonly append: (data: string | Uint8Array) => Effect.Effect<void, PlatformError.PlatformError>;
}

export interface RotatingFileLoggerOptions extends RotatingFileSinkOptions {
  readonly batchWindow?: Duration.Input;
  readonly transform?: (line: string) => string;
}

export interface RotatingFileLoggerControl {
  readonly logger: Logger.Logger<unknown, void>;
  readonly flush: Effect.Effect<void>;
}

interface ResolvedRotatingFileSinkOptions {
  readonly filePath: string;
  readonly previousFilePath: string;
  readonly maxBytes: number;
}

const textEncoder = new TextEncoder();
const noOpLogger = Logger.make<unknown, void>(() => undefined);

function resolveSinkOptions(
  options: RotatingFileSinkOptions,
  path: Path.Path,
): ResolvedRotatingFileSinkOptions {
  const parsedPath = path.parse(options.filePath);
  return {
    filePath: options.filePath,
    previousFilePath:
      options.previousFilePath ??
      path.format({
        dir: parsedPath.dir,
        name: `${parsedPath.name}.1`,
        ext: parsedPath.ext,
      }),
    maxBytes: options.maxBytes ?? DEFAULT_ROTATING_LOG_MAX_BYTES,
  };
}

function reportUnavailableDiagnosticFile(
  options: RotatingFileSinkOptions,
  error: PlatformError.PlatformError,
) {
  return Console.error(
    "Throughline could not open its diagnostic log. Terminal diagnostics remain available.",
    {
      filePath: options.filePath,
      errorType: error.reason._tag,
    },
  );
}

function retainNewestBytes(input: Uint8Array, maxBytes: number): Uint8Array {
  if (input.byteLength <= maxBytes) {
    return input;
  }

  const retainedStart = input.byteLength - maxBytes;
  const firstNewline = input.indexOf(10, retainedStart);
  return firstNewline >= 0 && firstNewline < input.byteLength - 1
    ? input.slice(firstNewline + 1)
    : input.slice(retainedStart);
}

/**
 * Creates a serialized append sink with one bounded rollover file.
 *
 * The previous path defaults to `<stem>.1.<ext>`, so `app.log` rolls to
 * `app.1.log`. Appends larger than the limit retain their newest bytes and,
 * when possible, discard the partial first line so NDJSON remains parseable.
 */
export const makeRotatingFileSink = Effect.fn("shared.rotatingLog.makeRotatingFileSink")(function* (
  options: RotatingFileSinkOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mutex = yield* Semaphore.make(1);
  const resolved = resolveSinkOptions(options, path);

  yield* fileSystem.makeDirectory(path.dirname(resolved.filePath), { recursive: true });
  yield* fileSystem.makeDirectory(path.dirname(resolved.previousFilePath), { recursive: true });

  const readRetainedTail = Effect.fn("shared.rotatingLog.readRetainedTail")(function* (
    fileSize: FileSystem.Size,
  ) {
    const file = yield* fileSystem.open(resolved.filePath, { flag: "r" });
    yield* file.seek(fileSize - BigInt(resolved.maxBytes), "start");
    const tail = yield* file.readAlloc(resolved.maxBytes);
    return retainNewestBytes(
      tail._tag === "Some" ? tail.value : new Uint8Array(),
      resolved.maxBytes,
    );
  }, Effect.scoped);

  const rotate = Effect.fn("shared.rotatingLog.rotate")(function* (fileSize: FileSystem.Size) {
    yield* fileSystem.remove(resolved.previousFilePath, { force: true });
    if (fileSize <= BigInt(resolved.maxBytes)) {
      yield* fileSystem.rename(resolved.filePath, resolved.previousFilePath);
      return;
    }

    const tail = yield* readRetainedTail(fileSize);
    yield* fileSystem.writeFile(resolved.previousFilePath, tail);
    yield* fileSystem.remove(resolved.filePath);
  });

  const append = Effect.fn("shared.rotatingLog.append")(function* (data: string | Uint8Array) {
    const chunk = typeof data === "string" ? textEncoder.encode(data) : data;
    if (chunk.byteLength === 0) {
      return;
    }

    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(resolved.filePath);
        const currentSize = exists
          ? (yield* fileSystem.stat(resolved.filePath)).size
          : FileSystem.Size(0);

        if (
          currentSize > 0 &&
          (currentSize > BigInt(resolved.maxBytes) ||
            currentSize + BigInt(chunk.byteLength) > BigInt(resolved.maxBytes))
        ) {
          yield* rotate(currentSize);
        }

        yield* fileSystem.writeFile(
          resolved.filePath,
          retainNewestBytes(chunk, resolved.maxBytes),
          { flag: "a" },
        );
      }),
    );
  });

  return {
    filePath: resolved.filePath,
    previousFilePath: resolved.previousFilePath,
    maxBytes: resolved.maxBytes,
    append,
  } satisfies RotatingFileSink;
});

/**
 * Acquires a rotating sink without making diagnostics a process dependency.
 * If the destination cannot be prepared, one direct console record is emitted
 * and the returned sink silently discards subsequent file writes.
 */
export const makeBestEffortRotatingFileSink = Effect.fn(
  "shared.rotatingLog.makeBestEffortRotatingFileSink",
)(function* (options: RotatingFileSinkOptions) {
  const path = yield* Path.Path;
  const resolved = resolveSinkOptions(options, path);
  const fallback: RotatingFileSink = {
    ...resolved,
    append: () => Effect.void,
  };

  return yield* makeRotatingFileSink(options).pipe(
    Effect.catch((error) =>
      reportUnavailableDiagnosticFile(options, error).pipe(Effect.as(fallback)),
    ),
  );
});

/**
 * Creates a scoped Effect logger that writes batched NDJSON through a rotating
 * file sink. Pending entries flush when the enclosing scope closes.
 */
export const makeRotatingFileLoggerControl = Effect.fn(
  "shared.rotatingLog.makeRotatingFileLoggerControl",
)(function* (options: RotatingFileLoggerOptions) {
  const sink = yield* makeRotatingFileSink(options);
  const formatter =
    options.transform === undefined
      ? Logger.formatJson
      : Logger.map(Logger.formatJson, options.transform);
  const flushMutex = yield* Semaphore.make(1);
  let entries: Array<string> = [];
  const flush = Effect.uninterruptible(
    flushMutex.withPermits(1)(
      Effect.suspend(() => {
        if (entries.length === 0) {
          return Effect.void;
        }
        const pending = entries;
        entries = [];
        return sink.append(`${pending.join("\n")}\n`).pipe(
          Effect.catch((error) =>
            Console.error("Throughline could not write its diagnostic log.", {
              filePath: sink.filePath,
              errorType: error._tag,
            }),
          ),
        );
      }),
    ),
  );

  yield* Effect.sleep(options.batchWindow ?? Duration.seconds(1)).pipe(
    Effect.andThen(flush),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => flush);

  return {
    logger: Logger.make((input) => {
      entries.push(formatter.log(input));
    }),
    flush,
  } satisfies RotatingFileLoggerControl;
});

/**
 * Acquires a rotating logger without making diagnostics a process dependency.
 * If the destination cannot be prepared, one direct console record is emitted
 * and the returned logger becomes a no-op.
 */
export const makeBestEffortRotatingFileLoggerControl = Effect.fn(
  "shared.rotatingLog.makeBestEffortRotatingFileLoggerControl",
)(function* (options: RotatingFileLoggerOptions) {
  const fallback: RotatingFileLoggerControl = {
    logger: noOpLogger,
    flush: Effect.void,
  };

  return yield* makeRotatingFileLoggerControl(options).pipe(
    Effect.catch((error) =>
      reportUnavailableDiagnosticFile(options, error).pipe(Effect.as(fallback)),
    ),
  );
});

export const makeRotatingFileLogger = Effect.fn("shared.rotatingLog.makeRotatingFileLogger")(
  function* (options: RotatingFileLoggerOptions) {
    return (yield* makeRotatingFileLoggerControl(options)).logger;
  },
);

export const makeBestEffortRotatingFileLogger = Effect.fn(
  "shared.rotatingLog.makeBestEffortRotatingFileLogger",
)(function* (options: RotatingFileLoggerOptions) {
  return (yield* makeBestEffortRotatingFileLoggerControl(options)).logger;
});
