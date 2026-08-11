#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessEnvironment, HostProcessPlatform } from "@app/shared/hostProcess";
import { layer as netServiceLayer, NetService } from "@app/shared/Net";

import { loadRepoEnv } from "./lib/public-config.ts";

export const MODES = ["dev", "dev:server", "dev:web", "dev:desktop"] as const;
export type Mode = (typeof MODES)[number];

export const BASE_SERVER_PORT = 13773;
export const BASE_WEB_PORT = 5733;
export const MAX_PORT = 65_535;
export const PORT_OFFSET_RANGE = 2000;

const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;
const FORCE_KILL_AFTER = "1500 millis";

export const isMode = (value: string): value is Mode =>
  (MODES as readonly string[]).includes(value);

export class DevRunnerPortExhaustedError extends Schema.TaggedError<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    role: Schema.Literals(["server", "web"]),
    startPort: Schema.Int,
    maximumPort: Schema.Int,
  },
) {
  override get message(): string {
    return `No free ${this.role} port between ${this.startPort} and ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedError<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    argumentCount: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner failed to ${this.operation} Turborepo.`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `Turborepo exited with ${this.exitCode}.`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerPortExhaustedError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);
export type DevRunnerError = typeof DevRunnerError.Type;
export const isDevRunnerError = Schema.is(DevRunnerError);

export function repoPortOffset(repoRoot: string): number {
  return (Hash.string(repoRoot) >>> 0) % PORT_OFFSET_RANGE;
}

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export type PortRole = "server" | "web";

export function isPortCandidate(port: number, role: PortRole): boolean {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return false;
  return role !== "web" || isBrowserAllowedPort(port);
}

export function parsePortOverride(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return parsed >= 1 && parsed <= MAX_PORT ? parsed : undefined;
}

export interface DevEnvInput {
  readonly serverPort: number;
  readonly webPort: number;
  readonly bootstrapToken: string;
  readonly logDir: string;
  readonly logLevel: string;
  readonly serverEntry: string;
  readonly isDesktopMode: boolean;
}

export interface DevEnv {
  readonly serverEnv: NodeJS.ProcessEnv;
  readonly webEnv: NodeJS.ProcessEnv;
  readonly desktopEnv: NodeJS.ProcessEnv;
  readonly turboEnv: NodeJS.ProcessEnv;
  readonly wsUrl: string;
  readonly devWebUrl: string;
}

export function createDevEnv({
  serverPort,
  webPort,
  bootstrapToken,
  logDir,
  logLevel,
  serverEntry,
  isDesktopMode,
}: DevEnvInput): DevEnv {
  const wsUrl = `ws://127.0.0.1:${serverPort}`;
  const devWebUrl = `http://localhost:${webPort}`;
  const serverEnv: NodeJS.ProcessEnv = {
    APP_SERVER_PORT: String(serverPort),
    APP_BOOTSTRAP_TOKEN: bootstrapToken,
    APP_DEV_WEB_URL: devWebUrl,
    APP_LOG_DIR: logDir,
    APP_LOG_LEVEL: logLevel,
  };
  const webEnv: NodeJS.ProcessEnv = {
    PORT: String(webPort),
    APP_SERVER_PORT: String(serverPort),
    ...(isDesktopMode
      ? { HOST: "localhost", VITE_WS_URL: wsUrl }
      : { APP_SINGLE_ORIGIN_DEV: "1", VITE_BOOTSTRAP_TOKEN: bootstrapToken }),
  };
  const desktopEnv: NodeJS.ProcessEnv = {
    APP_SERVER_PORT: String(serverPort),
    APP_DEV_WEB_URL: devWebUrl,
    APP_LOG_DIR: logDir,
    APP_LOG_LEVEL: logLevel,
    APP_SERVER_ENTRY: serverEntry,
  };

  return {
    serverEnv,
    webEnv,
    desktopEnv,
    turboEnv: isDesktopMode ? { ...webEnv, ...desktopEnv } : { ...serverEnv, ...webEnv },
    wsUrl,
    devWebUrl,
  };
}

export const turboArgsForMode = (mode: Mode): ReadonlyArray<string> => {
  switch (mode) {
    case "dev":
      return ["run", "dev", "--filter=@app/server", "--filter=@app/web"];
    case "dev:server":
      return ["run", "dev", "--filter=@app/server"];
    case "dev:web":
      return ["run", "dev", "--filter=@app/web"];
    case "dev:desktop":
      return [
        "run",
        "dev:bundle",
        "dev:desktop",
        "--filter=@app/server",
        "--filter=@app/web",
        "--filter=@app/desktop",
      ];
  }
};

export const pickPort = Effect.fn("devRunner.pickPort")(function* (start: number, role: PortRole) {
  const net = yield* NetService;

  for (let port = start; port <= MAX_PORT; port += 1) {
    if (!isPortCandidate(port, role)) continue;

    let available = true;
    for (const host of DEV_PORT_PROBE_HOSTS) {
      if (!(yield* net.canListenOnHost(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return port;
  }

  return yield* new DevRunnerPortExhaustedError({
    role,
    startPort: start,
    maximumPort: MAX_PORT,
  });
});

export const runTurbo = Effect.fn("devRunner.runTurbo")(function* (input: {
  readonly repoRoot: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly onWindows: boolean;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commandArgs = ["exec", "turbo", ...input.args];
  const child = yield* spawner
    .spawn(
      ChildProcess.make("pnpm", commandArgs, {
        cwd: input.repoRoot,
        env: input.env,
        extendEnv: true,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        shell: input.onWindows,
        detached: false,
        killSignal: "SIGTERM",
        forceKillAfter: FORCE_KILL_AFTER,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            operation: "spawn",
            argumentCount: commandArgs.length,
            cause,
          }),
      ),
    );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new DevRunnerProcessError({
          operation: "wait-for-exit",
          argumentCount: commandArgs.length,
          cause,
        }),
    ),
  );
  if (exitCode !== 0) {
    return yield* new DevRunnerProcessExitError({ exitCode });
  }
});

const runDevRunner = Effect.fn("devRunner.run")(function* (input: { readonly mode: Mode }) {
  const path = yield* Path.Path;
  const env = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const crypto = yield* Crypto.Crypto;
  const mode = input.mode;
  const scriptPath = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(Effect.orDie);
  const repoRoot = path.dirname(path.dirname(scriptPath));

  for (const [key, value] of Object.entries(loadRepoEnv({ baseEnv: {} }))) {
    if (value !== undefined && env[key] === undefined) {
      env[key] = value;
    }
  }

  const envPort = Effect.fn("devRunner.envPort")(function* (key: string) {
    const raw = env[key];
    const parsed = parsePortOverride(raw);
    if (raw !== undefined && parsed === undefined) {
      yield* Effect.logWarning(`[dev-runner] ignoring invalid ${key}="${raw}"`);
    }
    return parsed;
  });

  const offset = repoPortOffset(repoRoot);
  const serverPort =
    (yield* envPort("APP_SERVER_PORT")) ?? (yield* pickPort(BASE_SERVER_PORT + offset, "server"));
  const webPort =
    (yield* envPort("APP_WEB_PORT")) ?? (yield* pickPort(BASE_WEB_PORT + offset, "web"));
  const logDir = env["APP_LOG_DIR"] ?? path.join(repoRoot, ".logs");
  const logLevel = env["APP_LOG_LEVEL"] ?? "Info";
  const bootstrapToken = yield* crypto.randomBytes(24).pipe(
    Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
    Effect.orDie,
  );
  const { turboEnv, devWebUrl } = createDevEnv({
    serverPort,
    webPort,
    bootstrapToken,
    logDir,
    logLevel,
    serverEntry: path.join(repoRoot, "apps/server/dist/bin.mjs"),
    isDesktopMode: mode === "dev:desktop",
  });

  yield* Effect.logInfo(
    `[dev-runner] mode=${mode} server=${String(serverPort)} web=${String(webPort)}`,
  );
  yield* Effect.logInfo(
    `[dev-runner] logs: ${logDir} (server.trace.ndjson` +
      (mode === "dev:desktop" ? ", desktop.trace.ndjson, server-child.log" : "") +
      ")",
  );
  yield* Effect.logInfo(
    mode === "dev:desktop"
      ? `[dev-runner] Electron will load ${devWebUrl}.`
      : `[dev-runner] open ${devWebUrl} in a browser, or run \`pnpm dev:desktop\` for the shell.`,
  );

  yield* runTurbo({
    repoRoot,
    args: turboArgsForMode(mode),
    env: turboEnv,
    onWindows: platform === "win32",
  });
});

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", MODES).pipe(
    Argument.withDescription("Development mode to run."),
    Argument.withDefault("dev" as Mode),
  ),
}).pipe(
  Command.withDescription("Run the Turborepo dev graph with deterministic port and env wiring."),
  Command.withHandler((input) => runDevRunner(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  netServiceLayer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
