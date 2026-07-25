import { afterEach, describe, expect, it, vi } from "vitest";

import { syncDocumentWindowControlsOverlayClass } from "../src/windowControlsOverlay.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("window controls overlay document state", () => {
  it("tracks overlay visibility and removes its geometry listener", () => {
    const classes = new Set<string>();
    let geometryListener: EventListener | undefined;
    const overlay = {
      visible: true,
      addEventListener: vi.fn<(type: "geometrychange", listener: EventListener) => void>(
        (_type, listener) => {
          geometryListener = listener;
        },
      ),
      removeEventListener: vi.fn<(type: "geometrychange", listener: EventListener) => void>(),
    };
    vi.stubGlobal("document", {
      documentElement: {
        classList: {
          toggle: (className: string, enabled: boolean) => {
            if (enabled) {
              classes.add(className);
            } else {
              classes.delete(className);
            }
          },
        },
      },
    });
    vi.stubGlobal("navigator", { windowControlsOverlay: overlay });

    const unsubscribe = syncDocumentWindowControlsOverlayClass();
    expect(classes.has("window-controls-overlay")).toBe(true);

    overlay.visible = false;
    geometryListener?.({} as Event);
    expect(classes.has("window-controls-overlay")).toBe(false);

    unsubscribe();
    expect(overlay.removeEventListener).toHaveBeenCalledWith("geometrychange", geometryListener);
  });
});
