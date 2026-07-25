import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

const PROCESS_LIST_ARGUMENTS = ["-ww", "-axo", "pid=,ppid=,command="];
const WINDOWS_PROCESS_QUERY =
  "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"];
// oxlint-disable-next-line app/no-global-process-runtime -- Standalone dev script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function escapeRegularExpression(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function markerPattern(marker) {
  if (marker.length === 0 || marker.trim() !== marker) {
    throw new Error("The desktop development process marker must be non-empty and trimmed.");
  }
  return new RegExp(`(?:^|\\s)${escapeRegularExpression(marker)}(?:\\s|$)`, "u");
}

export function parseProcessTable(output) {
  const processes = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/u);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(parentPid)) {
      continue;
    }
    processes.push({
      pid,
      parentPid,
      command: match[3],
    });
  }
  return processes;
}

export function parseWindowsProcessTable(output) {
  const trimmed = output.replace(/^\uFEFF/u, "").trim();
  if (trimmed.length === 0) {
    return [];
  }

  const parsed = JSON.parse(trimmed);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const pid = Number(entry.ProcessId);
    const parentPid = Number(entry.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(parentPid)) {
      return [];
    }
    return [
      {
        pid,
        parentPid,
        command: typeof entry.CommandLine === "string" ? entry.CommandLine : "",
      },
    ];
  });
}

export function findMarkedProcessTree(processes, marker, excludedPids = []) {
  const matchesMarker = markerPattern(marker);
  const excluded = new Set(excludedPids);
  const childrenByParent = new Map();
  for (const process of processes) {
    const children = childrenByParent.get(process.parentPid) ?? [];
    children.push(process);
    childrenByParent.set(process.parentPid, children);
  }

  const ordered = [];
  const visited = new Set();
  const visit = (process) => {
    if (visited.has(process.pid) || excluded.has(process.pid)) {
      return;
    }
    visited.add(process.pid);
    for (const child of childrenByParent.get(process.pid) ?? []) {
      visit(child);
    }
    ordered.push(process);
  };

  for (const process of processes) {
    if (matchesMarker.test(process.command)) {
      visit(process);
    }
  }
  return ordered;
}

export function discoverMarkedProcessTree(
  marker,
  {
    currentPid = process.pid,
    platform = hostPlatform,
    spawnSync = NodeChildProcess.spawnSync,
  } = {},
) {
  if (platform === "win32") {
    let lastFailure;
    for (const executable of WINDOWS_SHELL_CANDIDATES) {
      const result = spawnSync(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY],
        {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
      );
      if (!result.error && result.status === 0) {
        try {
          return findMarkedProcessTree(parseWindowsProcessTable(result.stdout ?? ""), marker, [
            currentPid,
          ]);
        } catch (cause) {
          lastFailure = cause;
          continue;
        }
      }
      lastFailure =
        result.error ??
        new Error(
          `${executable} process inspection exited with status ${result.status ?? "unknown"}.`,
        );
    }
    throw new Error("Unable to inspect Windows desktop development processes.", {
      cause: lastFailure,
    });
  }

  const result = spawnSync("ps", PROCESS_LIST_ARGUMENTS, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error("Unable to inspect desktop development processes.", {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Process inspection exited with status ${result.status ?? "unknown"}.`);
  }
  return findMarkedProcessTree(parseProcessTable(result.stdout ?? ""), marker, [currentPid]);
}

export function taskkillProcessTree(
  pid,
  { force = false, spawnSync = NodeChildProcess.spawnSync } = {},
) {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

export function signalProcessTree(
  processes,
  signal,
  { platform = hostPlatform, kill = process.kill, spawnSync = NodeChildProcess.spawnSync } = {},
) {
  if (platform === "win32") {
    const selectedPids = new Set(processes.map((entry) => entry.pid));
    const roots = processes.filter((entry) => !selectedPids.has(entry.parentPid));
    for (const root of roots) {
      taskkillProcessTree(root.pid, {
        force: signal === "SIGKILL",
        spawnSync,
      });
    }
    return processes;
  }

  const signaled = [];
  for (const process of processes) {
    try {
      kill(process.pid, signal);
      signaled.push(process);
    } catch (cause) {
      if (cause && typeof cause === "object" && cause.code === "ESRCH") {
        continue;
      }
      throw cause;
    }
  }
  return signaled;
}

export async function waitForProcessTreeExit(
  processes,
  {
    timeoutMs,
    pollIntervalMs = 50,
    isRunning = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (cause) {
        return Boolean(cause && typeof cause === "object" && cause.code === "EPERM");
      }
    },
    now = Date.now,
    delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  },
) {
  const deadline = now() + timeoutMs;
  let remaining = processes;
  while (remaining.length > 0) {
    remaining = remaining.filter((process) => isRunning(process.pid));
    if (remaining.length === 0 || now() >= deadline) {
      return remaining;
    }
    await delay(pollIntervalMs);
  }
  return remaining;
}
