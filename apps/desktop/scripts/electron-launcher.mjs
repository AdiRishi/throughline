import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const scriptsDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

export const desktopDir = NodePath.resolve(scriptsDir, "..");
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone launcher script has no Effect runtime.
export const hostPlatform = NodeOS.platform();

function isLinuxSetuidSandboxConfigured(electronBinaryPath) {
  if (hostPlatform !== "linux") {
    return true;
  }

  const sandboxPath = NodePath.join(NodePath.dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = NodeFS.statSync(sandboxPath);
    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

function resolveLinuxSandboxArgs(electronBinaryPath) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath)) {
    return [];
  }

  console.warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );
  return ["--no-sandbox"];
}

export function resolveElectronLaunchCommand(args = []) {
  const electronPath = ensureElectronRuntime();
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath), ...args],
  };
}
