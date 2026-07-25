// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import { Flag } from "effect/unstable/cli";

/**
 * CLI → ServerConfig resolution.
 *
 * Resolves the fully-materialized `ServerConfig` from (in precedence order)
 * command flags, the bootstrap envelope, and environment variables. The
 * bootstrap token comes from: `--bootstrap-fd` envelope, else `APP_BOOTSTRAP_TOKEN`,
 * else a freshly generated random token (logged, for dev convenience).
 *
 * @module cli/config
 */
import { Port } from "@app/contracts";
import { HostProcessEnvironment } from "@app/shared/hostProcess";

import { type BootstrapEnvelope, readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";

export const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(Port),
  Flag.withDescription("Port for the HTTP/WebSocket server (default 13773 or APP_SERVER_PORT)."),
  Flag.optional,
);
export const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (default 127.0.0.1)."),
  Flag.optional,
);
export const devWebUrlFlag = Flag.string("dev-web-url").pipe(
  Flag.withDescription("Dev web URL to redirect navigations to (equivalent to APP_DEV_WEB_URL)."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withDescription("Read the one-time bootstrap envelope from the given file descriptor."),
  Flag.optional,
);

export const sharedServerCommandFlags = {
  port: portFlag,
  host: hostFlag,
  devWebUrl: devWebUrlFlag,
  bootstrapFd: bootstrapFdFlag,
} as const;

export interface CliServerFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly devWebUrl: Option.Option<string>;
  readonly bootstrapFd: Option.Option<number>;
}

const parseUrlOption = (value: string | undefined): URL | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

// Bounds match the contracts `Port` schema (1–65535); port 0 would bind an
// ephemeral port that no client could discover.
const parsePortOption = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
};

const parsePositiveIntOption = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
};

const parseBooleanOption = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
};

/**
 * Case-insensitive `LogLevel` parse. An unrecognized value falls back rather
 * than failing: a typo in an env var must not stop the server from booting, and
 * the fallback is always at least as verbose.
 */
const parseLogLevel = (
  value: string | undefined,
  fallback: LogLevel.LogLevel,
): LogLevel.LogLevel => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return LogLevel.values.find((level) => level.toLowerCase() === normalized) ?? fallback;
};

/** Resolve the full server config from flags + bootstrap envelope + env. */
export const resolveServerConfig = Effect.fn("cli.resolveServerConfig")(function* (
  flags: CliServerFlags,
  options?: {
    timeoutMs?: number;
  },
) {
  const env = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  const startedAt = yield* DateTime.now;

  const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
  const bootstrapEnvelope =
    bootstrapFd !== undefined
      ? yield* readBootstrapEnvelope(bootstrapFd, options)
      : Option.none<BootstrapEnvelope>();
  const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

  const port =
    Option.getOrUndefined(flags.port) ??
    bootstrap?.port ??
    parsePortOption(env["APP_SERVER_PORT"]) ??
    ServerConfig.DEFAULT_PORT;

  const host =
    Option.getOrUndefined(flags.host) ?? env["APP_SERVER_HOST"] ?? ServerConfig.DEFAULT_HOST;

  const devWebUrl =
    parseUrlOption(Option.getOrUndefined(flags.devWebUrl)) ??
    parseUrlOption(env["APP_DEV_WEB_URL"]);

  // No dev URL → resolve built static assets (undefined until the web is built).
  const staticDir = devWebUrl ? undefined : yield* ServerConfig.resolveStaticDir();

  // Same directory the desktop shell uses as its app-data base, so the server
  // persists to one place whether it was spawned by the shell or standalone.
  const dataDir = env["APP_DATA_DIR"] ?? NodePath.join(NodeOS.homedir(), ".throughline");
  const logDir = env["APP_LOG_DIR"] ?? NodePath.join(dataDir, "logs");

  // Bootstrap token precedence: envelope → env → generated (dev convenience).
  let bootstrapToken = bootstrap?.desktopBootstrapToken ?? env["APP_BOOTSTRAP_TOKEN"];
  if (bootstrapToken === undefined || bootstrapToken.trim().length === 0) {
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    bootstrapToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    yield* Effect.logInfo("generated bootstrap token (dev)", {
      bootstrapToken,
    });
  }

  return ServerConfig.make({
    appName: ServerConfig.APP_NAME,
    version: ServerConfig.APP_VERSION,
    startedAt,
    host,
    port,
    staticDir,
    devWebUrl,
    bootstrapToken,
    dataDir,
    logDir,
    serverTracePath: env["APP_TRACE_FILE"] ?? NodePath.join(logDir, ServerConfig.TRACE_FILE_NAME),
    logLevel: parseLogLevel(env["APP_LOG_LEVEL"], "Info"),
    traceMinLevel: parseLogLevel(env["APP_TRACE_MIN_LEVEL"], "Info"),
    traceTimingEnabled: parseBooleanOption(env["APP_TRACE_TIMING_ENABLED"]) ?? true,
    traceBatchWindowMs:
      parsePositiveIntOption(env["APP_TRACE_BATCH_WINDOW_MS"]) ??
      ServerConfig.DEFAULT_TRACE_BATCH_WINDOW_MS,
    traceMaxBytes:
      parsePositiveIntOption(env["APP_TRACE_MAX_BYTES"]) ?? ServerConfig.DEFAULT_TRACE_MAX_BYTES,
    traceMaxFiles:
      parsePositiveIntOption(env["APP_TRACE_MAX_FILES"]) ?? ServerConfig.DEFAULT_TRACE_MAX_FILES,
    otlpTracesUrl: parseUrlOption(env["APP_OTLP_TRACES_URL"])?.href,
    otlpMetricsUrl: parseUrlOption(env["APP_OTLP_METRICS_URL"])?.href,
    otlpExportIntervalMs:
      parsePositiveIntOption(env["APP_OTLP_EXPORT_INTERVAL_MS"]) ??
      ServerConfig.DEFAULT_OTLP_EXPORT_INTERVAL_MS,
    otlpServiceName: env["APP_OTLP_SERVICE_NAME"] ?? ServerConfig.DEFAULT_OTLP_SERVICE_NAME,
  });
});
