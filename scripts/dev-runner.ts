#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone Node script: it runs before anything is installed into the workspace, so there is no Effect runtime to borrow.
// Dev orchestrator. Derives collision-avoiding ports per checkout, mints one
// shared bootstrap token, and launches the server + web (+ optionally the
// desktop shell) with a consistent environment.
//
// Dependency-free on purpose: `pnpm dev` has to work before anything is
// installed into the workspace, so there is no task runner to delegate to.
// That makes this file the only place that can prefix each child's output and
// tear the session down when one child dies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { loadRepoEnv } from "./lib/public-config.ts";

export const MODES = ["dev", "dev:server", "dev:web", "dev:desktop"] as const;
export type Mode = (typeof MODES)[number];

const REPO_ROOT = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));

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
const FORCE_KILL_AFTER_MS = 1500;
// Last resort if something still holds the event loop after teardown. Unref'd,
// so a run that can exit cleanly is never delayed by it.
const EXIT_FALLBACK_AFTER_MS = 250;
// How long a failing child waits for a terminal signal to explain it (see the
// exit handler below).
const SIGNAL_RACE_GRACE_MS = 25;
// A child that dies from one of these was asked to stop (Ctrl+C reaches the
// whole process group, so children see it before our own handler runs). Any
// other signal — SIGKILL from the OOM killer, SIGSEGV — is a failure.
const REQUESTED_SHUTDOWN_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGHUP"]);
// Basic ANSI foreground colors, assigned in spawn order so each package keeps
// the same color for the whole run.
const LABEL_COLORS = [36, 35, 32, 33, 34, 31] as const;

export const isMode = (value: string): value is Mode =>
  (MODES as readonly string[]).includes(value);

/** Stable per-checkout offset so multiple clones don't fight over ports. */
export function repoPortOffset(repoRoot: string): number {
  const hash = NodeCrypto.createHash("sha256").update(repoRoot).digest();
  return hash.readUInt16BE(0) % PORT_OFFSET_RANGE;
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
  readonly repoRoot: string;
  readonly serverPort: number;
  readonly webPort: number;
  readonly bootstrapToken: string;
  readonly logDir: string;
  readonly logLevel: string;
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
  repoRoot,
  serverPort,
  webPort,
  bootstrapToken,
  logDir,
  logLevel,
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
      HOST: "localhost",
      VITE_WS_URL: wsUrl,
      VITE_BOOTSTRAP_TOKEN: bootstrapToken,
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
      APP_SERVER_ENTRY: NodePath.join(repoRoot, "apps/server/dist/bin.mjs"),
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

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", (cause: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      server.close();
      // Hosts without IPv6 reject "::1" binds with EADDRNOTAVAIL; treat that as
      // available so the probe doesn't mark every port as busy.
      resolve(cause.code === "EADDRNOTAVAIL");
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen({ host, port });
  });
}

async function pickPort(start: number, role: PortRole): Promise<number> {
  for (let port = start; port <= MAX_PORT; port += 1) {
    if (!isPortCandidate(port, role)) continue;
    let available = true;
    for (const host of DEV_PORT_PROBE_HOSTS) {
      if (!(await canListen(port, host))) {
        available = false;
        break;
      }
    }
    if (available) return port;
  }
  throw new Error(`No free port available from ${String(start)}.`);
}

interface SupervisedChild {
  readonly label: string;
  readonly child: NodeChildProcess.ChildProcess;
  readonly flush: () => void;
}

interface Supervisor {
  /** Register the terminal signal handlers. Call before the first spawn. */
  readonly install: () => void;
  readonly spawn: (label: string, filter: string, script: string, env: NodeJS.ProcessEnv) => void;
  /** SIGTERM every live child, then exit the runner with `code`. */
  readonly shutdown: (code: number) => void;
  readonly isShuttingDown: () => boolean;
}

