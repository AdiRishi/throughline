import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";

import { makeBestEffortRotatingFileLogger } from "@app/shared/rotatingLog";
import { sanitizeDiagnosticJsonLine, sanitizeDiagnosticText } from "@app/shared/safeLog";

import type * as ServerConfig from "./config.ts";

export function serverLogFilePath(
  config: ServerConfig.ServerConfig["Service"],
  path: Path.Path,
): string {
  return path.join(config.dataDir, "logs", "server.log");
}

export function layer(config: ServerConfig.ServerConfig["Service"]) {
  const terminalLogger = Logger.withConsoleLog(
    Logger.map(Logger.formatLogFmt, sanitizeDiagnosticText),
  );

  return Layer.mergeAll(
    Logger.layer(
      [
        terminalLogger,
        Effect.gen(function* () {
          const path = yield* Path.Path;
          return yield* makeBestEffortRotatingFileLogger({
            filePath: serverLogFilePath(config, path),
            transform: sanitizeDiagnosticJsonLine,
          });
        }),
      ],
      { mergeWithExisting: false },
    ),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );
}
