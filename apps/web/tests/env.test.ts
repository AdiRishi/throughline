import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectionTargetProtocolUnsupportedError,
  ConnectionTargetUrlInvalidError,
  resolveConnectionTarget,
  resolveConnectionTargetResult,
  toHttpOrigin,
  toWsOrigin,
} from "../src/env.ts";

// `env.ts` reads `window` at module load for `isElectron`, so the bridge cases
// install their own `window` stub and import a fresh module graph (the same
// pattern localApi.test.ts uses).
type MutableGlobal = { window?: unknown };

function setWindow(stub: object): void {
  (globalThis as MutableGlobal).window = stub;
}

async function loadEnvWithWindow(stub: object) {
  vi.resetModules();
  setWindow(stub);
  return await import("../src/env.ts");
}

afterEach(() => {
  delete (globalThis as MutableGlobal).window;
});

describe("connection target URL conversion", () => {
  it("maps ws(s) URLs to their http(s) origins", () => {
    expect(toHttpOrigin("ws://127.0.0.1:13773")).toBe("http://127.0.0.1:13773");
    expect(toHttpOrigin("wss://example.com/ws?token=x#y")).toBe("https://example.com");
  });

  it("maps http(s) origins to their ws(s) forms", () => {
    expect(toWsOrigin("http://127.0.0.1:5733")).toBe("ws://127.0.0.1:5733");
    expect(toWsOrigin("https://example.com/app?tab=1")).toBe("wss://example.com");
  });

  it("round-trips an origin through both conversions", () => {
    expect(toWsOrigin(toHttpOrigin("ws://127.0.0.1:13773"))).toBe("ws://127.0.0.1:13773");
  });

  it("classifies a malformed URL instead of throwing a bare TypeError", () => {
    expect(() => toHttpOrigin("")).toThrow(ConnectionTargetUrlInvalidError);
    expect(() => toWsOrigin("not a url")).toThrow(ConnectionTargetUrlInvalidError);
  });

  it("rejects a scheme that cannot carry the connection", () => {
    // `url.protocol = "ws:"` is a silent no-op on a non-special scheme, so an
    // unsupported input must be refused rather than passed along.
    expect(() => toWsOrigin("file:///app/index.html")).toThrow(
      ConnectionTargetProtocolUnsupportedError,
    );
  });
});

describe("resolveConnectionTarget in a browser", () => {
  it("derives both origins from the page origin", () => {
    setWindow({ location: { origin: "https://app.example.com" } });

    expect(resolveConnectionTarget()).toEqual({
      source: "window-origin",
      httpBaseUrl: "https://app.example.com",
      wsBaseUrl: "wss://app.example.com",
    });
  });

  it("keeps an insecure origin insecure", () => {
    setWindow({ location: { origin: "http://192.168.1.20:13773" } });

    expect(resolveConnectionTarget()).toEqual({
      source: "window-origin",
      httpBaseUrl: "http://192.168.1.20:13773",
      wsBaseUrl: "ws://192.168.1.20:13773",
    });
  });

  it("fails as a classified error when the page origin is unusable", () => {
    setWindow({ location: { origin: "file://" } });

    const read = resolveConnectionTargetResult();
    expect(read._tag).toBe("Failure");
    expect(read._tag === "Failure" && read.cause).toBeInstanceOf(
      ConnectionTargetProtocolUnsupportedError,
    );
  });
});

describe("resolveConnectionTarget in the shell", () => {
  it("uses the bridge's server bootstrap", async () => {
    const env = await loadEnvWithWindow({
      desktopBridge: {
        getServerBootstrap: () => ({
          httpBaseUrl: "http://127.0.0.1:13773",
          wsBaseUrl: "ws://127.0.0.1:13773",
        }),
      },
      location: { origin: "http://localhost:5733" },
    });

    expect(env.resolveConnectionTarget()).toEqual({
      source: "desktop-managed",
      httpBaseUrl: "http://127.0.0.1:13773",
      wsBaseUrl: "ws://127.0.0.1:13773",
    });
  });

  it("falls back to the page origin when the bootstrap is not ready yet", async () => {
    const env = await loadEnvWithWindow({
      desktopBridge: { getServerBootstrap: () => null },
      location: { origin: "http://localhost:5733" },
    });

    expect(env.resolveConnectionTarget()).toEqual({
      source: "window-origin",
      httpBaseUrl: "http://localhost:5733",
      wsBaseUrl: "ws://localhost:5733",
    });
  });

  it("classifies a half-filled bootstrap rather than dialling a broken URL", async () => {
    const env = await loadEnvWithWindow({
      desktopBridge: {
        getServerBootstrap: () => ({ httpBaseUrl: "http://127.0.0.1:13773", wsBaseUrl: "" }),
      },
      location: { origin: "http://localhost:5733" },
    });

    const read = env.resolveConnectionTargetResult();
    expect(read._tag).toBe("Failure");
    expect(read._tag === "Failure" && read.cause).toBeInstanceOf(
      env.DesktopServerBootstrapIncompleteError,
    );
  });
});

describe("resolveConnectionTargetResult", () => {
  it("returns a Failure instead of letting a throw become a defect", () => {
    const read = resolveConnectionTargetResult(() => {
      throw new ConnectionTargetProtocolUnsupportedError({
        source: "configured",
        protocol: "gopher:",
      });
    });

    expect(read).toEqual({
      _tag: "Failure",
      cause: expect.any(ConnectionTargetProtocolUnsupportedError),
    });
  });

  it("passes a resolved target through untouched", () => {
    const target = {
      source: "configured",
      httpBaseUrl: "http://127.0.0.1:13773",
      wsBaseUrl: "ws://127.0.0.1:13773",
    } as const;

    expect(resolveConnectionTargetResult(() => target)).toEqual({ _tag: "Success", target });
  });
});
