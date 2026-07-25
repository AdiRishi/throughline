import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/unstable/http";

import * as DesktopEnvironment from "../../src/app/DesktopEnvironment.ts";
import * as DesktopObservability from "../../src/app/DesktopObservability.ts";

const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-observability-test-"));

const environmentLayer = (input: { readonly logDir: string; readonly isDevelopment: boolean }) =>
  Layer.effect(
    DesktopEnvironment.DesktopEnvironment,
    Effect.map(Path.Path, (path) =>
      DesktopEnvironment.makeWith(
        {
          dirname: NodePath.join(SCRATCH, "dist-electron"),
          homeDirectory: SCRATCH,
          platform: "darwin",
          appVersion: "0.0.0-test",
          appPath: SCRATCH,
          isPackaged: !input.isDevelopment,
          resourcesPath: NodePath.join(SCRATCH, "resources"),
          appDataDirectory: Option.none(),
          xdgConfigHome: Option.none(),
          serverEntryOverride: Option.none(),
          logDirOverride: Option.some(input.logDir),
          logLevel: Option.none(),
          otlpTracesUrl: Option.none(),
          otlpExportIntervalMs: Option.none(),
          // `isDevelopment` is derived from having a dev server URL.
          configuredBackendPort: Option.none(),
          devServerUrl: input.isDevelopment
            ? Option.some(new URL("http://127.0.0.1:5173"))
            : Option.none(),
        },
        path,
      ),
    ),
  ).pipe(Layer.provide(Path.layer));

const readRecords = (logPath: string): Array<Record<string, unknown>> =>
  NodeFS.readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const withOutputLog = <A, E>(
  input: { readonly logDir: string; readonly isDevelopment: boolean },
  use: (log: DesktopObservability.DesktopBackendOutputLogShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const log = yield* DesktopObservability.DesktopBackendOutputLog;
    return yield* use(log);
  }).pipe(
    Effect.provide(
      DesktopObservability.layer.pipe(
        Layer.provideMerge(environmentLayer(input)),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(FetchHttpClient.layer),
      ),
    ),
  );

it.live("records the server child's output as NDJSON, tagged by stream", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "packaged");
    const encoder = new TextEncoder();

    yield* withOutputLog({ logDir, isDevelopment: false }, (log) =>
      Effect.gen(function* () {
        yield* log.writeSessionBoundary({ phase: "START", details: "pid=4242 port=13773" });
        yield* log.writeOutputChunk("stdout", encoder.encode("app server listening\n"));
        yield* log.writeOutputChunk("stderr", encoder.encode("something exploded\n"));
        yield* log.writeSessionBoundary({ phase: "END", details: "code=1" });
      }),
    );

    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    assert.strictEqual(records.length, 4);

    // Session boundaries bracket the run, carrying pid/port and the exit reason,
    // so a crash loop is readable from this file alone.
    assert.strictEqual(records[0]?.["message"], "backend child process session start");
    assert.strictEqual(records[3]?.["message"], "backend child process session end");
    const startAnnotations = records[0]?.["annotations"] as Record<string, unknown> | undefined;
    const endAnnotations = records[3]?.["annotations"] as Record<string, unknown> | undefined;
    assert.include(String(startAnnotations?.["details"]), "pid=4242");
    assert.strictEqual(endAnnotations?.["details"], "code=1");

    // stderr is recorded at ERROR so it stays distinguishable from stdout.
    const stdout = records[1] as Record<string, unknown>;
    const stderr = records[2] as Record<string, unknown>;
    assert.strictEqual(stdout["level"], "INFO");
    assert.strictEqual((stdout["annotations"] as Record<string, unknown>)["stream"], "stdout");
    assert.strictEqual(
      (stdout["annotations"] as Record<string, unknown>)["text"],
      "app server listening\n",
    );
    assert.strictEqual(stderr["level"], "ERROR");
    assert.strictEqual((stderr["annotations"] as Record<string, unknown>)["stream"], "stderr");
  }),
);

it.live("echoes child output to the shell's own stdout in development", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "dev");
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    // The dev terminal echo is the channel a developer is actually watching, so
    // it is asserted rather than assumed.
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;

    yield* Effect.ensuring(
      withOutputLog({ logDir, isDevelopment: true }, (log) =>
        log.writeOutputChunk("stdout", new TextEncoder().encode("hello from server\n")),
      ),
      Effect.sync(() => {
        process.stdout.write = realWrite;
      }),
    );

    assert.include(written.join(""), "hello from server");
    // And it is still recorded, so a packaged run loses nothing the dev run showed.
    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    const annotations = records[0]?.["annotations"] as Record<string, unknown> | undefined;
    assert.strictEqual(annotations?.["text"], "hello from server\n");
  }),
);

it.live("writes completed shell spans to desktop.trace.ndjson", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "tracing");

    yield* Effect.gen(function* () {
      yield* Effect.logInfo("inside the span").pipe(
        Effect.annotateLogs({ component: "test" }),
        Effect.withSpan("desktop.observability.test"),
      );
    }).pipe(
      Effect.provide(
        DesktopObservability.layer.pipe(
          Layer.provideMerge(environmentLayer({ logDir, isDevelopment: false })),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    );

    // The sink batches; give its flush window time to land.
    yield* Effect.sleep("400 millis");

    const records = readRecords(NodePath.join(logDir, "desktop.trace.ndjson"));
    const span = records.find((record) => record["name"] === "desktop.observability.test");
    assert.isDefined(span);

    // `Logger.tracerLogger` is what persists a log: it rides the span as an event.
    const events = span?.["events"] as Array<Record<string, unknown>>;
    const logEvent = events.find(
      (event) => (event["attributes"] as Record<string, unknown>)["effect.logLevel"] === "INFO",
    );
    assert.strictEqual(logEvent?.["name"], "inside the span");
  }),
);
