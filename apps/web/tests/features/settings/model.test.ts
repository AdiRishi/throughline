import { describe, expect, it } from "vitest";

import {
  automaticHarnessKind,
  effectiveHarnessKind,
  harnessReadiness,
} from "../../../src/features/settings/model.ts";

describe("harness settings model", () => {
  it("distinguishes installation from authentication", () => {
    expect(
      harnessReadiness({
        kind: "codex",
        installed: false,
        version: null,
        auth: "unknown",
      }),
    ).toBe("not-installed");
    expect(
      harnessReadiness({
        kind: "codex",
        installed: true,
        version: "1.2.3",
        auth: "unauthenticated",
      }),
    ).toBe("sign-in");
  });

  it("automatic mode chooses the first authenticated harness in documented order", () => {
    expect(
      automaticHarnessKind([
        { kind: "claude", installed: true, version: "2", auth: "authenticated" },
        { kind: "codex", installed: true, version: "1", auth: "authenticated" },
      ]),
    ).toBe("codex");
    expect(
      automaticHarnessKind([
        { kind: "codex", installed: true, version: "1", auth: "unauthenticated" },
        { kind: "claude", installed: true, version: "2", auth: "authenticated" },
      ]),
    ).toBe("claude");
  });

  it("requires the explicitly selected harness itself to be ready", () => {
    const harnesses = [
      { kind: "codex", installed: true, version: "1", auth: "unauthenticated" },
      { kind: "claude", installed: true, version: "2", auth: "authenticated" },
    ] as const;

    expect(effectiveHarnessKind(harnesses, undefined)).toBe("claude");
    expect(effectiveHarnessKind(harnesses, "codex")).toBeNull();
    expect(effectiveHarnessKind(harnesses, "claude")).toBe("claude");
  });
});
