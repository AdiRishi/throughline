import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  GitHubOwner,
  GitHubParkedError,
  GitHubReadError,
  GitHubRepositoryName,
  IngestionDoorRejectionError,
  PrDetail,
  PrRef,
  PrSummary,
  TrimmedNonEmptyString,
  Viewer,
  type PullRequestState,
} from "@app/contracts";

import * as GhCli from "./GhCli.ts";

const GRAPHQL_PAGE_SIZE = 100;
const GRAPHQL_CONNECTION_BATCH_SIZE = 20;

const GRAPHQL_PULL_REQUEST_PAGE_FRAGMENT = `fragment ThroughlinePullRequestPage on PullRequestConnection {
  nodes {
    number
    title
    author {
      login
      avatarUrl
    }
    url
    state
    baseRefName
    headRefOid
    updatedAt
    mergedAt
    changedFiles
    additions
    deletions
  }
  pageInfo {
    hasNextPage
    endCursor
  }
}`;

const GRAPHQL_PULL_REQUESTS_QUERY = `query ThroughlinePullRequests($repositoryCursor: String) {
  viewer {
    repositories(
      first: ${GRAPHQL_PAGE_SIZE}
      after: $repositoryCursor
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      nodes {
        name
        owner {
          login
        }
        openPullRequests: pullRequests(
          first: ${GRAPHQL_PAGE_SIZE}
          states: OPEN
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          ...ThroughlinePullRequestPage
        }
        mergedPullRequests: pullRequests(
          first: ${GRAPHQL_PAGE_SIZE}
          states: MERGED
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          ...ThroughlinePullRequestPage
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
${GRAPHQL_PULL_REQUEST_PAGE_FRAGMENT}`;

const RawPullRequestAuthor = Schema.Struct({
  login: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
});

const RawPullRequest = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  author: Schema.NullOr(RawPullRequestAuthor),
  url: Schema.String,
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  updatedAt: Schema.DateTimeUtcFromString,
  mergedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  changedFiles: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});

const RawPageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
});

const RawPullRequestConnection = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(RawPullRequest)),
  pageInfo: RawPageInfo,
});

const RawRepository = Schema.Struct({
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  openPullRequests: RawPullRequestConnection,
  mergedPullRequests: RawPullRequestConnection,
});

const RawRepositoryConnection = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(RawRepository)),
  pageInfo: RawPageInfo,
});

const RawGraphQlError = Schema.Struct({
  message: Schema.String,
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const RawRepositoriesResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.NullOr(
          Schema.Struct({
            repositories: RawRepositoryConnection,
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optionalKey(Schema.Array(RawGraphQlError)),
});

const RawPullRequestPageResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.NullOr(
          Schema.Struct({
            page: RawPullRequestConnection,
          }),
        ),
      ),
    ),
  ),
  errors: Schema.optionalKey(Schema.Array(RawGraphQlError)),
});

const RawViewerResponse = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String),
});

const RawPrDetailResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      avatar_url: Schema.NullOr(Schema.String),
    }),
  ),
  html_url: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  base: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
    repo: Schema.Struct({
      name: Schema.String,
      owner: Schema.Struct({ login: Schema.String }),
    }),
  }),
  head: Schema.Struct({ sha: Schema.String }),
  updated_at: Schema.DateTimeUtcFromString,
  changed_files: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});

const RepositoryIdentity = Schema.Struct({
  owner: GitHubOwner,
  name: GitHubRepositoryName,
});

const decodeRepositoriesResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RawRepositoriesResponse),
);
const decodePullRequestPageResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RawPullRequestPageResponse),
);
const decodeViewerResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(RawViewerResponse));
const decodePrDetailResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RawPrDetailResponse),
);
const decodeViewer = Schema.decodeUnknownEffect(Viewer);
const decodePrSummary = Schema.decodeUnknownEffect(PrSummary);
const decodePrDetail = Schema.decodeUnknownEffect(PrDetail);
const decodeRepositoryIdentity = Schema.decodeUnknownEffect(RepositoryIdentity);
const decodePrRef = Schema.decodeUnknownEffect(PrRef);
const decodeTrimmedString = Schema.decodeUnknownSync(TrimmedNonEmptyString);

const EMPTY_VIEWER: Viewer = {
  auth: "unauthenticated",
  login: null,
  name: null,
  avatarUrl: null,
};

