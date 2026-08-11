import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import type { DesktopTheme } from "@app/contracts";

// The theme store is module state: one set of subscribers, one cached snapshot,
// one latched read failure. Every scenario therefore stubs its own `window` and
// imports a fresh module graph. `react` is stubbed because there is no renderer
// here — the store is driven through the `subscribe`/`getSnapshot` pair
// `useSyncExternalStore` would otherwise own.

type StorageEventListener = (event: StorageEvent) => void;

interface WindowStub {
  readonly localStorage: Storage;
  readonly matchMedia: (query: string) => MediaQueryList;
  readonly addEventListener: (type: string, listener: StorageEventListener) => void;
  readonly removeEventListener: (type: string, listener: StorageEventListener) => void;
  readonly desktopBridge?: { readonly setTheme: (theme: DesktopTheme) => Promise<void> };
}

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    length: 0,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    ...overrides,
  } as Storage;
}

interface ThemeHarness {
  readonly theme: DesktopTheme;
  readonly setTheme: (next: DesktopTheme) => boolean;
  readonly readSnapshot: () => DesktopTheme;
  readonly subscribeToTheme: (listener: () => void) => () => void;
  readonly emitStorage: (key: string | null) => void;
  readonly emitSystemChange: () => void;
  readonly writeThroughLocalApi: (theme: DesktopTheme) => Promise<void>;
  readonly toggleClass: Mock<(token: string, force: boolean) => void>;
  readonly themeColorMeta: { readonly attributes: Map<string, string> };
  readonly documentElement: { readonly style: { backgroundColor: string } };
}

