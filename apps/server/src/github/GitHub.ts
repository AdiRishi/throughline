import * as Cache from "effect/Cache";
/**
 * The only door to GitHub.
 *
 * No other code in this repository may reach the GitHub API, shell out to `gh`,
 * or touch the network toward GitHub. That single-choke-point rule is what makes
 * every promise below enforceable rather than aspirational:
 *
 *  1. One concurrency gate — a semaphore of width 2 in front of every call,
 *     with no code path around it.
 *  2. Caching is the default, not an optimization. Every read has a TTL and is
 *     single-flighted: N concurrent callers produce one request.
 *  3. Nothing polls. There is no background refresh loop in this module; the
 *     only cache bypass is a user-initiated `refreshPrs`.
 *  4. 4xx is an answer, not an obstacle — never retried.
 *  5. A rate limit parks the module until the reported reset. Every call then
 *     fails fast with the reset instant, and *nothing* — not even a user
 *     refresh — sends a request early.
 *  6. Only transport failures retry: capped backoff, three attempts, inside the
 *     same semaphore so a retrying module still cannot stampede.
 *  7. Reads only. No mutating call exists here, so the most expensive class of
 *     mistake is unrepresentable.
 *
 * @module github/GitHub
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  GitHubParkedError,
  GitHubRequestError,
  GitHubUnavailableError,
  MERGED_LINGER_DAYS,
  type GitHubError,
  type PrDetail,
  type PrRef,
  type PrSummary,
  type Viewer,
} from "@app/contracts";

import { makeRunner, succeeded, type Runner } from "../process/Subprocess.ts";
import { classifyGhFailure, makeGh, type Gh, type GhFailure } from "./gh.ts";
import {
  decodeGraphQlPrs,
  GRAPHQL_PR_QUERY,
  mergedSearchQuery,
  OPEN_SEARCH_QUERY,
} from "./queries.ts";

/** Everything the welcome screen needs from GitHub, in one fetch. */
export interface PrListSource {
  readonly viewer: Viewer;
  readonly open: ReadonlyArray<PrSummary>;
  readonly merged: ReadonlyArray<PrSummary>;
  readonly fetchedAt: DateTime.Utc;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    /** `gh`'s own view of who you are. Free — no API call. */
    readonly identity: Effect.Effect<Viewer, GitHubError>;
    /** Open + recently-merged PRs, served from cache within its TTL. */
    readonly prs: Effect.Effect<PrListSource, GitHubError>;
    /** The one cache bypass, and only ever user-initiated. */
    readonly refreshPrs: Effect.Effect<PrListSource, GitHubError>;
    /** Single-PR lookup — the freshness source for staleness checks. */
    readonly pr: (ref: PrRef) => Effect.Effect<PrDetail, GitHubError>;
    /**
     * The `-c` arguments that let git authenticate as the reviewer.
     *
     * Git — not the API — moves every repository byte, so clones and fetches
     * cost quota nothing. The credential arrives through `gh`'s own git
     * credential helper rather than as a token on a command line, so it never
     * appears in `ps` output, and this module stays the only place that knows
     * how a GitHub credential is obtained.
     */
    readonly gitCredentialArgs: Effect.Effect<ReadonlyArray<string>, GitHubError>;
    /** When the module is parked, and until when. Rendered honestly by the UI. */
    readonly parkedUntil: Effect.Effect<DateTime.Utc | null>;
  }
>()("@app/server/github/GitHub") {}

const IDENTITY_TTL = Duration.hours(1);
const PR_LIST_TTL = Duration.seconds(60);
const PR_DETAIL_TTL = Duration.seconds(30);
/** Cap on how long a park can last if GitHub reports something absurd. */
const MAX_PARK = Duration.hours(2);
/** Applied when a secondary rate limit gives us no reset instant at all. */
const BLIND_PARK = Duration.minutes(1);
const RETRY_ATTEMPTS = 3;