export interface GitHubRepository {
  readonly owner: GitHubOwner;
  readonly name: GitHubRepositoryName;
  readonly openPullRequests: ReadonlyArray<PrSummary>;
  readonly recentlyMergedPullRequests: ReadonlyArray<PrSummary>;
}

export interface GitCredential {
  readonly username: "x-access-token";
  readonly password: string;
}

export interface GitHubReadOptions {
  readonly signal?: AbortSignal;
}

export interface GitHubOptions {
  readonly retryDelays?: readonly [Duration.Input, Duration.Input];
  readonly rateLimitJitter?: Duration.Input;
}

type GitHubFailure = GitHubReadError | GitHubParkedError;

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly identity: (options?: GitHubReadOptions) => Effect.Effect<Viewer, GitHubFailure>;
    readonly repositories: (
      options?: GitHubReadOptions,
    ) => Effect.Effect<ReadonlyArray<GitHubRepository>, GitHubFailure>;
    readonly pullRequests: (
      options?: GitHubReadOptions,
    ) => Effect.Effect<ReadonlyArray<PrSummary>, GitHubFailure>;
    readonly openPrs: (
      options?: GitHubReadOptions,
    ) => Effect.Effect<ReadonlyArray<PrSummary>, GitHubFailure>;
    readonly recentlyMergedPrs: (
      options?: GitHubReadOptions,
    ) => Effect.Effect<ReadonlyArray<PrSummary>, GitHubFailure>;
    readonly pr: (
      ref: PrRef,
      options?: GitHubReadOptions,
    ) => Effect.Effect<PrDetail, GitHubFailure>;
    readonly refreshPrs: (options?: GitHubReadOptions) => Effect.Effect<void, GitHubFailure>;
    readonly retry: () => Effect.Effect<void, GitHubParkedError>;
    readonly resolveUrl: (url: string) => Effect.Effect<PrRef, IngestionDoorRejectionError>;
    readonly cloneCredentials: (
      options?: GitHubReadOptions,
    ) => Effect.Effect<GitCredential, GitHubReadError>;
  }
>()("@app/server/github/GitHub") {}

interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly detail: string;
}

type Park =
  | {
      readonly _tag: "RateLimit";
      readonly resetAt: DateTime.Utc;
    }
  | {
      readonly _tag: "Transport";
      readonly detail: string;
    };

class RetryableGitHubFailure extends Data.TaggedError("RetryableGitHubFailure")<{
  readonly detail: string;
}> {}

const makeReadError = (
  reason: "unavailable" | "unauthenticated" | "not-found" | "forbidden" | "client" | "transport",
  detail: string,
) =>
  new GitHubReadError({
    reason,
    detail: decodeTrimmedString(detail.trim() || "GitHub request failed."),
  });

const makeDoorRejection = (
  reason: "invalid-url" | "gh-unavailable" | "not-found" | "not-open",
  input: string,
  detail: string,
) =>
  new IngestionDoorRejectionError({
    reason,
    input: decodeTrimmedString(input.trim() || "(empty)"),
    detail: decodeTrimmedString(detail),
  });

const schemaFailure = (context: string, error: unknown) =>
  makeReadError("transport", `${context}: ${String(error)}`);

const stateFromApi = (
  state: "OPEN" | "MERGED" | "CLOSED" | "open" | "closed",
  mergedAt: DateTime.Utc | null,
): PullRequestState => {
  if (mergedAt !== null || state === "MERGED") {
    return "merged";
  }
  return state === "OPEN" || state === "open" ? "open" : "closed";
};

const normalizedName = (value: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

const parseIncludedResponse = (result: GhCli.GhCliResult): HttpResponse => {
  const stdout = result.stdout.replaceAll("\r\n", "\n");
  const headerPattern = /^HTTP\/\S+\s+(\d{3})[^\n]*\n((?:[^\n]*\n)*?)\n/gm;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = headerPattern.exec(stdout)) !== null) {
    lastMatch = match;
  }

  const headers: Record<string, string> = {};
  let body = stdout;
  let status = result.exitCode === 0 ? 200 : 0;

  if (lastMatch !== null) {
    status = Number(lastMatch[1]);
    body = stdout.slice(lastMatch.index + lastMatch[0].length);
    for (const line of (lastMatch[2] ?? "").split("\n")) {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        continue;
      }
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
  } else {
    const stderrStatus = /\bHTTP\s+(\d{3})\b/i.exec(result.stderr);
    if (stderrStatus !== null) {
      status = Number(stderrStatus[1]);
    }
  }

  const detail =
    result.stderr.trim() ||
    body.trim().slice(0, 500) ||
    (status === 0 ? "GitHub CLI request failed." : `GitHub returned HTTP ${status}.`);

  return { status, headers, body, detail };
};

