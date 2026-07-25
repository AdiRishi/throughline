import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  makeBestEffortRotatingFileSink,
  makeRotatingFileLogger,
  makeRotatingFileLoggerControl,
  makeRotatingFileSink,
} from "../src/rotatingLog.ts";

it.layer(NodeServices.layer)("rotatingLog", (it) => {
  describe("rotating file sink", () => {
    it.effect("appends text and bytes and derives the conventional previous path", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "throughline.log");
        const sink = yield* makeRotatingFileSink({ filePath, maxBytes: 1024 });

        yield* sink.append("first\n");
        yield* sink.append(new TextEncoder().encode("second\n"));

        assert.equal(yield* fileSystem.readFileString(filePath), "first\nsecond\n");
        assert.equal(sink.previousFilePath, path.join(directory, "throughline.1.log"));
      }).pipe(Effect.scoped),
    );

    it.effect("rolls the active file before an append crosses the limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "server-child.log");
        const sink = yield* makeRotatingFileSink({ filePath, maxBytes: 16 });

        yield* sink.append("first-run\n");
        yield* sink.append("second-run\n");

        assert.equal(yield* fileSystem.readFileString(filePath), "second-run\n");
        assert.equal(
          yield* fileSystem.readFileString(path.join(directory, "server-child.1.log")),
          "first-run\n",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("recovers the newest complete entries from an oversized legacy file", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "app.log");
        const previousFilePath = path.join(directory, "app.previous.log");
        yield* fileSystem.writeFileString(
          filePath,
          `obsolete\n${"x".repeat(64)}\nlatest-diagnostic\n`,
        );
        const sink = yield* makeRotatingFileSink({
          filePath,
          previousFilePath,
          maxBytes: 32,
        });

        yield* sink.append("new-run\n");

        const previous = yield* fileSystem.readFileString(previousFilePath);
        assert.equal(yield* fileSystem.readFileString(filePath), "new-run\n");
        assert.include(previous, "latest-diagnostic\n");
        assert.notInclude(previous, "obsolete");
        assert.isAtMost(new TextEncoder().encode(previous).byteLength, 32);
      }).pipe(Effect.scoped),
    );

    it.effect("serializes concurrent appends without corrupting entries", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "concurrent.log");
        const sink = yield* makeRotatingFileSink({ filePath, maxBytes: 64 * 1024 });
        const entries = Array.from({ length: 100 }, (_, index) => `entry-${index}\n`);

        yield* Effect.forEach(entries, sink.append, {
          concurrency: "unbounded",
          discard: true,
        });

        const written = (yield* fileSystem.readFileString(filePath)).trim().split("\n").toSorted();
        assert.deepEqual(written, entries.map((entry) => entry.trim()).toSorted());
      }).pipe(Effect.scoped),
    );

    it.effect("reports the first runtime write failure and disables later file writes", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const errors: Array<ReadonlyArray<unknown>> = [];
        let writeAttempts = 0;
        const testConsole = Object.assign(Object.create(globalThis.console), {
          error: (...values: ReadonlyArray<unknown>) => {
            errors.push(values);
          },
        }) as Console.Console;
        const fileSystem = FileSystem.makeNoop({
          exists: () => Effect.succeed(false),
          makeDirectory: () => Effect.void,
          writeFile: (filePath) =>
            Effect.sync(() => {
              writeAttempts += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFile",
                    description: "runtime diagnostics failure fixture",
                    pathOrDescriptor: filePath,
                  }),
                ),
              ),
            ),
        });
        const filePath = path.join("/diagnostics", "throughline.log");
        yield* Effect.gen(function* () {
          const sink = yield* makeBestEffortRotatingFileSink({ filePath });
          yield* sink.append("first\n");
          yield* sink.append("second\n");
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Console.Console, testConsole),
        );

        assert.equal(writeAttempts, 1);
        assert.lengthOf(errors, 1);
        assert.equal(
          errors[0]?.[0],
          "Throughline could not write its diagnostic log. Further file writes are disabled; terminal diagnostics remain available.",
        );
        assert.deepEqual(errors[0]?.[1], {
          filePath,
          errorType: "PermissionDenied",
        });
      }),
    );
  });

  describe("rotating file logger", () => {
    it.effect("flushes pending NDJSON entries when its scope closes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "effect.log");

        yield* Effect.scoped(
          Effect.gen(function* () {
            const logger = yield* makeRotatingFileLogger({
              filePath,
              maxBytes: 1024,
              batchWindow: "1 hour",
              transform: (line) => line.replace("scope is closing", "[redacted]"),
            });
            yield* Effect.logInfo("scope is closing").pipe(
              Effect.annotateLogs({ component: "test" }),
              Effect.provide(Logger.layer([logger])),
            );
          }),
        );

        const entries = (yield* fileSystem.readFileString(filePath))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.lengthOf(entries, 1);
        assert.equal(entries[0]?.message, "[redacted]");
        assert.deepEqual(entries[0]?.annotations, { component: "test" });
      }).pipe(Effect.scoped),
    );

    it.effect("can flush pending entries before the logger scope closes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped();
        const filePath = path.join(directory, "effect.log");
        const control = yield* makeRotatingFileLoggerControl({
          filePath,
          maxBytes: 1024,
          batchWindow: "1 hour",
        });

        yield* Effect.logInfo("shutdown complete").pipe(
          Effect.provide(Logger.layer([control.logger])),
        );
        yield* Effect.all([control.flush, control.flush], {
          concurrency: "unbounded",
          discard: true,
        });

        const entry = JSON.parse(yield* fileSystem.readFileString(filePath)) as {
          readonly message: string;
        };
        assert.equal(entry.message, "shutdown complete");
      }).pipe(Effect.scoped),
    );
  });
});
