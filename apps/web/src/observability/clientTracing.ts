/**
 * Renderer tracing.
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
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import { safeErrorLogAttributes } from "@app/client-runtime/errors";

import { isElectron, resolveConnectionTargetResult } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { settleAsyncResult, squashAtomCommandFailure } from "../state/asyncResult.ts";

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
  OtlpExporter.layerFlusher,
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
  /**
   * Bearer presented to the trace-ingest route, which is gated exactly like the
   * `/ws` upgrade. Sent as a header rather than a query param on purpose: the
   * server records `url.query` as a span attribute, so a credential in the URL
   * would be written into the very trace files this exporter feeds.
   */
  readonly bearerToken?: string;
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
  if (
    config.exportIntervalMs === undefined &&
    config.bearerToken === undefined &&
    activeConfigKey !== null
  ) {
    return pendingConfiguration;
  }
  pendingConfiguration = pendingConfiguration.finally(() => applyClientTracingConfig(config));
  return pendingConfiguration;
}

async function applyClientTracingConfig(config: ClientTracingConfig): Promise<void> {
  // This promise is awaited by `Effect.promise` when the observability layer is
  // built, so a rejection here is a DEFECT that takes the whole client runtime
  // down. Tracing is not load-bearing: a target we cannot parse is reported and
  // skipped, leaving spans local-only (`NativeSpan`), and the next call retries.
  const targetRead = resolveConnectionTargetResult();
  if (targetRead._tag === "Failure") {
    console.warn("Failed to resolve the connection target for client tracing", {
      detail: errorMessage(targetRead.cause),
      ...safeErrorLogAttributes(targetRead.cause),
    });
    return;
  }

  const otlpTracesUrl = `${targetRead.target.httpBaseUrl}${OTLP_TRACES_PATH}`;
  const exportIntervalMs = Math.max(10, config.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  // The token is part of the key so a rotated credential rebuilds the exporter
  // instead of silently exporting with a bearer the server no longer accepts.
  const nextConfigKey = `${otlpTracesUrl}|${exportIntervalMs}|${config.bearerToken ?? ""}`;

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

  const delegateResult = await settleAsyncResult(() =>
    runtime.runPromiseExit(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: otlpTracesUrl,
          exportInterval: `${exportIntervalMs} millis`,
          resource: CLIENT_TRACING_RESOURCE,
          ...(config.bearerToken === undefined
            ? {}
            : { headers: { authorization: `Bearer ${config.bearerToken}` } }),
        }),
      ),
    ),
  );

  if (delegateResult._tag === "Failure") {
    await disposeTracerRuntime(runtime, scope);
    if (generation === configurationGeneration) {
      // The URL is reported in parts because the bearer travels alongside it.
      const error = squashAtomCommandFailure(delegateResult);
      const tracesUrl = new URL(otlpTracesUrl);
      console.warn("Failed to configure client tracing exporter", {
        scheme: tracesUrl.protocol.replace(/:$/, ""),
        host: tracesUrl.hostname,
        port: tracesUrl.port || undefined,
        exportIntervalMs,
        ...safeErrorLogAttributes(error),
      });
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await disposeTracerRuntime(runtime, scope);
    return;
  }

  activeDelegate = delegateResult.value;
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
  await settleAsyncResult(() => runtime.runPromiseExit(Scope.close(scope, Exit.void)));
  runtime.dispose();
}

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