const decodeRateLimit = Schema.decodeUnknownSync(
  Schema.Struct({
    resources: Schema.Struct({
      core: Schema.Struct({ reset: Schema.Number }),
    }),
  }),
);

const AUTH_HOST = /^\s*([\w.-]+)\s*$/u;

/**
 * Read `gh auth status`. It costs no API quota, which is why identity is free
 * and can be probed on every app focus without discipline concerns.
 */
const makeProbeIdentity = (gh: Gh) =>
  Effect.fn("github.probeIdentity")(function* () {
    const outcome = yield* gh({ args: ["auth", "status"], timeout: Duration.seconds(20) });

    if (outcome.exitCode === 127) {
      return {
        login: null,
        ghInstalled: false,
        authenticated: false,
        host: null,
      } satisfies Viewer;
    }

    const text = `${outcome.stdout}\n${outcome.stderr}`;
    if (!succeeded(outcome)) {
      return {
        login: null,
        ghInstalled: true,
        authenticated: false,
        host: null,
      } satisfies Viewer;
    }

    // "  ✓ Logged in to github.com account mara (keyring)"
    const account = /Logged in to (\S+) account ([\w-]+)/u.exec(text);
    const host = account?.[1] ?? firstHostLine(text);
    return {
      login: account?.[2] ?? null,
      ghInstalled: true,
      authenticated: true,
      host: host ?? null,
    } satisfies Viewer;
  });

function firstHostLine(text: string): string | null {
  for (const line of text.split("\n")) {
    const match = AUTH_HOST.exec(line);
    if (match?.[1] !== undefined && match[1].includes(".")) return match[1];
  }
  return null;
}

/**
 * The service over an explicit command runner.
 *
 * Taking the runner as an argument rather than reaching for it is what makes
 * the rate discipline testable: the adversarial tests count the commands a
 * scripted runner sees, which is the only way to assert "exactly zero further
 * requests until reset" and "a stampede produces exactly one".
 */
