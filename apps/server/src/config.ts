/**
 * ServerConfig - runtime configuration for the starter server.
 *
 * The whole server bottoms out at this single service. It is resolved once at
 * startup from environment variables + the bootstrap envelope, then provided as
 * a `Layer.succeed` value that every other layer reads.
 *
 * @module ServerConfig
 */
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as LogLevel from "effect/LogLevel";
import * as Path from "effect/Path";

import packageJson from "../package.json" with { type: "json" };

export const DEFAULT_PORT = 13773;
export const DEFAULT_HOST = "127.0.0.1";
export const APP_NAME = "Throughline";

// Observability defaults. Rotation keeps the trace file bounded across months
// of desktop sessions; the batch window keeps `tail -f` feeling live without a
// write per span.
export const TRACE_FILE_NAME = "server.trace.ndjson";
export const DEFAULT_TRACE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TRACE_MAX_FILES = 10;
export const DEFAULT_TRACE_BATCH_WINDOW_MS = 200;
export const DEFAULT_OTLP_EXPORT_INTERVAL_MS = 10_000;
export const DEFAULT_OTLP_SERVICE_NAME = "throughline-server";
/** Single-sourced from package.json so `--version` can't drift from the manifest. */
export const APP_VERSION: string = packageJson.version;

/**
 * ServerConfig - service tag for the resolved server runtime configuration.
 */
export class ServerConfig extends Context.Service<
  ServerConfig,
  {
    readonly appName: string;
    readonly version: string;
    /** When the process resolved config / started up. */
    readonly startedAt: DateTime.Utc;
    readonly host: string;
    readonly port: number;
    /** Built web assets to serve, or `undefined` when only a dev URL is set. */
    readonly staticDir: string | undefined;
    /** When set, navigations are 302-redirected here (dev). */
    readonly devWebUrl: URL | undefined;
    /** The shared secret a client exchanges for a bearer token. */
    readonly bootstrapToken: string;
    /** Where the server persists domain state (created on first write). */
    readonly dataDir: string;
    /** Where log/trace artifacts are written (created on first write). */
    readonly logDir: string;
    /**
     * The persisted observability artifact: completed spans as NDJSON. Logs
     * reach it as span events via `Logger.tracerLogger` — stdout is for humans,
     * this file is the record.
     */
    readonly serverTracePath: string;
    readonly logLevel: LogLevel.LogLevel;
    readonly traceMinLevel: LogLevel.LogLevel;
    readonly traceTimingEnabled: boolean;
    readonly traceBatchWindowMs: number;
    readonly traceMaxBytes: number;
    readonly traceMaxFiles: number;
    /** Optional OTLP export; local tracing works regardless. */
    readonly otlpTracesUrl: string | undefined;
    readonly otlpMetricsUrl: string | undefined;
    readonly otlpExportIntervalMs: number;
    readonly otlpServiceName: string;
  }
>()("@app/server/config/ServerConfig") {}

export const make = (config: ServerConfig["Service"]) => ServerConfig.of(config);

export const layer = (config: ServerConfig["Service"]) => Layer.succeed(ServerConfig, make(config));

/**
 * Resolve the directory of built web assets. Prefers the bundled `dist/client`
 * (packaged) and falls back to `../web/dist` (monorepo dev). Returns `undefined`
 * when neither exists.
 */
export const resolveStaticDir = Effect.fn("ServerConfig.resolveStaticDir")(function* () {
  const { join, resolve } = yield* Path.Path;
  const { exists } = yield* FileSystem.FileSystem;

  const bundledClient = resolve(join(import.meta.dirname, "client"));
  const hasBundled = yield* exists(join(bundledClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (hasBundled) {
    return bundledClient;
  }

  const monorepoClient = resolve(join(import.meta.dirname, "../../web/dist"));
  const hasMonorepo = yield* exists(join(monorepoClient, "index.html")).pipe(
    Effect.orElseSucceed(() => false),
  );
  if (hasMonorepo) {
    return monorepoClient;
  }

  return undefined;
});
