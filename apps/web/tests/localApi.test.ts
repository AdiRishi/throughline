import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopBridge } from "@app/contracts";

// `env.ts` reads `window` at module load and `localApi.ts` caches its instance,
// so every scenario installs its own `window` stub and imports a fresh module
// graph.

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
    getServerBootstrap: () => null,
    getBearerToken: vi.fn<DesktopBridge["getBearerToken"]>(async () => "bearer"),
    setTheme: vi.fn<DesktopBridge["setTheme"]>(async () => undefined),
    openExternal: vi.fn<DesktopBridge["openExternal"]>(async () => true),
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

function captureThrow(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
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
  it("reports desktop and delegates to the bridge", async () => {
    const bridge = makeBridge();
    const storage = makeStorage();
    const { localApi } = await loadLocalApi({ desktopBridge: bridge, localStorage: storage });
    const api = localApi();

    expect(api.isDesktop).toBe(true);

    await api.setTheme("dark");
    expect(bridge.setTheme).toHaveBeenCalledWith("dark");
    // Persisted too, so the pre-mount guard in index.html can read it.
    expect(storage.getItem("app:theme")).toBe("dark");

    await api.openExternal("https://example.com");
    expect(bridge.openExternal).toHaveBeenCalledWith("https://example.com");

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

  it("fails the theme change closed when localStorage throws (private mode)", async () => {
    const cause = new Error("QuotaExceededError");
    const bridge = makeBridge();
    const storage = makeStorage({
      setItem: () => {
        throw cause;
      },
    });
    const { localApi, isThemeStorageError } = await loadLocalApi({
      desktopBridge: bridge,
      localStorage: storage,
    });

    const error: unknown = await localApi()
      .setTheme("light")
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(isThemeStorageError(error)).toBe(true);
    expect(error).toMatchObject({
      operation: "write",
      storageKey: "app:theme",
      theme: "light",
      cause,
    });
    // A preference the store could not hold is never announced to the shell;
    // the two would otherwise disagree until the next reload.
    expect(bridge.setTheme).not.toHaveBeenCalled();
  });

  it("wraps a refused bridge handoff in DesktopThemeSyncError", async () => {
    const cause = new Error("desktop IPC unavailable");
    const bridge = makeBridge({
      setTheme: vi.fn<DesktopBridge["setTheme"]>(() => Promise.reject(cause)),
    });
    const { localApi, isDesktopThemeSyncError } = await loadLocalApi({
      desktopBridge: bridge,
      localStorage: makeStorage(),
    });

    const error: unknown = await localApi()
      .setTheme("dark")
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(isDesktopThemeSyncError(error)).toBe(true);
    expect(error).toMatchObject({ theme: "dark", cause });
  });
});

describe("theme storage primitives", () => {
  it("preserves the exact cause and operation context", async () => {
    const readCause = new Error("storage read blocked");
    const writeCause = new Error("storage quota exceeded");
    const { readThemePreference, writeThemePreference, ThemeStorageError } = await loadLocalApi({
      localStorage: makeStorage({
        getItem: () => {
          throw readCause;
        },
        setItem: () => {
          throw writeCause;
        },
      }),
    });

    expect(() => readThemePreference()).toThrow(ThemeStorageError);
    expect(() => writeThemePreference("dark")).toThrow(ThemeStorageError);

    // The exact cause survives, so a private-mode failure is still readable in
    // the log the caller writes.
    expect(captureThrow(() => readThemePreference())).toMatchObject({
      operation: "read",
      storageKey: "app:theme",
      cause: readCause,
    });
    expect(captureThrow(() => writeThemePreference("dark"))).toMatchObject({
      operation: "write",
      storageKey: "app:theme",
      theme: "dark",
      cause: writeCause,
    });
  });

  it("falls back to the default preference for an unknown stored value", async () => {
    const storage = makeStorage();
    storage.setItem("app:theme", "chartreuse");
    const { readThemePreference } = await loadLocalApi({ localStorage: storage });

    expect(readThemePreference()).toBe("system");
  });
});

describe("localApi in a plain browser (no bridge)", () => {
  it("reports non-desktop and uses web fallbacks", async () => {
    const open = vi.fn<typeof window.open>();
    const confirm = vi.fn<() => boolean>(() => false);
    const storage = makeStorage();
    const { localApi } = await loadLocalApi({ localStorage: storage, open, confirm });
    const api = localApi();

    expect(api.isDesktop).toBe(false);

    await api.setTheme("system");
    expect(storage.getItem("app:theme")).toBe("system");

    await api.openExternal("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer");

    expect(await api.confirm("sure?")).toBe(false);
    expect(confirm).toHaveBeenCalledWith("sure?");

    expect(await api.pickFolder()).toBeNull();
    const unsubscribe = api.onMenuAction(() => {});
    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
  });
});
