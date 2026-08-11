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
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Flag } from "effect/unstable/cli";

import { Port } from "@app/contracts";
import { HostProcessEnvironment } from "@app/shared/hostProcess";

import { type BootstrapEnvelope, readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { resolveBaseDir, resolveOverridePath } from "../os-jank.ts";

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
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to redirect navigations to (equivalent to APP_DEV_WEB_URL)."),
  Flag.optional,
);
export const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withDescription("Read the one-time bootstrap envelope from the given file descriptor."),
  Flag.optional,
);
export const parentLifetimeFdFlag = Flag.integer("parent-lifetime-fd").pipe(
  Flag.withDescription("Stop when the parent-owned lifetime file descriptor closes."),
  Flag.optional,
);

export const sharedServerCommandFlags = {
  port: portFlag,
  host: hostFlag,
  devWebUrl: devWebUrlFlag,
  bootstrapFd: bootstrapFdFlag,
  parentLifetimeFd: parentLifetimeFdFlag,
} as const;

export interface CliServerFlags {
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly devWebUrl: Option.Option<URL>;
  readonly bootstrapFd: Option.Option<number>;
  readonly parentLifetimeFd: Option.Option<number>;
}

/**
 * Every environment input the server accepts, declared once. A malformed value
 * fails startup with a typed `ConfigError` rather than being silently replaced
 * by its default.
 */
const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("APP_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("APP_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("APP_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.string("APP_TRACE_FILE").pipe(Config.option, Config.map(Option.getOrUndefined)),
  traceMaxBytes: Config.int("APP_TRACE_MAX_BYTES").pipe(
    Config.withDefault(ServerConfig.DEFAULT_TRACE_MAX_BYTES),
  ),
  traceMaxFiles: Config.int("APP_TRACE_MAX_FILES").pipe(
    Config.withDefault(ServerConfig.DEFAULT_TRACE_MAX_FILES),
  ),
  traceBatchWindowMs: Config.int("APP_TRACE_BATCH_WINDOW_MS").pipe(
    Config.withDefault(ServerConfig.DEFAULT_TRACE_BATCH_WINDOW_MS),
  ),
  otlpTracesUrl: Config.url("APP_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.url("APP_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.int("APP_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(ServerConfig.DEFAULT_OTLP_EXPORT_INTERVAL_MS),
  ),
  otlpServiceName: Config.string("APP_OTLP_SERVICE_NAME").pipe(
    Config.withDefault(ServerConfig.DEFAULT_OTLP_SERVICE_NAME),
  ),
  port: Config.port("APP_SERVER_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("APP_SERVER_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  dataDir: Config.string("APP_DATA_DIR").pipe(Config.option, Config.map(Option.getOrUndefined)),
  logDir: Config.string("APP_LOG_DIR").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devWebUrl: Config.url("APP_DEV_WEB_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  bootstrapToken: Config.string("APP_BOOTSTRAP_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

/** Resolve the full server config from flags + bootstrap envelope + env. */
export const resolveServerConfig = Effect.fn("cli.resolveServerConfig")(function* (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    timeoutMs?: number;
  },
) {
  const path = yield* Path.Path;
  const processEnv = yield* HostProcessEnvironment;
  const env = yield* EnvServerConfig.parse(ConfigProvider.fromEnvRecord(processEnv));
  const crypto = yield* Crypto.Crypto;
  const startedAt = yield* DateTime.now;

  const bootstrapFd = Option.getOrUndefined(flags.bootstrapFd);
  const bootstrapEnvelope =
    bootstrapFd !== undefined
      ? yield* readBootstrapEnvelope(bootstrapFd, options)
      : Option.none<BootstrapEnvelope>();
  const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

  const port =
    Option.getOrUndefined(flags.port) ?? bootstrap?.port ?? env.port ?? ServerConfig.DEFAULT_PORT;

  const host = Option.getOrUndefined(flags.host) ?? env.host ?? ServerConfig.DEFAULT_HOST;

  const devWebUrl = Option.getOrUndefined(flags.devWebUrl) ?? env.devWebUrl;

  const staticDir = devWebUrl ? undefined : yield* ServerConfig.resolveStaticDir();

  // Same directory the desktop shell uses as its app-data base, so the server
  // persists to one place whether it was spawned by the shell or standalone.
  const dataDir = yield* resolveBaseDir(env.dataDir);
  const logDir = yield* resolveOverridePath(env.logDir, () => path.join(dataDir, "logs"));
  const serverTracePath = yield* resolveOverridePath(env.traceFile, () =>
    path.join(logDir, ServerConfig.TRACE_FILE_NAME),
  );

  let bootstrapToken = bootstrap?.desktopBootstrapToken ?? env.bootstrapToken;
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
    serverTracePath,
    logLevel: Option.getOrElse(cliLogLevel, () => env.logLevel),
    traceMinLevel: env.traceMinLevel,
    traceTimingEnabled: env.traceTimingEnabled,
    traceBatchWindowMs: env.traceBatchWindowMs,
    traceMaxBytes: env.traceMaxBytes,
    traceMaxFiles: env.traceMaxFiles,
    otlpTracesUrl: env.otlpTracesUrl?.href,
    otlpMetricsUrl: env.otlpMetricsUrl?.href,
    otlpExportIntervalMs: env.otlpExportIntervalMs,
    otlpServiceName: env.otlpServiceName,
  });
});
