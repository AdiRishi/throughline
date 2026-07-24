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
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";

import * as Ingestion from "./analysis/Ingestion.ts";
import * as Auth from "./auth.ts";
import * as ServerConfig from "./config.ts";
import * as GhCli from "./github/GhCli.ts";
import * as GitHub from "./github/GitHub.ts";
import * as HarnessProcess from "./harness/HarnessProcess.ts";
import * as LiveHarnesses from "./harness/LiveHarnesses.ts";
import {
  authBootstrapRouteLayer,
  corsLayer,
  healthRouteLayer,
  staticAndDevRouteLayer,
} from "./http.ts";
import * as JourneyQuery from "./journeys/JourneyQuery.ts";
import * as JourneyState from "./journeys/JourneyState.ts";
import * as JourneyStore from "./journeys/JourneyStore.ts";
import * as LifecycleEvents from "./lifecycleEvents.ts";
import * as PullRequestIndex from "./pullRequests/PullRequestIndex.ts";
import * as Readiness from "./readiness.ts";
import * as GitProcess from "./workspace/GitProcess.ts";
import * as WorkspaceCloneAccess from "./workspace/WorkspaceCloneAccess.ts";
import * as Workspaces from "./workspace/Workspaces.ts";
import { websocketRpcRouteLayer } from "./ws.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// The app's primary transport is long-lived WebSocket RPC, whose Effect scope
// finalizer already closes the websocket gracefully. Do not add an artificial
// drain before those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
export const WORKSPACE_CACHE_MAX_REPOSITORIES = 20;

/**
 * All HTTP routes. Order matters only for the `*` catch-all, which HttpRouter
 * dispatches after the exact-path routes. CORS wraps the whole router.
 */
export const routesLayer = Layer.mergeAll(
  healthRouteLayer,
  authBootstrapRouteLayer,
  websocketRpcRouteLayer,
  staticAndDevRouteLayer,
).pipe(Layer.provide(corsLayer));

const GitHubLive = GitHub.layer.pipe(Layer.provide(GhCli.layer));
const WorkspaceCloneAccessLive = WorkspaceCloneAccess.liveLayer.pipe(Layer.provide(GitHubLive));
const HarnessesLive = LiveHarnesses.layer.pipe(Layer.provide(HarnessProcess.layer));
const ProductInfrastructureLive = Layer.mergeAll(
  JourneyStore.layer,
  GitHubLive,
  GitProcess.layer,
  WorkspaceCloneAccessLive,
  HarnessesLive,
);
const WorkspacesLive = Workspaces.layer.pipe(Layer.provide(ProductInfrastructureLive));
const ProductFoundationsLive = Layer.mergeAll(ProductInfrastructureLive, WorkspacesLive);
const ProductFeaturesLive = Layer.mergeAll(
  JourneyQuery.layer.pipe(Layer.provide(ProductFoundationsLive)),
  JourneyState.layer.pipe(Layer.provide(ProductFoundationsLive)),
  PullRequestIndex.layer.pipe(Layer.provide(ProductFoundationsLive)),
  Ingestion.layer.pipe(Layer.provide(ProductFoundationsLive)),
);

export const productServicesLayer = Layer.mergeAll(ProductFoundationsLive, ProductFeaturesLive);

export const pullRequestIndexSyncLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ingestion = yield* Ingestion.Ingestion;
    const pullRequests = yield* PullRequestIndex.PullRequestIndex;
    yield* ingestion.changes.pipe(
      Stream.filter((job) => job.phase === "complete"),
      Stream.runForEach(() =>
        pullRequests.recompute().pipe(
          Effect.ignore({
            log: "Error",
            message: "Failed to recompute the pull request index after ingestion.",
          }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

export const workspaceCacheEvictionLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspaces = yield* Workspaces.Workspaces;
    yield* workspaces.evictCache(WORKSPACE_CACHE_MAX_REPOSITORIES).pipe(
      Effect.tap((evicted) =>
        evicted.length === 0
          ? Effect.void
          : Effect.logInfo("evicted cached repository clones", {
              repositories: evicted,
            }),
      ),
      Effect.ignore({
        log: "Warn",
        message: "Failed to evict cached repository clones at startup.",
      }),
    );
  }),
);

/** Application services shared across routes and lifecycle. */
const RuntimeServicesLive = Layer.mergeAll(
  Auth.layer,
  LifecycleEvents.layer,
  productServicesLayer,
  pullRequestIndexSyncLayer.pipe(Layer.provide(productServicesLayer)),
  workspaceCacheEvictionLayer.pipe(Layer.provide(productServicesLayer)),
  Readiness.layer,
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
      // The stack's only HttpClient (NodeServices does not bundle one).
      // Nothing consumes it yet; it is pre-wired for handlers that make
      // outbound requests. Global fetch, not the undici-based Node client:
      // the shell spawns this server under Electron's bundled Node, where
      // bundling npm undici has crashed at load (`webidl.util.markAsUncloneable`).
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
    );
  }),
);

// Important: only `ServerConfig` should be provided by the CLI layer. Keep other
// requirements out of the launch layer.
export const runServer = Layer.launch(makeServerLayer);
