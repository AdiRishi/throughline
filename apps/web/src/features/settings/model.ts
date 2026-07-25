import type { HarnessSelection, HarnessStatus } from "@app/contracts";

export type HarnessReadiness = "ready" | "sign-in" | "not-installed" | "unknown";

export function harnessReadiness(harness: HarnessStatus): HarnessReadiness {
  if (!harness.installed) {
    return "not-installed";
  }
  if (harness.auth === "authenticated") {
    return "ready";
  }
  if (harness.auth === "unauthenticated") {
    return "sign-in";
  }
  return "unknown";
}

export function isHarnessSelection(kind: string): kind is HarnessSelection {
  return kind === "codex" || kind === "claude";
}

export function automaticHarnessKind(
  harnesses: ReadonlyArray<HarnessStatus>,
): HarnessSelection | null {
  for (const kind of ["codex", "claude"] as const) {
    const status = harnesses.find((harness) => harness.kind === kind);
    if (status !== undefined && harnessReadiness(status) === "ready") {
      return kind;
    }
  }
  return null;
}

export function effectiveHarnessKind(
  harnesses: ReadonlyArray<HarnessStatus>,
  selected: HarnessSelection | undefined,
): HarnessSelection | null {
  if (selected === undefined) {
    return automaticHarnessKind(harnesses);
  }
  const status = harnesses.find((harness) => harness.kind === selected);
  return status !== undefined && harnessReadiness(status) === "ready" ? selected : null;
}