export const makeWith = (runner: Runner) =>
  Effect.gen(function* () {
    const gh = makeGh(runner);
    const probeIdentity = makeProbeIdentity(gh);

    // (1) One gate. Everything that talks to GitHub passes through it, including
    // retries — so even a retrying module cannot stampede.
    const gate = yield* Semaphore.make(2);
    const parked = yield* Ref.make<DateTime.Utc | null>(null);

    const parkedNow = Effect.gen(function* () {
      const until = yield* Ref.get(parked);
      if (until === null) return null;
      const now = yield* DateTime.now;
      if (DateTime.isLessThan(until, now)) {
        yield* Ref.set(parked, null);
        return null;
      }
      return until;
    });

    /**
     * Ask GitHub when the quota resets. `/rate_limit` does not itself count
     * against the quota, so this is the one request we are allowed to make while
     * rate-limited — and it is what turns "parked" into "parked until 14:32".
     */
    const resolveResetAt = Effect.fn("github.resolveResetAt")(function* () {
      const now = yield* DateTime.now;
      const fallback = DateTime.addDuration(now, BLIND_PARK);
      const outcome = yield* gh({ args: ["api", "rate_limit"], timeout: Duration.seconds(15) });
      if (!succeeded(outcome)) return fallback;
      try {
        const parsed = decodeRateLimit(JSON.parse(outcome.stdout));
        const reset = DateTime.makeUnsafe(parsed.resources.core.reset * 1000);
        if (DateTime.isLessThanOrEqualTo(reset, now)) return fallback;
        const ceiling = DateTime.addDuration(now, MAX_PARK);
        return DateTime.isLessThan(reset, ceiling) ? reset : ceiling;
      } catch {
        return fallback;
      }
    });

    const park = Effect.fn("github.park")(function* (failure: GhFailure & { kind: "rate-limit" }) {
      const resetAt = yield* resolveResetAt();
      yield* Ref.set(parked, resetAt);
      yield* Effect.logWarning("GitHub rate limit reached; parking until reset.", {
        resetAt: resetAt.toString(),
        secondary: failure.secondary,
      });
      return new GitHubParkedError({
        resetAt,
        reason: failure.secondary ? "secondary-rate-limit" : "rate-limit",
      });
    });

    const toError = (operation: string, failure: GhFailure): Effect.Effect<GitHubError> => {
      switch (failure.kind) {
        case "rate-limit":
          return park(failure);
        case "not-installed":
          return Effect.succeed(
            new GitHubUnavailableError({ reason: "not-installed", detail: failure.detail }),
          );
        case "not-authenticated":
          return Effect.succeed(
            new GitHubUnavailableError({ reason: "not-authenticated", detail: failure.detail }),
          );
        case "client":
          return Effect.succeed(
            new GitHubRequestError({
              operation,
              status: failure.status === 0 ? null : failure.status,
              detail: failure.detail,
            }),
          );
        case "transport":
          return Effect.succeed(
            new GitHubRequestError({ operation, status: null, detail: failure.detail }),
          );
      }
    };

    /**
     * The single path every API-consuming call takes: park check, gate, bounded
     * transport-only retry, classification.
     */
    const call = Effect.fn("github.call")(function* (
      operation: string,
      args: ReadonlyArray<string>,
      options?: { readonly timeout?: Duration.Input },
    ) {
      const until = yield* parkedNow;
      if (until !== null) {
        return yield* new GitHubParkedError({ resetAt: until, reason: "rate-limit" });
      }

      const attempt = Effect.gen(function* () {
        const outcome = yield* gh({
          args,
          ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
        });
        if (succeeded(outcome)) return outcome.stdout;

        const failure =
          outcome.exitCode === 127
            ? ({ kind: "not-installed", detail: outcome.stderr } as const)
            : classifyGhFailure(outcome);
        return yield* Effect.flatMap(toError(operation, failure), Effect.fail);
      });

      // (6) Only transport failures retry. A parked module, a 404, or a signed-out
      // `gh` are answers — retrying them would be both useless and rude.
      return yield* gate.withPermits(1)(
        attempt.pipe(
          Effect.retry({
            times: RETRY_ATTEMPTS - 1,
            schedule: Schedule.exponential(Duration.millis(400)),
            while: (error: GitHubError) =>
              error._tag === "GitHubRequestError" && error.status === null,
          }),
        ),
      );
    });

    // (2) Caching is the default. `Cache`'s per-key deferred *is* the
    // single-flight: N concurrent callers await one lookup. Failures get a zero
    // TTL so a blip is never cached for a minute.
    const successOnly =
      <A, E>(ttl: Duration.Input) =>
      (exit: Exit.Exit<A, E>): Duration.Input =>
        Exit.isSuccess(exit) ? ttl : Duration.zero;

    const identityCache = yield* Cache.makeWith(() => probeIdentity(), {
      capacity: 1,
      timeToLive: successOnly(IDENTITY_TTL),
    });

    const fetchPrs = Effect.fn("github.fetchPrs")(function* () {
      const viewer = yield* Cache.get(identityCache, "viewer");
      if (!viewer.ghInstalled) {
        return yield* new GitHubUnavailableError({
          reason: "not-installed",
          detail: "The GitHub CLI (gh) was not found on PATH.",
        });
      }
      if (!viewer.authenticated) {
        return yield* new GitHubUnavailableError({
          reason: "not-authenticated",
          detail: "Run `gh auth login` to let Throughline see your pull requests.",
        });
      }

      const now = yield* DateTime.now;
      const since = DateTime.subtractDuration(now, Duration.days(MERGED_LINGER_DAYS));
      // (2) One GraphQL query for the whole screen, not N+1 REST calls.
      const raw = yield* call(
        "github.prs",
        [
          "api",
          "graphql",
          "-f",
          `query=${GRAPHQL_PR_QUERY}`,
          "-f",
          `openQuery=${OPEN_SEARCH_QUERY}`,
          "-f",
          `mergedQuery=${mergedSearchQuery(since)}`,
        ],
        { timeout: Duration.seconds(60) },
      );

      const decoded = yield* decodeGraphQlPrs(raw).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubRequestError({
              operation: "github.prs",
              status: null,
              detail: `Could not read GitHub's response: ${String(cause)}`,
            }),
        ),
      );

      return {
        viewer: decoded.login === null ? viewer : { ...viewer, login: decoded.login },
        open: decoded.open,
        merged: decoded.merged,
        fetchedAt: now,
      } satisfies PrListSource;
    });

    const prsCache = yield* Cache.makeWith(() => fetchPrs(), {
      capacity: 1,
      timeToLive: successOnly(PR_LIST_TTL),
    });

    const fetchPr = Effect.fn("github.fetchPr")(function* (ref: PrRef) {
      const raw = yield* call("github.pr", [
        "api",
        "--cache",
        "30s",
        `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      ]);
      return yield* decodeRestPr(raw, ref).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubRequestError({
              operation: "github.pr",
              status: null,
              detail: `Could not read GitHub's response: ${String(cause)}`,
            }),
        ),
      );
    });

    const prCache = yield* Cache.makeWith((ref: string) => fetchPr(parseKey(ref)), {
      capacity: 256,
      timeToLive: successOnly(PR_DETAIL_TTL),
    });

    return GitHub.of({
      identity: Cache.get(identityCache, "viewer"),
      prs: Cache.get(prsCache, "prs"),
      refreshPrs: Cache.invalidate(prsCache, "prs").pipe(
        Effect.andThen(Cache.invalidateAll(prCache)),
        Effect.andThen(Cache.get(prsCache, "prs")),
      ),
      pr: (ref) => Cache.get(prCache, formatKey(ref)),
      gitCredentialArgs: Effect.gen(function* () {
        const viewer = yield* Cache.get(identityCache, "viewer");
        if (!viewer.ghInstalled) {
          return yield* new GitHubUnavailableError({
            reason: "not-installed",
            detail: "The GitHub CLI (gh) was not found on PATH.",
          });
        }
        // Clearing the inherited helper first stops a misconfigured global helper
        // from answering before gh does.
        return viewer.authenticated
          ? ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
          : [];
      }),
      parkedUntil: parkedNow,
    });
  });

