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
  const updateState = {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  } as const;
  return {
    getAppInfo: () => null,
    getTheme: () => "system",
    getWindowFullscreenState: () => false,
    getServerBootstrap: () => null,
    getBearerToken: vi.fn<DesktopBridge["getBearerToken"]>(async () => "bearer"),
    setTheme: vi.fn<DesktopBridge["setTheme"]>(async () => undefined),
    openExternal: vi.fn<DesktopBridge["openExternal"]>(async () => true),
    openLogsFolder: vi.fn<DesktopBridge["openLogsFolder"]>(async () => true),
    confirm: vi.fn<DesktopBridge["confirm"]>(async () => true),
    pickFolder: vi.fn<DesktopBridge["pickFolder"]>(async () => "/picked"),
    showContextMenu: vi.fn<DesktopBridge["showContextMenu"]>(async () => null),
    getUpdateState: vi.fn<DesktopBridge["getUpdateState"]>(async () => updateState),
    setUpdateChannel: vi.fn<DesktopBridge["setUpdateChannel"]>(async (channel) => ({
      ...updateState,
      channel,
    })),
    checkForUpdate: vi.fn<DesktopBridge["checkForUpdate"]>(async () => ({
      checked: true,
      state: updateState,
    })),
    downloadUpdate: vi.fn<DesktopBridge["downloadUpdate"]>(async () => ({
      accepted: false,
      completed: false,
      state: updateState,
    })),
    installUpdate: vi.fn<DesktopBridge["installUpdate"]>(async () => ({
      accepted: false,
      completed: false,
      state: updateState,
    })),
    onUpdateState: vi.fn<DesktopBridge["onUpdateState"]>(() => () => {}),
    onMenuAction: vi.fn<DesktopBridge["onMenuAction"]>(() => () => {}),
    onWindowFullscreenStateChange: vi.fn<DesktopBridge["onWindowFullscreenStateChange"]>(
      () => () => {},
    ),
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

    expect((await api.getUpdateState()).currentVersion).toBe("1.2.3");
    expect((await api.setUpdateChannel("nightly")).channel).toBe("nightly");
    expect((await api.checkForUpdate()).checked).toBe(true);
    await api.downloadUpdate();
    await api.installUpdate();
    expect(bridge.downloadUpdate).toHaveBeenCalledOnce();
    expect(bridge.installUpdate).toHaveBeenCalledOnce();
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

  it("delegates native fullscreen state and subscriptions to the shell", async () => {
    const unsubscribe = vi.fn<() => void>();
    const listener = vi.fn<(fullscreen: boolean) => void>();
    const onWindowFullscreenStateChange = vi.fn<DesktopBridge["onWindowFullscreenStateChange"]>(
      () => unsubscribe,
    );
    const bridge = makeBridge({
      getWindowFullscreenState: () => true,
      onWindowFullscreenStateChange,
    });
    const { localApi } = await loadLocalApi({
      desktopBridge: bridge,
      localStorage: makeStorage(),
    });

    expect(localApi().getWindowFullscreenState()).toBe(true);
    const stop = localApi().onWindowFullscreenStateChange(listener);
    expect(onWindowFullscreenStateChange).toHaveBeenCalledWith(listener);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("degrades fullscreen capabilities while an older preload is still active", async () => {
    const bridge = {
      ...makeBridge(),
      getWindowFullscreenState: undefined,
      onWindowFullscreenStateChange: undefined,
    } as unknown as DesktopBridge;
    const { localApi } = await loadLocalApi({
      desktopBridge: bridge,
      localStorage: makeStorage(),
    });

    const api = localApi();
    expect(api.isDesktop).toBe(true);
    expect(api.getWindowFullscreenState()).toBe(false);
    const unsubscribe = api.onWindowFullscreenStateChange(() => {});
    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
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
    expect(api.getWindowFullscreenState()).toBe(false);

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
    expect(await api.getUpdateState()).toMatchObject({
      enabled: false,
      status: "disabled",
      currentVersion: "Browser",
    });
    expect(await api.checkForUpdate()).toMatchObject({
      checked: false,
      state: { enabled: false },
    });
    expect(await api.downloadUpdate()).toMatchObject({
      accepted: false,
      completed: false,
    });
    expect(await api.installUpdate()).toMatchObject({
      accepted: false,
      completed: false,
    });
    const unsubscribeUpdates = api.onUpdateState(() => {});
    expect(unsubscribeUpdates).toBeTypeOf("function");
    unsubscribeUpdates();
    const unsubscribe = api.onMenuAction(() => {});
    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
    const unsubscribeFullscreen = api.onWindowFullscreenStateChange(() => {});
    expect(unsubscribeFullscreen).toBeTypeOf("function");
    unsubscribeFullscreen();
  });
});
