import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "@app/contracts";

// `env.ts` reads `window` at module load and `localApi.ts` caches its instance,
// so every scenario installs its own `window` stub and imports a fresh module
// graph (the reference repo tests its localApi the same way).

type MutableGlobal = { window?: unknown };

function makeStorage(overrides?: Partial<Storage>): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: () => null,
    length: 0,
    ...overrides,
  } as Storage;
}

function makeBridge(overrides?: Partial<DesktopBridge>): DesktopBridge {
  return {
    getAppInfo: () => null,
    getTheme: () => "system",
    getServerBootstrap: () => null,
    getBearerToken: vi.fn<DesktopBridge["getBearerToken"]>(async () => "bearer"),
    setTheme: vi.fn<DesktopBridge["setTheme"]>(async () => undefined),
    openExternal: vi.fn<DesktopBridge["openExternal"]>(async () => true),
    openLogsFolder: vi.fn<DesktopBridge["openLogsFolder"]>(async () => true),
    confirm: vi.fn<DesktopBridge["confirm"]>(async () => true),
    pickFolder: vi.fn<DesktopBridge["pickFolder"]>(async () => "/picked"),
    showContextMenu: vi.fn<DesktopBridge["showContextMenu"]>(async () => null),
    getUpdateState: vi.fn<DesktopBridge["getUpdateState"]>(),
    setUpdateChannel: vi.fn<DesktopBridge["setUpdateChannel"]>(),
    checkForUpdate: vi.fn<DesktopBridge["checkForUpdate"]>(),
    downloadUpdate: vi.fn<DesktopBridge["downloadUpdate"]>(),
    installUpdate: vi.fn<DesktopBridge["installUpdate"]>(),
    onUpdateState: vi.fn<DesktopBridge["onUpdateState"]>(() => () => {}),
    onMenuAction: vi.fn<DesktopBridge["onMenuAction"]>(() => () => {}),
    ...overrides,
  } as DesktopBridge;
}

async function loadLocalApi(windowStub: object) {
  vi.resetModules();
  (globalThis as MutableGlobal).window = windowStub;
  const module = await import("../src/localApi.ts");
  return module;
}

afterEach(() => {
  delete (globalThis as MutableGlobal).window;
});

describe("localApi in the shell (bridge present)", () => {
  it("reads shell identity and theme while delegating local actions", async () => {
    const appInfo = {
      name: "Throughline",
      version: "1.2.3",
      platform: "darwin",
      isPackaged: true,
    } as const;
    const bridge = makeBridge({
      getAppInfo: () => appInfo,
      getTheme: () => "dark",
    });
    const storage = makeStorage();
    storage.setItem("app:theme", "light");
    const { localApi } = await loadLocalApi({ desktopBridge: bridge, localStorage: storage });
    const api = localApi();

    expect(api.isDesktop).toBe(true);
    expect(api.getAppInfo()).toEqual(appInfo);
    expect(api.getTheme()).toBe("dark");
    expect(storage.getItem("app:theme")).toBe("dark");

    const persisted = api.setTheme("light");
    expect(api.getTheme()).toBe("light");
    await persisted;
    expect(bridge.setTheme).toHaveBeenCalledWith("light");
    // Persisted too, so the pre-mount guard in index.html can read it.
    expect(storage.getItem("app:theme")).toBe("light");

    await api.openExternal("https://example.com");
    expect(bridge.openExternal).toHaveBeenCalledWith("https://example.com");

    expect(await api.openLogsFolder()).toBe(true);
    expect(bridge.openLogsFolder).toHaveBeenCalledOnce();

    expect(await api.confirm("sure?")).toBe(true);
    expect(await api.pickFolder({ title: "Pick" })).toBe("/picked");
    expect(bridge.pickFolder).toHaveBeenCalledWith({ title: "Pick" });
  });

  it("surfaces a failed openExternal as an error", async () => {
    const bridge = makeBridge({
      openExternal: vi.fn<DesktopBridge["openExternal"]>(async () => false),
    });
    const { localApi } = await loadLocalApi({ desktopBridge: bridge, localStorage: makeStorage() });

    await expect(localApi().openExternal("https://example.com")).rejects.toThrow(
      "Unable to open the link.",
    );
  });

  it("still syncs the theme to the shell when localStorage throws (private mode)", async () => {
    const bridge = makeBridge();
    const storage = makeStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { localApi } = await loadLocalApi({ desktopBridge: bridge, localStorage: storage });

    await localApi().setTheme("light");
    expect(bridge.setTheme).toHaveBeenCalledWith("light");
  });
});

describe("localApi in a plain browser (no bridge)", () => {
  it("reports non-desktop and uses web fallbacks", async () => {
    const open = vi.fn<typeof window.open>();
    const confirm = vi.fn<() => boolean>(() => false);
    const storage = makeStorage();
    storage.setItem("app:theme", "dark");
    const { localApi } = await loadLocalApi({ localStorage: storage, open, confirm });
    const api = localApi();

    expect(api.isDesktop).toBe(false);
    expect(api.getAppInfo()).toBeNull();
    expect(api.getTheme()).toBe("dark");

    await api.setTheme("system");
    expect(storage.getItem("app:theme")).toBe("system");

    await api.openExternal("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");

    expect(await api.confirm("sure?")).toBe(false);
    expect(confirm).toHaveBeenCalledWith("sure?");

    // No native affordances in a browser: folder picker degrades to null and
    // diagnostics discovery returns false, while menu subscriptions are inert.
    expect(await api.openLogsFolder()).toBe(false);
    expect(await api.pickFolder()).toBeNull();
    const unsubscribe = api.onMenuAction(() => {});
    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
  });
});
