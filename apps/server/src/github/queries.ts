/**
 * The GitHub queries and the schemas their responses decode through.
 *
 * The PR list is **one GraphQL query**, not N+1 REST calls — that is the whole
 * reason this file exists. Everything the welcome screen needs about every
 * repository and its pull requests arrives in a single request, which is what
 * makes the rate discipline in `GitHub.ts` affordable.
 *
 * @module github/queries
 */
import * as Schema from "effect/Schema";

import { PrSummary, type PrRef, type PrState } from "@app/contracts";

/** How many repositories and PRs per repository the list query asks for. */
export const REPO_PAGE_SIZE = 30;
export const OPEN_PR_PAGE_SIZE = 20;
export const MERGED_PR_PAGE_SIZE = 10;

export const VIEWER_PRS_QUERY = `
query ViewerPullRequests($repos: Int!, $open: Int!, $merged: Int!) {
  viewer {
    login
    repositories(
      first: $repos
      orderBy: { field: PUSHED_AT, direction: DESC }
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
    ) {
      nodes {
        name
        owner { login }
        open: pullRequests(states: [OPEN], first: $open, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ...PrFields }
        }
        merged: pullRequests(states: [MERGED], first: $merged, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ...PrFields }
        }
      }
    }
  }
}
fragment PrFields on PullRequest {
  number
  title
  url
  state
  isDraft
  createdAt
  updatedAt
  mergedAt
  body
  baseRefName
  headRefOid
  changedFiles
  additions
  deletions
  author { login }
}
`.trim();

// ── Response schemas ────────────────────────────────────────────────────────
//
// GitHub omits nothing but nulls plenty (a deleted author, an unmerged PR), so
// every nullable field is modelled as such and normalized on the way out.

const GraphQlAuthor = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const GraphQlPr = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  body: Schema.NullOr(Schema.String),
  baseRefName: Schema.String,
  headRefOid: Schema.String,
  changedFiles: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  author: GraphQlAuthor,
});
type GraphQlPr = typeof GraphQlPr.Type;

const GraphQlRepository = Schema.NullOr(
  Schema.Struct({
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
    open: Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.NullOr(GraphQlPr))) }),
    merged: Schema.Struct({ nodes: Schema.NullOr(Schema.Array(Schema.NullOr(GraphQlPr))) }),
  }),
);

export const ViewerPrsResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({
      login: Schema.String,
      repositories: Schema.Struct({
        nodes: Schema.NullOr(Schema.Array(GraphQlRepository)),
      }),
    }),
  }),
});

/** `gh api user` — the identity probe, cached for an hour. */
export const ViewerUserResponse = Schema.Struct({
  login: Schema.String,
});

/** `gh api repos/{owner}/{repo}/pulls/{number}` — the freshness source. */
export const RestPrResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  merged_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  body: Schema.NullOr(Schema.String),
  changed_files: Schema.optionalKey(Schema.Number),
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
  base: Schema.Struct({ ref: Schema.String }),
  head: Schema.Struct({ sha: Schema.String }),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});

/** `gh api rate_limit` — free, and the only honest source of a reset instant. */
export const RateLimitResponse = Schema.Struct({
  resources: Schema.Struct({
    core: Schema.Struct({
      remaining: Schema.Number,
      reset: Schema.Number,
    }),
    graphql: Schema.optionalKey(
      Schema.Struct({
        remaining: Schema.Number,
        reset: Schema.Number,
      }),
    ),
  }),
});

export const decodeViewerPrs = Schema.decodeUnknownEffect(Schema.fromJsonString(ViewerPrsResponse));
export const decodeViewerUser = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ViewerUserResponse),
);
export const decodeRestPr = Schema.decodeUnknownEffect(Schema.fromJsonString(RestPrResponse));
export const decodeRateLimit = Schema.decodeUnknownEffect(Schema.fromJsonString(RateLimitResponse));

// ── Normalization ───────────────────────────────────────────────────────────

const DELETED_AUTHOR = "ghost";

