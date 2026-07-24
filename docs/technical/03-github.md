# GitHub Access & Workspaces

How Throughline reads from GitHub — and the discipline that guarantees it can never hammer the API — plus the clone workspaces analysis runs in.

## Identity: the reviewer's `gh` login

Throughline authenticates through the GitHub CLI. What the reviewer's `gh` login can see is what Throughline can see; there is no app token, no OAuth flow of our own, no scope escalation. `gh auth status` (and `gh api user` once, cached) is the detection probe behind the welcome screen's identity; an unauthenticated `gh` is a visible, parked state with instructions — never a retry loop.

## The `GitHub` module

One deep module in `apps/server/src/github/`; **no other code in the repository may reach the GitHub API, shell out to `gh`, or touch the network toward GitHub.** This single-choke-point rule is what makes every promise below enforceable. The interface is deliberately small:

```ts
GitHub {
  identity(): Viewer                              // login + auth state
  openPrs(): PrSummary[]                          // the welcome screen's world: PRs relevant to the viewer
  pr(ref: PrRef): PrDetail                        // metadata + current headSha (the freshness source)
  resolveUrl(url: string): PrRef | DoorRejection  // door validation for pasted URLs
  cloneCredentials(repo): GitCredential           // hands git a token; git itself does the byte-moving
}
```

Implementation: `gh api` (GraphQL for the PR list — one query, not N+1 REST calls; REST for single-PR lookups) via the Effect `ChildProcessSpawner`, decoded against schemas in `packages/contracts`. `gh`'s own on-disk HTTP cache (`gh api --cache <ttl>`) is used as a second layer under ours.

## The rate discipline

GitHub's API is unforgiving, and an app that retries carelessly locks its own user out. These rules are structural — encoded in the one module, not distributed as good intentions:

1. **One concurrency gate.** A single semaphore (width 2) in front of every API call. There is no code path around it.
2. **Caching is the default, not an optimization.** Every read has a TTL (PR list ~60s, PR detail ~30s, identity ~1h) and is served from cache within it. Identical in-flight requests are **single-flighted** — N callers, one request.
3. **Nothing polls on its own.** No background refresh loops. The PR list refreshes on app focus, on explicit user refresh, and at most once per minimum interval; staleness checks reuse the cached `pr()` view. An idle Throughline issues zero requests.
4. **4xx is an answer, not an obstacle.** Client errors (404, 403 non-rate-limit, 422) are never retried — they become typed door rejections or visible states immediately.
5. **Rate limiting parks the module.** On 429 or a rate-limit-flavored 403, the module enters a **parked** state until the reported reset time (plus jitter): every call fails fast with a typed `GitHubParked` error carrying the reset, the UI shows it honestly, and _nothing_ — not even user-initiated refresh — sends a request early. Parking is global (it's one quota), and the secondary-rate-limit `retry-after` is obeyed the same way.
6. **Only transport failures retry** — network errors and 5xx, with capped exponential backoff and jitter, **max 3 attempts**, then a visible failure. Retries count against the same semaphore, so even a retrying module can't stampede.
7. **Reads only.** No mutating GitHub call exists in the codebase, so the most expensive class of mistake is unrepresentable.

The unit tests for this module are adversarial: simulated 403-with-reset must produce exactly zero further requests until reset; a stampede of `openPrs()` calls must produce exactly one.

## Workspaces

`apps/server/src/workspace/` owns everything on disk under `<dataRoot>/workspaces/`. Git — not the API — moves all repository bytes, so clones and fetches cost API quota nothing (they authenticate via `cloneCredentials`, i.e. `gh auth token`).

- **One clone per repository, shared across its PRs**: a bare, partial clone (`--filter=blob:none`) so history arrives lazily and the first ingestion of a big repo isn't a full download.
- **One worktree per analysis run**, added at the pinned `headSha`, removed when the run finishes (kept on failure for debugging, reaped on the next run). The worktree is the read-only ground the agent walks ([04](./04-analysis.md)).
- **Diff materialization** happens here at ingestion time, from local git, and is written into the run directory: the full rename-aware `baseSha..headSha` patch, per-file patches (what the renderer's diff surfaces are served from), the head-revision file tree listing, and the seed-hunk index (`@app/journey/hunks` output). After this point, ingestion and reading never consult git again — the journey and its run artifacts are self-contained.
- **Eviction**: workspaces are a cache. LRU by repository, generous cap; deleting one is always safe because re-cloning is always possible.

## The door

Ingestion's precondition checks — the only place "no" is an allowed answer (per the vision, analysis itself never fails):

| Check                                        | Rejection                                                 |
| -------------------------------------------- | --------------------------------------------------------- |
| URL parses to a PR                           | `invalid-url`                                             |
| `gh` installed and authenticated             | `gh-unavailable` (with setup instructions)                |
| PR visible to the viewer's login             | `not-found` (indistinguishable from private, honestly so) |
| PR state ingestible (open, or merged-recent) | `not-open`                                                |

Door rejections are typed contract errors surfaced before a job exists; they are the _only_ error channel of `ingestion.start`.
