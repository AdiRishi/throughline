import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpBody, HttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  BearerSessionJson,
  CompleteWsRpcGroup,
  IngestionJob,
  PRODUCT_WS_METHODS,
  PrRef,
  WS_METHODS,
  type ServerLifecycleStreamEvent,
} from "@app/contracts";

import * as Ingestion from "../src/analysis/Ingestion.ts";
import * as Auth from "../src/auth.ts";
import * as ServerConfig from "../src/config.ts";
import { AUTH_BOOTSTRAP_PATH, HEALTH_PATH } from "../src/http.ts";
import * as LifecycleEvents from "../src/lifecycleEvents.ts";
import * as Readiness from "../src/readiness.ts";
import {
  productServicesLayer,
  routesLayer,
  WORKSPACE_CACHE_MAX_REPOSITORIES,
  workspaceCacheEvictionLayer,
} from "../src/server.ts";
import * as Workspaces from "../src/workspace/Workspaces.ts";

const BOOTSTRAP_TOKEN = "boot-secret";

// Static fixtures live in a module-scope temp dir so the config layer can
// reference them before any Effect runs. `secret.txt` sits OUTSIDE the static
// root: no request may ever surface its contents.
const SCRATCH = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "app-server-test-"));
const STATIC_ROOT = NodePath.join(SCRATCH, "root");
NodeFS.mkdirSync(NodePath.join(STATIC_ROOT, "assets"), { recursive: true });
NodeFS.writeFileSync(NodePath.join(STATIC_ROOT, "index.html"), "<html>INDEX_SENTINEL</html>");
NodeFS.writeFileSync(NodePath.join(STATIC_ROOT, "assets", "app.js"), "APP_JS_SENTINEL");
NodeFS.writeFileSync(NodePath.join(SCRATCH, "secret.txt"), "TOP_SECRET");

interface HarnessOptions {
  readonly staticDir?: string;
  readonly devWebUrl?: URL;
  readonly lifecycleEvents?: Partial<LifecycleEvents.ServerLifecycleEvents["Service"]>;
}

/** The real route stack + services over the platform test server. */
const appLayer = (options: HarnessOptions = {}) => {
  const dataDir = NodeFS.mkdtempSync(NodePath.join(SCRATCH, "data-"));

  return HttpRouter.serve(routesLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Auth.layer,
        options.lifecycleEvents === undefined
          ? LifecycleEvents.layer
          : Layer.mock(LifecycleEvents.ServerLifecycleEvents)(options.lifecycleEvents),
        productServicesLayer,
        Readiness.layer,
      ),
    ),
    Layer.provideMerge(
      Layer.unwrap(
        Effect.gen(function* () {
          const startedAt = yield* DateTime.now;
          return ServerConfig.layer(
            ServerConfig.make({
              appName: "Test App",
              version: "0.0.0-test",
              startedAt,
              host: "127.0.0.1",
              port: 0,
              staticDir: options.staticDir,
              devWebUrl: options.devWebUrl,
              bootstrapToken: BOOTSTRAP_TOKEN,
              dataDir,
            }),
          );
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer)),
  );
};

const decodeBearerSession = Schema.decodeUnknownSync(BearerSessionJson);
const decodeIngestionJob = Schema.decodeUnknownSync(Schema.toCodecJson(IngestionJob));
const decodePrRef = Schema.decodeUnknownSync(PrRef);

const postJson = (path: string, body: string) =>
  HttpClient.post(path, { body: HttpBody.text(body, "application/json") });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(CompleteWsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, unknown, unknown> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl)));

/**
 * Issue a request with the path passed through verbatim — no WHATWG URL
 * normalization. Traversal probes like `/../secret.txt` must reach the server
 * as written, which `fetch` would silently rewrite.
 */
const rawGet = (rawPath: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address;
    const port = typeof address === "string" || !("port" in address) ? 0 : address.port;

    return yield* Effect.callback<{
      readonly status: number;
      readonly location: string | undefined;
      readonly body: string;
    }>((resume) => {
      const request = NodeHttp.request(
        { host: "127.0.0.1", port, path: rawPath, method: "GET" },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                location: response.headers.location,
                body,
              }),
            );
          });
        },
      );
      request.once("error", (cause) => {
        resume(Effect.die(cause));
      });
      request.end();
      return Effect.sync(() => {
        request.destroy();
      });
    });
  });

