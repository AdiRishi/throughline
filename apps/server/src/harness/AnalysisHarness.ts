/**
 * `AnalysisHarness` — the seam the reviewer's own agent harnesses plug into.
 *
 * Selection is the specification's: the first *authenticated* harness in order
 * (Codex, then Claude) unless the reviewer chose one explicitly in settings. The
 * choice actually used is recorded in the journey's provenance, and changing it
 * affects future analyses only — to apply it to an existing journey, rerun
 * ingestion.
 *
 * Detection is cached briefly. It shells out to two CLIs and opens a zero-token
 * session, which is cheap but not free, and the settings page asks for it on
 * every visit.
 *
 * @module harness/AnalysisHarness
 */
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { HarnessKind, HarnessReport, HarnessStatus } from "@app/contracts";

import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import {
  HarnessUnavailableError,
  type HarnessAdapter,
  type HarnessSession,
  type HarnessSessionOptions,
} from "./model.ts";

/** Order is the auto-selection order. */
const ADAPTERS: ReadonlyArray<HarnessAdapter> = [codexAdapter, claudeAdapter];

const DETECT_TTL = Duration.seconds(30);

export class AnalysisHarness extends Context.Service<
  AnalysisHarness,
  {
    /** Every detected harness with its install/auth state, plus the active one. */
    readonly report: (selected: HarnessKind | null) => Effect.Effect<HarnessReport>;
    /** Force the next `report` to re-probe (after the reviewer installs something). */
    readonly invalidate: Effect.Effect<void>;
    /**
     * Open a session on the active harness. Scoped: closing the scope kills the
     * subprocess, which is how ingestion cancellation reaches the agent.
     */
    readonly open: (
      input: HarnessSessionOptions & { readonly selected: HarnessKind | null },
    ) => Effect.Effect<HarnessSession, HarnessUnavailableError, Scope.Scope>;
  }
>()("@app/server/harness/AnalysisHarness") {}

const make = Effect.gen(function* () {
  // Captured once and provided into every probe, so the service this module
  // hands out is requirement-free (the same shape as `GitHub`).
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const probeCache = yield* Cache.makeWith<HarnessKind, HarnessStatus, never>(
    (kind) => {
      const adapter = ADAPTERS.find((candidate) => candidate.kind === kind);
      if (adapter === undefined) {
        // An unknown kind degrades to "unavailable" rather than failing — the
        // set of harnesses is open, and a stale setting must not break the app.
        return Effect.succeed<HarnessStatus>({
          kind,
          label: kind,
          installed: false,
          version: null,
          auth: "missing",
          detail: `Throughline does not know how to run "${kind}".`,
        });
      }
      return Effect.provideService(
        adapter.probe,
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      ).pipe(
        Effect.map(
          (result): HarnessStatus => ({
            kind: adapter.kind,
            label: adapter.label,
            installed: result.installed,
            version: result.version,
            auth: result.auth,
            detail: result.detail,
          }),
        ),
      );
    },
    {
      capacity: 8,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? DETECT_TTL : Duration.zero),
    },
  );

  const statuses = Effect.forEach(ADAPTERS, (adapter) => Cache.get(probeCache, adapter.kind), {
    concurrency: ADAPTERS.length,
  });

  /**
   * The active harness: the reviewer's explicit choice when it is usable,
   * otherwise the first authenticated one. A chosen-but-broken harness does not
   * silently fall back — the settings page shows why, and ingestion parks at the
   * door rather than quietly analysing with something else.
   */
  const resolveActive = (
    all: ReadonlyArray<HarnessStatus>,
    selected: HarnessKind | null,
  ): HarnessKind | null => {
    if (selected !== null) {
      const chosen = all.find((status) => status.kind === selected);
      return chosen !== undefined && chosen.auth === "authenticated" ? chosen.kind : null;
    }
    return all.find((status) => status.auth === "authenticated")?.kind ?? null;
  };

  return {
    report: (selected) =>
      Effect.gen(function* () {
        const harnesses: ReadonlyArray<HarnessStatus> = yield* statuses;
        const probedAt = yield* DateTime.now;
        const report: HarnessReport = {
          harnesses,
          selected,
          active: resolveActive(harnesses, selected),
          probedAt,
        };
        return report;
      }),

    invalidate: Cache.invalidateAll(probeCache),

    open: (input) =>
      Effect.gen(function* () {
        const harnesses = yield* statuses;
        const active = resolveActive(harnesses, input.selected);
        if (active === null) {
          return yield* new HarnessUnavailableError({
            kind: input.selected,
            detail: describeNoHarness(harnesses, input.selected),
          });
        }
        const adapter = ADAPTERS.find((candidate) => candidate.kind === active);
        if (adapter === undefined) {
          return yield* new HarnessUnavailableError({
            kind: active,
            detail: `Throughline does not know how to run "${active}".`,
          });
        }
        return yield* adapter.open(input);
      }),
  } satisfies AnalysisHarness["Service"];
});

export const layer = Layer.effect(AnalysisHarness, make);

/** The verbatim instruction the door shows when nothing can analyse. */
export function describeNoHarness(
  harnesses: ReadonlyArray<HarnessStatus>,
  selected: HarnessKind | null,
): string {
  if (selected !== null) {
    const chosen = harnesses.find((status) => status.kind === selected);
    return (
      chosen?.detail ??
      `${selected} is selected in settings but is not available. Choose another harness or sign in.`
    );
  }
  const installed = harnesses.filter((status) => status.installed);
  if (installed.length === 0) {
    return "Throughline analyses with your own agent harness, and none is installed. Install Codex (`npm i -g @openai/codex`) or Claude Code (`npm i -g @anthropic-ai/claude-code`), sign in, then try again.";
  }
  const details = installed
    .map((status) => status.detail)
    .filter((detail): detail is string => detail !== null);
  return details.length === 0
    ? "No agent harness is signed in. Sign in to Codex or Claude Code, then try again."
    : details.join(" ");
}
