// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ServerBootstrapEnvelope,
  type ServerBootstrapEnvelope as ServerBootstrapEnvelopeValue,
} from "@app/contracts";
import { HostProcessEnvironment } from "@app/shared/hostProcess";

import { resolveServerConfig, type CliServerFlags } from "../../src/cli/config.ts";

const encodeBootstrapEnvelope = Schema.encodeSync(Schema.fromJsonString(ServerBootstrapEnvelope));

const baseFlags: CliServerFlags = {
  port: Option.none(),
  host: Option.none(),
  devWebUrl: Option.some(new URL("http://127.0.0.1:5173")),
  bootstrapFd: Option.none(),
};

function withBootstrapFd<A, E, R>(
  envelope: ServerBootstrapEnvelopeValue,
  use: (fd: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "throughline-bootstrap-"));
      const path = NodePath.join(dir, "bootstrap.json");
      NodeFS.writeFileSync(path, `${encodeBootstrapEnvelope(envelope)}\n`);
      return { dir, fd: NodeFS.openSync(path, "r") };
    }),
    ({ fd }) => use(fd),
    ({ dir, fd }) =>
      Effect.sync(() => {
        NodeFS.closeSync(fd);
        NodeFS.rmSync(dir, { force: true, recursive: true });
      }),
  );
}

describe("resolveServerConfig", () => {
  it.effect("prefers the bootstrap fd envelope over inherited environment values", () =>
    withBootstrapFd({ desktopBootstrapToken: "fd-token", port: 19731 }, (fd) =>
      Effect.gen(function* () {
        const config = yield* resolveServerConfig(
          {
            ...baseFlags,
            bootstrapFd: Option.some(fd),
          },
          Option.none(),
        );

        assert.equal(config.bootstrapToken, "fd-token");
        assert.equal(config.port, 19731);
        assert.equal(config.devWebUrl?.href, "http://127.0.0.1:5173/");
      }),
    ).pipe(
      Effect.provideService(HostProcessEnvironment, {
        APP_BOOTSTRAP_TOKEN: "env-token",
        APP_SERVER_PORT: "3000",
      }),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("APP_DATA_DIR overrides the default home-directory data dir", () =>
    Effect.gen(function* () {
      const overridden = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_DATA_DIR: "/tmp/custom-data",
        }),
      );
      assert.equal(overridden.dataDir, "/tmp/custom-data");

      const defaulted = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, { APP_BOOTSTRAP_TOKEN: "env-token" }),
      );
      assert.equal(defaulted.dataDir, NodePath.join(NodeOS.homedir(), ".throughline"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("expands, resolves, and blank-checks the base directory env vars", () =>
    Effect.gen(function* () {
      const blank = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_DATA_DIR: "   ",
        }),
      );
      assert.equal(blank.dataDir, NodePath.join(NodeOS.homedir(), ".throughline"));
      assert.equal(blank.logDir, NodePath.join(NodeOS.homedir(), ".throughline", "logs"));

      const expanded = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_DATA_DIR: "~/throughline-data",
          APP_LOG_DIR: "~/throughline-logs",
        }),
      );
      assert.equal(expanded.dataDir, NodePath.join(NodeOS.homedir(), "throughline-data"));
      assert.equal(expanded.logDir, NodePath.join(NodeOS.homedir(), "throughline-logs"));
      assert.equal(
        expanded.serverTracePath,
        NodePath.join(NodeOS.homedir(), "throughline-logs", "server.trace.ndjson"),
      );

      const relative = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_DATA_DIR: "state",
        }),
      );
      assert.equal(NodePath.isAbsolute(relative.dataDir), true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the --log-level flag over APP_LOG_LEVEL", () =>
    Effect.gen(function* () {
      const fromFlag = yield* resolveServerConfig(baseFlags, Option.some("Debug")).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_LOG_LEVEL: "Warn",
        }),
      );
      assert.equal(fromFlag.logLevel, "Debug");

      const fromEnv = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_LOG_LEVEL: "Warn",
        }),
      );
      assert.equal(fromEnv.logLevel, "Warn");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "generates a bootstrap token when neither the envelope nor the environment has one",
    () =>
      Effect.gen(function* () {
        const config = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
          Effect.provideService(HostProcessEnvironment, { APP_BOOTSTRAP_TOKEN: "   " }),
        );
        assert.match(config.bootstrapToken, /^[0-9a-f]{64}$/);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails on a malformed environment value instead of silently defaulting", () =>
    Effect.gen(function* () {
      const exit = yield* resolveServerConfig(baseFlags, Option.none()).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_TRACE_MAX_BYTES: "abc",
        }),
        Effect.exit,
      );
      assert.equal(Exit.isFailure(exit), true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
