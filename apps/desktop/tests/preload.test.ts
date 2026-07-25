import { describe, expect, it, vi } from "vitest";

import type { DesktopBridge, DesktopUpdateState } from "@app/contracts";

const { exposed, listeners, removeListener } = vi.hoisted(() => ({
  exposed: { bridge: undefined as DesktopBridge | undefined },
  listeners: new Map<string, (...args: ReadonlyArray<unknown>) => void>(),
  removeListener:
    vi.fn<(channel: string, listener: (...args: ReadonlyArray<unknown>) => void) => void>(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: DesktopBridge) => {
      exposed.bridge = bridge;
    },
  },
  ipcRenderer: {
    invoke: vi.fn<(...args: ReadonlyArray<unknown>) => Promise<unknown>>(),
    sendSync: vi.fn<(...args: ReadonlyArray<unknown>) => unknown>(),
    on: (channel: string, listener: (...args: ReadonlyArray<unknown>) => void) => {
      listeners.set(channel, listener);
    },
    removeListener,
  },
}));

import { UPDATE_STATE_CHANNEL } from "../src/ipc/channels.ts";
import * as DesktopPreload from "../src/preload.ts";

void DesktopPreload;

const validState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "latest",
  currentVersion: "1.0.0",
  availableVersion: "1.1.0",
  downloadedVersion: null,
  releaseNotes: [],
  downloadPercent: null,
  checkedAt: "2026-07-25T12:00:00.000Z",
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop preload update events", () => {
  it("forwards only schema-valid updater state and unregisters the exact listener", () => {
    const bridge = exposed.bridge;
    expect(bridge).toBeDefined();
    const listener = vi.fn<(state: DesktopUpdateState) => void>();
    const unsubscribe = bridge?.onUpdateState(listener);
    const push = listeners.get(UPDATE_STATE_CHANNEL);
    expect(push).toBeDefined();

    push?.({}, { ...validState, releaseNotes: "not-an-array" });
    push?.({}, validState);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(validState);
    unsubscribe?.();
    expect(removeListener).toHaveBeenCalledWith(UPDATE_STATE_CHANNEL, push);
  });
});