function createSupervisor(options: {
  readonly repoRoot: string;
  readonly useColor: boolean;
}): Supervisor {
  const children: Array<SupervisedChild> = [];
  let shuttingDown = false;
  let spawnCount = 0;

  const onSignal = (): void => {
    shutdown(0);
  };

  const finish = (code: number): void => {
    for (const entry of children) entry.flush();
    process.exitCode = code;
    // Prefer letting Node exit on its own: `process.exit` truncates stdout
    // writes that are still queued when stdout is a pipe, which is exactly the
    // tail of a failing child's output. Dropping the signal handlers releases
    // the last handles keeping the loop alive.
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    setTimeout(() => {
      process.exit(code);
    }, EXIT_FALLBACK_AFTER_MS).unref();
  };

  // SIGTERM everything, give children a short grace period to exit cleanly,
  // then SIGKILL any survivor so nothing is orphaned when the runner exits.
  // `children` may still be filling up (dev:desktop builds between spawns), so
  // this only ever looks at what has actually been started.
  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const alive = children.filter(
      (entry) => entry.child.exitCode === null && entry.child.signalCode === null,
    );
    if (alive.length === 0) {
      finish(code);
      return;
    }
    let remaining = alive.length;
    const forceKillTimer = setTimeout(() => {
      for (const entry of alive) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) {
          entry.child.kill("SIGKILL");
        }
      }
    }, FORCE_KILL_AFTER_MS);
    for (const entry of alive) {
      entry.child.once("exit", () => {
        remaining -= 1;
        if (remaining === 0) {
          clearTimeout(forceKillTimer);
          finish(code);
        }
      });
      entry.child.kill("SIGTERM");
    }
  };

  const spawn = (label: string, filter: string, script: string, env: NodeJS.ProcessEnv): void => {
    // A Ctrl+C that lands mid-startup must not be followed by another spawn.
    if (shuttingDown) return;
    const prefix = formatLabel(label, spawnCount, options.useColor);
    spawnCount += 1;

    const child = NodeChildProcess.spawn("pnpm", ["--filter", filter, script], {
      cwd: options.repoRoot,
      env: { ...process.env, ...env },
      // stdin stays on the terminal (Vite's dev-server shortcuts read it);
      // stdout/stderr are piped so every line can be attributed to a package.
      stdio: ["inherit", "pipe", "pipe"],
      // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see file header).
      shell: process.platform === "win32",
    });

    const out = createLinePrefixer(prefix, (line) => process.stdout.write(line));
    const err = createLinePrefixer(prefix, (line) => process.stderr.write(line));
    const flush = (): void => {
      out.flush();
      err.flush();
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => out.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => err.push(chunk));

    children.push({ label, child, flush });

    child.on("error", (cause) => {
      flush();
      process.stderr.write(`[dev-runner] ${label} failed to start: ${String(cause)}\n`);
      shutdown(1);
    });
    // `close` fires once the pipes have drained; `exit` can arrive with output
    // still in flight, so flush on both.
    child.on("close", flush);
    child.on("exit", (code, signal) => {
      flush();
      if (shuttingDown) return;
      const sessionCode = sessionExitCode(code, signal);
      if (sessionCode === 0) {
        shutdown(0);
        return;
      }
      // Ctrl+C reaches the children too, and a wrapper like `pnpm run` reports
      // it as exit 130 rather than as a signal — indistinguishable from a
      // crash. Our own SIGINT handler is racing this event, so give it a beat
      // to win before declaring the run failed. Deliberately not unref'd: on a
      // real crash of the last child this timer is the only thing left holding
      // the loop, and losing it would exit 0 on a failure.
      setTimeout(() => {
        if (shuttingDown) return;
        process.stderr.write(
          `[dev-runner] ${label} exited with ${code === null ? String(signal) : String(code)}; stopping the other dev processes\n`,
        );
        shutdown(sessionCode);
      }, SIGNAL_RACE_GRACE_MS);
    });
  };

  return {
    install: (): void => {
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
    },
    spawn,
    shutdown,
    isShuttingDown: (): boolean => shuttingDown,
  };
}

