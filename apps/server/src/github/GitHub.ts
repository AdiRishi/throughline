import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  GitHubUnavailableError,
  IngestionDoorError,
  type GitHubPrsStreamEvent,
  type GitHubViewer,
  type PrRef,
  type PullRequestDetail,
  type PullRequestSummary,
} from "@app/contracts";

import { ProcessRunner } from "../process/ProcessRunner.ts";

const IDENTITY_TTL = Duration.hours(1);
const PRS_TTL = Duration.seconds(60);
const PR_TTL = Duration.seconds(30);
const MAX_ATTEMPTS = 3;

const PULL_REQUESTS_QUERY = `
query ThroughlinePullRequests {
  viewer {
    repositories(
      first: 100
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
      orderBy: { field: PUSHED_AT, direction: DESC }
    ) {
      nodes {
        name
        owner { login }
        pullRequests(first: 50, states: [OPEN, MERGED], orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes {
            number
            title
            url
            state
            isDraft
            updatedAt
            mergedAt
            additions
            deletions
            changedFiles
            headRefOid
            headRefName
            baseRefName
            author { login avatarUrl }
          }
        }
      }
    }
  }
}`.trim();

const RawViewer = Schema.Struct({
  login: Schema.String,
  name: Schema.NullOr(Schema.String),
  avatar_url: Schema.String,
});

const RawPrNode = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  updatedAt: Schema.DateTimeUtc,
  mergedAt: Schema.NullOr(Schema.DateTimeUtc),
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  headRefOid: Schema.String,
  headRefName: Schema.String,
  baseRefName: Schema.String,
  author: Schema.NullOr(
    Schema.Struct({
      login: Schema.String,
      avatarUrl: Schema.String,
    }),
  ),
});

const RawGraphQl = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      repositories: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            owner: Schema.Struct({ login: Schema.String }),
            pullRequests: Schema.Struct({ nodes: Schema.Array(RawPrNode) }),
          }),
        ),
      }),
    }),
  }),
});

const RawPrDetail = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.Boolean,
  updated_at: Schema.DateTimeUtc,
  merged_at: Schema.NullOr(Schema.DateTimeUtc),
  additions: Schema.Number,
  deletions: Schema.Number,
  changed_files: Schema.Number,
  user: Schema.Struct({
    login: Schema.String,
    avatar_url: Schema.String,
  }),
  head: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
  }),
  base: Schema.Struct({
    sha: Schema.String,
    ref: Schema.String,
    repo: Schema.Struct({ clone_url: Schema.String }),
  }),
});

const decodeViewer = Schema.decodeUnknownEffect(Schema.toCodecJson(RawViewer));
const decodeGraphQl = Schema.decodeUnknownEffect(Schema.toCodecJson(RawGraphQl));
const decodePrDetail = Schema.decodeUnknownEffect(Schema.toCodecJson(RawPrDetail));

export class GitHubCommandError extends Data.TaggedError("GitHubCommandError")<{
  readonly reason: "unavailable" | "unauthenticated" | "http" | "transport";
  readonly detail: string;
  readonly status?: number;
  readonly resetAt?: DateTime.Utc;
}> {}

export interface GitHubCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export class GitHubCommand extends Context.Service<
  GitHubCommand,
  {
    readonly run: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<GitHubCommandResult, GitHubCommandError>;
  }
>()("@app/server/github/GitHubCommand") {}

function errorFromOutput(
  detail: string,
  exitCode: number | undefined,
  transport = false,
): GitHubCommandError {
  const statusMatch = /\bHTTP\s+(\d{3})\b/i.exec(detail);
  const status = statusMatch?.[1] === undefined ? undefined : Number(statusMatch[1]);
  const resetMatch = /(?:x-ratelimit-reset|rate limit reset)[:= ]+(\d{10,13})/i.exec(detail);
  const resetSeconds = resetMatch?.[1] === undefined ? undefined : Number(resetMatch[1]);
  const resetAt =
    resetSeconds === undefined
      ? undefined
      : DateTime.makeUnsafe(resetSeconds < 10_000_000_000 ? resetSeconds * 1000 : resetSeconds);
  const unavailable =
    /ENOENT|not found|is not recognized|executable/i.test(detail) && status === undefined;
  const unauthenticated = /not logged|authenticate|auth login|authentication/i.test(detail);
  return new GitHubCommandError({
    reason: unavailable
      ? "unavailable"
      : unauthenticated
        ? "unauthenticated"
        : transport
          ? "transport"
          : "http",
    detail: detail.trim() || `gh exited with code ${String(exitCode)}`,
    ...(status === undefined ? {} : { status }),
    ...(resetAt === undefined ? {} : { resetAt }),
  });
}

