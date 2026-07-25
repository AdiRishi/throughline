/**
 * Renderer tracing.
 *
 * The renderer is the one surface with no terminal and no filesystem, so it
 * reaches the log/trace artifacts the same way everything else does: as spans.
 * An `OtlpTracer` exports to the server's `/api/observability/v1/traces`, where
 * `BrowserTraceCollector` pushes the decoded records into the very sink the
 * server's own tracer writes to. Renderer and server spans then sit in one file
 * and correlate by `traceId`.
 *
 * Because `Logger.tracerLogger` is installed in the renderer runtime too, an
 * `Effect.log*` inside a span rides along as a span event — which is how a
 * renderer log ends up somewhere other than DevTools.
 *
 * The `Tracer.Tracer` provided here is a stable indirection over a delegate
 * that is configured asynchronously: the export URL depends on the resolved
 * connection target, which is not known at module load. Until the delegate
 * exists, spans fall back to `NativeSpan` — they still nest correctly, they
 * just are not exported.
 *
 * @module observability/clientTracing
 */
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { isElectron, resolveConnectionTarget } from "../env.ts";

export const OTLP_TRACES_PATH = "/api/observability/v1/traces";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;

const CLIENT_TRACING_RESOURCE = {
  serviceName: "throughline-web",
  attributes: {
    "service.runtime": "throughline-web",
    "service.mode": isElectron ? "electron" : "browser",
  },
} as const;

// `TracerDisabledWhen` stops the exporter's own HTTP calls from creating spans,
// which would otherwise feed themselves forever.
const delegateRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

export interface ClientTracingConfig {
  readonly exportIntervalMs?: number;
}

export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

/**
 * Point the exporter at the current server. Safe to call repeatedly: calls are
 * serialized on `pendingConfiguration`, and a repeat with the same resolved URL
 * is a no-op rather than a teardown/rebuild.
 */
export function configureClientTracing(config: ClientTracingConfig = {}): Promise<void> {
  if (config.exportIntervalMs === undefined && activeConfigKey !== null) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  const otlpTracesUrl = `${resolveConnectionTarget().httpBaseUrl}${OTLP_TRACES_PATH}`;
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && activeDelegate !== null) {
    return;
  }

  activeConfigKey = nextConfigKey;
  // Guards against an in-flight build being installed after a newer call has
  // already superseded it.
  const generation = ++configurationGeneration;

  const previousRuntime = activeRuntime;
  const previousScope = activeScope;

  activeDelegate = null;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(previousRuntime, previousScope);

  const runtime = ManagedRuntime.make(delegateRuntimeLayer);
  const scope = runtime.runSync(Scope.make());

  const delegateExit = await runtime.runPromiseExit(
    Scope.provide(scope)(
      OtlpTracer.make({
        url: otlpTracesUrl,
        exportInterval: `${exportIntervalMs} millis`,
        resource: CLIENT_TRACING_RESOURCE,
      }),
    ),
  );

  if (Exit.isFailure(delegateExit)) {
    await disposeTracerRuntime(runtime, scope);
    if (generation === configurationGeneration) {
      // Tracing is not load-bearing: report and carry on with NativeSpan.
      console.warn("Failed to configure client tracing exporter", { otlpTracesUrl });
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await disposeTracerRuntime(runtime, scope);
    return;
  }

  activeDelegate = delegateExit.value;
  activeRuntime = runtime;
  activeScope = scope;
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }
  await runtime.runPromiseExit(Scope.close(scope, Exit.void));
  runtime.dispose();
}

/** Test seam: drop the active delegate and its runtime. */
export async function __resetClientTracingForTests(): Promise<void> {
  configurationGeneration++;
  activeConfigKey = null;
  activeDelegate = null;
  pendingConfiguration = Promise.resolve();

  const runtime = activeRuntime;
  const scope = activeScope;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(runtime, scope);
}
