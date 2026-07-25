# Observability

Throughline has one observability model, shared by all three processes:

- pretty logs go to stdout for humans
- completed spans go to a local NDJSON trace file
- traces and metrics can also be exported over OTLP to a real backend like Grafana LGTM

The local trace files are the persisted source of truth. There is no separate persisted log file for the server or the shell.

## Where To Find Things

### The one directory

Every artifact lands in one directory, shared by the shell and the server it spawns:

| Run                                               | Directory                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`, `pnpm dev:server`, `pnpm dev:desktop` | `<repo>/.logs` (gitignored; the dev runner prints it at startup)                       |
| Packaged desktop                                  | `<app-data>/throughline/logs` — macOS `~/Library/Application Support/throughline/logs` |
| Standalone server                                 | `$APP_DATA_DIR/logs`, default `~/.throughline/logs`                                    |

`APP_LOG_DIR` overrides it. The desktop shell resolves the value once and hands it to the server child, so one `dev:desktop` run never splits its artifacts across two directories.

### Files

| File                   | Written by | Contents                                                            |
| ---------------------- | ---------- | ------------------------------------------------------------------- |
| `server.trace.ndjson`  | server     | completed server spans, **plus renderer spans forwarded over OTLP** |
| `desktop.trace.ndjson` | shell      | completed shell spans                                               |
| `server-child.log`     | shell      | the spawned server's raw stdout/stderr, as NDJSON records           |

All three rotate: `<name>.1` … `<name>.10`, 10 MB each.

### Logs

Logs are human-facing on stdout:

- destination: stdout
- format: `Logger.consolePretty()`
- persistence: none, directly

To make a log message persist, emit it **inside an active span** with `Effect.log*`. `Logger.tracerLogger` is installed in all three processes, so it attaches as a span event and rides the span into the trace file. A log outside any span is stdout-only, by design.

Level: `APP_LOG_LEVEL` (default `Info`) — applied to the server, the shell, and the renderer alike.

### Traces

Important fields in each NDJSON record:

- `name`: span name
- `traceId`, `spanId`, `parentSpanId`: correlation
- `durationMs`: elapsed time
- `attributes`: structured context
- `events`: embedded logs and custom events
- `exit`: `Success`, `Failure`, or `Interrupted`

The record types live in `packages/shared/src/observability.ts` (`EffectTraceRecord` for spans this process created, `OtlpTraceRecord` for spans it received over OTLP).

### Where renderer logs go

The renderer has no terminal and no filesystem. It reaches the trace file the same way everything else does — as spans:

```
renderer OtlpTracer
  → POST /api/observability/v1/traces
    → BrowserTraceCollector
      → the same sink the server's own tracer writes to
        → server.trace.ndjson
```

`apps/web/src/observability/clientTracing.ts` configures the exporter against the resolved connection target, so the identical web build works in a plain browser tab and inside the Electron renderer (ADR-0004). Renderer spans carry `resourceAttributes["service.name"] = "throughline-web"`, and share a `traceId` with the server spans they triggered.

Until the exporter finishes configuring, spans fall back to `NativeSpan` — they still nest correctly, they are just not exported. Tracing is never load-bearing.

### Where the server child's crash output goes

The shell always pipes the spawned server's stdout/stderr rather than inheriting it, and records every chunk into `server-child.log` with a `stream: "stdout" | "stderr"` annotation, bracketed by `START` / `END` session boundaries carrying the pid, port, and exit reason.

This is the only evidence that survives when the child dies _before_ its own Effect runtime exists — a Node-level module-load failure under Electron's bundled Node, for example, which never reaches `server.trace.ndjson`.

In development the raw chunk is **also** echoed to the shell's own stdout, so the terminal that ran `pnpm dev:desktop` still shows server output inline, exactly as it did when the child inherited stdio.

## Reading The Trace File

```bash
TRACE_FILE=".logs/server.trace.ndjson"   # dev; see the table above otherwise
tail -f "$TRACE_FILE"
```

Failed spans:

```bash
# `.exit` only exists on effect-span records, so filter on the type first —
# otherwise every forwarded renderer span matches too.
jq -c 'select(.type == "effect-span" and .exit._tag != "Success")
  | { name, durationMs, exit, attributes }' "$TRACE_FILE"
