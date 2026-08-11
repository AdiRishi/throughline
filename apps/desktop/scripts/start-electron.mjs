// Minimal Electron launcher for `pnpm --filter @app/desktop start`. Verifies
// (and repairs) the Electron runtime, then spawns it against the built main
// entry. Clears ELECTRON_RUN_AS_NODE so the parent's Node-mode flag (set when
// the shell spawns the server child) can't leak in and make Electron boot as
// plain Node.

import * as NodeChildProcess from "node:child_process";

import { desktopDir, hostPlatform, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const forcedShutdownTimeoutMs = 1_500;
const childTreeGracePeriodMs = 1_200;

function killChildTreeByPid(pid, signal) {
  if (hostPlatform === "win32" || typeof pid !== "number") {
    return;
  }

  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function killChildTree(signal) {
  if (hostPlatform === "win32") {
    return;
  }

  // Kill direct children as a final fallback in case normal shutdown leaves stragglers.
  NodeChildProcess.spawnSync("pkill", [`-${signal}`, "-P", String(process.pid)], {
    stdio: "ignore",
  });
}

const { electronPath, args } = resolveElectronLaunchCommand([
  "dist-electron/main.cjs",
  ...process.argv.slice(2),
]);

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = NodeChildProcess.spawn(electronPath, args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

let shuttingDown = false;

// SIGTERM the app, then its children (the server the shell spawned), and
// escalate to SIGKILL if it has not exited by the grace period. Without this
// the grandchildren outlive us and keep the dev ports bound.
function stopApp() {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    child.once("exit", finish);
    child.kill("SIGTERM");
    killChildTreeByPid(child.pid, "TERM");

    setTimeout(() => {
      if (settled) {
        return;
      }

      child.kill("SIGKILL");
      killChildTreeByPid(child.pid, "KILL");
      finish();
    }, forcedShutdownTimeoutMs).unref();
  });
}

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  await stopApp();
  killChildTree("TERM");
  await new Promise((resolve) => {
    setTimeout(resolve, childTreeGracePeriodMs);
  });
  killChildTree("KILL");

  process.exit(exitCode);
}

child.on("exit", (code, signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  if (signal) {
    // Re-raise with the default handler so our exit status mirrors the child's;
    // the shutdown listener below would otherwise swallow the signal.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

process.once("SIGINT", () => {
  void shutdown(130);
});
process.once("SIGTERM", () => {
  void shutdown(143);
});
process.once("SIGHUP", () => {
  void shutdown(129);
});
