import { describe, expect, it, vi } from "vitest";

import {
  discoverMarkedProcessTree,
  findMarkedProcessTree,
  parseProcessTable,
  parseWindowsProcessTable,
  signalProcessTree,
  taskkillProcessTree,
  waitForProcessTreeExit,
} from "../../scripts/dev-processes.mjs";

const marker = "--throughline-dev-root=/work/throughline/apps/desktop";

describe("desktop development process cleanup", () => {
  it("selects only the exact checkout marker and orders descendants before their parent", () => {
    const processes = parseProcessTable(`
      100 1 /Applications/Electron --throughline-dev-root=/work/throughline/apps/desktop dist-electron/main.cjs
      101 100 /Applications/Electron --type=renderer
      102 100 /Applications/Electron --type=utility
      103 102 /usr/bin/node apps/server/dist/bin.mjs
      200 1 /Applications/Electron --throughline-dev-root=/work/throughline/apps/desktop-copy dist-electron/main.cjs
      300 1 /usr/bin/node dev-electron.mjs
    `);

    expect(findMarkedProcessTree(processes, marker).map((process) => process.pid)).toEqual([
      101, 103, 102, 100,
    ]);
  });

  it("reads the portable process table without passing the marker to ps", () => {
    const spawnSync = vi.fn(() => ({
      pid: 99,
      output: [],
      stdout: `400 1 Electron ${marker} dist-electron/main.cjs\n`,
      stderr: "",
      status: 0,
      signal: null,
    }));

    expect(discoverMarkedProcessTree(marker, { currentPid: 999, spawnSync })).toEqual([
      {
        pid: 400,
        parentPid: 1,
        command: `Electron ${marker} dist-electron/main.cjs`,
      },
    ]);
    expect(spawnSync).toHaveBeenCalledWith("ps", ["-ww", "-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  });

  it("signals the discovered tree and ignores processes that already exited", () => {
    const processes = [
      { pid: 501, parentPid: 500, command: "renderer" },
      { pid: 500, parentPid: 1, command: `Electron ${marker}` },
    ];
    const kill = vi.fn((pid) => {
      if (pid === 500) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
    });

    expect(signalProcessTree(processes, "SIGTERM", { kill }).map((process) => process.pid)).toEqual(
      [501],
    );
    expect(kill.mock.calls).toEqual([
      [501, "SIGTERM"],
      [500, "SIGTERM"],
    ]);
  });

  it("discovers the exact marked Windows process tree through PowerShell", () => {
    const spawnSync = vi.fn(() => ({
      pid: 99,
      output: [],
      stdout: JSON.stringify([
        {
          ProcessId: 700,
          ParentProcessId: 1,
          CommandLine: `Electron.exe ${marker} dist-electron/main.cjs`,
        },
        {
          ProcessId: 701,
          ParentProcessId: 700,
          CommandLine: "Electron.exe --type=renderer",
        },
        {
          ProcessId: 800,
          ParentProcessId: 1,
          CommandLine: `Electron.exe ${marker}-copy dist-electron/main.cjs`,
        },
      ]),
      stderr: "",
      status: 0,
      signal: null,
    }));

    expect(
      discoverMarkedProcessTree(marker, {
        currentPid: 999,
        platform: "win32",
        spawnSync,
      }).map((process) => process.pid),
    ).toEqual([701, 700]);
    expect(spawnSync.mock.calls[0]?.[0]).toBe("pwsh.exe");
    expect(spawnSync.mock.calls[0]?.[1]).toContain("-NoProfile");
  });

  it("normalizes the single-object Windows process query result", () => {
    expect(
      parseWindowsProcessTable(
        `\uFEFF${JSON.stringify({
          ProcessId: 900,
          ParentProcessId: 4,
          CommandLine: `Electron.exe ${marker}`,
        })}`,
      ),
    ).toEqual([
      {
        pid: 900,
        parentPid: 4,
        command: `Electron.exe ${marker}`,
      },
    ]);
  });

  it("uses taskkill once per selected Windows tree root and forces only SIGKILL", () => {
    const processes = [
      { pid: 1002, parentPid: 1001, command: "server" },
      { pid: 1001, parentPid: 1000, command: "renderer" },
      { pid: 1000, parentPid: 1, command: `Electron.exe ${marker}` },
    ];
    const spawnSync = vi.fn(() => ({
      pid: 99,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }));

    signalProcessTree(processes, "SIGTERM", { platform: "win32", spawnSync });
    signalProcessTree(processes, "SIGKILL", { platform: "win32", spawnSync });

    expect(spawnSync.mock.calls).toEqual([
      ["taskkill.exe", ["/PID", "1000", "/T"], { encoding: "utf8", windowsHide: true }],
      ["taskkill.exe", ["/PID", "1000", "/T", "/F"], { encoding: "utf8", windowsHide: true }],
    ]);
  });

  it("surfaces a missing taskkill executable", () => {
    const cause = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(() =>
      taskkillProcessTree(1200, {
        spawnSync: () => ({
          pid: 0,
          output: [],
          stdout: "",
          stderr: "",
          status: null,
          signal: null,
          error: cause,
        }),
      }),
    ).toThrow(cause);
  });

  it("waits only until the selected process tree exits", async () => {
    const processes = [
      { pid: 601, parentPid: 600, command: "server" },
      { pid: 600, parentPid: 1, command: `Electron ${marker}` },
    ];
    const running = new Set([600, 601]);
    let clock = 0;

    const remaining = await waitForProcessTreeExit(processes, {
      timeoutMs: 100,
      isRunning: (pid) => running.has(pid),
      now: () => clock,
      delay: async (duration) => {
        clock += duration;
        running.clear();
      },
    });

    expect(remaining).toEqual([]);
  });
});
