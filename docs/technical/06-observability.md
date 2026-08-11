# Observability Runbook

The T3-aligned starter owns the observability implementation. This runbook records only the Throughline-specific facts needed to find and interpret its output across the shell, server, and renderer.

## Start Here

All artifacts from one desktop run share a directory chosen by the shell:

| Run                                               | Directory                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm dev`, `pnpm dev:server`, `pnpm dev:desktop` | `<repo>/.logs` (gitignored; the dev runner prints it at startup)                       |
| Packaged desktop                                  | `<app-data>/throughline/logs` — macOS `~/Library/Application Support/throughline/logs` |
| Standalone server                                 | `$APP_DATA_DIR/logs`, default `~/.throughline/logs`                                    |

`APP_LOG_DIR` overrides the directory. The shell resolves it once and passes the result to its server child, so a desktop run does not split artifacts between locations.

| File                   | Contents                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| `server.trace.ndjson`  | completed server spans and renderer spans forwarded over OTLP                    |
| `desktop.trace.ndjson` | completed shell spans                                                            |
| `server-child.log`     | bounded stdout/stderr tails from failed server-child sessions, encoded as NDJSON |

Trace files rotate at 10 MB with ten backups. `server-child.log` follows the same rotation policy when written, but may not exist after successful runs.

## How The Processes Connect

```text
renderer OtlpTracer
  → POST /api/observability/v1/traces
    → server trace sink
      → server.trace.ndjson

server local tracer
  → server.trace.ndjson

shell local tracer
  → desktop.trace.ndjson
```

The renderer has no terminal or filesystem, so its persisted output consists of spans forwarded to the server. Renderer records carry `resourceAttributes["service.name"] = "throughline-web"` and use the `otlp-span` record type.

Renderer and server RPC spans land in the same file but do **not** share a trace ID. The RPC server runs with protocol tracing disabled; the server handlers emit independent `ws.rpc.<method>` root spans. Follow a renderer action into the server by method name and timestamp, not by `traceId`.

Pretty logs still go to stdout. A log emitted inside an active span is also attached as a span event and persisted with that span; a log outside a span is stdout-only. Until the renderer exporter is configured, spans fall back to in-memory native spans. Tracing is never load-bearing.

## Server-Child Failures

The shell pipes the spawned server's stdout and stderr. During a child session it retains only the newest 1 MiB and at most 256 chunks in memory:

- an unexpected exit writes the retained tail to `server-child.log`
- a readiness failure writes a snapshot while retaining the buffer for later crash output
- requested stops and orderly shutdowns discard the buffer
- development also echoes each chunk to the shell's stdout

This file is a crash diagnostic, not a complete process log. It is the evidence to inspect when the child fails before its own Effect runtime and tracer start.

## Useful Commands

Choose the directory from the table above; these examples use development paths.

```bash
TRACE_FILE=".logs/server.trace.ndjson"
tail -f "$TRACE_FILE"
```

Failed server spans:

```bash
jq -c 'select(.type == "effect-span" and .exit._tag != "Success")
  | { name, durationMs, exit, attributes }' "$TRACE_FILE"
```

Slow spans:

```bash
jq -c 'select(.durationMs > 1000)
  | { type, name, durationMs, traceId, attributes }' "$TRACE_FILE"
```

Persisted log events:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | { message: .name, level: .attributes["effect.logLevel"] }
  ]
}' "$TRACE_FILE"
```

Renderer spans:

```bash
jq -c 'select(.type == "otlp-span")
  | { name, durationMs, attributes }' "$TRACE_FILE"
```

Failed child output, when present:

```bash
jq -r 'select(.annotations.stream)
  | "\(.timestamp) \(.annotations.stream) \(.annotations.text)"' \
  .logs/server-child.log
```

## Operational Overrides

| Variable               | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `APP_LOG_DIR`          | Override the shared artifact directory                            |
| `APP_LOG_LEVEL`        | Set the shell, server, and renderer minimum level; default `Info` |
| `APP_OTLP_TRACES_URL`  | Export traces to a reviewer-operated OTLP HTTP endpoint           |
| `APP_OTLP_METRICS_URL` | Export server metrics to a reviewer-operated OTLP HTTP endpoint   |

Local trace files remain enabled when OTLP export is unset. Metrics are not persisted locally. Advanced server-only trace rotation, batching, and timing settings are defined in `apps/server/src/cli/config.ts`; that configuration is the source of truth rather than a duplicated list here.
