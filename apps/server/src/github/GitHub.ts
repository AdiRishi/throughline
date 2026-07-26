/**
 * The `GitHub` module — the only door to the GitHub API.
 *
 * No other code in the repository may reach the GitHub API, shell out to `gh`,
 * or touch the network toward GitHub. That single-choke-point rule is what makes
 * every promise below *enforceable* rather than aspirational:
 *
 * 1. **One concurrency gate.** A single width-2 semaphore in front of every
 *    call. There is no code path around it.
 * 2. **Caching is the default.** Every read has a TTL and is served from cache
 *    within it; identical in-flight requests are single-flighted by `Cache`
 *    (N callers, one request).
 * 3. **Nothing polls.** There is no background loop in this file. The PR list
 *    refreshes only when someone asks, and at most once per minimum interval.
 * 4. **4xx is an answer.** Client errors are never retried; they become typed
 *    rejections immediately.
 * 5. **Rate limiting parks the module.** Globally, until the reported reset —
 *    every call fails fast, and *nothing*, not even a user-initiated refresh,
 *    sends a request early.
 * 6. **Only transport failures retry**, capped at 3 attempts, inside the same
 *    semaphore so a retrying module still cannot stampede.
 * 7. **Reads only.** No mutating call exists here, so the most expensive class
 *    of mistake is unrepresentable.
 *
 * @module github/GitHub
 */
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import {
  DoorRejection,
  type GitHubHealth,
  type PrRef,
  type PrSummary,
  type Viewer,
} from "@app/contracts";

import { firstLine } from "../process/run.ts";
import { GhRunner, layer as GhRunnerLayer, type GhError } from "./GhRunner.ts";
import {
  decodePrSummary,
  decodeRateLimit,
  decodeViewerPrs,
  decodeViewerUser,
  flattenViewerPrs,
  fromRestPr,
  MERGED_PR_PAGE_SIZE,
  OPEN_PR_PAGE_SIZE,
  parsePrUrl,
  REPO_PAGE_SIZE,
  VIEWER_PRS_QUERY,
  decodeRestPr,
  type RawPrSummary,
} from "./queries.ts";

/** Cache lifetimes, straight from the technical specification. */
const IDENTITY_TTL = Duration.hours(1);
const PR_LIST_TTL = Duration.seconds(60);
const PR_DETAIL_TTL = Duration.seconds(30);
/** The floor between two refreshes, however many times the reviewer asks. */
const MIN_REFRESH_INTERVAL = Duration.seconds(15);
/** Jitter added to a reported reset so every client does not wake together. */
const PARK_JITTER = Duration.seconds(2);
/** Used when GitHub reports a rate limit without a reset we can read. */
const PARK_FALLBACK = Duration.seconds(60);
const API_CONCURRENCY = 2;
const CACHE_CAPACITY = 512;

/** The module refuses this call because the quota is exhausted. */
export class GitHubParkedError extends Data.TaggedError("GitHubParkedError")<{
  readonly resetAtMillis: number;
  readonly detail: string;
}> {}

/** `gh` is missing or unauthenticated — a visible, parked state with instructions. */
export class GitHubUnavailableError extends Data.TaggedError("GitHubUnavailableError")<{
  readonly reason: "missing" | "unauthenticated";
  readonly detail: string;
}> {}

/** The pull request is not visible to this login (indistinguishable from private). */
export class GitHubNotFoundError extends Data.TaggedError("GitHubNotFoundError")<{
  readonly detail: string;
}> {}

/** Everything else, after retries were exhausted. */
export class GitHubFailedError extends Data.TaggedError("GitHubFailedError")<{
  readonly detail: string;
}> {}

export type GitHubError =
  | GitHubParkedError
  | GitHubUnavailableError
  | GitHubNotFoundError
  | GitHubFailedError;

