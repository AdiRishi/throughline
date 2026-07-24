import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { GitHubReadError, PrRef, type PrRef as PrRefType } from "@app/contracts";

import * as GhCli from "../../src/github/GhCli.ts";
import * as GitHub from "../../src/github/GitHub.ts";

const HEAD_SHA = "1111111111111111111111111111111111111111";
const BASE_SHA = "2222222222222222222222222222222222222222";
const NOW = Date.parse("2026-07-25T00:00:00.000Z");

const decodePrRef = Schema.decodeUnknownSync(PrRef);

const prRef = (number = 17): PrRefType => decodePrRef({ owner: "acme", repo: "rocket", number });

const included = (
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): GhCli.GhCliResult => ({
  exitCode: status >= 400 ? 1 : 0,
  stdout: [
    `HTTP/2.0 ${status} ${status < 400 ? "OK" : "Error"}`,
    "content-type: application/json",
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    "",
    JSON.stringify(body),
  ].join("\n"),
  stderr: status >= 400 ? `gh: request failed (HTTP ${status})` : "",
});

const viewerResult = included(200, {
  login: "octocat",
  name: "The Octocat",
  avatar_url: "https://avatars.example/octocat",
});

const rawPullRequest = (number: number, overrides: Readonly<Record<string, unknown>> = {}) => ({
  number,
  title: `Pull request ${number}`,
  author: {
    login: "monalisa",
    avatarUrl: "https://avatars.example/monalisa",
  },
  url: `https://github.com/acme/rocket/pull/${number}`,
  state: "OPEN",
  baseRefName: "main",
  headRefOid: HEAD_SHA,
  updatedAt: "2026-07-24T12:00:00.000Z",
  mergedAt: null,
  changedFiles: 3,
  additions: 21,
  deletions: 5,
  ...overrides,
});

const repositoriesResult = (
  options: {
    readonly open?: ReadonlyArray<unknown>;
    readonly merged?: ReadonlyArray<unknown>;
  } = {},
) =>
  included(200, {
    data: {
      viewer: {
        repositories: {
          nodes: [
            {
              name: "rocket",
              owner: { login: "acme" },
              openPullRequests: {
                nodes: options.open ?? [rawPullRequest(17)],
              },
              mergedPullRequests: {
                nodes: options.merged ?? [],
              },
            },
          ],
        },
      },
    },
  });

const detailResult = (number: number) =>
  included(200, {
    number,
    title: `Pull request ${number}`,
    body: "A complete description.",
    user: {
      login: "monalisa",
      avatar_url: "https://avatars.example/monalisa",
    },
    html_url: `https://github.com/acme/rocket/pull/${number}`,
    state: "open",
    merged_at: null,
    base: {
      ref: "main",
      sha: BASE_SHA,
      repo: {
        name: "rocket",
        owner: { login: "acme" },
      },
    },
    head: { sha: HEAD_SHA },
    updated_at: "2026-07-24T12:00:00.000Z",
    changed_files: 3,
    additions: 21,
    deletions: 5,
  });

const isAuthStatus = (args: ReadonlyArray<string>) => args[0] === "auth" && args[1] === "status";

const isViewer = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "user";

const isGraphQl = (args: ReadonlyArray<string>) => args[0] === "api" && args[1] === "graphql";

const detailNumber = (args: ReadonlyArray<string>): number | undefined => {
  const match = /^repos\/[^/]+\/[^/]+\/pulls\/([1-9]\d*)$/.exec(args[1] ?? "");
  return match === null ? undefined : Number(match[1]);
};

const makeService = (
  run: GhCli.GhCli["Service"]["run"],
  options: GitHub.GitHubOptions = {
    retryDelays: ["0 millis", "0 millis"],
    rateLimitJitter: "0 millis",
  },
) => GitHub.make(options).pipe(Effect.provideService(GhCli.GhCli, GhCli.GhCli.of({ run })));

const failureHasTag = (exit: Exit.Exit<unknown, unknown>, tag: string): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      "_tag" in reason.error &&
      reason.error._tag === tag,
  );

const failureValue = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;

