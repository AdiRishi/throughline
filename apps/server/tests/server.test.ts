import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
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
  WS_METHODS,
  WsRpcGroup,
  type ServerLifecycleStreamEvent,
} from "@app/contracts";
import type { TraceRecord } from "@app/shared/observability";

import * as Auth from "../src/auth.ts";
import * as ServerConfig from "../src/config.ts";
import { AUTH_BOOTSTRAP_PATH, HEALTH_PATH, OTLP_TRACES_PROXY_PATH } from "../src/http.ts";
import * as LifecycleEvents from "../src/lifecycleEvents.ts";
import * as BrowserTraceCollector from "../src/observability/BrowserTraceCollector.ts";
import * as Readiness from "../src/readiness.ts";
import { routesLayer } from "../src/server.ts";

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
  /** Collects records the OTLP route pushed, so tests can assert on them. */
  readonly traceRecords?: Array<TraceRecord>;
}

/** The real route stack + services over the platform test server. */
const appLayer = (options: HarnessOptions = {}) =>
  HttpRouter.serve(routesLayer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        // Stands in for ObservabilityLive's collector, which the production
        // graph wires to the same sink the local file tracer writes to.
        Layer.succeed(BrowserTraceCollector.BrowserTraceCollector, {
          record: (records) =>
            Effect.sync(() => {
              options.traceRecords?.push(...records);
            }),
        }),
        Auth.layer,
        options.lifecycleEvents === undefined
          ? LifecycleEvents.layer
          : Layer.mock(LifecycleEvents.ServerLifecycleEvents)(options.lifecycleEvents),
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
              dataDir: NodePath.join(SCRATCH, "data"),
              logDir: NodePath.join(SCRATCH, "data", "logs"),
              serverTracePath: NodePath.join(SCRATCH, "data", "logs", "server.trace.ndjson"),
              logLevel: "Info",
              traceMinLevel: "Info",
              traceTimingEnabled: true,
              traceBatchWindowMs: 200,
              traceMaxBytes: 10 * 1024 * 1024,
              traceMaxFiles: 10,
              otlpTracesUrl: undefined,
              otlpMetricsUrl: undefined,
              otlpExportIntervalMs: 10_000,
              otlpServiceName: "throughline-test",
            }),
          );
        }),
      ),
    ),
    // NodeServices provides Crypto in production; layerTest does not.
    Layer.provideMerge(
      Layer.mergeAll(NodeHttpServer.layerTest, NodeCrypto.layer, NodeServices.layer),
    ),
  );

const decodeBearerSession = Schema.decodeUnknownSync(BearerSessionJson);

const postJson = (path: string, body: string) =>
  HttpClient.post(path, { body: HttpBody.text(body, "application/json") });

const wsRpcProtocolLayer = (wsUrl: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
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

// One resource span carrying one client span, in the wire shape the renderer's
// `OtlpTracer` produces. Hand-authored rather than captured from a live
// exporter so the test asserts the decode contract, not the exporter's timing.
const BROWSER_OTLP_PAYLOAD = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "throughline-web" } }],
      },
      scopeSpans: [
        {
          scope: { name: "@effect/opentelemetry", version: "0.0.0" },
          spans: [
            {
              name: "clientRuntime.rpc.request",
              traceId: "11111111111111111111111111111111",
              spanId: "2222222222222222",
              parentSpanId: "3333333333333333",
              kind: 3,
              startTimeUnixNano: "1000000",
              endTimeUnixNano: "2000000",
              attributes: [{ key: "rpc.method", value: { stringValue: "server.getConfig" } }],
              events: [],
              links: [],
              status: { code: 0 },
            },
          ],
        },
      ],
    },
  ],
};

describe("browser OTLP trace ingest", () => {
  it.effect("decodes renderer spans into the shared trace sink", () =>
    Effect.gen(function* () {
      const traceRecords: Array<TraceRecord> = [];

      const response = yield* postJson(
        OTLP_TRACES_PROXY_PATH,
        JSON.stringify(BROWSER_OTLP_PAYLOAD),
      ).pipe(Effect.provide(appLayer({ traceRecords })));

      assert.equal(response.status, 204);
      assert.equal(traceRecords.length, 1);

      const record = traceRecords[0];
      assert.equal(record?.type, "otlp-span");
      assert.equal(record?.name, "clientRuntime.rpc.request");
      // The traceId is what joins this renderer span to the server span it
      // triggered, once both are in the same file.
      assert.equal(record?.traceId, "11111111111111111111111111111111");
      assert.equal(record?.parentSpanId, "3333333333333333");
      assert.equal(record?.kind, "client");
      assert.equal(record?.durationMs, 1);
      assert.deepEqual(record?.attributes, { "rpc.method": "server.getConfig" });
    }),
  );

  it.effect("answers 400 on a malformed body instead of failing the request", () =>
    Effect.gen(function* () {
      const traceRecords: Array<TraceRecord> = [];

      const response = yield* postJson(OTLP_TRACES_PROXY_PATH, "not json at all").pipe(
        Effect.provide(appLayer({ traceRecords })),
      );

      assert.equal(response.status, 400);
      assert.deepEqual(traceRecords, []);
    }),
  );

  it.effect("swallows an undecodable OTLP payload rather than rejecting it", () =>
    Effect.gen(function* () {
      // Telemetry must never be the thing that breaks the app reporting it.
      const traceRecords: Array<TraceRecord> = [];

      const response = yield* postJson(
        OTLP_TRACES_PROXY_PATH,
        JSON.stringify({ resourceSpans: "not-an-array" }),
      ).pipe(Effect.provide(appLayer({ traceRecords })));

      assert.equal(response.status, 204);
      assert.deepEqual(traceRecords, []);
    }),
  );
});
