import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { desktopDir } from "./electron-launcher.mjs";

const require = NodeModule.createRequire(import.meta.url);
const viteCli = NodePath.join(
  NodePath.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const outputDir = NodePath.join(desktopDir, "dist-electron");

NodeFS.rmSync(outputDir, { recursive: true, force: true });

const childEnv = { ...process.env, APP_DESKTOP_BUILD_WATCH: "1" };
const children = ["main", "preload"].map((mode) =>
  NodeChildProcess.spawn(process.execPath, [viteCli, "build", "--mode", mode, "--watch"], {
    cwd: desktopDir,
    env: childEnv,
    stdio: "inherit",
  }),
);

let shuttingDown = false;

function stopChildren(signal) {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopChildren(signal);
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    shutdown("SIGTERM");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shutdown("SIGTERM");
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.once("SIGHUP", () => {
  shutdown("SIGHUP");
});
