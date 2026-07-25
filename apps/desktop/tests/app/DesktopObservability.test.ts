import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopObservability from "../../src/app/DesktopObservability.ts";

function makeTestEnvironment(
  path: Path.Path,
  homeDirectory: string,
  isPackaged: boolean,
  devServerUrl: Option.Option<URL>,
) {
  return DesktopEnvironment.makeWith(
    {
      dirname: path.join(homeDirectory, "app", "dist-electron"),
      homeDirectory,
      platform: "darwin",
      appVersion: "0.0.0-test",
      appPath: path.join(homeDirectory, "app"),
      isPackaged,
      resourcesPath: path.join(homeDirectory, "app", "resources"),
      appDataDirectory: Option.none(),
      xdgConfigHome: Option.none(),
      appImagePath: Option.none(),
      serverEntryOverride: Option.none(),
      configuredBackendPort: Option.none(),
      devServerUrl,
    },
    path,
  );
}

it.layer(NodeServices.layer)("DesktopObservability", (it) => {
  it.effect("persists desktop and sanitized child diagnostics with run correlation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const environment = makeTestEnvironment(path, homeDirectory, true, Option.none());
      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment);

      yield* Effect.gen(function* () {
        const childLog = yield* DesktopObservability.DesktopBackendOutputLog;
        yield* Effect.logError("desktop diagnostic sentinel").pipe(
          Effect.annotateLogs({
            component: "test",
            credential: "desktop-secret-sentinel",
          }),
        );
        yield* Effect.logError("x".repeat(16 * 1024));
        yield* childLog.writeSessionBoundary({
          phase: "START",
          pid: 4242,
          port: 13_773,
        });
        yield* childLog.writeOutputChunk(
          "stderr",
          new TextEncoder().encode(
            "failed wss://localhost/ws?access_token=url-secret-sentinel Authorization: Bearer bearer-secret-sentinel",
          ),
        );
        yield* childLog.writeOutputChunk(
          "stderr",
          new TextEncoder().encode(
            ` credential="split quoted secret sentinel"\n${"z".repeat(20 * 1024)}\n`,
          ),
        );
      }).pipe(
        Effect.annotateLogs({ runId: "desktop-run-test", service: "desktop" }),
        Effect.provide(DesktopObservability.layer.pipe(Layer.provide(environmentLayer))),
      );

      const desktopLog = yield* fileSystem.readFileString(
        path.join(environment.logDir, "desktop.log"),
      );
      const childLog = yield* fileSystem.readFileString(
        path.join(environment.logDir, "server-child.log"),
      );

      assert.include(desktopLog, "desktop diagnostic sentinel");
      assert.include(desktopLog, '"runId":"desktop-run-test"');
      assert.notInclude(desktopLog, "desktop-secret-sentinel");
      assert.include(childLog, "backend child process session start");
      assert.include(childLog, '"stream":"stderr"');
      assert.include(childLog, "wss://localhost/ws");
      assert.include(childLog, "[redacted]");
      assert.notInclude(childLog, "url-secret-sentinel");
      assert.notInclude(childLog, "bearer-secret-sentinel");
      assert.notInclude(childLog, "quoted secret sentinel");
      for (const line of desktopLog.trim().split("\n")) {
        JSON.parse(line);
      }
      for (const line of childLog.trim().split("\n")) {
        JSON.parse(line);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("mirrors development child output to the launching terminal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fileSystem.makeTempDirectoryScoped();
      const environment = makeTestEnvironment(
        path,
        homeDirectory,
        false,
        Option.some(new URL("http://localhost:5733")),
      );
      const chunks: string[] = [];
      const collect = Sink.forEach<string | Uint8Array, void, never, never>((chunk) =>
        Effect.sync(() => {
          chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        }),
      );
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdout: () => collect,
        stderr: () => collect,
        stdin: Stream.empty,
      });

      yield* Effect.gen(function* () {
        const childLog = yield* DesktopObservability.DesktopBackendOutputLog;
        const encoder = new TextEncoder();
        yield* childLog.writeOutputChunk("stderr", encoder.encode("split caf"));
        yield* childLog.writeOutputChunk("stderr", Uint8Array.of(0xc3));
        yield* childLog.writeOutputChunk(
          "stderr",
          Uint8Array.from([
            0xa9,
            ...encoder.encode(' Authorization: Bearer terminal-secret-sentinel credential="split'),
          ]),
        );
        yield* childLog.writeOutputChunk("stderr", encoder.encode(' quoted terminal secret"\n'));
        yield* childLog.writeOutputChunk("stdout", encoder.encode("searchable server output\n"));
      }).pipe(
        Effect.provide(
          DesktopObservability.layer.pipe(
            Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
          ),
        ),
        Effect.provideService(Stdio.Stdio, stdio),
      );

      assert.deepEqual(chunks, [
        "split café Authorization: Bearer [redacted] credential=[redacted]\n",
        "searchable server output\n",
      ]);
      const childLog = yield* fileSystem.readFileString(
        path.join(environment.logDir, "server-child.log"),
      );
      assert.include(childLog, "split café Authorization: Bearer [redacted]");
      assert.notInclude(childLog, "terminal-secret-sentinel");
      assert.notInclude(childLog, "quoted terminal secret");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps desktop and child terminal diagnostics available when log files cannot open",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = makeTestEnvironment(
          path,
          "/diagnostics-unavailable",
          false,
          Option.some(new URL("http://localhost:5733")),
        );
        const terminal: string[] = [];
        const childTerminal: string[] = [];
        const directErrors: Array<ReadonlyArray<unknown>> = [];
        const testConsole = Object.assign(Object.create(globalThis.console), {
          log: (...values: ReadonlyArray<unknown>) => {
            terminal.push(values.join(" "));
          },
          error: (...values: ReadonlyArray<unknown>) => {
            directErrors.push(values);
          },
        }) as Console.Console;
        const collectChildTerminal = Sink.forEach<string | Uint8Array, void, never, never>(
          (chunk) =>
            Effect.sync(() => {
              childTerminal.push(
                typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
              );
            }),
        );
        const stdio = Stdio.make({
          args: Effect.succeed([]),
          stdout: () => collectChildTerminal,
          stderr: () => collectChildTerminal,
          stdin: Stream.empty,
        });
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
          const childLog = yield* DesktopObservability.DesktopBackendOutputLog;
          yield* Effect.logError("desktop terminal fallback sentinel");
          yield* childLog.writeOutputChunk(
            "stderr",
            new TextEncoder().encode("child terminal fallback sentinel\n"),
          );
          return true;
        }).pipe(
          Effect.provide(
            DesktopObservability.layer.pipe(
              Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Console.Console, testConsole),
          Effect.provideService(Stdio.Stdio, stdio),
        );

        assert.isTrue(acquired);
        assert.include(terminal.join("\n"), "desktop terminal fallback sentinel");
        assert.include(childTerminal.join(""), "child terminal fallback sentinel");
        assert.lengthOf(directErrors, 2);
        assert.isTrue(
          directErrors.every(
            (entry) =>
              entry[0] ===
              "Throughline could not open its diagnostic log. Terminal diagnostics remain available.",
          ),
        );
        const details = directErrors.map(
          (entry) => entry[1] as { readonly errorType: string; readonly filePath: string },
        );
        assert.isTrue(details.every((detail) => detail.errorType === "PermissionDenied"));
        assert.isTrue(details.some((detail) => detail.filePath.endsWith("desktop.log")));
        assert.isTrue(details.some((detail) => detail.filePath.endsWith("server-child.log")));
      }).pipe(Effect.scoped),
  );
});
