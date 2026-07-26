/**
 * The one GraphQL document behind the welcome screen, and its decoder.
 *
 * One query, not N+1 REST calls: open pull requests and recently-merged ones
 * come back together with the viewer's login, which is what makes "refresh the
 * whole screen" cost exactly one request.
 *
 * The search is scoped to pull requests the viewer is *involved in* — authored,
 * assigned, mentioned, or asked to review. That is "the review work that exists
 * for you right now"; anything outside it comes in through the pasted-URL door.
 *
 * @module github/queries
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { PrSummary } from "@app/contracts";

export const OPEN_SEARCH_QUERY = "is:pr is:open involves:@me archived:false sort:updated-desc";

export function mergedSearchQuery(since: DateTime.Utc): string {
  const day = DateTime.formatIso(since).slice(0, 10);
  return `is:pr is:merged involves:@me archived:false merged:>=${day} sort:updated-desc`;
}

const PR_FIELDS = `
  __typename
  number
  title
  url
  isDraft
  state
  createdAt
  updatedAt
  mergedAt
  additions
  deletions
  changedFiles
  baseRefName
  headRefName
  headRefOid
  author { login }
  repository { name owner { login } }
`;

export const GRAPHQL_PR_QUERY = `
query Throughline($openQuery: String!, $mergedQuery: String!) {
  viewer { login }
  open: search(query: $openQuery, type: ISSUE, first: 60) {
    nodes { ... on PullRequest {${PR_FIELDS}} }
  }
  merged: search(query: $mergedQuery, type: ISSUE, first: 30) {
    nodes { ... on PullRequest {${PR_FIELDS}} }
  }
}`;

const GraphQlPr = Schema.Struct({
  __typename: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  isDraft: Schema.Boolean,
  state: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
  changedFiles: Schema.Number,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  repository: Schema.Struct({
    name: Schema.String,
    owner: Schema.Struct({ login: Schema.String }),
  }),
});

// `search` returns a union; non-PullRequest members decode to `{}`. Keeping the
// node schema permissive and filtering on `__typename` means one unexpected
// result type cannot fail the whole screen.
const SearchNodes = Schema.Struct({
  nodes: Schema.Array(Schema.Union([GraphQlPr, Schema.Struct({})])),
});

const GraphQlResponse = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    open: SearchNodes,
    merged: SearchNodes,
  }),
});

const decodeResponse = Schema.decodeUnknownEffect(GraphQlResponse);

const isPr = (node: unknown): node is typeof GraphQlPr.Type =>
  typeof node === "object" &&
  node !== null &&
  "__typename" in node &&
  (node as { __typename?: unknown }).__typename === "PullRequest";

function toSummary(node: typeof GraphQlPr.Type): PrSummary {
  const merged = node.mergedAt !== null;
  return {
    ref: {
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    },
    title: node.title,
    authorLogin: node.author?.login ?? "unknown",
    url: node.url,
    state: merged ? "merged" : node.state === "OPEN" ? "open" : "closed",
    isDraft: node.isDraft,
    createdAt: DateTime.makeUnsafe(node.createdAt),
    updatedAt: DateTime.makeUnsafe(node.updatedAt),
    mergedAt: node.mergedAt === null ? null : DateTime.makeUnsafe(node.mergedAt),
    headSha: node.headRefOid,
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    changedFiles: node.changedFiles,
    additions: node.additions,
    deletions: node.deletions,
  };
}

export interface DecodedPrs {
  readonly login: string | null;
  readonly open: ReadonlyArray<PrSummary>;
  readonly merged: ReadonlyArray<PrSummary>;
}

export const decodeGraphQlPrs = Effect.fn("github.decodeGraphQlPrs")(function* (raw: string) {
  const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown);
  const response = yield* decodeResponse(parsed);
  return {
    login: response.data.viewer.login,
    open: response.data.open.nodes.filter(isPr).map(toSummary),
    merged: response.data.merged.nodes.filter(isPr).map(toSummary),
  } satisfies DecodedPrs;
});
