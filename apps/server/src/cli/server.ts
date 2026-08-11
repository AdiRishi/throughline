/**
 * The `start` command: resolve config, then launch the server.
 *
 * @module cli/server
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig } from "../config.ts";
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";
import { waitForParentLifetimeFdClose } from "./parentLifetime.ts";

export { sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (flags: CliServerFlags) => {
  const server = Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

  return Option.match(flags.parentLifetimeFd, {
    onNone: () => server,
    onSome: (fd) =>
      Effect.raceFirst(
        server,
        waitForParentLifetimeFdClose(fd).pipe(
          Effect.tap(() => Effect.logInfo("desktop parent lifetime channel closed")),
        ),
      ),
  });
};

export const startCommand = Command.make("start", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription("Run the Throughline server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);
