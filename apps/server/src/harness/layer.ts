/**
 * Wiring for the harness seam: the v1 adapter set, behind one layer.
 *
 * ACP is the planned third adapter and lands here without the pipeline
 * noticing — that is the whole point of the seam being this small.
 *
 * @module harness/layer
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeRunner } from "../process/Subprocess.ts";
import { AnalysisHarness, makeWith } from "./AnalysisHarness.ts";
import { makeClaudeAdapter } from "./claude.ts";
import { makeCodexAdapter } from "./codex.ts";

export const layer: Layer.Layer<AnalysisHarness, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    AnalysisHarness,
    Effect.gen(function* () {
      const runner = yield* makeRunner;
      return yield* makeWith([makeCodexAdapter(runner), makeClaudeAdapter(runner)]);
    }),
  );
