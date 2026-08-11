// @effect-diagnostics nodeBuiltinImport:off - Test asserts on real files written by the observability layer.
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

const annotationsOf = (record: Record<string, unknown> | undefined): Record<string, unknown> =>
  (record?.["annotations"] as Record<string, unknown> | undefined) ?? {};

const withOutputLog = <A, E>(
  input: { readonly logDir: string; readonly isDevelopment: boolean },
  use: (log: DesktopObservability.DesktopBackendOutputLogShape) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const log = yield* DesktopObservability.DesktopBackendOutputLog;
    return yield* use(log);
  }).pipe(
    Effect.annotateLogs({ runId: "test-run" }),
    Effect.provide(
      DesktopObservability.layer.pipe(
        Layer.provideMerge(environmentLayer(input)),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(FetchHttpClient.layer),
      ),
    ),
  );

it("advances a retained output offset instead of repeatedly copying a full head chunk", () => {
  const maxBufferedBytes = 1024 * 1024;
  const initial = DesktopObservability.appendBoundedOutputChunk(
    {
      runId: "test-run",
      startDetails: "pid=123",
      chunks: [],
      byteLength: 0,
    },
    "stderr",
    new Uint8Array(maxBufferedBytes),
  );
  const initialBackingBuffer = initial.chunks[0]?.chunk.buffer;

  const next = DesktopObservability.appendBoundedOutputChunk(initial, "stderr", Uint8Array.of(1));

  assert.equal(next.chunks[0]?.chunk.buffer, initialBackingBuffer);
  assert.equal(next.chunks[0]?.offset, 1);
  assert.equal(next.byteLength, maxBufferedBytes);
});

it.live("buffers the server child's output and persists it only on a reported failure", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "packaged");
    const logPath = NodePath.join(logDir, "server-child.log");
    const encoder = new TextEncoder();

    yield* withOutputLog({ logDir, isDevelopment: false }, (log) =>
      Effect.gen(function* () {
        yield* log.beginSession({ details: "pid=4242 port=13773 cwd=/repo" });
        yield* log.writeOutputChunk("stdout", encoder.encode("app server listening\n"));
        yield* log.writeOutputChunk("stderr", encoder.encode("something exploded\n"));
        assert.isFalse(NodeFS.existsSync(logPath));
        yield* log.persistFailure({ details: "code=1" });
        yield* log.beginSession({ details: "pid=4343" });
        yield* log.writeOutputChunk("stdout", encoder.encode("normal shutdown\n"));
        yield* log.discardSession;
      }),
    );

    const records = readRecords(logPath);
    assert.strictEqual(records.length, 4);

    assert.strictEqual(records[0]?.["message"], "backend child process failure output start");
    assert.strictEqual(records[0]?.["level"], "ERROR");
    assert.strictEqual(annotationsOf(records[0])["runId"], "test-run");
    assert.include(String(annotationsOf(records[0])["details"]), "pid=4242");
    assert.strictEqual(records[3]?.["message"], "backend child process failure output end");
    assert.strictEqual(annotationsOf(records[3])["details"], "code=1");

    const stdout = records[1] as Record<string, unknown>;
    const stderr = records[2] as Record<string, unknown>;
    assert.strictEqual(stdout["level"], "INFO");
    assert.strictEqual(annotationsOf(stdout)["stream"], "stdout");
    assert.strictEqual(annotationsOf(stdout)["text"], "app server listening\n");
    assert.strictEqual(stderr["level"], "ERROR");
    assert.strictEqual(annotationsOf(stderr)["stream"], "stderr");

    assert.isFalse(
      records.some((record) => annotationsOf(record)["text"] === "normal shutdown\n"),
      "a run that stopped on request must not be persisted",
    );

    // Buffering a chunk must not cost a span per line the child writes.
    const traceRecords = readRecords(NodePath.join(logDir, "desktop.trace.ndjson"));
    assert.isFalse(
      traceRecords.some(
        (record) => record["name"] === "desktop.observability.backendOutput.writeOutputChunk",
      ),
    );
  }),
);

