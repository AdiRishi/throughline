// @effect-diagnostics nodeBuiltinImport:off - Exercises a standalone Node script, including its CLI entrypoint.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vitest";

import {
  BASE_SERVER_PORT,
  BASE_WEB_PORT,
  createDevEnv,
  createLinePrefixer,
  formatLabel,
  isBrowserAllowedPort,
  isMode,
  isPortCandidate,
  MAX_PORT,
  parsePortOverride,
  PORT_OFFSET_RANGE,
  repoPortOffset,
  sessionExitCode,
} from "../dev-runner.ts";

const DEV_RUNNER = NodePath.join(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
  "dev-runner.ts",
);

describe("cli entrypoint", () => {
  it("exits non-zero on an unknown mode without spawning anything", () => {
    const result = NodeChildProcess.spawnSync(process.execPath, [DEV_RUNNER, "dev:mobile"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown mode "dev:mobile"');
  });
});

describe("isMode", () => {
  it("rejects anything else", () => {
    expect(isMode("dev:mobile")).toBe(false);
    expect(isMode("")).toBe(false);
  });
});

describe("repoPortOffset", () => {
  it("is stable for a given checkout", () => {
    expect(repoPortOffset("/Users/dev/throughline")).toBe(repoPortOffset("/Users/dev/throughline"));
  });

  it("differs between checkouts so clones don't fight over ports", () => {
    expect(repoPortOffset("/Users/dev/a")).not.toBe(repoPortOffset("/Users/dev/b"));
  });

  it("stays inside the offset window", () => {
    for (const root of ["/", "/a", "/Users/dev/throughline", "C:\\src\\throughline"]) {
      const offset = repoPortOffset(root);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(PORT_OFFSET_RANGE);
    }
  });

  it("keeps both bases below the maximum port for every possible offset", () => {
    expect(BASE_SERVER_PORT + PORT_OFFSET_RANGE).toBeLessThan(MAX_PORT);
    expect(BASE_WEB_PORT + PORT_OFFSET_RANGE).toBeLessThan(MAX_PORT);
  });
});

describe("isBrowserAllowedPort", () => {
  // These are the entries of the WHATWG blocked-port set that fall inside the
  // web scan window [5733, 5733 + PORT_OFFSET_RANGE): curl connects to them,
  // every browser refuses. The regression this guards is a dev URL that works
  // from the terminal and not from the app.
  it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
    "rejects blocked port %i inside the web scan window",
    (port) => {
      expect(port).toBeGreaterThanOrEqual(BASE_WEB_PORT);
      expect(port).toBeLessThan(BASE_WEB_PORT + PORT_OFFSET_RANGE);
      expect(isBrowserAllowedPort(port)).toBe(false);
    },
  );

  it.each([0, 22, 25, 143, 993, 5060, 10080])("rejects blocked port %i", (port) => {
    expect(isBrowserAllowedPort(port)).toBe(false);
  });

  it("allows the documented defaults", () => {
    expect(isBrowserAllowedPort(BASE_WEB_PORT)).toBe(true);
    expect(isBrowserAllowedPort(BASE_SERVER_PORT)).toBe(true);
    expect(isBrowserAllowedPort(5734)).toBe(true);
  });
});

describe("isPortCandidate", () => {
  it("skips browser-blocked ports for the web role", () => {
    expect(isPortCandidate(6000, "web")).toBe(false);
    expect(isPortCandidate(6001, "web")).toBe(true);
  });

  it("keeps browser-blocked ports usable for the server role", () => {
    // The server port is reached by the desktop shell and by Vite's proxy, so
    // the Fetch block list does not apply to it.
    expect(isPortCandidate(6000, "server")).toBe(true);
  });

  it("rejects out-of-range numbers", () => {
    expect(isPortCandidate(0, "server")).toBe(false);
    expect(isPortCandidate(MAX_PORT + 1, "server")).toBe(false);
    expect(isPortCandidate(1.5, "server")).toBe(false);
  });
});

describe("parsePortOverride", () => {
  it("accepts a valid port", () => {
    expect(parsePortOverride("13773")).toBe(13773);
    expect(parsePortOverride("1")).toBe(1);
    expect(parsePortOverride(String(MAX_PORT))).toBe(MAX_PORT);
  });

  it("returns undefined when unset", () => {
    expect(parsePortOverride(undefined)).toBeUndefined();
  });

  it("returns undefined for values the children would parse differently", () => {
    expect(parsePortOverride("abc")).toBeUndefined();
    expect(parsePortOverride("")).toBeUndefined();
    expect(parsePortOverride("0")).toBeUndefined();
    expect(parsePortOverride("-1")).toBeUndefined();
    expect(parsePortOverride(String(MAX_PORT + 1))).toBeUndefined();
  });
});

describe("createDevEnv", () => {
  const env = createDevEnv({
    repoRoot: "/repo",
    serverPort: 13_800,
    webPort: 5_800,
    bootstrapToken: "token",
    logDir: "/repo/.logs",
    logLevel: "Debug",
  });

  it("hands the same bootstrap token to the server and the web client", () => {
    expect(env.serverEnv["APP_BOOTSTRAP_TOKEN"]).toBe("token");
    expect(env.webEnv["VITE_BOOTSTRAP_TOKEN"]).toBe("token");
  });

  it("points the web client at the server's websocket on loopback", () => {
    expect(env.wsUrl).toBe("ws://127.0.0.1:13800");
    expect(env.webEnv["VITE_WS_URL"]).toBe(env.wsUrl);
  });

  it("agrees on the dev web URL across the server and the shell", () => {
    expect(env.devWebUrl).toBe("http://localhost:5800");
    expect(env.serverEnv["APP_DEV_WEB_URL"]).toBe(env.devWebUrl);
    expect(env.desktopEnv["APP_DEV_WEB_URL"]).toBe(env.devWebUrl);
  });

  it("sends every process to one log directory", () => {
    for (const child of [env.serverEnv, env.desktopEnv]) {
      expect(child["APP_LOG_DIR"]).toBe("/repo/.logs");
      expect(child["APP_LOG_LEVEL"]).toBe("Debug");
    }
  });

  it("points the shell at the built server bundle, which it can run as node", () => {
    expect(env.desktopEnv["APP_SERVER_ENTRY"]).toBe("/repo/apps/server/dist/bin.mjs");
  });

  it("gives the server and the shell the same port", () => {
    expect(env.serverEnv["APP_SERVER_PORT"]).toBe("13800");
    expect(env.desktopEnv["APP_SERVER_PORT"]).toBe("13800");
    expect(env.webEnv["PORT"]).toBe("5800");
  });

  it("never leaks the bootstrap token to the shell, which reads it from the server", () => {
    expect(env.desktopEnv["APP_BOOTSTRAP_TOKEN"]).toBeUndefined();
  });
});

describe("formatLabel", () => {
  it("is a plain bracketed label when the stream is not a TTY", () => {
    expect(formatLabel("web", 0, false)).toBe("[web] ");
    expect(formatLabel("web", 5, false)).toBe("[web] ");
  });
});

describe("createLinePrefixer", () => {
  const collect = (): { lines: Array<string>; write: (line: string) => void } => {
    const lines: Array<string> = [];
    return { lines, write: (line) => lines.push(line) };
  };

  it("prefixes each complete line", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("one\ntwo\n");
    expect(sink.lines).toEqual(["[web] one\n", "[web] two\n"]);
  });

  it("buffers a partial line until its newline arrives", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("ready in ");
    expect(sink.lines).toEqual([]);
    prefixer.push("120 ms\n");
    expect(sink.lines).toEqual(["[web] ready in 120 ms\n"]);
  });

  it("splits a chunk that carries several lines and a remainder", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[server] ", sink.write);
    prefixer.push("a\nb\nc");
    expect(sink.lines).toEqual(["[server] a\n", "[server] b\n"]);
    prefixer.flush();
    expect(sink.lines).toEqual(["[server] a\n", "[server] b\n", "[server] c\n"]);
  });

  it("does not swallow the tail when the child exits mid-line", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("crashed:");
    prefixer.flush();
    expect(sink.lines).toEqual(["[web] crashed:\n"]);
  });

  it("flushes nothing when the buffer is empty", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("done\n");
    prefixer.flush();
    prefixer.flush();
    expect(sink.lines).toEqual(["[web] done\n"]);
  });

  it("keeps a CRLF terminator out of the middle of the line", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("windows\r\n");
    expect(sink.lines).toEqual(["[web] windows\n"]);
  });

  it("preserves blank lines", () => {
    const sink = collect();
    const prefixer = createLinePrefixer("[web] ", sink.write);
    prefixer.push("\n\n");
    expect(sink.lines).toEqual(["[web] \n", "[web] \n"]);
  });
});

describe("sessionExitCode", () => {
  it("propagates a non-zero child exit so the runner cannot exit 0 on a crash", () => {
    expect(sessionExitCode(1, null)).toBe(1);
    expect(sessionExitCode(127, null)).toBe(127);
  });

  it("stays successful when a child exits cleanly", () => {
    expect(sessionExitCode(0, null)).toBe(0);
  });

  it("treats a shutdown signal as the user stopping the run", () => {
    // Ctrl+C reaches the whole process group, so children see SIGINT before
    // the runner's own handler gets a turn.
    expect(sessionExitCode(null, "SIGINT")).toBe(0);
    expect(sessionExitCode(null, "SIGTERM")).toBe(0);
    expect(sessionExitCode(null, "SIGHUP")).toBe(0);
  });

  it("treats any other signal as a failure", () => {
    expect(sessionExitCode(null, "SIGKILL")).toBe(1);
    expect(sessionExitCode(null, "SIGSEGV")).toBe(1);
    expect(sessionExitCode(null, null)).toBe(1);
  });
});
