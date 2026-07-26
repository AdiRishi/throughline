import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../src/config.ts";

/**
 * A `ServerConfig` for tests, in one place.
 *
 * `ServerConfig` is deliberately a wide record with no defaults — every field is
 * a decision the process must have made — which is right for production and
 * tedious in a test, where all but one or two fields are noise. Assembling it
 * per test file would mean each new field breaking every test file, and copies
 * quietly drifting until two tests disagree about what a server is.
 *
 * Logging is off (`Error`) and tracing is minimal because a test's output should
 * be its assertions.
 *
 * @module tests/support/config
 */

/** A fresh temp directory, prefixed so a leaked one is identifiable. */
export function scratchDir(prefix: string): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
}

export const configLayer = (
  dataDir: string,
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
): Layer.Layer<ServerConfig.ServerConfig> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const startedAt = yield* DateTime.now;
      return ServerConfig.layer(
        ServerConfig.make({
          appName: "Throughline",
          version: "0.0.0-test",
          startedAt,
          host: "127.0.0.1",
          port: 0,
          staticDir: undefined,
          devWebUrl: undefined,
          bootstrapToken: "test",
          dataDir,
          logDir: NodePath.join(dataDir, "logs"),
          serverTracePath: NodePath.join(dataDir, "logs", "trace.ndjson"),
          logLevel: "Error",
          traceMinLevel: "Error",
          traceTimingEnabled: false,
          traceBatchWindowMs: 200,
          traceMaxBytes: 1024,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "test",
          ...overrides,
        }),
      );
    }),
  );
