/**
 * The server's logger.
 *
 * Two loggers, both from Effect's own stack:
 *  - `Logger.consolePretty()` — humans reading stdout. In dev that stream is
 *    inherited by whatever terminal ran `pnpm dev` / `pnpm dev:desktop`.
 *  - `Logger.tracerLogger` — attaches every log to the active span as an event,
 *    which is how a log reaches the persisted trace file. Logs emitted outside
 *    a span are stdout-only by design.
 *
 * `mergeWithExisting: false` replaces Effect's default logger rather than
 * adding to it, so nothing is printed twice.
 *
 * @module serverLogger
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import { ServerConfig } from "./config.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer([Logger.consolePretty(), Logger.tracerLogger], {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