it.live("keeps buffering output after a non-terminal failure snapshot", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "snapshot");
    const encoder = new TextEncoder();

    yield* withOutputLog({ logDir, isDevelopment: false }, (log) =>
      Effect.gen(function* () {
        yield* log.beginSession({ details: "pid=123" });
        yield* log.writeOutputChunk("stdout", encoder.encode("before timeout\n"));
        yield* log.persistFailureSnapshot({ details: "readiness timeout" });
        yield* log.writeOutputChunk("stderr", encoder.encode("after timeout\n"));
        yield* log.persistFailure({ details: "code=1" });
      }),
    );

    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    assert.isTrue(records.some((record) => annotationsOf(record)["text"] === "after timeout\n"));
    assert.strictEqual(annotationsOf(records.at(-1))["details"], "code=1");
  }),
);

it.live("retains only the last mebibyte of backend child output", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "bounded-bytes");
    const maxBufferedBytes = 1024 * 1024;
    const discardedPrefixBytes = 128;
    const output = new Uint8Array(maxBufferedBytes + discardedPrefixBytes);
    output.fill("x".charCodeAt(0));
    output.fill("y".charCodeAt(0), 0, discardedPrefixBytes);

    yield* withOutputLog({ logDir, isDevelopment: false }, (log) =>
      Effect.gen(function* () {
        yield* log.beginSession({ details: "pid=123" });
        yield* log.writeOutputChunk("stderr", output);
        yield* log.persistFailure({ details: "code=1" });
      }),
    );

    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    const text = annotationsOf(records[1])["text"];
    assert.strictEqual(typeof text, "string");
    if (typeof text !== "string") return;
    assert.strictEqual(new TextEncoder().encode(text).byteLength, maxBufferedBytes);
    assert.isFalse(text.includes("y"));
  }),
);

it.live("bounds the number of retained backend child output chunks", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "bounded-chunks");

    yield* withOutputLog({ logDir, isDevelopment: false }, (log) =>
      Effect.gen(function* () {
        yield* log.beginSession({ details: "pid=123" });
        for (let index = 0; index < 300; index += 1) {
          yield* log.writeOutputChunk("stderr", Uint8Array.of(index % 128));
        }
        yield* log.persistFailure({ details: "code=1" });
      }),
    );

    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    // 256 retained chunks, bracketed by the failure start/end records.
    assert.strictEqual(records.length, 258);
  }),
);

it.live("echoes child output to the shell's own stdout in development", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "dev");
    const written: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;

    yield* Effect.ensuring(
      withOutputLog({ logDir, isDevelopment: true }, (log) =>
        Effect.gen(function* () {
          yield* log.beginSession({ details: "pid=123" });
          yield* log.writeOutputChunk("stdout", new TextEncoder().encode("hello from server\n"));
          yield* log.persistFailure({ details: "code=1" });
        }),
      ),
      Effect.sync(() => {
        process.stdout.write = realWrite;
      }),
    );

    assert.include(written.join(""), "hello from server");
    const records = readRecords(NodePath.join(logDir, "server-child.log"));
    assert.strictEqual(annotationsOf(records[1])["text"], "hello from server\n");
  }),
);

it.live("writes completed shell spans to desktop.trace.ndjson", () =>
  Effect.gen(function* () {
    const logDir = NodePath.join(SCRATCH, "tracing");

    yield* Effect.logInfo("inside the span").pipe(
      Effect.annotateLogs({ component: "test" }),
      Effect.withSpan("desktop.observability.test"),
      Effect.provide(
        DesktopObservability.layer.pipe(
          Layer.provideMerge(environmentLayer({ logDir, isDevelopment: false })),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
      ),
    );

    // The sink batches; the layer's teardown flush is what lands the file.
    yield* Effect.sleep("100 millis");

    const records = readRecords(NodePath.join(logDir, "desktop.trace.ndjson"));
    const span = records.find((record) => record["name"] === "desktop.observability.test");
    assert.isDefined(span);

    // A log is persisted only by riding its enclosing span as an event.
    const events = span?.["events"] as Array<Record<string, unknown>>;
    const logEvent = events.find(
      (event) => (event["attributes"] as Record<string, unknown>)["effect.logLevel"] === "INFO",
    );
    assert.strictEqual(logEvent?.["name"], "inside the span");
  }),
);