export const commandLayer = Layer.effect(
  GitHubCommand,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner;
    const textDecoder = new TextDecoder();
    return GitHubCommand.of({
      run: (args) =>
        runner.run("gh", args).pipe(
          Effect.map((result) => ({
            stdout: textDecoder.decode(result.stdout),
            stderr: result.stderr,
          })),
          Effect.mapError((error) =>
            errorFromOutput(error.stderr, error.exitCode, error.exitCode === undefined),
          ),
        ),
    });
  }),
);

interface PrBusState {
  readonly sequence: number;
  readonly pullRequests: ReadonlyArray<PullRequestSummary>;
}

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly identity: (refresh?: boolean) => Effect.Effect<GitHubViewer, GitHubUnavailableError>;
    readonly openPrs: (
      refresh?: boolean,
    ) => Effect.Effect<ReadonlyArray<PullRequestSummary>, GitHubUnavailableError>;
    readonly pr: (
      ref: PrRef,
      refresh?: boolean,
    ) => Effect.Effect<PullRequestDetail, GitHubUnavailableError>;
    readonly resolveUrl: (url: string) => Effect.Effect<PrRef, IngestionDoorError>;
    readonly cloneToken: Effect.Effect<string, GitHubUnavailableError>;
    readonly changes: Stream.Stream<GitHubPrsStreamEvent, GitHubUnavailableError>;
  }
>()("@app/server/github/GitHub") {}

function unavailable(error: GitHubCommandError): GitHubUnavailableError {
  return new GitHubUnavailableError({
    reason:
      error.reason === "unavailable"
        ? "gh-unavailable"
        : error.reason === "unauthenticated"
          ? "unauthenticated"
          : "transport",
    detail: error.detail,
    ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
  });
}

function emptyJourneyState() {
  return {
    exists: false,
    stale: false,
    readHunks: 0,
    totalHunks: 0,
  };
}