describe("health gate", () => {
  it.effect("reports 503 until the readiness gate opens, then 200", () =>
    Effect.gen(function* () {
      const before = yield* HttpClient.get(HEALTH_PATH);
      assert.equal(before.status, 503);

      const gate = yield* Readiness.ReadinessGate;
      yield* gate.signalReady;

      const after = yield* HttpClient.get(HEALTH_PATH);
      assert.equal(after.status, 200);
      assert.equal(yield* after.text, "ok");
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("bearer bootstrap exchange", () => {
  it.effect("exchanges the bootstrap token for a bearer session in the JSON wire shape", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
      );
      assert.equal(response.status, 200);

      const body: unknown = yield* response.json;
      // Exact wire shape: the codec decodes it, and nothing extra rides along.
      const session = decodeBearerSession(body);
      assert.match(session.access_token, /^[0-9a-f]{64}$/);
      assert.isNull(session.expires_at);
      assert.deepEqual(Object.keys(body as object).toSorted(), ["access_token", "expires_at"]);

      // The minted bearer is immediately valid for the WS gate.
      const auth = yield* Auth.BearerSessionStore;
      assert.isTrue(yield* auth.authenticateBearer(session.access_token));
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects a wrong credential with 401", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: "wrong" }),
      );
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("rejects malformed bodies with 400", () =>
    Effect.gen(function* () {
      const empty = yield* postJson(AUTH_BOOTSTRAP_PATH, JSON.stringify({ credential: "  " }));
      assert.equal(empty.status, 400);

      const notJson = yield* postJson(AUTH_BOOTSTRAP_PATH, "not json");
      assert.equal(notJson.status, 400);
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("websocket gate", () => {
  it.effect("rejects /ws without a bearer token", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/ws");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(appLayer())),
  );

  it.effect("buffers lifecycle events published while the initial snapshot loads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<ServerLifecycleStreamEvent>();
      const snapshotEvent: ServerLifecycleStreamEvent = {
        version: 1,
        sequence: 1,
        phase: "starting",
        at: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
      };
      const liveEvent: ServerLifecycleStreamEvent = {
        version: 1,
        sequence: 2,
        phase: "ready",
        at: DateTime.makeUnsafe("2026-01-01T00:00:01.000Z"),
      };
      const lifecycleEvents = {
        snapshot: Effect.gen(function* () {
          yield* Effect.sleep("25 millis");
          yield* PubSub.publish(liveEvents, liveEvent);
          return { sequence: snapshotEvent.sequence, events: [snapshotEvent] };
        }),
        stream: Stream.fromPubSub(liveEvents),
      };

      yield* Effect.gen(function* () {
        const response = yield* postJson(
          AUTH_BOOTSTRAP_PATH,
          JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
        );
        const session = decodeBearerSession(yield* response.json);
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        const port = typeof address === "string" || !("port" in address) ? 0 : address.port;
        const wsUrl = `ws://127.0.0.1:${port}/ws?access_token=${encodeURIComponent(session.access_token)}`;

        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.serverSubscribeLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        ).pipe(Effect.timeout("2 seconds"));

        assert.deepStrictEqual(
          events.map((event) => event.sequence),
          [1, 2],
        );
      }).pipe(Effect.provide(appLayer({ lifecycleEvents })));
    }).pipe(TestClock.withLive),
  );

  it.effect("serves product state handlers through the complete RPC group", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        AUTH_BOOTSTRAP_PATH,
        JSON.stringify({ credential: BOOTSTRAP_TOKEN }),
      );
      const session = decodeBearerSession(yield* response.json);
      const server = yield* HttpServer.HttpServer;
      const address = server.address;
      const port = typeof address === "string" || !("port" in address) ? 0 : address.port;
      const wsUrl = `ws://127.0.0.1:${port}/ws?access_token=${encodeURIComponent(session.access_token)}`;
      const pr = decodePrRef({ owner: "effect-ts", repo: "throughline", number: 42 });

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const config = yield* client[WS_METHODS.serverGetConfig]({});
            const initial = yield* client[PRODUCT_WS_METHODS.settingsGet]({});
            const updated = yield* client[PRODUCT_WS_METHODS.prStateReviewed]({
              pr,
              active: true,
            });
            const persisted = yield* client[PRODUCT_WS_METHODS.prStateGet]({});
            return { config, initial, updated, persisted };
          }),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.strictEqual(result.config.appName, "Test App");
      assert.strictEqual(result.config.version, "0.0.0-test");
      assert.isTrue(DateTime.isUtc(result.config.startedAt));
      assert.deepStrictEqual(result.initial, {});
      assert.deepStrictEqual(result.updated.reviewed, [pr]);
      assert.deepStrictEqual(result.persisted, result.updated);
    }).pipe(Effect.provide(appLayer())),
  );
});

describe("static serving", () => {
  it.effect("serves index.html at the root and real assets by path", () =>
    Effect.gen(function* () {
      const index = yield* HttpClient.get("/");
      assert.equal(index.status, 200);
      assert.include(yield* index.text, "INDEX_SENTINEL");

      const asset = yield* HttpClient.get("/assets/app.js");
      assert.equal(asset.status, 200);
      assert.include(yield* asset.text, "APP_JS_SENTINEL");
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );

  it.effect("falls back to index.html for unknown SPA routes", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/settings/updates");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "INDEX_SENTINEL");
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );

  it.effect("never serves files outside the static root", () =>
    Effect.gen(function* () {
      // Raw paths bypass fetch's URL normalization, so `..` reaches the server.
      const probes = [
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/..%2fsecret.txt",
        "/assets/../../secret.txt",
        "/..%5csecret.txt",
        "/assets/%00/../../secret.txt",
      ];
      for (const probe of probes) {
        const response = yield* rawGet(probe);
        assert.notInclude(response.body, "TOP_SECRET", `path ${probe} must not leak`);
      }
    }).pipe(Effect.provide(appLayer({ staticDir: STATIC_ROOT }))),
  );
});

describe("dev redirect", () => {
  it.effect("302-redirects loopback navigations to the dev server, preserving the path", () =>
    Effect.gen(function* () {
      const response = yield* rawGet("/settings?tab=updates");
      assert.equal(response.status, 302);
      assert.equal(response.location, "http://127.0.0.1:5173/settings?tab=updates");
    }).pipe(Effect.provide(appLayer({ devWebUrl: new URL("http://127.0.0.1:5173") }))),
  );

  it.effect("does not redirect reserved API paths", () =>
    Effect.gen(function* () {
      const response = yield* rawGet(HEALTH_PATH);
      assert.equal(response.status, 503);
    }).pipe(Effect.provide(appLayer({ devWebUrl: new URL("http://127.0.0.1:5173") }))),
  );
});

describe("workspace cache maintenance", () => {
  it.effect("continues capping the clone cache when one completion eviction fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const consumed = yield* Deferred.make<void>();
        const pr = decodePrRef({ owner: "octo", repo: "widgets", number: 42 });
        const resolving = decodeIngestionJob({
          id: "job-41",
          pr,
          phase: "resolving",
          queuePosition: null,
          startedAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:00:10.000Z",
          activity: null,
          journeyId: null,
          failure: null,
        });
        const completed = decodeIngestionJob({
          id: "job-42",
          pr,
          phase: "complete",
          queuePosition: null,
          startedAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:01:00.000Z",
          activity: null,
          journeyId: "job-42",
          failure: null,
        });
        const nextCompleted = decodeIngestionJob({
          id: "job-43",
          pr: decodePrRef({ owner: "octo", repo: "gadgets", number: 7 }),
          phase: "complete",
          queuePosition: null,
          startedAt: "2026-07-25T00:02:00.000Z",
          updatedAt: "2026-07-25T00:03:00.000Z",
          activity: null,
          journeyId: "job-43",
          failure: null,
        });
        const maximums: number[] = [];

        yield* Layer.build(
          workspaceCacheEvictionLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(Ingestion.Ingestion)({
                  changes: Stream.make(resolving, completed, nextCompleted).pipe(
                    Stream.ensuring(Deferred.succeed(consumed, undefined)),
                  ),
                }),
                Layer.mock(Workspaces.Workspaces)({
                  evictCache: (maximum) =>
                    Effect.gen(function* () {
                      maximums.push(maximum);
                      if (maximums.length === 2) {
                        return yield* new Workspaces.WorkspaceError({
                          reason: "io",
                          detail: "temporary filesystem failure",
                        });
                      }
                      return [];
                    }),
                }),
              ),
            ),
          ),
        );

        yield* Deferred.await(consumed);
        assert.deepStrictEqual(maximums, [
          WORKSPACE_CACHE_MAX_REPOSITORIES,
          WORKSPACE_CACHE_MAX_REPOSITORIES,
          WORKSPACE_CACHE_MAX_REPOSITORIES,
        ]);
      }),
    ),
  );
});
