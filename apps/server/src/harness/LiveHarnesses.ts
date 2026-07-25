import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { AnalysisHarnessRegistry, HarnessAdapters, registryLayer } from "./AnalysisHarness.ts";
import { makeClaudeHarness } from "./ClaudeHarness.ts";
import { makeCodexHarness } from "./CodexHarness.ts";
import { HarnessProcess } from "./HarnessProcess.ts";

export const adaptersLayer = Layer.effect(
  HarnessAdapters,
  Effect.map(HarnessProcess, (process) =>
    HarnessAdapters.of([makeCodexHarness({ process }), makeClaudeHarness({ process })]),
  ),
);

export const layer = registryLayer.pipe(Layer.provide(adaptersLayer));

export { AnalysisHarnessRegistry };