async function main(): Promise<void> {
  const modeArgument = process.argv[2] ?? "dev";
  if (!isMode(modeArgument)) {
    process.stderr.write(`Unknown mode "${modeArgument}". Use one of: ${MODES.join(", ")}\n`);
    process.exit(1);
  }
  const mode: Mode = modeArgument;

  // Layer repo-root .env / .env.local under the real environment so the
  // overrides documented in .env.example (APP_SERVER_PORT, APP_WEB_PORT) take
  // effect. A real shell env var still wins — we only fill keys not already set.
  for (const [key, value] of Object.entries(loadRepoEnv({ baseEnv: {} }))) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  const envPort = (key: string): number | undefined => {
    const raw = process.env[key];
    const parsed = parsePortOverride(raw);
    if (raw !== undefined && parsed === undefined) {
      process.stderr.write(`[dev-runner] ignoring invalid ${key}="${raw}"\n`);
    }
    return parsed;
  };

  const offset = repoPortOffset(REPO_ROOT);
  const serverPort =
    envPort("APP_SERVER_PORT") ?? (await pickPort(BASE_SERVER_PORT + offset, "server"));
  const webPort = envPort("APP_WEB_PORT") ?? (await pickPort(BASE_WEB_PORT + offset, "web"));

  // Dev artifacts land in the checkout, not the platform app-data directory:
  // it keeps a dev run from polluting the installed app's history, and it means
  // "where are the logs" is answerable without knowing a per-OS path.
  const logDir = process.env["APP_LOG_DIR"] ?? NodePath.join(REPO_ROOT, ".logs");
  const logLevel = process.env["APP_LOG_LEVEL"] ?? "Info";

  const { serverEnv, webEnv, desktopEnv, devWebUrl } = createDevEnv({
    repoRoot: REPO_ROOT,
    serverPort,
    webPort,
    bootstrapToken: NodeCrypto.randomBytes(24).toString("hex"),
    logDir,
    logLevel,
  });

  const targetMessage =
    mode === "dev:desktop"
      ? `[dev-runner] Electron will load ${devWebUrl} for the shell.\n`
      : `[dev-runner] open ${devWebUrl} in a browser, or run \`pnpm dev:desktop\` for the shell.\n`;

  process.stdout.write(
    `[dev-runner] mode=${mode} server=${String(serverPort)} web=${String(webPort)}\n` +
      `[dev-runner] logs: ${logDir} (server.trace.ndjson` +
      (mode === "dev:desktop" ? ", desktop.trace.ndjson, server-child.log" : "") +
      `)\n` +
      targetMessage,
  );

  const supervisor = createSupervisor({
    repoRoot: REPO_ROOT,
    useColor: process.stdout.isTTY === true,
  });
  // Installed *before* the first spawn: `dev:desktop` runs a synchronous build
  // between spawning the web dev server and launching the shell, and a Ctrl+C
  // inside that window would otherwise orphan the already-running dev server.
  supervisor.install();

  // `dev`/`dev:server` run the server standalone; in `dev:desktop` the Electron
  // shell spawns its own server, so we don't start a second one here.
  if (mode === "dev" || mode === "dev:server") {
    supervisor.spawn("server", "@app/server", "dev", serverEnv);
  }
  if (mode === "dev" || mode === "dev:web" || mode === "dev:desktop") {
    supervisor.spawn("web", "@app/web", "dev", webEnv);
  }
  if (mode === "dev:desktop") {
    // The shell loads the vite dev URL for HMR but spawns the built server
    // bundle, so both it and the server must be built before launch.
    process.stdout.write("[dev-runner] building server + desktop for the shell...\n");
    const build = NodeChildProcess.spawnSync(
      "pnpm",
      ["--filter", "@app/server", "--filter", "@app/desktop", "build"],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        // oxlint-disable-next-line app/no-global-process-runtime -- Standalone Node script has no Effect runtime (see file header).
        shell: process.platform === "win32",
      },
    );
    if (build.status !== 0 || build.signal !== null) {
      const code = sessionExitCode(build.status, build.signal);
      if (code !== 0) {
        process.stderr.write("[dev-runner] the desktop pre-launch build failed\n");
      }
      supervisor.shutdown(code);
      return;
    }
    supervisor.spawn("desktop", "@app/desktop", "start", desktopEnv);
  }
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`[dev-runner] fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