describe("GitHub", () => {
  it.effect("single-flights a stampede of repository pull-request reads", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const graphqlGate = yield* Deferred.make<void>();
      let graphqlCalls = 0;

      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          graphqlCalls += 1;
          return Deferred.await(graphqlGate).pipe(Effect.as(repositoriesResult()));
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });

      const readers = yield* Effect.all(
        Array.from({ length: 24 }, () => service.pullRequests()),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);

      assert.strictEqual(graphqlCalls, 1);
      yield* Deferred.succeed(graphqlGate, undefined);
      const results = yield* Fiber.join(readers);
      assert.strictEqual(results.length, 24);
      assert.strictEqual(results[0]?.[0]?.headSha, HEAD_SHA);
    }),
  );

  it.effect("keeps cache-backed manual refreshes inside the one-minute minimum", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let graphqlCalls = 0;
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          graphqlCalls += 1;
          return Effect.succeed(repositoriesResult());
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });

      yield* service.pullRequests();
      yield* service.refreshPrs();
      assert.strictEqual(graphqlCalls, 1);

      yield* TestClock.adjust("61 seconds");
      yield* service.refreshPrs();
      assert.strictEqual(graphqlCalls, 2);
    }),
  );

  it.effect("parks all reads after three retryable failures until explicit recovery", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let graphqlCalls = 0;
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          graphqlCalls += 1;
          return Effect.succeed(
            graphqlCalls <= 3
              ? included(502, { message: "upstream unavailable" })
              : repositoriesResult(),
          );
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });

      const exhausted = yield* service.pullRequests().pipe(Effect.exit);
      assert.isTrue(failureHasTag(exhausted, "GitHubReadError"));
      assert.strictEqual(graphqlCalls, 3);

      const parked = yield* service.pullRequests().pipe(Effect.exit);
      assert.isTrue(failureHasTag(parked, "GitHubReadError"));
      assert.strictEqual(graphqlCalls, 3);

      yield* service.retry();
      const recovered = yield* service.pullRequests();
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual(graphqlCalls, 4);
    }),
  );

  it.effect("parks a rate-limited response globally until its reset time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      let graphqlCalls = 0;
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          graphqlCalls += 1;
          return Effect.succeed(
            graphqlCalls === 1
              ? included(
                  403,
                  { message: "API rate limit exceeded" },
                  {
                    "x-ratelimit-remaining": "0",
                    "x-ratelimit-reset": "10",
                  },
                )
              : repositoriesResult(),
          );
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });

      const first = yield* service.pullRequests().pipe(Effect.exit);
      assert.isTrue(failureHasTag(first, "GitHubParkedError"));
      assert.strictEqual(graphqlCalls, 1);

      const beforeReset = yield* service.refreshPrs().pipe(Effect.exit);
      assert.isTrue(failureHasTag(beforeReset, "GitHubParkedError"));
      assert.strictEqual(graphqlCalls, 1);

      const forcedRetry = yield* service.retry().pipe(Effect.exit);
      assert.isTrue(failureHasTag(forcedRetry, "GitHubParkedError"));
      assert.strictEqual(graphqlCalls, 1);

      yield* TestClock.adjust("10 seconds");
      const recovered = yield* service.pullRequests();
      assert.strictEqual(recovered.length, 1);
      assert.strictEqual(graphqlCalls, 2);
    }),
  );

  it.effect("does not start a queued API read after another read parks the gate", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const releaseRateLimit = yield* Deferred.make<void>();
      const releaseInFlight = yield* Deferred.make<void>();
      const detailCalls: Array<number> = [];
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        const number = detailNumber(args);
        if (number === undefined) {
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        }
        detailCalls.push(number);
        if (number === 1) {
          return Deferred.await(releaseRateLimit).pipe(
            Effect.as(
              included(
                403,
                { message: "API rate limit exceeded" },
                {
                  "x-ratelimit-remaining": "0",
                  "x-ratelimit-reset": "100",
                },
              ),
            ),
          );
        }
        return number === 2
          ? Deferred.await(releaseInFlight).pipe(Effect.as(detailResult(number)))
          : Effect.succeed(detailResult(number));
      });

      yield* service.identity();
      const reads = yield* Effect.all(
        [1, 2, 3].map((number) => service.pr(prRef(number)).pipe(Effect.exit)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      assert.deepStrictEqual(detailCalls, [1, 2]);

      yield* Deferred.succeed(releaseRateLimit, undefined);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      assert.deepStrictEqual(detailCalls, [1, 2]);

      yield* Deferred.succeed(releaseInFlight, undefined);
      const exits = yield* Fiber.join(reads);
      assert.isTrue(failureHasTag(exits[0]!, "GitHubParkedError"));
      assert.isTrue(Exit.isSuccess(exits[1]!));
      assert.isTrue(failureHasTag(exits[2]!, "GitHubParkedError"));
    }),
  );

  describe("failure classification", () => {
    it.effect("retries a transport failure and succeeds within the three-attempt cap", () =>
      Effect.gen(function* () {
        let graphqlCalls = 0;
        const service = yield* makeService(({ args }) => {
          if (isAuthStatus(args)) {
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (isViewer(args)) {
            return Effect.succeed(viewerResult);
          }
          if (isGraphQl(args)) {
            graphqlCalls += 1;
            return graphqlCalls < 3
              ? Effect.fail(
                  new GhCli.GhCliError({
                    reason: "transport",
                    detail: "connection reset",
                  }),
                )
              : Effect.succeed(repositoriesResult());
          }
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        });

        const result = yield* service.pullRequests();
        assert.strictEqual(result.length, 1);
        assert.strictEqual(graphqlCalls, 3);
      }),
    );

    it.effect("does not retry a non-rate-limit 4xx response", () =>
      Effect.gen(function* () {
        let graphqlCalls = 0;
        const service = yield* makeService(({ args }) => {
          if (isAuthStatus(args)) {
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (isViewer(args)) {
            return Effect.succeed(viewerResult);
          }
          if (isGraphQl(args)) {
            graphqlCalls += 1;
            return Effect.succeed(included(404, { message: "Not Found" }));
          }
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        });

        const result = yield* service.pullRequests().pipe(Effect.exit);
        assert.isTrue(failureHasTag(result, "GitHubReadError"));
        const error = failureValue(result);
        assert.instanceOf(error, GitHubReadError);
        if (error instanceof GitHubReadError) {
          assert.strictEqual(error.reason, "not-found");
        }
        assert.strictEqual(graphqlCalls, 1);
      }),
    );

    it.effect("does not retry a schema-invalid successful response", () =>
      Effect.gen(function* () {
        let graphqlCalls = 0;
        const service = yield* makeService(({ args }) => {
          if (isAuthStatus(args)) {
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (isViewer(args)) {
            return Effect.succeed(viewerResult);
          }
          if (isGraphQl(args)) {
            graphqlCalls += 1;
            return Effect.succeed(included(200, { data: "not a GraphQL envelope" }));
          }
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        });

        const result = yield* service.pullRequests().pipe(Effect.exit);
        assert.isTrue(failureHasTag(result, "GitHubReadError"));
        assert.strictEqual(graphqlCalls, 1);
      }),
    );

    it.effect("does not park an ordinary 403 that carries normal quota headers", () =>
      Effect.gen(function* () {
        let graphqlCalls = 0;
        const service = yield* makeService(({ args }) => {
          if (isAuthStatus(args)) {
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (isViewer(args)) {
            return Effect.succeed(viewerResult);
          }
          if (isGraphQl(args)) {
            graphqlCalls += 1;
            return Effect.succeed(
              included(
                403,
                { message: "Resource not accessible by integration" },
                {
                  "x-ratelimit-remaining": "4999",
                  "x-ratelimit-reset": "2000000000",
                },
              ),
            );
          }
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        });

        const first = yield* service.pullRequests().pipe(Effect.exit);
        const second = yield* service.pullRequests().pipe(Effect.exit);
        assert.isTrue(failureHasTag(first, "GitHubReadError"));
        assert.isTrue(failureHasTag(second, "GitHubReadError"));
        const error = failureValue(first);
        assert.instanceOf(error, GitHubReadError);
        if (error instanceof GitHubReadError) {
          assert.strictEqual(error.reason, "forbidden");
        }
        assert.strictEqual(graphqlCalls, 2);
      }),
    );
  });

  it.effect("returns repo-grouped open and only last-seven-day merged summaries", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          return Effect.succeed(
            repositoriesResult({
              open: [rawPullRequest(17)],
              merged: [
                rawPullRequest(18, {
                  state: "MERGED",
                  mergedAt: "2026-07-20T00:00:00.000Z",
                }),
                rawPullRequest(19, {
                  state: "MERGED",
                  mergedAt: "2026-07-10T00:00:00.000Z",
                }),
              ],
            }),
          );
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });

      const repositories = yield* service.repositories();
      assert.strictEqual(repositories.length, 1);
      assert.strictEqual(repositories[0]?.openPullRequests.length, 1);
      assert.deepStrictEqual(
        repositories[0]?.recentlyMergedPullRequests.map((pullRequest) => pullRequest.ref.number),
        [18],
      );
    }),
  );

  it.effect("returns PR metadata pinned by exact base and head commit SHAs", () =>
    Effect.gen(function* () {
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        const number = detailNumber(args);
        return number === undefined
          ? Effect.die(`Unexpected gh invocation: ${args.join(" ")}`)
          : Effect.succeed(detailResult(number));
      });

      const detail = yield* service.pr(prRef());
      assert.strictEqual(detail.baseSha, BASE_SHA);
      assert.strictEqual(detail.headSha, HEAD_SHA);
      assert.strictEqual(detail.body, "A complete description.");
    }),
  );

  it.effect("limits distinct concurrent GitHub API reads to two", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maxActive = 0;
      let detailCalls = 0;

      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        const number = detailNumber(args);
        if (number === undefined) {
          return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
        }
        return Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            detailCalls += 1;
            maxActive = Math.max(maxActive, active);
          }),
          () => Deferred.await(release).pipe(Effect.as(detailResult(number))),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        );
      });

      yield* service.identity();
      const details = yield* Effect.all(
        [service.pr(prRef(1)), service.pr(prRef(2)), service.pr(prRef(3))],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);

      assert.strictEqual(detailCalls, 2);
      assert.strictEqual(maxActive, 2);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(details);
      assert.deepStrictEqual(
        results.map((detail) => detail.ref.number),
        [1, 2, 3],
      );
      assert.strictEqual(maxActive, 2);
    }),
  );

  it.effect("interrupts an in-flight read when its AbortSignal aborts", () =>
    Effect.gen(function* () {
      let graphqlStarted = false;
      let graphqlInterrupted = false;
      const service = yield* makeService(({ args }) => {
        if (isAuthStatus(args)) {
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (isViewer(args)) {
          return Effect.succeed(viewerResult);
        }
        if (isGraphQl(args)) {
          graphqlStarted = true;
          return Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                graphqlInterrupted = true;
              }),
            ),
          );
        }
        return Effect.die(`Unexpected gh invocation: ${args.join(" ")}`);
      });
      const controller = new AbortController();

      const reader = yield* service
        .pullRequests({ signal: controller.signal })
        .pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow);
      assert.isTrue(graphqlStarted);

      controller.abort();
      const exit = yield* Fiber.await(reader);
      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(graphqlInterrupted);
    }),
  );

  it.effect("discovers authenticated, unauthenticated, and unavailable viewer states", () =>
    Effect.gen(function* () {
      const authenticated = yield* makeService(({ args }) =>
        isAuthStatus(args)
          ? Effect.succeed({ exitCode: 0, stdout: "", stderr: "" })
          : isViewer(args)
            ? Effect.succeed(viewerResult)
            : Effect.die(`Unexpected gh invocation: ${args.join(" ")}`),
      );
      assert.strictEqual((yield* authenticated.identity()).auth, "authenticated");

      const unauthenticated = yield* makeService(({ args }) =>
        isAuthStatus(args)
          ? Effect.succeed({ exitCode: 1, stdout: "", stderr: "not logged in" })
          : Effect.die(`Unexpected gh invocation: ${args.join(" ")}`),
      );
      assert.strictEqual((yield* unauthenticated.identity()).auth, "unauthenticated");

      const unavailable = yield* makeService(() =>
        Effect.fail(
          new GhCli.GhCliError({
            reason: "unavailable",
            detail: "gh was not found",
          }),
        ),
      );
      assert.strictEqual((yield* unavailable.identity()).auth, "unavailable");
    }),
  );

  it.effect("parses only canonical GitHub pull-request URLs", () =>
    Effect.gen(function* () {
      const service = yield* makeService(() => Effect.die("gh should not run"));

      const ref = yield* service.resolveUrl(
        "https://github.com/acme/rocket/pull/17?notification_referrer_id=1",
      );
      assert.deepStrictEqual(ref, prRef());

      const invalid = yield* service
        .resolveUrl("https://example.com/acme/rocket/pull/17")
        .pipe(Effect.exit);
      assert.isTrue(failureHasTag(invalid, "IngestionDoorRejectionError"));
    }),
  );
});
