import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../../src/config.ts";
import { GhRunner, classify, type GhError } from "../../src/github/GhRunner.ts";
import { GitHub, internals, layerRequiringRunner } from "../../src/github/GitHub.ts";

/**
 * Adversarial tests for the rate discipline.
 *
 * These are the tests the technical specification names: *"simulated 403-with-reset
 * must produce exactly zero further requests until reset; a stampede of
 * `openPrs()` calls must produce exactly one."* Both assert on a **request
 * count**, which is why `GhRunner` is a service rather than a function — the
 * promises this module makes are only checkable if the thing that issues a
 * request can be counted.
 *
 * Every test uses a scripted runner and asserts on `calls`, never on wall-clock
 * behaviour, so a regression shows up as "it sent a request" rather than as a
 * flake.
 */

interface Scripted {
  readonly layer: Layer.Layer<GhRunner>;
  /** Read inside the test's own runtime — never through a manual runner. */
  readonly calls: Effect.Effect<ReadonlyArray<ReadonlyArray<string>>>;
}

/** A `GhRunner` that answers from a script and records every call it received. */
const scripted = (
  respond: (args: ReadonlyArray<string>, callIndex: number) => Effect.Effect<string, GhError>,
): Effect.Effect<Scripted> =>
  Effect.gen(function* () {
    const log = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    let index = 0;
    const layer = Layer.succeed(GhRunner, {
      run: (args) =>
        Effect.gen(function* () {
          const callIndex = index;
          index += 1;
          yield* Ref.update(log, (current) => [...current, args]);
          return yield* respond(args, callIndex);
        }),
    });
    return { layer, calls: Ref.get(log) };
  });

const configLayer = Layer.unwrap(
  Effect.gen(function* () {
    const startedAt = yield* DateTime.now;
    return ServerConfig.layer(
      ServerConfig.make({
        appName: "Throughline",
        version: "0.0.0-test",
        startedAt,
        host: "127.0.0.1",
        port: 0,
        staticDir: undefined,
        devWebUrl: undefined,
        bootstrapToken: "test",
        dataDir: "/tmp/throughline-github-test",
        logDir: "/tmp/throughline-github-test/logs",
        serverTracePath: "/tmp/throughline-github-test/logs/trace.ndjson",
        logLevel: "Error",
        traceMinLevel: "Error",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpExportIntervalMs: 10_000,
        otlpServiceName: "test",
      }),
    );
  }),
);

/** One PR list response, minimal but schema-valid. */
const PRS_RESPONSE = JSON.stringify({
  data: {
    viewer: {
      login: "mara",
      repositories: {
        nodes: [
          {
            name: "console",
            owner: { login: "meridian" },
            open: {
              nodes: [
                {
                  number: 418,
                  title: "Add authentication",
                  url: "https://github.com/meridian/console/pull/418",
                  state: "OPEN",
                  isDraft: false,
                  createdAt: "2026-07-23T00:00:00Z",
                  updatedAt: "2026-07-25T00:00:00Z",
                  mergedAt: null,
                  body: "",
                  baseRefName: "main",
                  headRefOid: "f47c19d",
                  changedFiles: 87,
                  additions: 9914,
                  deletions: 2507,
                  author: { login: "mara" },
                },
              ],
            },
            merged: { nodes: [] },
          },
        ],
      },
    },
  },
});

const runWith = <A>(runner: Scripted, program: Effect.Effect<A, never, GitHub>): Effect.Effect<A> =>
  program.pipe(
    Effect.provide(layerRequiringRunner.pipe(Layer.provide(runner.layer))),
    Effect.provide(configLayer),
  );

describe("the concurrency gate and single-flighting", () => {
  it.effect("a stampede of PR-list calls produces exactly one request", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() => Effect.succeed(PRS_RESPONSE));

      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          // Twenty callers, one key: `Cache` gives them all the same Deferred.
          const results = yield* Effect.forEach(
            Array.from({ length: 20 }, (_unused, index) => index),
            () => github.prs.pipe(Effect.orDie),
            { concurrency: "unbounded" },
          );
          assert.equal(results.length, 20);
          assert.equal(results[0]?.open.length, 1);
        }),
      );

      const graphqlCalls = (yield* runner.calls).filter(
        (args) => args[0] === "api" && args[1] === "graphql",
      );
      assert.equal(graphqlCalls.length, 1, "twenty callers must produce one request");
    }),
  );

  it.effect("a second read inside the TTL sends nothing", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() => Effect.succeed(PRS_RESPONSE));
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          yield* github.prs.pipe(Effect.orDie);
          yield* github.prs.pipe(Effect.orDie);
          yield* github.prs.pipe(Effect.orDie);
        }),
      );
      assert.equal(
        (yield* runner.calls).filter((args) => args[1] === "graphql").length,
        1,
        "caching is the default, not an optimization",
      );
    }),
  );
});

