/**
 * Receives spans the renderer exported over OTLP and pushes them into the
 * server's own trace sink, so browser and server spans land in one file and
 * correlate by `traceId`.
 *
 * @module observability/BrowserTraceCollector
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TraceRecord, TraceSink } from "@app/shared/observability";

export class BrowserTraceCollector extends Context.Service<
  BrowserTraceCollector,
  {
    readonly record: (records: ReadonlyArray<TraceRecord>) => Effect.Effect<void>;
  }
>()("@app/server/observability/BrowserTraceCollector") {}

export const make = (sink: TraceSink): BrowserTraceCollector["Service"] =>
  BrowserTraceCollector.of({
    record: (records) =>
      Effect.sync(() => {
        for (const record of records) {
          sink.push(record);
        }
      }),
  });

export const layer = (sink: TraceSink) => Layer.succeed(BrowserTraceCollector, make(sink));
