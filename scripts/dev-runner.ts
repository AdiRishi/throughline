#!/usr/bin/env node
/**
 * Dev orchestrator. Derives collision-avoiding ports per checkout, mints one
 * shared bootstrap token, and launches the server + web (+ optionally the
 * desktop shell) with a consistent environment.
 *
 * Unlike T3 Code — which hands the whole fan-out to `vp run --parallel` and
 * only computes the environment here — this repo runs on pnpm, which does not
 * prefix each package's output or give the session a single deterministic exit
 * code. So the supervision lives in this file: one child per package, output
 * attributed per line, and the first child to exit ends the run.
 *
 * The children are scoped, so an interrupt (Ctrl+C, which `NodeRuntime.runMain`
 * turns into a fiber interrupt) closes the scope and tears every child down
 * with a `forceKillAfter` grace period. Nothing is orphaned, including during
 * the `dev:desktop` build that happens between two spawns.
 *
 * @module dev-runner
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
/** Width of the per-checkout port offset window (both bases stay well below MAX_PORT). */
export const PORT_OFFSET_RANGE = 2000;
// HTTP(S) requests to these ports are blocked by the Fetch standard before a
// browser reaches the network. Keep the complete list here so explicit or
// future wider offsets cannot produce a URL that curl accepts but browsers
// reject. https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
// Dev servers bind loopback, so loopback is the only interface whose
// availability decides whether we can use a port. Probing wildcards too made
// the runner walk away from a perfectly free port whenever something else held
// the same number on another interface — `tailscale serve` does exactly that,
// which silently moved the ports out from under a URL that had just been shared.
export const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;
const FORCE_KILL_AFTER = "1500 millis";
// A child that dies from one of these was asked to stop (Ctrl+C reaches the
// whole process group, so children see it before our own handler runs). Any
// other signal — SIGKILL from the OOM killer, SIGSEGV — is a failure.
const REQUESTED_SHUTDOWN_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
// Basic ANSI foreground colors, assigned in spawn order so each package keeps
// the same color for the whole run.
const LABEL_COLORS = [36, 35, 32, 33, 34, 31] as const;

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
    label: Schema.String,
    filter: Schema.String,
    script: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner failed to ${this.operation} for ${this.label} (${this.filter} ${this.script}).`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    label: Schema.String,
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `${this.label} exited with ${this.exitCode}; stopping the other dev processes.`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerPortExhaustedError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);
export type DevRunnerError = typeof DevRunnerError.Type;
export const isDevRunnerError = Schema.is(DevRunnerError);

/**
 * Stable per-checkout offset so multiple clones don't fight over ports.
 *
 * Derived from the path rather than scanned from a fixed base: a scan-only
 * scheme gives each checkout whatever happened to be free that minute, so
 * ports move between runs and any URL you already shared goes stale.
 */
export function repoPortOffset(repoRoot: string): number {
  return (Hash.string(repoRoot) >>> 0) % PORT_OFFSET_RANGE;
}

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export type PortRole = "server" | "web";

/**
 * Whether a port number is worth probing at all. Only the web port is loaded
 * by a browser, so only it has to dodge the Fetch-blocked set; the server port
 * is reached by the desktop shell and by Vite's proxy, neither of which cares.
 */
export function isPortCandidate(port: number, role: PortRole): boolean {
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) return false;
  return role !== "web" || isBrowserAllowedPort(port);
}

/**
 * Parse an `APP_*_PORT` override. A malformed value (e.g. `APP_SERVER_PORT=abc`
 * in .env.local) yields `undefined` so the caller can fall back to
 * auto-selection, instead of silently exporting "NaN" to the children (whose
 * stricter parsers would then diverge to their own defaults).
 */
export function parsePortOverride(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PORT) return parsed;
  return undefined;
}

export interface DevEnvInput {
  readonly serverPort: number;
  readonly webPort: number;
  readonly bootstrapToken: string;
  readonly logDir: string;
  readonly logLevel: string;
  readonly serverEntry: string;
  /**
   * The shell loads the renderer from a custom scheme and hands it the server
   * address over the IPC bridge, so it is the one mode where a baked-in URL is
   * correct. Every browser mode is single-origin instead.
   */
  readonly isDesktopMode: boolean;
}

export interface DevEnv {
  readonly serverEnv: NodeJS.ProcessEnv;
  readonly webEnv: NodeJS.ProcessEnv;
  readonly desktopEnv: NodeJS.ProcessEnv;
  readonly wsUrl: string;
  readonly devWebUrl: string;
}

/** The exact environment each child is launched with, derived from one set of ports. */
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

  return {
    wsUrl,
    devWebUrl,
    serverEnv: {
      APP_SERVER_PORT: String(serverPort),
      APP_BOOTSTRAP_TOKEN: bootstrapToken,
      APP_DEV_WEB_URL: devWebUrl,
      APP_LOG_DIR: logDir,
      APP_LOG_LEVEL: logLevel,
    },
    webEnv: {
      PORT: String(webPort),
      // Vite needs the backend port either way — to proxy to it in browser dev,
      // and nothing else — but only the shell gets the URL baked into the
      // bundle.
      APP_SERVER_PORT: String(serverPort),
      VITE_BOOTSTRAP_TOKEN: bootstrapToken,
      ...(isDesktopMode
        ? {
            // HMR needs an explicit host inside a BrowserWindow, and the shell
            // is always local, so pinning it here is safe.
            HOST: "localhost",
            VITE_WS_URL: wsUrl,
          }
        : {
            // Browser dev is single-origin: /api, /ws and friends are proxied
            // through Vite, so the client must resolve its backend from
            // window.location.origin. Baking localhost here is what breaks
            // every non-localhost origin (LAN, tailnet, phone) — the remote
            // browser then dials its OWN loopback. Stated positively rather
            // than by omission because vite.config.ts must be able to tell
            // "single-origin dev" from "nobody set a URL".
            APP_SINGLE_ORIGIN_DEV: "1",
          }),
    },
    desktopEnv: {
      APP_SERVER_PORT: String(serverPort),
      APP_DEV_WEB_URL: devWebUrl,
      // The shell forwards these to the server child it spawns, so every process
      // in a `dev:desktop` run writes to the same directory.
      APP_LOG_DIR: logDir,
      APP_LOG_LEVEL: logLevel,
      // The shell spawns the server via Electron-as-node, which can't run `.ts`,
      // so point it at the built bundle (dev:desktop builds it first, below).
      APP_SERVER_ENTRY: serverEntry,
    },
  };
}

/** `[web] ` — colored per child when the stream is a TTY, plain otherwise. */
export function formatLabel(label: string, colorIndex: number, useColor: boolean): string {
  if (!useColor) return `[${label}] `;
  const color = LABEL_COLORS[colorIndex % LABEL_COLORS.length] ?? LABEL_COLORS[0];
  return `\u001B[${String(color)}m[${label}]\u001B[0m `;
}

export interface LinePrefixer {
  /** Feed a raw chunk; complete lines are written immediately, the rest is buffered. */
  readonly push: (chunk: string) => void;
  /** Write whatever partial line is still buffered (call on child exit). */
  readonly flush: () => void;
}

/**
 * Attribute every line a child prints to that child. Chunks arrive on pipe
 * boundaries, not line boundaries, so a partial line is held back until its
 * newline shows up — otherwise a prefix lands mid-word.
 */
export function createLinePrefixer(prefix: string, write: (line: string) => void): LinePrefixer {
  let buffer = "";

  const emit = (line: string): void => {
    // Progress output ends lines with \r\n or bare \r; keep the terminal's
    // carriage return out of the middle of a prefixed line.
    write(`${prefix}${line.replace(/\r$/u, "")}\n`);
  };

  return {
    push: (chunk: string): void => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        emit(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    flush: (): void => {
      if (buffer.length === 0) return;
      const pending = buffer;
      buffer = "";
      emit(pending);
    },
  };
}

/**
 * Exit code to end the whole dev session with, given how one child ended.
 * A child killed by a shutdown signal is the user stopping the run, not a
 * failure; anything else non-zero has to reach the shell.
 */
export function sessionExitCode(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  if (signal !== null && REQUESTED_SHUTDOWN_SIGNALS.has(signal)) return 0;
  return 1;
}

/** First port at or above `start` that nothing holds on either loopback family. */
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

export interface SpawnInput {
  readonly label: string;
  readonly filter: string;
  readonly script: string;
  readonly env: NodeJS.ProcessEnv;
  readonly colorIndex: number;
}

export interface RunnerContext {
  readonly repoRoot: string;
  readonly useColor: boolean;
  readonly onWindows: boolean;
}

/**
 * Spawns one package's dev script and returns an effect that completes when it
 * exits. The handle is scoped, so the caller's scope owns the child's lifetime:
 * whichever child exits first, the rest are torn down by scope close.
 */
export const spawnChild = Effect.fn("devRunner.spawnChild")(function* (
  context: RunnerContext,
  input: SpawnInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processContext = {
    label: input.label,
    filter: input.filter,
    script: input.script,
  } as const;

  const command = ChildProcess.make("pnpm", ["--filter", input.filter, input.script], {
    cwd: context.repoRoot,
    env: input.env,
    extendEnv: true,
    // stdin stays on the terminal (Vite's dev-server shortcuts read it);
    // stdout/stderr are piped so every line can be attributed to a package.
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    shell: context.onWindows,
    // Same process group, so a terminal Ctrl+C reaches the child directly.
    // Effect defaults to detached on non-Windows, which would put the runner in
    // a new group and require forwarding signals by hand.
    detached: false,
    killSignal: "SIGTERM",
    forceKillAfter: FORCE_KILL_AFTER,
  });

  const handle = yield* spawner
    .spawn(command)
    .pipe(
      Effect.mapError(
        (cause) => new DevRunnerProcessError({ ...processContext, operation: "spawn", cause }),
      ),
    );

  const prefix = formatLabel(input.label, input.colorIndex, context.useColor);
  yield* Effect.forkScoped(drainToPrefixed(handle.stdout, prefix, process.stdout));
  yield* Effect.forkScoped(drainToPrefixed(handle.stderr, prefix, process.stderr));

  return Effect.gen(function* () {
    const exitCode = yield* handle.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({ ...processContext, operation: "wait-for-exit", cause }),
      ),
    );
    // A signal-killed child surfaces here as a shell-style 128+n code, so the
    // same mapping covers both spellings of "the user stopped the run".
    const sessionCode = sessionExitCode(exitCode, null);
    if (sessionCode !== 0) {
      return yield* new DevRunnerProcessExitError({ label: input.label, exitCode: sessionCode });
    }
  });
});

/**
 * Pipe a child's output stream through the line prefixer. The flush is a
 * finalizer so a child that exits mid-line still gets its tail printed — that
 * last partial line is usually the most interesting one.
 */
function drainToPrefixed(
  stream: Stream.Stream<Uint8Array, unknown>,
  prefix: string,
  sink: NodeJS.WriteStream,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const prefixer = createLinePrefixer(prefix, (line) => sink.write(line));
    yield* Effect.addFinalizer(() => Effect.sync(prefixer.flush));
    yield* Stream.decodeText(stream).pipe(
      Stream.runForEach((chunk) => Effect.sync(() => prefixer.push(chunk))),
      Effect.ignore,
    );
  }).pipe(Effect.scoped);
}

/** The desktop pre-launch build: the shell runs the built bundles, not the sources. */
const buildForDesktop = Effect.fn("devRunner.buildForDesktop")(function* (context: RunnerContext) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const processContext = {
    label: "build",
    filter: "@app/server,@app/desktop",
    script: "build",
  } as const;

  const command = ChildProcess.make(
    "pnpm",
    ["--filter", "@app/server", "--filter", "@app/desktop", "build"],
    {
      cwd: context.repoRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      shell: context.onWindows,
      detached: false,
    },
  );

  const exitCode = yield* Effect.scoped(
    spawner.spawn(command).pipe(Effect.flatMap((handle) => handle.exitCode)),
  ).pipe(
    Effect.mapError(
      (cause) => new DevRunnerProcessError({ ...processContext, operation: "spawn", cause }),
    ),
  );

  if (exitCode !== 0) {
    yield* Effect.logError("[dev-runner] the desktop pre-launch build failed");
    return yield* new DevRunnerProcessExitError({ label: "build", exitCode });
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

  // Layer repo-root .env / .env.local under the real environment so the
  // overrides documented in .env.example (APP_SERVER_PORT, APP_WEB_PORT) take
  // effect. A real shell env var still wins — we only fill keys not already set.
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

  // Dev artifacts land in the checkout, not the platform app-data directory:
  // it keeps a dev run from polluting the installed app's history, and it means
  // "where are the logs" is answerable without knowing a per-OS path.
  const logDir = env["APP_LOG_DIR"] ?? path.join(repoRoot, ".logs");
  const logLevel = env["APP_LOG_LEVEL"] ?? "Info";
  const bootstrapToken = yield* crypto.randomBytes(24).pipe(
    Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
    Effect.orDie,
  );

  const { serverEnv, webEnv, desktopEnv, devWebUrl } = createDevEnv({
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
      ? `[dev-runner] Electron will load ${devWebUrl} for the shell.`
      : `[dev-runner] open ${devWebUrl} in a browser, or run \`pnpm dev:desktop\` for the shell.`,
  );

  const context: RunnerContext = {
    repoRoot,
    useColor: process.stdout.isTTY === true,
    onWindows: platform === "win32",
  };

  // Completed by whichever child exits first. Watched from the moment each
  // child starts rather than after the last spawn: `dev:desktop` runs a build
  // between two spawns, and a web dev server that dies inside that window has
  // to end the session too, not sit unnoticed until the race is set up.
  const sessionEnded = yield* Deferred.make<void, DevRunnerError>();
  let colorIndex = 0;
  const start = (label: string, filter: string, script: string, childEnv: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const awaitExit = yield* spawnChild(context, {
        label,
        filter,
        script,
        env: childEnv,
        colorIndex,
      });
      colorIndex += 1;
      yield* Effect.forkScoped(
        awaitExit.pipe(
          Effect.matchEffect({
            onFailure: (error) => Deferred.fail(sessionEnded, error),
            onSuccess: () => Deferred.succeed(sessionEnded, undefined),
          }),
        ),
      );
    });

  // `dev`/`dev:server` run the server standalone; in `dev:desktop` the Electron
  // shell spawns its own server, so we don't start a second one here.
  if (mode === "dev" || mode === "dev:server") {
    yield* start("server", "@app/server", "dev", serverEnv);
  }
  if (mode === "dev" || mode === "dev:web" || mode === "dev:desktop") {
    yield* start("web", "@app/web", "dev", webEnv);
  }
  if (mode === "dev:desktop") {
    // The shell loads the vite dev URL for HMR but spawns the built server
    // bundle, so both it and the server must be built before launch. The web
    // dev server is already running and scoped, so a failure here still tears
    // it down rather than orphaning it.
    yield* Effect.logInfo("[dev-runner] building server + desktop for the shell...");
    yield* buildForDesktop(context);
    yield* start("desktop", "@app/desktop", "start", desktopEnv);
  }

  // The first child to exit ends the session; scope close then tears the rest
  // down through their scoped handles.
  yield* Deferred.await(sessionEnded);
});

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", MODES).pipe(
    Argument.withDescription("Development mode to run."),
    Argument.withDefault("dev" as Mode),
  ),
}).pipe(
  Command.withDescription("Run the dev processes with deterministic port and env wiring."),
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