describe("parking on a rate limit", () => {
  it.effect("a rate limit produces zero further requests until the reset", () =>
    Effect.gen(function* () {
      const reset = Math.floor(Date.now() / 1000) + 3600;
      const runner = yield* scripted((args) =>
        // `rate_limit` is free and answers honestly; everything else is refused.
        args[1] === "rate_limit"
          ? Effect.succeed(JSON.stringify({ resources: { core: { remaining: 0, reset } } }))
          : Effect.fail(classify(1, "gh: API rate limit exceeded for user ID 12345.", "")),
      );

      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          // The first call discovers the limit and parks the module.
          const first = yield* Effect.result(github.prs);
          assert.isTrue(first._tag === "Failure");

          const before = (yield* runner.calls).length;

          // Everything after it must fail fast without touching the network —
          // including an explicit, user-initiated refresh.
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const outcome = yield* Effect.result(github.prs);
            assert.isTrue(outcome._tag === "Failure");
          }
          const refresh = yield* Effect.result(github.refreshPrs);
          assert.isTrue(refresh._tag === "Failure", "a manual refresh must not bypass the park");
          const detail = yield* Effect.result(github.pr({ owner: "a", repo: "b", number: 1 }));
          assert.isTrue(detail._tag === "Failure");

          assert.equal(
            (yield* runner.calls).length,
            before,
            "nothing — not even a user-initiated refresh — may send a request while parked",
          );
        }),
      );
    }),
  );

  it.effect("health reports the park honestly, with its reset", () =>
    Effect.gen(function* () {
      const reset = Math.floor(Date.now() / 1000) + 1800;
      const runner = yield* scripted((args) =>
        args[1] === "rate_limit"
          ? Effect.succeed(JSON.stringify({ resources: { core: { remaining: 0, reset } } }))
          : Effect.fail(classify(1, "API rate limit exceeded", "")),
      );
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          yield* Effect.result(github.prs);
          const health = yield* github.health;
          assert.equal(health.status, "parked");
          assert.isNotNull(health.resetAt);
        }),
      );
    }),
  );
});

describe("retry discipline", () => {
  it.effect("a 404 is an answer and is never retried", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() =>
        Effect.fail(classify(1, "gh: Not Found (HTTP 404)", "")),
      );
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const outcome = yield* Effect.result(
            github.pr({ owner: "meridian", repo: "console", number: 9 }),
          );
          assert.isTrue(outcome._tag === "Failure");
          if (outcome._tag === "Failure") {
            assert.equal(outcome.failure._tag, "GitHubNotFoundError");
          }
        }),
      );
      assert.equal((yield* runner.calls).length, 1, "a client error must not be retried");
    }),
  );

  it.live("a transport failure retries, but at most three attempts in total", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() =>
        Effect.fail(classify(1, "dial tcp 140.82.121.6:443: connect: connection refused", "")),
      );
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const outcome = yield* Effect.result(
            github.pr({ owner: "meridian", repo: "console", number: 9 }),
          );
          assert.isTrue(outcome._tag === "Failure");
        }),
      );
      assert.equal((yield* runner.calls).length, 3, "retries are bounded to three attempts");
    }),
  );
});

describe("identity", () => {
  it.effect("an unauthenticated gh is a visible state, never a retry loop", () =>
    Effect.gen(function* () {
      const runner = yield* scripted((args) =>
        args[0] === "--version"
          ? Effect.succeed("gh version 2.96.0")
          : Effect.fail(classify(1, "gh: To get started with GitHub CLI, run: gh auth login", "")),
      );
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const identity = yield* github.identity;
          assert.equal(identity.auth, "unauthenticated");
          assert.isNotNull(identity.detail);
          assert.include(identity.detail ?? "", "gh auth login");
        }),
      );
    }),
  );

  it.effect("a missing gh reports how to install it", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() =>
        Effect.fail(classify(127, "sh: gh: command not found", "")),
      );
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const identity = yield* github.identity;
          assert.equal(identity.auth, "missing");
          assert.include(identity.detail ?? "", "cli.github.com");
        }),
      );
    }),
  );
});

describe("staleness reads from either cache, and never sends a request", () => {
  it.effect("the PR list's view answers a staleness check", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() => Effect.succeed(PRS_RESPONSE));
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          yield* github.prs.pipe(Effect.orDie);
          const before = (yield* runner.calls).length;
          const cached = yield* github.cachedPr({
            owner: "meridian",
            repo: "console",
            number: 418,
          });
          assert.isTrue(Option.isSome(cached), "the list's own view must satisfy the check");
          if (Option.isSome(cached)) assert.equal(cached.value.headSha, "f47c19d");
          assert.equal((yield* runner.calls).length, before, "a staleness check sends nothing");
        }),
      );
    }),
  );

  it.effect("an unknown PR reads as unknown rather than guessing", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() => Effect.succeed(PRS_RESPONSE));
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const cached = yield* github.cachedPr({ owner: "who", repo: "what", number: 1 });
          assert.isTrue(Option.isNone(cached));
        }),
      );
      assert.equal((yield* runner.calls).length, 0);
    }),
  );
});

