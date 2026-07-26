/**
 * Adversarial tests for the rate discipline.
 *
 * The promises in `GitHub.ts` are only worth anything if they are checked, and
 * the two that matter most are countable: a simulated rate limit must produce
 * exactly zero further requests until reset, and a stampede of concurrent
 * callers must produce exactly one.
 */
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { classifyGhFailure } from "../../src/github/gh.ts";
import { makeWith } from "../../src/github/GitHub.ts";
import type { CommandOutcome, Runner } from "../../src/process/Subprocess.ts";

const AUTH_OK = [
  "github.com",
  "  ✓ Logged in to github.com account mara (keyring)",
  "  - Active account: true",
].join("\n");

const prNode = (number: number) => ({
  __typename: "PullRequest",
  number,
  title: `PR ${number}`,
  url: `https://github.com/meridian/console/pull/${number}`,
  isDraft: false,
  state: "OPEN",
  createdAt: "2026-07-20T10:00:00Z",
  updatedAt: "2026-07-24T10:00:00Z",
  mergedAt: null,
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "a".repeat(40),
  author: { login: "mara" },
  repository: { name: "console", owner: { login: "meridian" } },
});

const GRAPHQL_OK = JSON.stringify({
  data: {
    viewer: { login: "mara" },
    open: { nodes: [prNode(418)] },
    merged: { nodes: [] },
  },
});

interface Recorder {
  readonly runner: Runner;
  readonly calls: ReadonlyArray<string>;
}

/**
 * A runner that records every command and answers from a script. The log is a
 * plain array rather than a Ref: the assertions are about *how many* commands
 * the module issued, and reading that has to be as cheap as counting.
 */
const recordingRunner = (
  respond: (args: ReadonlyArray<string>, index: number) => CommandOutcome,
): Recorder => {
  const calls: string[] = [];
  return {
    calls,
    runner: (options) =>
      Effect.sync(() => {
        const index = calls.length;
        calls.push(options.args.join(" "));
        return respond(options.args, index);
      }),
  };
};

const ok = (stdout: string): CommandOutcome => ({
  command: "gh",
  exitCode: 0,
  stdout,
  stderr: "",
});
const failure = (stderr: string, exitCode = 1): CommandOutcome => ({
  command: "gh",
  exitCode,
  stdout: "",
  stderr,
});

const isAuthStatus = (args: ReadonlyArray<string>) => args[0] === "auth" && args[1] === "status";
const isRateLimit = (args: ReadonlyArray<string>) => args.includes("rate_limit");

describe("classifyGhFailure", () => {
  it("reads the HTTP status gh prints on stderr", () => {
    assert.deepInclude(classifyGhFailure(failure("gh: Not Found (HTTP 404)")), {
      kind: "client",
      status: 404,
    });
    assert.strictEqual(classifyGhFailure(failure("gh: Bad gateway (HTTP 502)")).kind, "transport");
  });

  it("separates a rate-limit 403 from an ordinary 403", () => {
    assert.deepInclude(
      classifyGhFailure(failure("gh: API rate limit exceeded for user ID 1. (HTTP 403)")),
      { kind: "rate-limit", secondary: false },
    );
    assert.deepInclude(
      classifyGhFailure(failure("gh: You have exceeded a secondary rate limit (HTTP 403)")),
      { kind: "rate-limit", secondary: true },
    );
    assert.deepInclude(classifyGhFailure(failure("gh: Forbidden (HTTP 403)")), {
      kind: "client",
      status: 403,
    });
  });

  it("treats 429 as a rate limit and 401 as sign-in", () => {
    assert.strictEqual(classifyGhFailure(failure("gh: too many (HTTP 429)")).kind, "rate-limit");
    assert.strictEqual(
      classifyGhFailure(failure("gh: Bad credentials (HTTP 401)")).kind,
      "not-authenticated",
    );
    assert.strictEqual(
      classifyGhFailure(failure("To get started with GitHub CLI, please run: gh auth login")).kind,
      "not-authenticated",
    );
  });

  it("only calls something transport when it has no HTTP answer at all", () => {
    assert.strictEqual(
      classifyGhFailure(failure("dial tcp: lookup api.github.com: ENOTFOUND")).kind,
      "transport",
    );
    assert.strictEqual(classifyGhFailure(failure("something odd happened")).kind, "client");
  });
});