export interface PrListing {
  readonly login: string;
  readonly open: ReadonlyArray<PrSummary>;
  readonly merged: ReadonlyArray<PrSummary>;
  readonly fetchedAtMillis: number;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    /** Login + auth state. Cached for an hour; never throws. */
    readonly identity: Effect.Effect<Viewer>;
    /** The viewer's repositories and their pull requests, from one query. */
    readonly prs: Effect.Effect<PrListing, GitHubError>;
    /**
     * Ask for a fresh list. Honours the minimum interval and the park; returns
     * whether a request was actually sent.
     */
    readonly refreshPrs: Effect.Effect<boolean, GitHubError>;
    /** One pull request's current state — the freshness source for staleness. */
    readonly pr: (ref: PrRef) => Effect.Effect<PrSummary, GitHubError>;
    /** The same, but never sends a request: staleness checks reuse the cache. */
    readonly cachedPr: (ref: PrRef) => Effect.Effect<Option.Option<PrSummary>>;
    /** Door validation for a pasted URL. */
    readonly resolveUrl: (url: string) => Effect.Effect<PrRef, DoorRejection>;
    /** Hands git a token; git itself moves the repository bytes. */
    readonly cloneToken: Effect.Effect<string, GitHubError>;
    /** The module's honest health, for the welcome screen's banner. */
    readonly health: Effect.Effect<GitHubHealth>;
    /** Drop a PR from the detail cache (after an ingestion pins a new head). */
    readonly invalidatePr: (ref: PrRef) => Effect.Effect<void>;
  }
>()("@app/server/github/GitHub") {}

const prKey = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;

/**
 * Only transport failures retry, and the predicate is on the *tag* rather than a
 * message match — so a new 4xx signature can never accidentally become retryable.
 */
const TRANSIENT_TAGS = new Set<GhError["_tag"]>(["GhTransientError"]);

const retryPolicy = Schedule.min([
  Schedule.exponential("400 millis", 2),
  Schedule.spaced("4 seconds"),
]).pipe(
  Schedule.jittered,
  // 2 retries == 3 total attempts, per the specification's cap.
  Schedule.upTo({ times: 2 }),
  Schedule.setInputType<GhError>(),
  Schedule.while(({ input }) => TRANSIENT_TAGS.has(input._tag)),
);

