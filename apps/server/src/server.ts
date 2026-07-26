/**
 * Composition root.
 *
 * Wires the route layers over an HTTP server, provides the platform + services,
 * and drives the lifecycle: publish `starting`, open the readiness gate and
 * publish `ready` once the HTTP server is bound, publish `draining` on shutdown.
 *
 * Only `ServerConfig` is provided by the CLI — nothing else leaks into the
 * launch layer.
 *
 * @module server
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as Ingestion from "./analysis/Ingestion.ts";
import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as GitHub from "./github/GitHub.ts";
import * as AnalysisHarness from "./harness/AnalysisHarness.ts";
import {
  authBootstrapRouteLayer,
  corsLayer,
  healthRouteLayer,
  otlpTracesRouteLayer,
  staticAndDevRouteLayer,
} from "./http.ts";
import * as JourneyReader from "./journeys/JourneyReader.ts";
import * as JourneyStore from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as PrList from "./prs/PrList.ts";
import * as Readiness from "./readiness.ts";
import * as Workspaces from "./workspace/Workspaces.ts";
import { websocketRpcRouteLayer } from "./ws.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// The app's primary transport is long-lived WebSocket RPC, whose Effect scope
// finalizer already closes the websocket gracefully. Do not add an artificial
// drain before those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;

/**
 * All HTTP routes. Order matters only for the `*` catch-all, which HttpRouter
 * dispatches after the exact-path routes. CORS wraps the whole router.
 */
export const routesLayer = Layer.mergeAll(
  healthRouteLayer,
  authBootstrapRouteLayer,
  otlpTracesRouteLayer,
  websocketRpcRouteLayer,
  staticAndDevRouteLayer,
).pipe(Layer.provide(corsLayer));

/**
 * Application services shared across routes and lifecycle.
 *
 * The layering below is the dependency order of the five seams. `Ingestion` sits
 * on top because it is the only module that needs all of the others; `PrList` is
 * beside it because it folds their state into one view. Everything under them —
 * `GitHub`, `Workspaces`, `AnalysisHarness`, `JourneyStore` — is independent, and
 * `provideMerge` keeps each one visible to the RPC handlers as well.
 */
const DomainServicesLive = PrList.layer.pipe(
  // `mergeAll` does NOT let siblings see each other, so `PrList` (which folds
  // ingestion state into its view) has to sit *above* `Ingestion`, not beside it.
  Layer.provideMerge(Layer.mergeAll(Ingestion.layer, JourneyReader.layer)),
  Layer.provideMerge(
    Layer.mergeAll(GitHub.layer, Workspaces.layer, AnalysisHarness.layer, JourneyStore.layer),
  ),
);

const RuntimeServicesLive = Layer.mergeAll(
  Auth.layer,
  LifecycleEvents.layer,
  Readiness.layer,
  DomainServicesLive,
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;

    const httpServerLayer = NodeHttpServer.layer(NodeHttp.createServer, {
      host: config.host,
      port: config.port,
      gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
    });

    // Publish `starting` immediately as the runtime spins up.
    const startingLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;
        const at = yield* DateTime.now;
        yield* lifecycle.publish({ phase: "starting", at });
      }),
    );

    // Once the HTTP server is bound: open the readiness gate and publish
    // `ready`. On shutdown the release runs first (before the HTTP server
    // closes), so `draining` reaches live subscribers ahead of the socket drop.
    const readyLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const readiness = yield* Readiness.ReadinessGate;
          const lifecycle = yield* LifecycleEvents.ServerLifecycleEvents;

          const address = server.address;
          const boundPort =
            typeof address === "string" || !("port" in address) ? config.port : address.port;

          yield* readiness.signalReady;
          const at = yield* DateTime.now;
          yield* lifecycle.publish({ phase: "ready", at });

          yield* Effect.logInfo("app server listening", {
            host: config.host,
            port: boundPort,
          });
          return lifecycle;
        }),
        (lifecycle) =>
          Effect.gen(function* () {
            const at = yield* DateTime.now;
            yield* lifecycle.publish({ phase: "draining", at });
            yield* Effect.logInfo("app server draining");
          }),
      ),
    );

    const applicationLayer = Layer.mergeAll(
      HttpRouter.serve(routesLayer),
      startingLayer,
      readyLayer,
    );

    return applicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(httpServerLayer),
      // Under everything: the logger, the trace-level references, the local
      // file tracer, and the browser trace collector. Installed here (rather
      // than around the CLI) because it is built from `ServerConfig`.
      Layer.provideMerge(ObservabilityLive),
      // The stack's only HttpClient (NodeServices does not bundle one).
      // Nothing consumes it yet; it is pre-wired for handlers that make
      // outbound requests. Global fetch, not the undici-based Node client:
      // the shell spawns this server under Electron's bundled Node (v20.18),
      // where npm undici@8 crashes at load (`webidl.util.markAsUncloneable`).
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

// Important: only `ServerConfig` should be provided by the CLI layer. Keep other
// requirements out of the launch layer.
export const runServer = Layer.launch(makeServerLayer);