function normalizeState(state: string, mergedAt: string | null): PrState {
  const upper = state.toUpperCase();
  if (upper === "MERGED" || mergedAt !== null) return "merged";
  if (upper === "CLOSED") return "closed";
  return "open";
}

/**
 * A GraphQL PR node in Throughline's own terms. Dates stay ISO strings here and
 * are decoded by the contract schema at the boundary — one decode, one place.
 */
export interface RawPrSummary {
  readonly ref: PrRef;
  readonly title: string;
  readonly author: string;
  readonly url: string;
  readonly state: PrState;
  readonly isDraft: boolean;
  readonly headSha: string;
  readonly baseRef: string;
  readonly changedFiles: number;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
  readonly body: string;
}

export function fromGraphQlPr(owner: string, repo: string, node: GraphQlPr): RawPrSummary {
  return {
    ref: { owner, repo, number: node.number },
    title: node.title,
    author: node.author?.login ?? DELETED_AUTHOR,
    url: node.url,
    state: normalizeState(node.state, node.mergedAt),
    isDraft: node.isDraft,
    headSha: node.headRefOid,
    baseRef: node.baseRefName,
    changedFiles: node.changedFiles,
    additions: node.additions,
    deletions: node.deletions,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    mergedAt: node.mergedAt,
    body: node.body ?? "",
  };
}

export function fromRestPr(ref: PrRef, node: typeof RestPrResponse.Type): RawPrSummary {
  return {
    ref,
    title: node.title,
    author: node.user?.login ?? DELETED_AUTHOR,
    url: node.html_url,
    state: normalizeState(node.state, node.merged_at),
    isDraft: node.draft ?? false,
    headSha: node.head.sha,
    baseRef: node.base.ref,
    changedFiles: node.changed_files ?? 0,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    mergedAt: node.merged_at,
    body: node.body ?? "",
  };
}

/**
 * A `RawPrSummary` is exactly the JSON-encoded form of the contract's
 * `PrSummary`, so one decoder turns GitHub's answer into the wire type — and
 * refinement failures (an empty head sha, a negative count) surface here at the
 * boundary rather than deeper in the app.
 */
export const decodePrSummary = Schema.decodeUnknownEffect(Schema.toCodecJson(PrSummary));

/** Parse an `owner/repo/pull/number` shape out of a pasted URL. */
export function parsePrUrl(input: string): PrRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // `owner/repo#123` and `owner/repo/123` shorthands, for a pasted reference.
  const shorthand = /^([\w.-]+)\/([\w.-]+)(?:#|\/)(\d+)$/.exec(trimmed);
  if (shorthand !== null) {
    return {
      owner: shorthand[1] as string,
      repo: shorthand[2] as string,
      number: Number.parseInt(shorthand[3] as string, 10),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const pullIndex = segments.findIndex((segment) => segment === "pull" || segment === "pulls");
  if (pullIndex < 2) return null;
  const owner = segments[pullIndex - 2];
  const repo = segments[pullIndex - 1];
  const numberRaw = segments[pullIndex + 1];
  if (owner === undefined || repo === undefined || numberRaw === undefined) return null;
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner, repo, number };
}

/** Flatten the one big GraphQL response into repo-grouped raw summaries. */
export function flattenViewerPrs(response: typeof ViewerPrsResponse.Type): {
  readonly login: string;
  readonly open: ReadonlyArray<RawPrSummary>;
  readonly merged: ReadonlyArray<RawPrSummary>;
} {
  const open: RawPrSummary[] = [];
  const merged: RawPrSummary[] = [];
  for (const repository of response.data.viewer.repositories.nodes ?? []) {
    if (repository === null) continue;
    const owner = repository.owner.login;
    const repo = repository.name;
    for (const node of repository.open.nodes ?? []) {
      if (node !== null) open.push(fromGraphQlPr(owner, repo, node));
    }
    for (const node of repository.merged.nodes ?? []) {
      if (node !== null) merged.push(fromGraphQlPr(owner, repo, node));
    }
  }
  return { login: response.data.viewer.login, open, merged };
}