const make = Effect.gen(function* () {
  const runner = yield* GhRunner;
  const gate = yield* Semaphore.make(API_CONCURRENCY);
  /**
   * The one gate. Every request in this module goes through it, and there is no
   * code path around it — which is the whole reason the concurrency promise is
   * enforceable rather than aspirational.
   */
  const withGate = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    gate.withPermits(1)(effect);
  const runGh = (args: ReadonlyArray<string>, options?: { readonly timeout?: Duration.Input }) =>
    runner.run(args, options);

  /** `0` means open. Never shortened once set — a park only ever extends. */
  const parkedUntil = yield* Ref.make(0);
  const lastRefreshAt = yield* Ref.make(0);
  const lastFailure = yield* Ref.make<string | null>(null);

  const park = (resetAtMillis: number) =>
    Ref.update(parkedUntil, (current) => Math.max(current, resetAtMillis));

  /** Remaining park, clearing an elapsed one. Time comes from `Clock`, always. */
  const parkRemaining: Effect.Effect<Option.Option<number>> = Effect.gen(function* () {
    const until = yield* Ref.get(parkedUntil);
    if (until === 0) return Option.none();
    const now = yield* Clock.currentTimeMillis;
    if (now >= until) {
      yield* Ref.update(parkedUntil, (current) => (current === until ? 0 : current));
      return Option.none();
    }
    return Option.some(until);
  });

  /**
   * Every request in the module goes through here. The order is the whole
   * discipline: check the park (fail fast, send nothing), take a permit, retry
   * only transport failures inside that permit, then translate.
   */
  const request = <A>(
    label: string,
    args: ReadonlyArray<string>,
    decode: (stdout: string) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, GitHubError> =>
    Effect.gen(function* () {
      const until = yield* parkRemaining;
      if (Option.isSome(until)) {
        return yield* new GitHubParkedError({
          resetAtMillis: until.value,
          detail: "GitHub's rate limit is exhausted; Throughline is waiting it out.",
        });
      }

      const nowMillis = yield* Clock.currentTimeMillis;
      const stdout = yield* withGate(runGh(args).pipe(Effect.retry(retryPolicy))).pipe(
        Effect.tapError((cause) =>
          cause._tag === "GhRateLimitedError"
            ? Effect.gen(function* () {
                const reset =
                  cause.resetAtMillis ??
                  (yield* discoverResetAt().pipe(Effect.orElseSucceed(() => null))) ??
                  (yield* Clock.currentTimeMillis) + Duration.toMillis(PARK_FALLBACK);
                yield* park(reset + Duration.toMillis(PARK_JITTER));
                yield* Effect.logWarning("GitHub rate limit reached; parking the module", {
                  resetAt: new Date(reset).toISOString(),
                  secondary: cause.secondary,
                });
              })
            : Effect.void,
        ),
        Effect.mapError((cause) => toGitHubError(cause, nowMillis)),
      );

      yield* Ref.set(lastFailure, null);
      return yield* decode(stdout).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubFailedError({
              detail: `GitHub's answer to ${label} could not be read: ${String(cause)}`,
            }),
        ),
      );
    }).pipe(
      Effect.tapError((cause) =>
        cause._tag === "GitHubFailedError" || cause._tag === "GitHubNotFoundError"
          ? Ref.set(lastFailure, cause.detail)
          : Effect.void,
      ),
      Effect.withSpan("github.request", { attributes: { "github.call": label } }),
    );

  /**
   * `/rate_limit` does not itself count against the quota, so it is the one
   * honest way to learn a reset instant. It runs *outside* the park (the park
   * does not exist yet at this point) but still inside the gate.
   */
  const discoverResetAt = (): Effect.Effect<number | null> =>
    withGate(runGh(["api", "rate_limit"], { timeout: "10 seconds" })).pipe(
      Effect.flatMap((stdout) => decodeRateLimit(stdout)),
      Effect.map((body) => {
        const core = body.resources.core.reset * 1000;
        const graphql = body.resources.graphql?.reset;
        return graphql === undefined ? core : Math.max(core, graphql * 1000);
      }),
      Effect.orElseSucceed(() => null),
    );

  // ── Identity ──────────────────────────────────────────────────────────────

  const probeIdentity: Effect.Effect<Viewer> = Effect.gen(function* () {
    const version = yield* withGate(runGh(["--version"], { timeout: "10 seconds" })).pipe(
      Effect.map(firstLine),
      Effect.option,
    );
    if (Option.isNone(version)) {
      return {
        auth: "missing" as const,
        login: null,
        ghVersion: null,
        detail:
          "Throughline reads GitHub through the GitHub CLI. Install `gh` (https://cli.github.com), run `gh auth login`, then refresh.",
      };
    }

    const user = yield* withGate(runGh(["api", "user"], { timeout: "20 seconds" })).pipe(
      Effect.flatMap(decodeViewerUser),
      Effect.result,
    );
    if (user._tag === "Success") {
      return {
        auth: "authenticated" as const,
        login: user.success.login,
        ghVersion: version.value,
        detail: null,
      };
    }
    return {
      auth: "unauthenticated" as const,
      login: null,
      ghVersion: version.value,
      detail:
        "The GitHub CLI is installed but not authenticated. Run `gh auth login`, then refresh.",
    };
  });

  const identityCache = yield* Cache.makeWith<"viewer", Viewer, never>(() => probeIdentity, {
    capacity: 1,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.auth === "authenticated"
        ? IDENTITY_TTL
        : // An unauthenticated probe is cheap and the reviewer is probably
          // about to fix it, so do not hold the bad answer for an hour.
          Duration.seconds(10),
  });

  // ── The PR list ───────────────────────────────────────────────────────────

  const fetchPrs: Effect.Effect<PrListing, GitHubError> = Effect.gen(function* () {
    const raw = yield* request(
      "github.prs",
      [
        "api",
        "graphql",
        "-f",
        `query=${VIEWER_PRS_QUERY}`,
        "-F",
        `repos=${REPO_PAGE_SIZE}`,
        "-F",
        `open=${OPEN_PR_PAGE_SIZE}`,
        "-F",
        `merged=${MERGED_PR_PAGE_SIZE}`,
      ],
      (stdout) => decodeViewerPrs(stdout).pipe(Effect.map(flattenViewerPrs)),
    );

    const open = yield* decodeMany(raw.open);
    const merged = yield* decodeMany(raw.merged);
    const fetchedAtMillis = yield* Clock.currentTimeMillis;
    yield* Ref.set(lastRefreshAt, fetchedAtMillis);
    return { login: raw.login, open, merged, fetchedAtMillis };
  });

  const prsCache = yield* Cache.makeWith<"prs", PrListing, GitHubError>(() => fetchPrs, {
    capacity: 1,
    // A failed list is never cached: the reviewer's next refresh must be a
    // real attempt, not a replay of the error.
    timeToLive: (exit) => (Exit.isSuccess(exit) ? PR_LIST_TTL : Duration.zero),
  });

  const prDetailCache = yield* Cache.makeWith<string, PrSummary, GitHubError>(
    (key) => {
      const ref = refFromKey(key);
      return request(
        "github.pr",
        ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`],
        (stdout) => decodeRestPr(stdout).pipe(Effect.map((body) => fromRestPr(ref, body))),
      ).pipe(Effect.flatMap((raw) => decodeRaw(raw)));
    },
    {
      capacity: CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PR_DETAIL_TTL : Duration.zero),
    },
  );

  const health: Effect.Effect<GitHubHealth> = Effect.gen(function* () {
    const until = yield* parkRemaining;
    if (Option.isSome(until)) {
      return {
        status: "parked" as const,
        detail:
          "GitHub's rate limit is exhausted. Throughline will not send another request until it resets.",
        resetAt: DateTime.makeUnsafe(until.value),
      };
    }
    const failure = yield* Ref.get(lastFailure);
    if (failure !== null) {
      return { status: "failing" as const, detail: failure, resetAt: null };
    }
    return { status: "ok" as const, detail: null, resetAt: null };
  });

  return {
    identity: Cache.get(identityCache, "viewer"),

    prs: Cache.get(prsCache, "prs"),

    refreshPrs: Effect.gen(function* () {
      const until = yield* parkRemaining;
      if (Option.isSome(until)) {
        return yield* new GitHubParkedError({
          resetAtMillis: until.value,
          detail: "GitHub's rate limit is exhausted; Throughline is waiting it out.",
        });
      }
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastRefreshAt);
      if (now - last < Duration.toMillis(MIN_REFRESH_INTERVAL)) {
        // Honest no-op: the reviewer asked, but the floor says not yet.
        return false;
      }
      yield* Cache.invalidate(prsCache, "prs");
      yield* Cache.get(prsCache, "prs");
      return true;
    }),

    pr: (ref) => Cache.get(prDetailCache, prKey(ref)),

    /**
     * Both caches, never a request.
     *
     * Staleness is computed at the moment of display from the module's *cached*
     * view, so this must never send anything. But the two caches fill from
     * different calls: the welcome screen's one GraphQL query fills the list
     * cache, while `pr()` fills the detail cache. Consulting only the detail
     * cache means staleness is unknowable in the common case where the reviewer
     * opened a journey from the list — which is exactly the case that matters.
     */
    cachedPr: (ref) =>
      Cache.getSuccess(prDetailCache, prKey(ref)).pipe(
        Effect.flatMap((detail) =>
          Option.isSome(detail)
            ? Effect.succeed(detail)
            : Cache.getSuccess(prsCache, "prs").pipe(
                Effect.map(
                  Option.flatMap((listing) =>
                    Option.fromNullishOr(
                      [...listing.open, ...listing.merged].find(
                        (candidate) =>
                          candidate.ref.owner === ref.owner &&
                          candidate.ref.repo === ref.repo &&
                          candidate.ref.number === ref.number,
                      ),
                    ),
                  ),
                ),
              ),
        ),
      ),

    resolveUrl: (url) =>
      Effect.gen(function* () {
        const ref = parsePrUrl(url);
        if (ref === null) {
          return yield* new DoorRejection({
            reason: "invalid-url",
            detail:
              "That does not look like a GitHub pull request. Paste a link like https://github.com/owner/repo/pull/123.",
            resetAt: null,
          });
        }
        return ref;
      }),

    cloneToken: request("github.cloneToken", ["auth", "token"], (stdout) =>
      Effect.succeed(firstLine(stdout)),
    ),

    health,

    invalidatePr: (ref) => Cache.invalidate(prDetailCache, prKey(ref)),
  } satisfies GitHub["Service"];
});

/**
 * The module without its runner provided. Exported so the adversarial tests can
 * substitute a scripted `GhRunner` and *count requests* — the only way the
 * "exactly one request" and "zero requests while parked" promises are checkable.
 */
export const layerRequiringRunner: Layer.Layer<GitHub, never, GhRunner> = Layer.effect(
  GitHub,
  make,
);

export const layer = layerRequiringRunner.pipe(Layer.provide(GhRunnerLayer));

// ── Helpers ─────────────────────────────────────────────────────────────────

function refFromKey(key: string): PrRef {
  const [ownerRepo = "", numberRaw = "0"] = key.split("#");
  const slash = ownerRepo.lastIndexOf("/");
  return {
    owner: ownerRepo.slice(0, slash),
    repo: ownerRepo.slice(slash + 1),
    number: Number.parseInt(numberRaw, 10),
  };
}

const decodeRaw = (raw: RawPrSummary): Effect.Effect<PrSummary, GitHubError> =>
  decodePrSummary(raw).pipe(
    Effect.mapError(
      (cause) =>
        new GitHubFailedError({
          detail: `A pull request from GitHub could not be read: ${String(cause)}`,
        }),
    ),
  );

/**
 * Decode a batch, dropping (and logging) individual rows that fail rather than
 * failing the whole list. One malformed PR must not empty the welcome screen.
 */
const decodeMany = (raws: ReadonlyArray<RawPrSummary>): Effect.Effect<ReadonlyArray<PrSummary>> =>
  Effect.forEach(raws, (raw) =>
    decodePrSummary(raw).pipe(
      Effect.map(Option.some),
      Effect.catch((cause) =>
        Effect.logWarning("Dropped a pull request Throughline could not read", {
          cause,
          ref: raw.ref,
        }).pipe(Effect.as(Option.none<PrSummary>())),
      ),
    ),
  ).pipe(Effect.map((results) => results.filter(Option.isSome).map((entry) => entry.value)));

/**
 * `nowMillis` is passed in rather than read from `Date.now()`: the park's whole
 * behaviour is a time comparison, and a wall-clock read here would make it
 * untestable — which is exactly the property the specification's adversarial
 * tests exist to pin.
 */
function toGitHubError(cause: GhError, nowMillis: number): GitHubError {
  switch (cause._tag) {
    case "GhUnavailableError":
      return new GitHubUnavailableError({ reason: cause.reason, detail: cause.detail });
    case "GhRateLimitedError":
      return new GitHubParkedError({
        resetAtMillis: cause.resetAtMillis ?? nowMillis + Duration.toMillis(PARK_FALLBACK),
        detail: cause.detail,
      });
    case "GhClientError":
      return cause.status === 404 || cause.status === 403
        ? new GitHubNotFoundError({
            detail:
              "That pull request is not visible to your `gh` login. It may be private, or it may not exist.",
          })
        : new GitHubFailedError({ detail: cause.detail });
    case "GhTransientError":
      return new GitHubFailedError({ detail: cause.detail });
  }
}

/** Exported for the adversarial unit tests, which assert on the rate discipline. */
export const internals = { parsePrUrl, toGitHubError, retryPolicy } as const;