export const make: Effect.Effect<
  GitHub["Service"],
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.flatMap(makeRunner, makeWith);

export const layer: Layer.Layer<GitHub, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(GitHub, make);

function formatKey(ref: PrRef): string {
  return `${ref.owner}/${ref.repo}/${ref.number}`;
}

function parseKey(key: string): PrRef {
  const [owner = "", repo = "", number = "0"] = key.split("/");
  return { owner, repo, number: Number.parseInt(number, 10) };
}

// Kept beside the service rather than in `queries.ts` because it is the only
// REST shape we decode; everything else is one GraphQL document.
const RestPr = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  created_at: Schema.String,
  updated_at: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
  changed_files: Schema.optionalKey(Schema.Number),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  head: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
});
const decodeRestPrPayload = Schema.decodeUnknownEffect(RestPr);

const decodeRestPr = Effect.fn("github.decodeRestPr")(function* (raw: string, ref: PrRef) {
  const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown);
  const pr = yield* decodeRestPrPayload(parsed);
  const summary: PrSummary = {
    ref,
    title: pr.title,
    authorLogin: pr.user?.login ?? "unknown",
    url: pr.html_url,
    state: pr.merged_at !== null ? "merged" : pr.state === "open" ? "open" : "closed",
    isDraft: pr.draft ?? false,
    createdAt: DateTime.makeUnsafe(pr.created_at),
    updatedAt: DateTime.makeUnsafe(pr.updated_at),
    mergedAt: pr.merged_at === null ? null : DateTime.makeUnsafe(pr.merged_at),
    headSha: pr.head.sha,
    baseRefName: pr.base.ref,
    headRefName: pr.head.ref,
    changedFiles: pr.changed_files ?? 0,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
  };
  return { summary, body: pr.body ?? "" } satisfies PrDetail;
});