describe("GitHub rate discipline", () => {
  it.effect("single-flights a stampede into exactly one request", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner((args) =>
        isAuthStatus(args) ? ok(AUTH_OK) : ok(GRAPHQL_OK),
      );
      const github = yield* makeWith(recorder.runner);

      const results = yield* Effect.all(
        Array.from({ length: 12 }, () => github.prs),
        {
          concurrency: "unbounded",
        },
      );

      assert.strictEqual(results.length, 12);
      assert.strictEqual(recorder.calls.filter(isGraphQlLine).length, 1);
      assert.strictEqual(results[0]?.open.length, 1);
    }),
  );

  it.effect("serves repeat reads from cache without touching gh again", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner((args) =>
        isAuthStatus(args) ? ok(AUTH_OK) : ok(GRAPHQL_OK),
      );
      const github = yield* makeWith(recorder.runner);

      yield* github.prs;
      yield* github.prs;
      yield* github.prs;

      assert.strictEqual(recorder.calls.filter(isGraphQlLine).length, 1);
    }),
  );

  it.effect("sends exactly zero further requests once parked, even on user refresh", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner((args) => {
        if (isAuthStatus(args)) return ok(AUTH_OK);
        if (isRateLimit(args)) {
          return ok(
            JSON.stringify({
              resources: { core: { reset: Math.floor(Date.now() / 1000) + 900 } },
            }),
          );
        }
        return failure("gh: API rate limit exceeded for user ID 1. (HTTP 403)");
      });
      const github = yield* makeWith(recorder.runner);

      const first = yield* Effect.exit(github.prs);
      assert.isTrue(first._tag === "Failure");

      const afterPark = recorder.calls.length;

      // Everything after the park must be answered locally — including the one
      // action a user can take to insist.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const exit = yield* Effect.exit(github.prs);
        assert.isTrue(exit._tag === "Failure");
      }
      const refresh = yield* Effect.exit(github.refreshPrs);
      assert.isTrue(refresh._tag === "Failure");
      const detail = yield* Effect.exit(
        github.pr({ owner: "meridian", repo: "console", number: 418 }),
      );
      assert.isTrue(detail._tag === "Failure");

      assert.strictEqual(recorder.calls.length, afterPark);

      const parkedUntil = yield* github.parkedUntil;
      assert.isNotNull(parkedUntil);
      const now = yield* DateTime.now;
      assert.isTrue(DateTime.isGreaterThan(parkedUntil!, now));
    }),
  );

  it.effect("never retries a 404 — a client error is an answer", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner((args) =>
        isAuthStatus(args) ? ok(AUTH_OK) : failure("gh: Not Found (HTTP 404)"),
      );
      const github = yield* makeWith(recorder.runner);

      const exit = yield* Effect.exit(github.pr({ owner: "meridian", repo: "gone", number: 1 }));
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual(recorder.calls.length, 1);
    }),
  );

  // Live clock: the point of the test is that the backoff actually elapses and
  // then stops, which a test clock would let us skip past without proving.
  it.live("retries a transport failure up to three attempts, then gives up visibly", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner((args) =>
        isAuthStatus(args) ? ok(AUTH_OK) : failure("dial tcp: lookup api.github.com: ENOTFOUND"),
      );
      const github = yield* makeWith(recorder.runner);

      const exit = yield* Effect.exit(github.pr({ owner: "m", repo: "c", number: 1 }));
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual(recorder.calls.length, 3);
    }),
  );

  it.effect("reports an unauthenticated gh as a state rather than an error", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner(() =>
        failure("You are not logged into any GitHub hosts. To log in, run: gh auth login"),
      );
      const github = yield* makeWith(recorder.runner);

      const viewer = yield* github.identity;
      assert.deepEqual(viewer, {
        login: null,
        ghInstalled: true,
        authenticated: false,
        host: null,
      });

      // …and never reaches the API at all in that state.
      const exit = yield* Effect.exit(github.prs);
      assert.isTrue(exit._tag === "Failure");
      assert.strictEqual(recorder.calls.filter(isGraphQlLine).length, 0);
    }),
  );

  it.effect("reads the login and host out of `gh auth status`", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner(() => ok(AUTH_OK));
      const github = yield* makeWith(recorder.runner);
      const viewer = yield* github.identity;
      assert.deepEqual(viewer, {
        login: "mara",
        ghInstalled: true,
        authenticated: true,
        host: "github.com",
      });
    }),
  );

  it.effect("asks gh for a git credential helper rather than a bare token", () =>
    Effect.gen(function* () {
      const recorder = recordingRunner(() => ok(AUTH_OK));
      const github = yield* makeWith(recorder.runner);
      const args = yield* github.gitCredentialArgs;
      assert.deepEqual(args, [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
      ]);
    }),
  );
});

function isGraphQlLine(line: string): boolean {
  return line.includes("graphql");
}
