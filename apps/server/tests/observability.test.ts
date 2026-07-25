import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../src/config.ts";
import * as ServerObservability from "../src/observability.ts";

const makeTestConfig = Effect.fn("tests.observability.makeTestConfig")(function* (dataDir: string) {
  return ServerConfig.make({
    appName: "Throughline",
    version: "0.0.0-test",
    startedAt: yield* DateTime.now,
    host: "127.0.0.1",
    port: 13_773,
    staticDir: undefined,
    devWebUrl: undefined,
    bootstrapToken: "bootstrap-secret-sentinel",
    dataDir,
  });
});

it.layer(NodeServices.layer)("server observability", (it) => {
  it.effect("persists structured records and redacts credentials on scope close", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped();
      const config = yield* makeTestConfig(dataDir);

      const terminal: string[] = [];
      const testConsole = Object.assign(Object.create(globalThis.console), {
        log: (...values: ReadonlyArray<unknown>) => {
          terminal.push(values.join(" "));
        },
      }) as Console.Console;

      yield* Effect.gen(function* () {
        yield* Effect.logError(
          "diagnostic sentinel Authorization: Basic dXNlcjpwYXNzd29yZA==",
        ).pipe(
          Effect.annotateLogs({
            component: "test",
            access_token: "query-secret-sentinel",
            credential: "bootstrap secret sentinel",
            source: "wss://localhost/ws?access_token=url-secret-sentinel",
          }),
        );
        yield* Effect.logError("x".repeat(16 * 1024));
      }).pipe(
        Effect.provide(ServerObservability.layer(config)),
        Effect.provideService(Console.Console, testConsole),
      );

      const log = yield* fileSystem.readFileString(
        ServerObservability.serverLogFilePath(config, path),
      );
      const records = log
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              readonly annotations: Record<string, unknown>;
              readonly level: string;
              readonly message: string;
            },
        );
      const record = records[0] as {
        readonly annotations: Record<string, unknown>;
        readonly level: string;
        readonly message: string;
      };

      assert.equal(record.level, "ERROR");
      assert.equal(record.message, "diagnostic sentinel Authorization: Basic [redacted]");
      assert.equal(record.annotations.component, "test");
      assert.equal(record.annotations.access_token, "[redacted]");
      assert.equal(record.annotations.credential, "[redacted]");
      assert.equal(record.annotations.source, "wss://localhost/ws");
      assert.match(records[1]?.message ?? "", /…\[truncated\]$/u);
      assert.notInclude(log, "query-secret-sentinel");
      assert.notInclude(log, "url-secret-sentinel");
      assert.notInclude(log, "bootstrap secret sentinel");
      assert.notInclude(log, "dXNlcjpwYXNzd29yZA==");
      assert.notInclude(terminal.join("\n"), "bootstrap secret sentinel");
      assert.notInclude(terminal.join("\n"), "secret sentinel");
      assert.notInclude(terminal.join("\n"), "dXNlcjpwYXNzd29yZA==");
      assert.include(terminal.join("\n"), "Authorization: Basic [redacted]");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps terminal diagnostics available when the server log cannot open", () =>
    Effect.gen(function* () {
      const config = yield* makeTestConfig("/diagnostics-unavailable");
      const terminal: string[] = [];
      const directErrors: Array<ReadonlyArray<unknown>> = [];
      const testConsole = Object.assign(Object.create(globalThis.console), {
        log: (...values: ReadonlyArray<unknown>) => {
          terminal.push(values.join(" "));
        },
        error: (...values: ReadonlyArray<unknown>) => {
          directErrors.push(values);
        },
      }) as Console.Console;
      const fileSystem = FileSystem.makeNoop({
        makeDirectory: (directory) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "makeDirectory",
              description: "read-only diagnostics fixture",
              pathOrDescriptor: directory,
            }),
          ),
      });

      const acquired = yield* Effect.gen(function* () {
        yield* Effect.logError("server terminal fallback sentinel");
        return true;
      }).pipe(
        Effect.provide(ServerObservability.layer(config)),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Console.Console, testConsole),
      );

      assert.isTrue(acquired);
      assert.include(terminal.join("\n"), "server terminal fallback sentinel");
      assert.lengthOf(directErrors, 1);
      assert.equal(
        directErrors[0]?.[0],
        "Throughline could not open its diagnostic log. Terminal diagnostics remain available.",
      );
      const details = directErrors[0]?.[1] as {
        readonly errorType: string;
        readonly filePath: string;
      };
      assert.equal(details.errorType, "PermissionDenied");
      assert.isTrue(details.filePath.endsWith("server.log"));
    }).pipe(Effect.scoped),
  );
});