```

Slow spans:

```bash
jq -c 'select(.durationMs > 1000) | { name, durationMs, traceId, spanId }' "$TRACE_FILE"
```

Embedded log events — this is how you read logs out of the file:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | { message: .name, level: .attributes["effect.logLevel"] }
  ]
}' "$TRACE_FILE"
```

Renderer spans only:

```bash
jq -c 'select(.type == "otlp-span") | { name, durationMs, attributes }' "$TRACE_FILE"
```

Follow one trace across the renderer and the server:

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .type, .name, .spanId, (.parentSpanId // "-"), .durationMs
] | @tsv' "$TRACE_FILE"
```

The server child's output:

```bash
jq -r 'select(.annotations.stream) | "\(.timestamp) \(.annotations.stream) \(.annotations.text)"' \
  .logs/server-child.log
```

## Running With A Local LGTM Stack

Local tracing is always on. OTLP export is opt-in.

```bash
docker run --name lgtm -p 3000:3000 -p 4317:4317 -p 4318:4318 --rm -ti grafana/otel-lgtm
```

Then open `http://localhost:3000` (`admin` / `admin`) and launch the app from a shell exporting:

```bash
export APP_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export APP_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export APP_OTLP_SERVICE_NAME=throughline-local
```

For a packaged desktop app, launch the executable from that same shell — a Finder/Spotlight/dock launch will not inherit the vars. Observability config is read at process start, so a change means a full restart.

Renderer spans reach the collector too: they are forwarded by the server's `/api/observability/v1/traces` route once `APP_OTLP_TRACES_URL` is set.

## Adding Instrumentation

### Prefer boundaries over tiny helpers

Good span boundaries: RPC methods, analysis stages, external process calls, persistence writes, queue handoffs. Most helpers should inherit the active span rather than create one.

`Effect.fn("name")` is already used throughout the codebase and should usually be your first tracing boundary.

```ts
const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({ "thing.id": "abc123" });
  yield* Effect.logInfo("starting thing"); // becomes a span event
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### Put high-cardinality detail on spans

IDs, paths, and other detailed context belong in span annotations — not in metric labels, which must stay low-cardinality (operation kind, method name, outcome).

### Use component loggers

Each module takes a `makeComponentLogger("name")` so every record carries a `component` annotation:

```ts
const { logInfo, logWarning } = makeComponentLogger("desktop-backend");
```

## Runtime Wiring

| Process  | Module                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Server   | `apps/server/src/observability/Layers/Observability.ts` (+ `serverLogger.ts`)                                                  |
| Shell    | `apps/desktop/src/app/DesktopObservability.ts`                                                                                 |
| Renderer | `apps/web/src/observability/clientTracing.ts`, wired in `apps/web/src/state/connection.ts`                                     |
| Shared   | `packages/shared/src/observability.ts` (trace sink + local file tracer), `packages/shared/src/logging.ts` (`RotatingFileSink`) |

## Environment Variables

Artifacts:

- `APP_LOG_DIR` — directory for all log/trace artifacts
- `APP_LOG_LEVEL` — minimum log level, default `Info`
- `APP_TRACE_FILE` — override the server's trace file path
- `APP_TRACE_MAX_BYTES` — per-file rotation size, default `10485760`
- `APP_TRACE_MAX_FILES` — rotated file count, default `10`
- `APP_TRACE_BATCH_WINDOW_MS` — flush window, default `200`
- `APP_TRACE_MIN_LEVEL` — minimum trace level, default `Info`
- `APP_TRACE_TIMING_ENABLED` — timing metadata, default `true`

OTLP export:

- `APP_OTLP_TRACES_URL`, `APP_OTLP_METRICS_URL`
- `APP_OTLP_EXPORT_INTERVAL_MS` — default `10000`
- `APP_OTLP_SERVICE_NAME` — default `throughline-server`

If the OTLP URLs are unset, local tracing still works and metrics stay in-process only.

## Current Constraints

- logs emitted outside a span are not persisted
- metrics are not snapshotted locally; OTLP export is the only way to see them
- `server-child.log` is raw child output, not structured application logs — the server's own records are in `server.trace.ndjson`