describe("the door", () => {
  const cases: ReadonlyArray<
    readonly [string, { owner: string; repo: string; number: number } | null]
  > = [
    [
      "https://github.com/meridian/console/pull/418",
      { owner: "meridian", repo: "console", number: 418 },
    ],
    [
      "github.com/meridian/console/pull/418/files",
      { owner: "meridian", repo: "console", number: 418 },
    ],
    [
      "https://github.com/meridian/console/pull/418#discussion_r1",
      { owner: "meridian", repo: "console", number: 418 },
    ],
    ["meridian/console#418", { owner: "meridian", repo: "console", number: 418 }],
    ["https://gitlab.com/meridian/console/pull/418", null],
    ["https://github.com/meridian/console", null],
    ["https://github.com/meridian/console/pull/abc", null],
    ["not a url at all", null],
    ["", null],
  ];

  for (const [input, expected] of cases) {
    it(`resolves ${JSON.stringify(input)}`, () => {
      assert.deepEqual(internals.parsePrUrl(input), expected);
    });
  }

  it.effect("an unparseable URL is rejected at the door with an instruction", () =>
    Effect.gen(function* () {
      const runner = yield* scripted(() => Effect.succeed(""));
      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          const outcome = yield* Effect.result(github.resolveUrl("nonsense"));
          assert.isTrue(outcome._tag === "Failure");
          if (outcome._tag === "Failure") {
            assert.equal(outcome.failure.reason, "invalid-url");
            assert.include(outcome.failure.detail, "github.com/owner/repo/pull/123");
          }
        }),
      );
      assert.equal((yield* runner.calls).length, 0, "the door rejects before any request");
    }),
  );
});

describe("classification", () => {
  const cases: ReadonlyArray<readonly [string, string, GhError["_tag"]]> = [
    ["missing binary", "sh: gh: command not found", "GhUnavailableError"],
    ["needs login", "gh: run gh auth login to authenticate", "GhUnavailableError"],
    ["bad credentials", "gh: Bad credentials (HTTP 401)", "GhUnavailableError"],
    ["primary limit", "API rate limit exceeded for user ID 1", "GhRateLimitedError"],
    ["secondary limit", "You have exceeded a secondary rate limit", "GhRateLimitedError"],
    ["not found", "gh: Not Found (HTTP 404)", "GhClientError"],
    ["unprocessable", "gh: Validation Failed (HTTP 422)", "GhClientError"],
    ["server error", "gh: Bad Gateway (HTTP 502)", "GhTransientError"],
    ["network", "dial tcp: connection refused", "GhTransientError"],
    ["graphql", '{"errors":[{"message":"nope"}]}', "GhClientError"],
    ["unknown", "something nobody has seen", "GhTransientError"],
  ];

  for (const [name, stderr, expected] of cases) {
    it(`reads ${name} as ${expected}`, () => {
      assert.equal(classify(1, stderr, "")._tag, expected);
    });
  }

  it("reads a secondary limit before a primary one", () => {
    // A secondary-rate-limit message also contains the words "rate limit", so
    // ordering in `classify` is load-bearing.
    const error = classify(1, "You have exceeded a secondary rate limit and rate limit", "");
    assert.equal(error._tag, "GhRateLimitedError");
    if (error._tag === "GhRateLimitedError") assert.isTrue(error.secondary);
  });

  it("reads a reset instant out of a rate-limit header when one is present", () => {
    const error = classify(1, "x-ratelimit-reset: 1800000000\nAPI rate limit exceeded", "");
    assert.equal(error._tag, "GhRateLimitedError");
    if (error._tag === "GhRateLimitedError") {
      assert.equal(error.resetAtMillis, 1_800_000_000_000);
    }
  });
});

describe("TestClock is available for park expiry", () => {
  it.effect("a park lapses once its reset passes", () =>
    Effect.gen(function* () {
      let phase: "limited" | "ok" = "limited";
      // The reset is expressed in the TEST clock's time, not the wall clock:
      // the park is a time comparison, so mixing the two would make this assert
      // nothing at all.
      const startMillis = yield* Clock.currentTimeMillis;
      const runner = yield* scripted((args) => {
        if (args[1] === "rate_limit") {
          return Effect.succeed(
            JSON.stringify({
              resources: {
                core: { remaining: 0, reset: Math.floor((startMillis + 60_000) / 1000) },
              },
            }),
          );
        }
        return phase === "limited"
          ? Effect.fail(classify(1, "API rate limit exceeded", ""))
          : Effect.succeed(PRS_RESPONSE);
      });

      yield* runWith(
        runner,
        Effect.gen(function* () {
          const github = yield* GitHub;
          yield* Effect.result(github.prs);
          const parked = yield* github.health;
          assert.equal(parked.status, "parked");

          phase = "ok";
          // Time only moves when the test says so, so this asserts the park's
          // *rule*, not a sleep.
          yield* TestClock.adjust("2 minutes");
          const outcome = yield* Effect.result(github.prs);
          assert.isTrue(outcome._tag === "Success", "the park must lapse at its reset");
        }),
      );
    }),
  );
});