export const make = Effect.gen(function* () {
  const command = yield* GitHubCommand;
  const gate = yield* Semaphore.make(2);
  const parkedUntil = yield* Ref.make<DateTime.Utc | undefined>(undefined);
  const prBus = yield* SynchronizedRef.make<PrBusState>({
    sequence: 0,
    pullRequests: [],
  });
  const prPubSub = yield* PubSub.unbounded<GitHubPrsStreamEvent>();

  const run = (
    args: ReadonlyArray<string>,
  ): Effect.Effect<GitHubCommandResult, GitHubUnavailableError> =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const parked = yield* Ref.get(parkedUntil);
        if (parked !== undefined && DateTime.toEpochMillis(parked) > DateTime.toEpochMillis(now)) {
          return yield* new GitHubUnavailableError({
            reason: "parked",
            detail: `GitHub rate limit is parked until ${DateTime.formatIso(parked)}.`,
            resetAt: parked,
          });
        }
        if (parked !== undefined) yield* Ref.set(parkedUntil, undefined);

        const attempt = (
          index: number,
        ): Effect.Effect<GitHubCommandResult, GitHubUnavailableError> =>
          command.run(args).pipe(
            Effect.catchTag("GitHubCommandError", (error) => {
              const rateLimited =
                error.status === 429 ||
                (error.status === 403 && /rate.?limit|abuse|secondary/i.test(error.detail));
              if (rateLimited) {
                const resetAt =
                  error.resetAt ??
                  DateTime.makeUnsafe(DateTime.toEpochMillis(now) + Duration.toMillis("1 minute"));
                return Ref.set(parkedUntil, resetAt).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new GitHubUnavailableError({
                        reason: "parked",
                        detail: error.detail,
                        resetAt,
                      }),
                    ),
                  ),
                );
              }
              const retryable =
                error.reason === "transport" || (error.status !== undefined && error.status >= 500);
              if (!retryable || index >= MAX_ATTEMPTS) {
                return Effect.fail(unavailable(error));
              }
              return Random.nextBetween(0, 150).pipe(
                Effect.flatMap((jitter) =>
                  Effect.sleep(Duration.millis(200 * 2 ** (index - 1) + jitter)),
                ),
                Effect.andThen(attempt(index + 1)),
              );
            }),
          );
        return yield* attempt(1);
      }),
    );

  const loadIdentity = Effect.gen(function* () {
    const status = yield* Effect.result(command.run(["auth", "status"]));
    if (Result.isFailure(status)) {
      const error = status.failure;
      return {
        state: error.reason === "unavailable" ? "unavailable" : "unauthenticated",
        setupInstructions:
          error.reason === "unavailable"
            ? "Install the GitHub CLI, then run gh auth login."
            : "Run gh auth login in a terminal, then refresh.",
      } satisfies GitHubViewer;
    }
    const response = yield* run(["api", "user", "--cache", "1h"]);
    const viewer = yield* Effect.try({
      try: () => JSON.parse(response.stdout) as unknown,
      catch: (cause) => unavailable(errorFromOutput(String(cause), undefined)),
    }).pipe(
      Effect.flatMap(decodeViewer),
      Effect.mapError((error) =>
        error instanceof GitHubUnavailableError
          ? error
          : new GitHubUnavailableError({
              reason: "transport",
              detail: `GitHub returned an invalid viewer response: ${String(error)}`,
            }),
      ),
    );
    return {
      state: "authenticated",
      login: viewer.login,
      ...(viewer.name === null || viewer.name.trim() === "" ? {} : { name: viewer.name }),
      ...(viewer.avatar_url === "" ? {} : { avatarUrl: viewer.avatar_url }),
    } satisfies GitHubViewer;
  });

  const loadPrs = Effect.gen(function* () {
    const response = yield* run([
      "api",
      "graphql",
      "--cache",
      "60s",
      "-f",
      `query=${PULL_REQUESTS_QUERY}`,
    ]);
    const raw = yield* Effect.try({
      try: () => JSON.parse(response.stdout) as unknown,
      catch: (cause) =>
        new GitHubUnavailableError({
          reason: "transport",
          detail: `GitHub returned invalid JSON: ${String(cause)}`,
        }),
    }).pipe(
      Effect.flatMap(decodeGraphQl),
      Effect.mapError((error) =>
        error instanceof GitHubUnavailableError
          ? error
          : new GitHubUnavailableError({
              reason: "transport",
              detail: `GitHub returned an invalid pull request list: ${String(error)}`,
            }),
      ),
    );
    const weekAgo = DateTime.toEpochMillis(yield* DateTime.now) - Duration.toMillis("7 days");
    return raw.data.viewer.repositories.nodes.flatMap((repository) =>
      repository.pullRequests.nodes.flatMap((pr): ReadonlyArray<PullRequestSummary> => {
        const merged = pr.state === "MERGED";
        if (
          pr.state !== "OPEN" &&
          (!merged || pr.mergedAt === null || DateTime.toEpochMillis(pr.mergedAt) < weekAgo)
        ) {
          return [];
        }
        return [
          {
            ref: { owner: repository.owner.login, repo: repository.name, number: pr.number },
            title: pr.title,
            url: pr.url,
            author: {
              login: pr.author?.login ?? "ghost",
              ...(pr.author?.avatarUrl === undefined ? {} : { avatarUrl: pr.author.avatarUrl }),
            },
            state: merged ? "merged" : "open",
            isDraft: pr.isDraft,
            updatedAt: pr.updatedAt,
            mergedAt: pr.mergedAt,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            headSha: pr.headRefOid,
            baseBranch: pr.baseRefName,
            headBranch: pr.headRefName,
            journey: emptyJourneyState(),
          },
        ];
      }),
    );
  });

  const loadPr = (ref: PrRef) =>
    Effect.gen(function* () {
      const response = yield* run([
        "api",
        `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
        "--cache",
        "30s",
      ]);
      const raw = yield* Effect.try({
        try: () => JSON.parse(response.stdout) as unknown,
        catch: (cause) =>
          new GitHubUnavailableError({
            reason: "transport",
            detail: `GitHub returned invalid JSON: ${String(cause)}`,
          }),
      }).pipe(
        Effect.flatMap(decodePrDetail),
        Effect.mapError((error) =>
          error instanceof GitHubUnavailableError
            ? error
            : new GitHubUnavailableError({
                reason: "transport",
                detail: `GitHub returned an invalid pull request: ${String(error)}`,
              }),
        ),
      );
      return {
        ref,
        title: raw.title,
        body: raw.body ?? "",
        url: raw.html_url,
        author: { login: raw.user.login, avatarUrl: raw.user.avatar_url },
        state: raw.merged_at === null ? "open" : "merged",
        isDraft: raw.draft,
        updatedAt: raw.updated_at,
        mergedAt: raw.merged_at,
        additions: raw.additions,
        deletions: raw.deletions,
        changedFiles: raw.changed_files,
        headSha: raw.head.sha,
        baseSha: raw.base.sha,
        baseBranch: raw.base.ref,
        headBranch: raw.head.ref,
        repositoryUrl: raw.base.repo.clone_url,
        journey: emptyJourneyState(),
      } satisfies PullRequestDetail;
    });

  const identityCache = yield* Cache.make({
    capacity: 1,
    timeToLive: IDENTITY_TTL,
    lookup: () => loadIdentity,
  });
  const prsCache = yield* Cache.make({
    capacity: 1,
    timeToLive: PRS_TTL,
    lookup: () => loadPrs,
  });
  const prCache = yield* Cache.make({
    capacity: 100,
    timeToLive: PR_TTL,
    lookup: (key: string) => {
      const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(key);
      return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
        ? Effect.die(`Invalid PR cache key: ${key}`)
        : loadPr({
            owner: match[1],
            repo: match[2],
            number: Number(match[3]),
          });
    },
  });

  const openPrs = (refresh = false) =>
    Effect.gen(function* () {
      if (refresh) yield* Cache.invalidate(prsCache, "viewer");
      const pullRequests = yield* Cache.get(prsCache, "viewer");
      yield* SynchronizedRef.modifyEffect(prBus, (current) => {
        const event: GitHubPrsStreamEvent = {
          version: 1,
          sequence: current.sequence + 1,
          type: "updated",
          pullRequests,
        };
        return PubSub.publish(prPubSub, event).pipe(
          Effect.as([undefined, { sequence: event.sequence, pullRequests }] as const),
        );
      });
      return pullRequests;
    }).pipe(Effect.withSpan("github.openPrs"));

  return GitHub.of({
    identity: (refresh = false) =>
      Effect.gen(function* () {
        if (refresh) yield* Cache.invalidate(identityCache, "viewer");
        return yield* Cache.get(identityCache, "viewer");
      }).pipe(Effect.withSpan("github.identity")),
    openPrs,
    pr: (ref, refresh = false) => {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`;
      return Effect.gen(function* () {
        if (refresh) yield* Cache.invalidate(prCache, key);
        return yield* Cache.get(prCache, key);
      }).pipe(Effect.withSpan("github.pr"));
    },
    resolveUrl: (url) => {
      const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
        url.trim(),
      );
      return match?.[1] === undefined || match[2] === undefined || match[3] === undefined
        ? Effect.fail(
            new IngestionDoorError({
              reason: "invalid-url",
              detail:
                "Enter a GitHub pull request URL such as https://github.com/owner/repo/pull/42.",
            }),
          )
        : Effect.succeed({
            owner: match[1],
            repo: match[2],
            number: Number(match[3]),
          });
    },
    cloneToken: run(["auth", "token"]).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.filterOrFail(
        (token) => token.length > 0,
        () =>
          new GitHubUnavailableError({
            reason: "unauthenticated",
            detail: "gh did not return an authentication token. Run gh auth login.",
          }),
      ),
      Effect.withSpan("github.cloneToken"),
    ),
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const liveBuffer = yield* Queue.unbounded<GitHubPrsStreamEvent>();
        yield* Effect.forkScoped(
          Stream.fromPubSub(prPubSub).pipe(
            Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
          ),
        );
        const pullRequests = yield* openPrs();
        const current = yield* SynchronizedRef.get(prBus);
        const snapshot: GitHubPrsStreamEvent = {
          version: 1,
          sequence: current.sequence,
          type: "snapshot",
          pullRequests,
        };
        return Stream.concat(
          Stream.make(snapshot),
          Stream.fromQueue(liveBuffer).pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          ),
        );
      }),
    ),
  });
});

export const layer = Layer.effect(GitHub, make).pipe(Layer.provide(commandLayer));
