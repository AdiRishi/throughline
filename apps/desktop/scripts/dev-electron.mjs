import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  discoverMarkedProcessTree,
  signalProcessTree,
  taskkillProcessTree,
  waitForProcessTreeExit,
} from "./dev-processes.mjs";
import {
  desktopDir,
  resolveDevelopmentLauncher,
  resolveElectronLaunchCommand,
} from "./electron-launcher.mjs";
import { waitForResources } from "./wait-for-resources.mjs";

const devServerUrl = process.env.APP_DEV_WEB_URL?.trim();
if (!devServerUrl) {
  throw new Error("APP_DEV_WEB_URL is required for desktop development.");
}

const devServer = new URL(devServerUrl);
const port = Number.parseInt(devServer.port, 10);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`APP_DEV_WEB_URL must include an explicit port: ${devServerUrl}`);
}

const requiredFiles = [
  "dist-electron/main.cjs",
  "dist-electron/preload.cjs",
  "../server/dist/bin.mjs",
];
const watchedDirectories = [
  { directory: "dist-electron", files: new Set(["main.cjs", "preload.cjs"]) },
  { directory: "../server/dist", files: new Set(["bin.mjs"]) },
];
const forcedShutdownTimeoutMs = 1_500;
const restartDebounceMs = 120;
const childTreeGracePeriodMs = 1_200;
const remoteDebuggingPort = process.env.APP_DESKTOP_REMOTE_DEBUGGING_PORT?.trim();
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();
const processMarker = `--throughline-dev-root=${desktopDir}`;

await waitForResources({
  baseDir: desktopDir,
  files: requiredFiles,
  tcpHost: devServer.hostname,
  tcpPort: port,
});
const developmentLauncher = resolveDevelopmentLauncher();

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

let shuttingDown = false;
let restartTimer = null;
let currentApp = null;
let restartQueue = Promise.resolve();
const expectedExits = new WeakSet();
const watchers = [];

function killChildTreeByPid(pid, signal) {
  if (typeof pid !== "number") {
    return;
  }

  if (hostPlatform === "win32") {
    taskkillProcessTree(pid, { force: signal === "KILL" });
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function discoverStaleDevApps() {
  try {
    return discoverMarkedProcessTree(processMarker);
  } catch (cause) {
    process.stderr.write(
      `[desktop-dev] unable to inspect stale processes: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return [];
  }
}

function signalDevApps(processes, signal) {
  try {
    return signalProcessTree(processes, signal);
  } catch (cause) {
    process.stderr.write(
      `[desktop-dev] unable to clean stale processes: ${
        cause instanceof Error ? cause.message : String(cause)
      }\n`,
    );
    return [];
  }
}

function signalStaleDevApps(signal) {
  return signalDevApps(discoverStaleDevApps(), signal);
}

async function cleanupStaleDevApps() {
  const processes = signalStaleDevApps("SIGTERM");
  if (processes.length === 0) {
    return;
  }

  const remaining = await waitForProcessTreeExit(processes, {
    timeoutMs: forcedShutdownTimeoutMs,
  });
  if (remaining.length === 0) {
    return;
  }

  signalProcessTree(remaining, "SIGKILL");
  const survivors = await waitForProcessTreeExit(remaining, {
    timeoutMs: childTreeGracePeriodMs,
  });
  if (survivors.length > 0) {
    process.stderr.write(
      `[desktop-dev] ${survivors.length} stale process${survivors.length === 1 ? "" : "es"} did not exit.\n`,
    );
  }
}

function startApp() {
  if (shuttingDown || currentApp !== null) {
    return;
  }

  const electronArgs = remoteDebuggingPort
    ? [`--remote-debugging-port=${remoteDebuggingPort}`]
    : [];
  const launchArgs =
    developmentLauncher === null
      ? [...electronArgs, processMarker, "dist-electron/main.cjs"]
      : electronArgs;
  const electronCommand = resolveElectronLaunchCommand(launchArgs);
  const app = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  });

  currentApp = app;

  app.once("error", () => {
    if (currentApp === app) {
      currentApp = null;
    }

    if (!shuttingDown) {
      scheduleRestart();
    }
  });

  app.once("exit", (code, signal) => {
    if (currentApp === app) {
      currentApp = null;
    }

    const exitedAbnormally = signal !== null || code !== 0;
    if (!shuttingDown && !expectedExits.has(app) && exitedAbnormally) {
      scheduleRestart();
    }
  });
}

async function stopApp() {
  const app = currentApp;
  if (!app) {
    return;
  }

  currentApp = null;
  expectedExits.add(app);
  const knownProcesses = discoverStaleDevApps();
  signalDevApps(knownProcesses, "SIGTERM");

  await new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    app.once("exit", finish);
    killChildTreeByPid(app.pid, "TERM");
    app.kill("SIGTERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      signalDevApps(knownProcesses, "SIGKILL");
      killChildTreeByPid(app.pid, "KILL");
      app.kill("SIGKILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });

  const remaining = await waitForProcessTreeExit(knownProcesses, {
    timeoutMs: childTreeGracePeriodMs,
  });
  if (remaining.length > 0) {
    signalDevApps(remaining, "SIGKILL");
    const survivors = await waitForProcessTreeExit(remaining, {
      timeoutMs: childTreeGracePeriodMs,
    });
    if (survivors.length > 0) {
      process.stderr.write(
        `[desktop-dev] ${survivors.length} process${survivors.length === 1 ? "" : "es"} survived desktop shutdown.\n`,
      );
    }
  }
}

function scheduleRestart() {
  if (shuttingDown) {
    return;
  }

  if (restartTimer) {
    clearTimeout(restartTimer);
  }

  restartTimer = setTimeout(() => {
    restartTimer = null;
    restartQueue = restartQueue
      .catch(() => undefined)
      .then(async () => {
        await stopApp();
        if (!shuttingDown) {
          startApp();
        }
        return undefined;
      });
  }, restartDebounceMs);
}

function startWatchers() {
  for (const { directory, files } of watchedDirectories) {
    const watcher = NodeFS.watch(
      NodePath.join(desktopDir, directory),
      { persistent: true },
      (_eventType, filename) => {
        if (typeof filename !== "string" || !files.has(filename)) {
          return;
        }

        scheduleRestart();
      },
    );

    watchers.push(watcher);
  }
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  for (const watcher of watchers) {
    watcher.close();
  }

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

startWatchers();
await cleanupStaleDevApps();
startApp();

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