async function loadTheme(options: {
  readonly storage?: Storage;
  readonly systemDark?: boolean;
  readonly bridge?: { readonly setTheme: (theme: DesktopTheme) => Promise<void> };
}): Promise<ThemeHarness> {
  vi.resetModules();

  let readSnapshot: (() => DesktopTheme) | undefined;
  let subscribeToTheme: ((listener: () => void) => () => void) | undefined;
  const windowListeners = new Map<string, Set<StorageEventListener>>();
  const mediaListeners = new Set<() => void>();

  vi.doMock("react", () => ({
    useCallback: <A>(callback: A) => callback,
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => DesktopTheme,
    ) => {
      subscribeToTheme = subscribe;
      readSnapshot = getSnapshot;
      return getSnapshot();
    },
  }));

  const toggleClass = vi.fn<(token: string, force: boolean) => void>();
  // A real-enough `<html>`: `applyTheme` reads the current class to decide
  // whether the theme actually changed, suppresses transitions across the
  // switch, and repaints the browser chrome from the resolved palette.
  const classes = new Set<string>();
  const themeColorMeta = {
    attributes: new Map<string, string>([["media", "(prefers-color-scheme: dark)"]]),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
  };
  const documentElement = {
    classList: {
      toggle: (token: string, force: boolean) => {
        if (force) classes.add(token);
        else classes.delete(token);
        toggleClass(token, force);
      },
      contains: (token: string) => classes.has(token),
      add: (token: string) => classes.add(token),
      remove: (token: string) => classes.delete(token),
    },
    style: { backgroundColor: "" },
    offsetHeight: 0,
  };
  vi.stubGlobal("document", {
    documentElement,
    querySelectorAll: (selector: string) =>
      selector === 'meta[name="theme-color"]' ? [themeColorMeta] : [],
  });
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (property: string) =>
      property === "--color-background" ? (classes.has("dark") ? "#0b0b0c" : "#fafafa") : "",
  }));
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });
  vi.stubGlobal("window", {
    localStorage: options.storage ?? createStorage(),
    matchMedia: () =>
      ({
        matches: options.systemDark ?? false,
        addEventListener: (_type: string, listener: () => void) => {
          mediaListeners.add(listener);
        },
        removeEventListener: (_type: string, listener: () => void) => {
          mediaListeners.delete(listener);
        },
      }) as unknown as MediaQueryList,
    addEventListener: (type: string, listener: StorageEventListener) => {
      const existing = windowListeners.get(type) ?? new Set<StorageEventListener>();
      existing.add(listener);
      windowListeners.set(type, existing);
    },
    removeEventListener: (type: string, listener: StorageEventListener) => {
      windowListeners.get(type)?.delete(listener);
    },
    ...(options.bridge ? { desktopBridge: options.bridge } : {}),
  } satisfies WindowStub);

  // Bound under a non-hook name: this is a plain call, not a React render.
  const { useTheme: readThemeStore } = await import("../../src/hooks/useTheme.ts");
  const { localApi } = await import("../../src/localApi.ts");
  const store = readThemeStore();

  return {
    theme: store.theme,
    setTheme: store.setTheme,
    readSnapshot: () => readSnapshot?.() ?? "system",
    subscribeToTheme: (listener) => subscribeToTheme?.(listener) ?? (() => {}),
    emitStorage: (key) => {
      for (const listener of windowListeners.get("storage") ?? []) {
        listener({ key } as StorageEvent);
      }
    },
    emitSystemChange: () => {
      for (const listener of mediaListeners) listener();
    },
    writeThroughLocalApi: (theme) => localApi().setTheme(theme),
    toggleClass,
    themeColorMeta,
    documentElement,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useTheme snapshot", () => {
  it("memoizes the snapshot until a change is signalled", async () => {
    const getItem = vi.fn<() => string | null>(() => "dark");
    const harness = await loadTheme({ storage: createStorage({ getItem }) });

    expect(harness.theme).toBe("dark");
    expect(harness.readSnapshot()).toBe("dark");
    expect(harness.readSnapshot()).toBe("dark");
    // Consumers call getSnapshot on every render; only the first one may read
    // storage.
    expect(getItem).toHaveBeenCalledTimes(1);

    // A signalled change is the only thing that reopens storage.
    expect(harness.setTheme("system")).toBe(true);
    harness.readSnapshot();
    expect(getItem).toHaveBeenCalledTimes(2);
  });

  it("retries a failed storage read only after a relevant storage event", async () => {
    const cause = new Error("persistent storage failure");
    const themeGetItem = vi.fn<() => string | null>(() => {
      throw cause;
    });
    const getItem = vi.fn<(key: string) => string | null>((key) =>
      key === "app:theme" ? themeGetItem() : null,
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const harness = await loadTheme({ storage: createStorage({ getItem }) });
    harness.readSnapshot();
    harness.readSnapshot();

    expect(harness.theme).toBe("system");
    expect(themeGetItem).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to read theme preference for app:theme.",
      expect.objectContaining({
        operation: "read",
        storageKey: "app:theme",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);

    const unsubscribe = harness.subscribeToTheme(() => {});
    harness.emitStorage("app:theme");
    harness.readSnapshot();

    expect(themeGetItem).toHaveBeenCalledTimes(2);
    expect(errorLog).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("clears the latch on a write that did not come from the hook", async () => {
    let readable = false;
    const getItem = vi.fn<(key: string) => string | null>(() => {
      if (!readable) throw new DOMException("denied", "SecurityError");
      return "dark";
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const harness = await loadTheme({ storage: createStorage({ getItem }) });
    const unsubscribe = harness.subscribeToTheme(() => {});
    expect(harness.readSnapshot()).toBe("system");

    readable = true;
    await harness.writeThroughLocalApi("dark");
    harness.emitSystemChange();

    // A same-window write emits no storage event, so the write itself is the
    // only thing that can prove storage works again. Left latched, the store
    // reports the default forever.
    expect(harness.readSnapshot()).toBe("dark");
    unsubscribe();
  });
});

describe("useTheme browser chrome", () => {
  // Without this the UA keeps painting light scrollbars, a white overscroll
  // gutter and a light mobile toolbar around a dark app.
  it("repaints the browser chrome from the resolved palette", async () => {
    const harness = await loadTheme({});

    harness.setTheme("dark");
    expect(harness.documentElement.style.backgroundColor).toBe("#0b0b0c");
    expect(harness.themeColorMeta.attributes.get("content")).toBe("#0b0b0c");
    // A media-scoped meta would keep the stale value winning once we set it
    // ourselves.
    expect(harness.themeColorMeta.attributes.has("media")).toBe(false);

    harness.setTheme("light");
    expect(harness.documentElement.style.backgroundColor).toBe("#fafafa");
    expect(harness.themeColorMeta.attributes.get("content")).toBe("#fafafa");
  });

  it("suppresses transitions only across an actual theme change", async () => {
    const harness = await loadTheme({});

    harness.setTheme("dark");
    // `requestAnimationFrame` is synchronous in this harness, so the class is
    // added and removed within the call.
    expect(harness.toggleClass).toHaveBeenLastCalledWith("dark", true);

    harness.toggleClass.mockClear();
    harness.setTheme("dark");
    // Re-applying the same theme is not a change; nothing should flash.
    expect(harness.toggleClass).toHaveBeenLastCalledWith("dark", true);
  });
});

describe("useTheme cross-window sync", () => {
  it("applies a theme another window wrote and notifies subscribers", async () => {
    const storage = createStorage();
    const harness = await loadTheme({ storage });
    const listener = vi.fn<() => void>();
    const unsubscribe = harness.subscribeToTheme(listener);

    storage.setItem("app:theme", "dark");
    harness.emitStorage("app:theme");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.toggleClass).toHaveBeenLastCalledWith("dark", true);
    expect(harness.readSnapshot()).toBe("dark");

    unsubscribe();
  });

  it("treats a cleared store as a theme change and ignores other keys", async () => {
    const storage = createStorage();
    storage.setItem("app:theme", "dark");
    const harness = await loadTheme({ storage });
    const listener = vi.fn<() => void>();
    const unsubscribe = harness.subscribeToTheme(listener);

    harness.emitStorage("app:other");
    expect(listener).not.toHaveBeenCalled();

    storage.clear();
    harness.emitStorage(null);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.readSnapshot()).toBe("system");

    unsubscribe();
  });

  it("drops the shared window listeners once the last subscriber leaves", async () => {
    const storage = createStorage();
    const harness = await loadTheme({ storage });
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const unsubscribeFirst = harness.subscribeToTheme(first);
    const unsubscribeSecond = harness.subscribeToTheme(second);

    unsubscribeFirst();
    storage.setItem("app:theme", "dark");
    harness.emitStorage("app:theme");
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeSecond();
    harness.emitStorage("app:theme");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("follows the system appearance while the preference is system", async () => {
    const harness = await loadTheme({ storage: createStorage(), systemDark: true });
    const listener = vi.fn<() => void>();
    const unsubscribe = harness.subscribeToTheme(listener);

    harness.emitSystemChange();

    expect(harness.toggleClass).toHaveBeenLastCalledWith("dark", true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});

describe("useTheme setTheme", () => {
  it("applies and persists the theme, then hands it to the shell", async () => {
    const storage = createStorage();
    const setTheme = vi.fn<(theme: DesktopTheme) => Promise<void>>(async () => {});
    const harness = await loadTheme({ storage, bridge: { setTheme } });
    const listener = vi.fn<() => void>();
    const unsubscribe = harness.subscribeToTheme(listener);

    expect(harness.setTheme("dark")).toBe(true);

    expect(storage.getItem("app:theme")).toBe("dark");
    expect(harness.toggleClass).toHaveBeenLastCalledWith("dark", true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(harness.readSnapshot()).toBe("dark");
    await Promise.resolve();
    expect(setTheme).toHaveBeenCalledWith("dark");

    unsubscribe();
  });

  it("fails closed when the preference cannot be written", async () => {
    const cause = new Error("storage quota exceeded");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn<(theme: DesktopTheme) => Promise<void>>(async () => {});
    const harness = await loadTheme({
      storage: createStorage({
        setItem: () => {
          throw cause;
        },
      }),
      bridge: { setTheme },
    });
    const listener = vi.fn<() => void>();
    const unsubscribe = harness.subscribeToTheme(listener);

    expect(harness.setTheme("dark")).toBe(false);

    // Nothing moved: the store would otherwise report a theme the page is not
    // showing and cannot restore on the next load.
    expect(harness.toggleClass).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(setTheme).not.toHaveBeenCalled();
    expect(harness.readSnapshot()).toBe("system");
    expect(errorLog).toHaveBeenCalledWith(
      "Failed to write theme preference for app:theme.",
      expect.objectContaining({
        operation: "write",
        storageKey: "app:theme",
        theme: "dark",
        errorTag: "ThemeStorageError",
      }),
    );
    const attributes = errorLog.mock.calls[0]?.[1];
    expect(attributes).not.toHaveProperty("cause");
    expect(JSON.stringify(attributes)).not.toContain(cause.message);

    unsubscribe();
  });

  it("reports a refused shell handoff instead of leaving it unhandled", async () => {
    const cause = new Error("desktop IPC unavailable");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const setTheme = vi.fn<(theme: DesktopTheme) => Promise<void>>(() => Promise.reject(cause));
    const harness = await loadTheme({ storage: createStorage(), bridge: { setTheme } });

    expect(harness.setTheme("dark")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();

    expect(errorLog).toHaveBeenCalledWith(
      "Failed to sync the dark theme to the desktop shell.",
      expect.objectContaining({ theme: "dark", errorTag: "DesktopThemeSyncError" }),
    );
    for (const [, attributes] of errorLog.mock.calls) {
      expect(attributes).not.toHaveProperty("cause");
      expect(JSON.stringify(attributes)).not.toContain(cause.message);
    }
  });
});