const isRateLimitResponse = (response: HttpResponse): boolean => {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  const text = `${response.detail}\n${response.body}`.toLowerCase();
  return (
    response.headers["retry-after"] !== undefined ||
    response.headers["x-ratelimit-remaining"] === "0" ||
    text.includes("rate limit") ||
    text.includes("secondary rate") ||
    text.includes("abuse detection")
  );
};

const isGraphQlRateLimit = (
  errors: ReadonlyArray<{ readonly message: string; readonly type?: string | null }>,
): boolean =>
  errors.some((error) => {
    const text = `${error.type ?? ""} ${error.message}`.toLowerCase();
    return (
      text.includes("rate_limit") || text.includes("rate limit") || text.includes("abuse detection")
    );
  });

const abortEffect = (signal: AbortSignal): Effect.Effect<never> =>
  Effect.callback<never>((resume) => {
    if (signal.aborted) {
      resume(Effect.interrupt);
      return;
    }
    const onAbort = () => resume(Effect.interrupt);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

const withAbortSignal = <A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
): Effect.Effect<A, E> =>
  signal === undefined ? effect : Effect.raceFirst(effect, abortEffect(signal));

const cacheTimeToLive = (successTtl: Duration.Input) => (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? successTtl : Duration.zero;

const detailCacheKey = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;

const refFromDetailCacheKey = (key: string): Effect.Effect<PrRef, GitHubReadError> => {
  const match = /^([^/]+)\/(.+)#([1-9]\d*)$/.exec(key);
  if (match === null) {
    return Effect.die(`Invalid internal PR cache key: ${key}`);
  }
  return decodePrRef({
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  }).pipe(Effect.mapError((error) => schemaFailure("Invalid internal PR cache key", error)));
};

const flattenOpen = (repositories: ReadonlyArray<GitHubRepository>) =>
  repositories.flatMap((repository) => repository.openPullRequests);

const flattenMerged = (repositories: ReadonlyArray<GitHubRepository>) =>
  repositories.flatMap((repository) => repository.recentlyMergedPullRequests);

type RawPullRequestValue = typeof RawPullRequest.Type;
type RawPullRequestConnectionValue = typeof RawPullRequestConnection.Type;

interface RawRepositoryAccumulator {
  readonly name: string;
  readonly owner: { readonly login: string };
  readonly openPullRequests: Array<RawPullRequestValue>;
  readonly mergedPullRequests: Array<RawPullRequestValue>;
}

interface PullRequestPageRequest {
  readonly repositoryKey: string;
  readonly owner: string;
  readonly name: string;
  readonly kind: "open" | "merged";
  readonly cursor: string;
}

const repositoryKey = (owner: string, name: string): string => JSON.stringify([owner, name]);

const appendUniquePullRequests = (
  target: Array<RawPullRequestValue>,
  nodes: ReadonlyArray<RawPullRequestValue | null>,
): void => {
  const numbers = new Set(target.map((pullRequest) => pullRequest.number));
  for (const pullRequest of nodes) {
    if (pullRequest === null || numbers.has(pullRequest.number)) continue;
    numbers.add(pullRequest.number);
    target.push(pullRequest);
  }
};

const mergedPageCanContainRecentPullRequests = (
  connection: RawPullRequestConnectionValue,
  mergedCutoff: DateTime.Utc,
): boolean => {
  const lastPullRequest = connection.nodes.findLast((pullRequest) => pullRequest !== null);
  return (
    lastPullRequest === undefined ||
    DateTime.isGreaterThanOrEqualTo(lastPullRequest.updatedAt, mergedCutoff)
  );
};

const graphQlArgs = (
  query: string,
  variables: Readonly<Record<string, string>> = {},
): ReadonlyArray<string> => [
  "api",
  "graphql",
  "--include",
  "--cache",
  "60s",
  "-f",
  `query=${query}`,
  ...Object.entries(variables).flatMap(([name, value]) => ["-f", `${name}=${value}`]),
];

const pullRequestPagesQuery = (requests: ReadonlyArray<PullRequestPageRequest>): string => {
  const variables = requests
    .flatMap((_, index) => [
      `$owner${index}: String!`,
      `$name${index}: String!`,
      `$cursor${index}: String!`,
    ])
    .join(", ");
  const pages = requests
    .map(
      (request, index) => `page${index}: repository(owner: $owner${index}, name: $name${index}) {
    page: pullRequests(
      first: ${GRAPHQL_PAGE_SIZE}
      after: $cursor${index}
      states: ${request.kind === "open" ? "OPEN" : "MERGED"}
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      ...ThroughlinePullRequestPage
    }
  }`,
    )
    .join("\n");
  return `query ThroughlinePullRequestPages(${variables}) {
  ${pages}
}
${GRAPHQL_PULL_REQUEST_PAGE_FRAGMENT}`;
};

const pullRequestPageVariables = (
  requests: ReadonlyArray<PullRequestPageRequest>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    requests.flatMap((request, index) => [
      [`owner${index}`, request.owner],
      [`name${index}`, request.name],
      [`cursor${index}`, request.cursor],
    ]),
  );

const makeRepository = (
  raw: RawRepositoryAccumulator,
  mergedCutoff: DateTime.Utc,
): Effect.Effect<GitHubRepository, GitHubReadError> =>
  Effect.gen(function* () {
    const identity = yield* decodeRepositoryIdentity({
      owner: raw.owner.login,
      name: raw.name,
    }).pipe(Effect.mapError((error) => schemaFailure("Invalid GitHub repository", error)));

    const mapPullRequest = (pullRequest: typeof RawPullRequest.Type) =>
      decodePrSummary({
        ref: {
          owner: identity.owner,
          repo: identity.name,
          number: pullRequest.number,
        },
        title: pullRequest.title,
        author: {
          login: pullRequest.author?.login ?? "ghost",
          avatarUrl: pullRequest.author?.avatarUrl ?? null,
        },
        url: pullRequest.url,
        state: stateFromApi(pullRequest.state, pullRequest.mergedAt),
        baseRefName: pullRequest.baseRefName,
        headSha: pullRequest.headRefOid,
        updatedAt: pullRequest.updatedAt,
        mergedAt: pullRequest.mergedAt,
        changedFiles: pullRequest.changedFiles,
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        journey: null,
      }).pipe(Effect.mapError((error) => schemaFailure("Invalid GitHub pull request", error)));

    const openPullRequests = yield* Effect.forEach(raw.openPullRequests, mapPullRequest);
    const mergedPullRequests = yield* Effect.forEach(raw.mergedPullRequests, mapPullRequest);

    return {
      ...identity,
      openPullRequests,
      recentlyMergedPullRequests: mergedPullRequests.filter(
        (pullRequest) =>
          pullRequest.mergedAt !== null &&
          DateTime.isGreaterThanOrEqualTo(pullRequest.mergedAt, mergedCutoff),
      ),
    };
  });

export const make = (options: GitHubOptions = {}) =>
  Effect.gen(function* () {
    const gh = yield* GhCli.GhCli;
    const semaphore = yield* Semaphore.make(2);
    const park = yield* Ref.make<Option.Option<Park>>(Option.none());
    const retryDelays = options.retryDelays ?? [Duration.millis(250), Duration.seconds(1)];
    const rateLimitJitter = options.rateLimitJitter ?? Duration.seconds(1);

    const checkPark = Effect.gen(function* () {
      const current = yield* Ref.get(park);
      if (Option.isNone(current)) {
        return;
      }
      if (current.value._tag === "Transport") {
        return yield* makeReadError("transport", current.value.detail);
      }
      const now = yield* DateTime.now;
      if (DateTime.isLessThan(now, current.value.resetAt)) {
        return yield* new GitHubParkedError({ resetAt: current.value.resetAt });
      }
      yield* Ref.set(park, Option.none());
    });

    const rateLimitReset = (response: HttpResponse): Effect.Effect<DateTime.Utc> =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const nowMillis = DateTime.toEpochMillis(now);
        const retryAfter = response.headers["retry-after"];
        const rateLimitResetHeader = response.headers["x-ratelimit-reset"];
        let resetMillis: number | undefined;

        if (retryAfter !== undefined) {
          const seconds = Number(retryAfter);
          resetMillis = Number.isFinite(seconds)
            ? nowMillis + Math.max(seconds, 0) * 1_000
            : Date.parse(retryAfter);
        } else if (rateLimitResetHeader !== undefined) {
          const secondsSinceEpoch = Number(rateLimitResetHeader);
          if (Number.isFinite(secondsSinceEpoch)) {
            resetMillis = secondsSinceEpoch * 1_000;
          }
        }

        if (resetMillis === undefined || !Number.isFinite(resetMillis) || resetMillis < nowMillis) {
          resetMillis = nowMillis + Duration.toMillis(Duration.minutes(1));
        }
        const jitter = yield* Random.next;
        return DateTime.makeUnsafe(
          resetMillis + Math.floor(Duration.toMillis(rateLimitJitter) * jitter),
        );
      });

    const parkForRateLimit = (response: HttpResponse): Effect.Effect<never, GitHubParkedError> =>
      Effect.gen(function* () {
        const resetAt = yield* rateLimitReset(response);
        yield* Ref.set(park, Option.some<Park>({ _tag: "RateLimit", resetAt }));
        return yield* new GitHubParkedError({ resetAt });
      });

    const runApiAttempt = (
      args: ReadonlyArray<string>,
    ): Effect.Effect<HttpResponse, RetryableGitHubFailure | GitHubReadError | GitHubParkedError> =>
      Effect.gen(function* () {
        const command = Effect.suspend(() => gh.run({ args })).pipe(
          Effect.mapError((error): GitHubReadError | RetryableGitHubFailure =>
            error.reason === "unavailable"
              ? makeReadError("unavailable", error.detail)
              : new RetryableGitHubFailure({ detail: error.detail }),
          ),
        );
        return yield* semaphore.withPermits(1)(
          Effect.gen(function* () {
            yield* checkPark;
            const result = yield* command;
            const response = parseIncludedResponse(result);

            if (isRateLimitResponse(response)) {
              return yield* parkForRateLimit(response);
            }
            if (response.status >= 500 || response.status === 0) {
              return yield* new RetryableGitHubFailure({ detail: response.detail });
            }
            if (response.status >= 400 || result.exitCode !== 0) {
              const reason =
                response.status === 401
                  ? "unauthenticated"
                  : response.status === 404
                    ? "not-found"
                    : response.status === 403
                      ? "forbidden"
                      : "client";
              return yield* makeReadError(reason, response.detail);
            }
            return response;
          }),
        );
      });

    const runApi = (
      args: ReadonlyArray<string>,
    ): Effect.Effect<HttpResponse, GitHubReadError | GitHubParkedError> => {
      const attempt = (
        attemptIndex: number,
      ): Effect.Effect<HttpResponse, GitHubReadError | GitHubParkedError> =>
        runApiAttempt(args).pipe(
          Effect.catchTag("RetryableGitHubFailure", (error) => {
            if (attemptIndex >= 2) {
              const detail = `GitHub reads are paused after three failed attempts: ${error.detail}`;
              return Ref.set(park, Option.some<Park>({ _tag: "Transport", detail })).pipe(
                Effect.andThen(Effect.fail(makeReadError("transport", detail))),
              );
            }
            const delay = attemptIndex === 0 ? retryDelays[0] : retryDelays[1];
            return Random.next.pipe(
              Effect.flatMap((jitter) =>
                Effect.sleep(
                  Duration.millis(Math.floor(Duration.toMillis(delay) * (0.75 + jitter * 0.5))),
                ),
              ),
              Effect.andThen(attempt(attemptIndex + 1)),
            );
          }),
        );
      return attempt(0);
    };

    const ensureGraphQlSuccess = Effect.fn("GitHub.ensureGraphQlSuccess")(function* (
      response: HttpResponse,
      errors: ReadonlyArray<typeof RawGraphQlError.Type>,
      context: string,
    ) {
      if (errors.length === 0) return;
      if (isGraphQlRateLimit(errors)) {
        return yield* parkForRateLimit(response);
      }
      return yield* makeReadError(
        "transport",
        `${context}: ${errors.map((error) => error.message).join("; ")}`,
      );
    });

    const continuationCursor = Effect.fn("GitHub.continuationCursor")(function* (
      pageInfo: typeof RawPageInfo.Type,
      context: string,
      previousCursor: string | null,
    ) {
      if (!pageInfo.hasNextPage) return null;
      if (
        pageInfo.endCursor === null ||
        pageInfo.endCursor.length === 0 ||
        pageInfo.endCursor === previousCursor
      ) {
        return yield* makeReadError(
          "transport",
          `${context} reported another page without an advancing cursor.`,
        );
      }
      return pageInfo.endCursor;
    });

    const fetchIdentity = Effect.gen(function* () {
      const authStatus = yield* gh
        .run({
          args: ["auth", "status", "--hostname", "github.com"],
        })
        .pipe(
          Effect.catchTag("GhCliError", (error) =>
            error.reason === "unavailable"
              ? Effect.succeed<GhCli.GhCliResult>({
                  exitCode: 127,
                  stdout: "",
                  stderr: error.detail,
                })
              : Effect.fail(makeReadError("transport", error.detail)),
          ),
        );

      if (authStatus.exitCode === 127) {
        return yield* decodeViewer({
          ...EMPTY_VIEWER,
          auth: "unavailable",
        }).pipe(Effect.mapError((error) => schemaFailure("Invalid GitHub viewer", error)));
      }
      if (authStatus.exitCode !== 0) {
        return EMPTY_VIEWER;
      }

      const response = yield* runApi(["api", "user", "--include", "--cache", "1h"]);
      const raw = yield* decodeViewerResponse(response.body).pipe(
        Effect.mapError((error) => schemaFailure("Invalid GitHub viewer response", error)),
      );
      return yield* decodeViewer({
        auth: "authenticated",
        login: raw.login,
        name: normalizedName(raw.name),
        avatarUrl: raw.avatar_url,
      }).pipe(Effect.mapError((error) => schemaFailure("Invalid GitHub viewer", error)));
    });

    const identityCache = yield* Cache.makeWith(() => fetchIdentity, {
      capacity: 1,
      timeToLive: cacheTimeToLive(Duration.hours(1)),
    });

    const requireAuthenticated = Cache.get(identityCache, "viewer").pipe(
      Effect.flatMap((viewer) => {
        if (viewer.auth === "authenticated") {
          return Effect.void;
        }
        return Effect.fail(
          makeReadError(
            viewer.auth === "unavailable" ? "unavailable" : "unauthenticated",
            viewer.auth === "unavailable"
              ? "GitHub CLI is not available. Install gh and try again."
              : "GitHub CLI is not authenticated. Run gh auth login and try again.",
          ),
        );
      }),
    );

    const fetchRepositories = Effect.gen(function* () {
      yield* requireAuthenticated;
      const now = yield* DateTime.now;
      const mergedCutoff = DateTime.subtract(now, { days: 7 });
      const repositories = new Map<string, RawRepositoryAccumulator>();
      const pending: Array<PullRequestPageRequest> = [];
      let repositoryCursor: string | null = null;

      while (true) {
        const response: HttpResponse = yield* runApi(
          graphQlArgs(
            GRAPHQL_PULL_REQUESTS_QUERY,
            repositoryCursor === null ? {} : { repositoryCursor },
          ),
        );
        const raw: typeof RawRepositoriesResponse.Type = yield* decodeRepositoriesResponse(
          response.body,
        ).pipe(
          Effect.mapError((error) => schemaFailure("Invalid GitHub repositories response", error)),
        );
        yield* ensureGraphQlSuccess(response, raw.errors ?? [], "GitHub repositories query failed");
        const repositoryPage: typeof RawRepositoryConnection.Type | undefined =
          raw.data?.viewer?.repositories;
        if (repositoryPage === undefined) {
          return yield* makeReadError(
            "transport",
            "GitHub GraphQL response did not contain the viewer's repositories.",
          );
        }

        for (const rawRepository of repositoryPage.nodes) {
          if (rawRepository === null) continue;
          const key = repositoryKey(rawRepository.owner.login, rawRepository.name);
          const repository = repositories.get(key) ?? {
            name: rawRepository.name,
            owner: rawRepository.owner,
            openPullRequests: [],
            mergedPullRequests: [],
          };
          appendUniquePullRequests(
            repository.openPullRequests,
            rawRepository.openPullRequests.nodes,
          );
          appendUniquePullRequests(
            repository.mergedPullRequests,
            rawRepository.mergedPullRequests.nodes,
          );
          repositories.set(key, repository);

          const openCursor = yield* continuationCursor(
            rawRepository.openPullRequests.pageInfo,
            `${rawRepository.owner.login}/${rawRepository.name} open pull requests`,
            null,
          );
          if (openCursor !== null) {
            pending.push({
              repositoryKey: key,
              owner: rawRepository.owner.login,
              name: rawRepository.name,
              kind: "open",
              cursor: openCursor,
            });
          }

          if (
            rawRepository.mergedPullRequests.pageInfo.hasNextPage &&
            mergedPageCanContainRecentPullRequests(rawRepository.mergedPullRequests, mergedCutoff)
          ) {
            const mergedCursor = yield* continuationCursor(
              rawRepository.mergedPullRequests.pageInfo,
              `${rawRepository.owner.login}/${rawRepository.name} merged pull requests`,
              null,
            );
            if (mergedCursor !== null) {
              pending.push({
                repositoryKey: key,
                owner: rawRepository.owner.login,
                name: rawRepository.name,
                kind: "merged",
                cursor: mergedCursor,
              });
            }
          }
        }

        const nextRepositoryCursor: string | null = yield* continuationCursor(
          repositoryPage.pageInfo,
          "GitHub repositories",
          repositoryCursor,
        );
        if (nextRepositoryCursor === null) break;
        repositoryCursor = nextRepositoryCursor;
      }

      while (pending.length > 0) {
        const requests = pending.splice(0, GRAPHQL_CONNECTION_BATCH_SIZE);
        const response = yield* runApi(
          graphQlArgs(pullRequestPagesQuery(requests), pullRequestPageVariables(requests)),
        );
        const raw = yield* decodePullRequestPageResponse(response.body).pipe(
          Effect.mapError((error) =>
            schemaFailure("Invalid GitHub pull-request page response", error),
          ),
        );
        yield* ensureGraphQlSuccess(
          response,
          raw.errors ?? [],
          "GitHub pull-request pagination query failed",
        );
        if (raw.data === null || raw.data === undefined) {
          return yield* makeReadError(
            "transport",
            "GitHub GraphQL response did not contain paginated pull requests.",
          );
        }

        for (const [index, request] of requests.entries()) {
          const page = raw.data[`page${index}`]?.page;
          if (page === undefined) {
            return yield* makeReadError(
              "transport",
              `GitHub GraphQL response omitted ${request.owner}/${request.name} ${request.kind} pull requests.`,
            );
          }
          const repository = repositories.get(request.repositoryKey);
          if (repository === undefined) {
            return yield* Effect.die(
              `Missing repository accumulator for ${request.owner}/${request.name}.`,
            );
          }
          appendUniquePullRequests(
            request.kind === "open" ? repository.openPullRequests : repository.mergedPullRequests,
            page.nodes,
          );

          if (
            request.kind === "merged" &&
            !mergedPageCanContainRecentPullRequests(page, mergedCutoff)
          ) {
            continue;
          }
          const nextCursor = yield* continuationCursor(
            page.pageInfo,
            `${request.owner}/${request.name} ${request.kind} pull requests`,
            request.cursor,
          );
          if (nextCursor !== null) pending.push({ ...request, cursor: nextCursor });
        }
      }

      return yield* Effect.forEach(repositories.values(), (repository) =>
        makeRepository(repository, mergedCutoff),
      );
    });

    const repositoriesCache = yield* Cache.makeWith(() => fetchRepositories, {
      capacity: 1,
      timeToLive: cacheTimeToLive(Duration.minutes(1)),
    });

    const fetchPr = (ref: PrRef) =>
      Effect.gen(function* () {
        yield* requireAuthenticated;
        const response = yield* runApi([
          "api",
          `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pulls/${ref.number}`,
          "--include",
          "--cache",
          "30s",
        ]);
        const raw = yield* decodePrDetailResponse(response.body).pipe(
          Effect.mapError((error) => schemaFailure("Invalid GitHub pull request response", error)),
        );
        return yield* decodePrDetail({
          ref: {
            owner: raw.base.repo.owner.login,
            repo: raw.base.repo.name,
            number: raw.number,
          },
          title: raw.title,
          author: {
            login: raw.user?.login ?? "ghost",
            avatarUrl: raw.user?.avatar_url ?? null,
          },
          url: raw.html_url,
          state: stateFromApi(raw.state, raw.merged_at),
          baseRefName: raw.base.ref,
          headSha: raw.head.sha,
          updatedAt: raw.updated_at,
          mergedAt: raw.merged_at,
          changedFiles: raw.changed_files,
          additions: raw.additions,
          deletions: raw.deletions,
          journey: null,
          body: raw.body ?? "",
          baseSha: raw.base.sha,
        }).pipe(
          Effect.mapError((error) => schemaFailure("Invalid GitHub pull request detail", error)),
        );
      });

    const prCache = yield* Cache.makeWith(
      (key: string) => refFromDetailCacheKey(key).pipe(Effect.flatMap(fetchPr)),
      {
        capacity: 256,
        timeToLive: cacheTimeToLive(Duration.seconds(30)),
      },
    );

    const repositories = (readOptions?: GitHubReadOptions) =>
      withAbortSignal(Cache.get(repositoriesCache, "repositories"), readOptions?.signal);

    const retry = Effect.gen(function* () {
      const current = yield* Ref.get(park);
      if (Option.isSome(current) && current.value._tag === "RateLimit") {
        const now = yield* DateTime.now;
        if (DateTime.isLessThan(now, current.value.resetAt)) {
          return yield* new GitHubParkedError({ resetAt: current.value.resetAt });
        }
      }
      yield* Ref.set(park, Option.none());
      yield* Cache.invalidateAll(identityCache);
      yield* Cache.invalidateAll(repositoriesCache);
      yield* Cache.invalidateAll(prCache);
    });

    return GitHub.of({
      identity: (readOptions) =>
        withAbortSignal(Cache.get(identityCache, "viewer"), readOptions?.signal).pipe(
          Effect.withSpan("github.identity"),
        ),
      repositories: (readOptions) =>
        repositories(readOptions).pipe(Effect.withSpan("github.repositories")),
      pullRequests: (readOptions) =>
        repositories(readOptions).pipe(
          Effect.map((all) => [...flattenOpen(all), ...flattenMerged(all)]),
          Effect.withSpan("github.pullRequests"),
        ),
      openPrs: (readOptions) =>
        repositories(readOptions).pipe(Effect.map(flattenOpen), Effect.withSpan("github.openPrs")),
      recentlyMergedPrs: (readOptions) =>
        repositories(readOptions).pipe(
          Effect.map(flattenMerged),
          Effect.withSpan("github.recentlyMergedPrs"),
        ),
      pr: (ref, readOptions) =>
        withAbortSignal(Cache.get(prCache, detailCacheKey(ref)), readOptions?.signal).pipe(
          Effect.withSpan("github.pr"),
        ),
      refreshPrs: (readOptions) =>
        repositories(readOptions).pipe(Effect.asVoid, Effect.withSpan("github.refreshPrs")),
      retry: () => retry.pipe(Effect.withSpan("github.retry")),
      resolveUrl: (url) =>
        Effect.gen(function* () {
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            return yield* makeDoorRejection(
              "invalid-url",
              url,
              "Enter a GitHub pull request URL such as https://github.com/owner/repository/pull/123.",
            );
          }

          const segments = parsed.pathname.split("/").filter(Boolean);
          if (
            parsed.protocol !== "https:" ||
            (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") ||
            segments.length !== 4 ||
            segments[2] !== "pull" ||
            !/^[A-Za-z0-9_.-]+$/.test(segments[0] ?? "") ||
            !/^[A-Za-z0-9_.-]+$/.test(segments[1] ?? "") ||
            !/^[1-9]\d*$/.test(segments[3] ?? "")
          ) {
            return yield* makeDoorRejection(
              "invalid-url",
              url,
              "Enter a GitHub pull request URL such as https://github.com/owner/repository/pull/123.",
            );
          }

          return yield* decodePrRef({
            owner: segments[0],
            repo: segments[1],
            number: Number(segments[3]),
          }).pipe(
            Effect.mapError(() =>
              makeDoorRejection("invalid-url", url, "The GitHub pull request URL is not valid."),
            ),
          );
        }).pipe(Effect.withSpan("github.resolveUrl")),
      cloneCredentials: (readOptions) =>
        withAbortSignal(
          gh
            .run({
              args: ["auth", "token", "--hostname", "github.com"],
              signal: readOptions?.signal,
            })
            .pipe(
              Effect.mapError((error) => makeReadError(error.reason, error.detail)),
              Effect.flatMap((result) => {
                const token = result.stdout.trim();
                if (result.exitCode !== 0 || token.length === 0) {
                  return Effect.fail(
                    makeReadError(
                      "unauthenticated",
                      result.stderr.trim() ||
                        "GitHub CLI is not authenticated. Run gh auth login and try again.",
                    ),
                  );
                }
                return Effect.succeed({
                  username: "x-access-token" as const,
                  password: token,
                });
              }),
            ),
          readOptions?.signal,
        ).pipe(Effect.withSpan("github.cloneCredentials")),
    });
  });

export const layer = Layer.effect(GitHub, make());
