import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { HarnessStatus } from "@app/contracts";

import {
  type AnalysisHarness,
  HarnessSelectionError,
  makeRegistry,
} from "../../src/harness/AnalysisHarness.ts";

const adapter = (kind: string, status: Omit<HarnessStatus, "kind">): AnalysisHarness => ({
  kind,
  detect: Effect.succeed({ kind, ...status }),
  run: () => Effect.die("not used"),
});

describe("AnalysisHarnessRegistry", () => {
  it.effect("selects the first authenticated adapter in registry order", () =>
    Effect.gen(function* () {
      const codex = adapter("codex", {
        installed: true,
        version: "1.0.0",
        auth: "unauthenticated",
      });
      const claude = adapter("claude", {
        installed: true,
        version: "2.0.0",
        auth: "authenticated",
      });
      const registry = makeRegistry([codex, claude]);

      const selected = yield* registry.select();

      assert.strictEqual(selected.kind, "claude");
    }),
  );

  it.effect("honors an explicit selection without falling back", () =>
    Effect.gen(function* () {
      const codex = adapter("codex", {
        installed: true,
        version: "1.0.0",
        auth: "unauthenticated",
      });
      const claude = adapter("claude", {
        installed: true,
        version: "2.0.0",
        auth: "authenticated",
      });
      const registry = makeRegistry([codex, claude]);

      const error = yield* registry.select("codex").pipe(Effect.flip);

      assert.instanceOf(error, HarnessSelectionError);
      assert.strictEqual(error.kind, "codex");
      assert.match(error.detail, /not authenticated/u);
    }),
  );

  it.effect("reports unknown adapter kinds as unavailable", () =>
    Effect.gen(function* () {
      const registry = makeRegistry([]);

      assert.deepStrictEqual(yield* registry.status("future-harness"), {
        kind: "future-harness",
        installed: false,
        version: null,
        auth: "unknown",
      });

      const error = yield* registry.select("future-harness").pipe(Effect.flip);
      assert.strictEqual(error.kind, "future-harness");
      assert.match(error.detail, /unavailable/u);
    }),
  );
});
