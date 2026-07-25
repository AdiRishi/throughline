/**
 * The `start` command: resolve config, then launch the server.
 *
 * @module cli/server
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";

import * as ServerConfig from "../config.ts";
import * as ServerObservability from "../observability.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export { sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    const config = yield* resolveServerConfig(flags);
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const runId = yield* crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((value) => value.replaceAll("-", "").slice(0, 12)),
    );
    const runtimeLayer = Layer.mergeAll(
      ServerConfig.layer(config),
      ServerObservability.layer(config),
    );

    return yield* Effect.gen(function* () {
      yield* Effect.logInfo("server process starting").pipe(
        Effect.annotateLogs({
          logFile: ServerObservability.serverLogFilePath(config, path),
          mode: config.devWebUrl === undefined ? "packaged" : "development",
        }),
      );
      return yield* runServer;
    }).pipe(
      Effect.annotateLogs({
        service: "server",
        runId,
        version: config.version,
      }),
      Effect.withSpan("server.process"),
      Effect.provide(runtimeLayer),
    );
  });

export const startCommand = Command.make("start", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription("Run the Throughline server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);
