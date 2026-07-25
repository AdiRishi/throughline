// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
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
  devWebUrl: Option.some("http://127.0.0.1:5173"),
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
    withBootstrapFd(
      {
        desktopBootstrapToken: "fd-token",
        port: 19731,
        appVersion: "1.2.3-nightly.20260725.2",
      },
      (fd) =>
        Effect.gen(function* () {
          const config = yield* resolveServerConfig({
            ...baseFlags,
            bootstrapFd: Option.some(fd),
          });

          assert.equal(config.bootstrapToken, "fd-token");
          assert.equal(config.port, 19731);
          assert.equal(config.version, "1.2.3-nightly.20260725.2");
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
      const overridden = yield* resolveServerConfig(baseFlags).pipe(
        Effect.provideService(HostProcessEnvironment, {
          APP_BOOTSTRAP_TOKEN: "env-token",
          APP_DATA_DIR: "/tmp/custom-data",
        }),
      );
      assert.equal(overridden.dataDir, "/tmp/custom-data");

      const defaulted = yield* resolveServerConfig(baseFlags).pipe(
        Effect.provideService(HostProcessEnvironment, { APP_BOOTSTRAP_TOKEN: "env-token" }),
      );
      assert.equal(defaulted.dataDir, NodePath.join(NodeOS.homedir(), ".throughline"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never emits a generated bootstrap credential through the logger", () =>
    Effect.gen(function* () {
      const records: string[] = [];
      const logger = Logger.map(Logger.formatJson, (record) => {
        records.push(record);
      });
      const config = yield* resolveServerConfig(baseFlags).pipe(
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provide(Logger.layer([logger])),
      );

      assert.match(config.bootstrapToken, /^[0-9a-f]{64}$/u);
      assert.notInclude(records.join("\n"), config.bootstrapToken);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
