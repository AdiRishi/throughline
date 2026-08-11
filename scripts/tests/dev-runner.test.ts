// @effect-diagnostics nodeBuiltinImport:off - Exercises a standalone Node script, including its CLI entrypoint.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";

import {
  BASE_SERVER_PORT,
  BASE_WEB_PORT,
  createDevEnv,
  isBrowserAllowedPort,
  isDevRunnerError,
  isMode,
  isPortCandidate,
  MAX_PORT,
  MODES,
  parsePortOverride,
  PORT_OFFSET_RANGE,
  repoPortOffset,
  runTurbo,
  turboArgsForMode,
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
    // The CLI rejects the argument before the handler runs, and names the modes
    // that would have worked.
    expect(result.stderr).toContain('Invalid value for argument <mode>: "dev:mobile"');
    for (const mode of MODES) {
      expect(result.stderr).toContain(mode);
    }
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
    expect(parsePortOverride("13773junk")).toBeUndefined();
    expect(parsePortOverride("13773.9")).toBeUndefined();
    expect(parsePortOverride("")).toBeUndefined();
    expect(parsePortOverride("0")).toBeUndefined();
    expect(parsePortOverride("-1")).toBeUndefined();
    expect(parsePortOverride(String(MAX_PORT + 1))).toBeUndefined();
  });
});

describe("createDevEnv", () => {
  const baseInput = {
    serverPort: 13_800,
    webPort: 5_800,
    bootstrapToken: "token",
    logDir: "/repo/.logs",
    logLevel: "Debug",
    serverEntry: "/repo/apps/server/dist/bin.mjs",
  };
  const env = createDevEnv({ ...baseInput, isDesktopMode: false });
  const desktopEnvResult = createDevEnv({ ...baseInput, isDesktopMode: true });

  it("hands the same bootstrap token to the server and the web client", () => {
    expect(env.serverEnv["APP_BOOTSTRAP_TOKEN"]).toBe("token");
    expect(env.webEnv["VITE_BOOTSTRAP_TOKEN"]).toBe("token");
  });

  // Baking a loopback URL into the browser bundle is what breaks LAN/tailnet
  // dev: the remote browser resolves it and dials its own machine.
  it("keeps browser dev single-origin instead of baking a backend URL", () => {
    expect(env.webEnv["VITE_WS_URL"]).toBeUndefined();
    expect(env.webEnv["HOST"]).toBeUndefined();
    expect(env.webEnv["APP_SINGLE_ORIGIN_DEV"]).toBe("1");
    expect(env.webEnv["APP_SERVER_PORT"]).toBe("13800");
  });

  it("bakes the backend URL only for the shell, which loads from a custom scheme", () => {
    expect(desktopEnvResult.wsUrl).toBe("ws://127.0.0.1:13800");
    expect(desktopEnvResult.webEnv["VITE_WS_URL"]).toBe(desktopEnvResult.wsUrl);
    expect(desktopEnvResult.webEnv["HOST"]).toBe("localhost");
    expect(desktopEnvResult.webEnv["APP_SINGLE_ORIGIN_DEV"]).toBeUndefined();
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
    expect(desktopEnvResult.turboEnv["APP_BOOTSTRAP_TOKEN"]).toBeUndefined();
    expect(desktopEnvResult.turboEnv["VITE_BOOTSTRAP_TOKEN"]).toBeUndefined();
  });
});

describe("turboArgsForMode", () => {
  it("uses the browser dev tasks for the default session", () => {
    expect(turboArgsForMode("dev")).toEqual([
      "run",
      "dev",
      "--filter=@app/server",
      "--filter=@app/web",
    ]);
  });

  it("runs the bundle watchers and Electron supervisor for desktop development", () => {
    expect(turboArgsForMode("dev:desktop")).toEqual([
      "run",
      "dev:bundle",
      "dev:desktop",
      "--filter=@app/server",
      "--filter=@app/web",
      "--filter=@app/desktop",
    ]);
  });
});

describe("runTurbo", () => {
  const repoRoot = NodePath.resolve(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "../..",
  );

  effectIt.effect("surfaces a failed Turbo task as a typed failure", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runTurbo({
          repoRoot,
          args: ["run", "definitely-not-a-task", "--filter=@app/scripts"],
          env: {},
          onWindows: false,
        }),
      );
      assert.isTrue(Exit.isFailure(exit), "a missing Turbo task should fail the session");
      const failure = Exit.isFailure(exit)
        ? exit.cause.reasons.find(Cause.isFailReason)?.error
        : undefined;
      assert.isTrue(isDevRunnerError(failure), `expected a DevRunnerError, got ${String(failure)}`);
      assert.equal(failure?._tag, "DevRunnerProcessExitError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
