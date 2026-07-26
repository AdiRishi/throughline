# GitHub Access & Workspaces

How Throughline reads from GitHub — and the discipline that guarantees it can never hammer the API — plus the clone workspaces analysis runs in.

## Identity: the reviewer's `gh` login

Throughline authenticates through the GitHub CLI. What the reviewer's `gh` login can see is what Throughline can see; there is no app token, no OAuth flow of our own, no scope escalation. The detection probe behind the welcome screen's identity is two questions in order: `gh --version` (is the CLI there at all?), then `gh api user` (does it have credentials, and whose?) — a failure at the first means `missing` with install instructions, a failure at the second means `unauthenticated` with `gh auth login`. An authenticated answer is cached for an hour, an unauthenticated one for ten seconds, because the reviewer who just read those instructions is probably about to act on them. Either way an unauthenticated `gh` is a visible, parked state with instructions — never a retry loop.

## The `GitHub` module

One deep module in `apps/server/src/github/`; **no other code in the repository may reach the GitHub API, shell out to `gh`, or touch the network toward GitHub.** This single-choke-point rule is what makes every promise below enforceable. The interface is deliberately small:

```ts
GitHub {
  identity: Viewer                                // login + auth state; cached, and never fails
  prs: PrListing                                  // the viewer's open and recently merged PRs, from one query
  refreshPrs: boolean                             // explicit refresh; false when the module's own floor said "not yet"
  pr(ref: PrRef): PrSummary                       // metadata + current headSha (the freshness source)
  cachedPr(ref: PrRef): Option<PrSummary>         // the same, but never sends a request
  resolveUrl(url: string): PrRef | DoorRejection  // door validation for pasted URLs
  cloneToken: string                              // `gh auth token`, for a caller that needs a token in hand
  health: GitHubHealth                            // the module's honest state, for the welcome screen's banner
  invalidatePr(ref: PrRef): void                  // drop a PR after an ingestion pinned a new head
}
```

`PrListing` is flat — `{ login, open, merged, fetchedAtMillis }` — because grouping is a presentation decision, not a fact about GitHub: one GraphQL query walks the viewer's repositories and the module hands back two plain arrays, and the welcome screen's repo groups are assembled later in [`prs/PrList.ts`](../../apps/server/src/prs/PrList.ts). `cachedPr` exists for the same reason `pr` cannot serve staleness: staleness is computed at the moment of display, so it must consult both caches (the list one the welcome screen filled, the detail one `pr` fills) and send nothing.

Implementation: `gh api` (GraphQL for the PR list — one query, not N+1 REST calls; REST for single-PR lookups) via the Effect `ChildProcessSpawner`, behind the single injectable `GhRunner` seam ([ADR 0011](../adr/0011-the-gh-cli-is-reached-through-one-injectable-runner.md) records why every call goes through one seam, and the ordering subtlety in its classifier). GitHub's raw answers decode through schemas that live beside the queries that ask for them — `ViewerPrsResponse`, `ViewerUserResponse`, `RestPrResponse`, `RateLimitResponse` in [`github/queries.ts`](../../apps/server/src/github/queries.ts) — and are normalized there into the one `PrSummary` shape `packages/contracts` defines: a single decode at the boundary that turns GitHub's vocabulary into Throughline's, so no GitHub field name travels further into the server. There is no second cache underneath, either: `gh api --cache` is deliberately unused, because an invisible on-disk layer could serve a stale answer the module believed it had just fetched, and the TTLs below would stop being the whole story about when Throughline last really asked GitHub.

## The rate discipline

GitHub's API is unforgiving, and an app that retries carelessly locks its own user out. These rules are structural — encoded in the one module, not distributed as good intentions:

1. **One concurrency gate.** A single semaphore (width 2) in front of every API call. There is no code path around it.
2. **Caching is the default, not an optimization.** Every read has a TTL (PR list ~60s, PR detail ~30s, identity ~1h) and is served from cache within it. Identical in-flight requests are **single-flighted** — N callers, one request.
3. **Nothing polls on its own.** No background refresh loops. The PR list refreshes on app focus, on explicit user refresh, and at most once per minimum interval; staleness checks reuse the cached `pr()` view. An idle Throughline issues zero requests.
4. **4xx is an answer, not an obstacle.** Client errors (404, 403 non-rate-limit, 422) are never retried — they become typed door rejections or visible states immediately.
5. **Rate limiting parks the module.** On 429 or a rate-limit-flavored 403, the module enters a **parked** state until the reported reset time (plus jitter): every call fails fast with a typed `GitHubParked` error carrying the reset, the UI shows it honestly, and _nothing_ — not even user-initiated refresh — sends a request early. Parking is global (it's one quota), and the secondary-rate-limit `retry-after` is obeyed the same way.
6. **Only transport failures retry** — network errors and 5xx, with capped exponential backoff and jitter, **max 3 attempts**, then a visible failure. Retries count against the same semaphore, so even a retrying module can't stampede.
7. **Reads only.** No mutating GitHub call exists in the codebase, so the most expensive class of mistake is unrepresentable.

The unit tests for this module are adversarial: simulated 403-with-reset must produce exactly zero further requests until reset; a stampede of `prs` reads must produce exactly one.

## Workspaces

`apps/server/src/workspace/` owns everything Throughline writes to disk for a repository and a run, and it keeps the two under separate roots: the clone cache at `<dataRoot>/workspaces/<owner>/<repo>/` (the bare repo plus one worktree per run) and the materialized run inputs at `<dataRoot>/runs/<owner>/<repo>/<number>/<runId>/`. The run id _is_ the journey id, which is what lets a reading surface find the materialized diff for a journey it only knows by id — and it is why evicting a clone never costs a journey its diff.

Git — not the API — moves all repository bytes, so clones and fetches cost API quota nothing. They authenticate through git's own credential-helper protocol rather than through a token this code holds: every invocation runs with `credential.helper=` (an empty value, which first _clears_ whatever the reviewer has configured) followed by `credential.helper=!gh auth git-credential`, the same helper `gh auth setup-git` installs, plus an empty `core.askPass` so a missing credential fails instead of hanging on a prompt. `gh` keeps the token and hands it over one request at a time, so it never appears in argv (readable by other local processes), never in the environment, and never in `.git/config`. `GitHub` can still produce a raw token on request via `cloneToken`, but nothing under `apps/server/src/workspace/` asks for one.

- **One clone per repository, shared across its PRs**: a bare, partial clone (`--filter=blob:none`) so history arrives lazily and the first ingestion of a big repo isn't a full download.
- **One worktree per analysis run**, added at the pinned `headSha` and removed when the run succeeds — deliberately kept when it fails, so the failure can be inspected on the exact tree that produced it. Because worktrees are named by run id and every run gets a fresh one, a kept worktree is never in a later run's way, and nothing sweeps it afterwards: it survives until its whole repository clone is evicted. The worktree is the read-only ground the agent walks ([04](./04-analysis.md)).
- **PR heads are fetched as `refs/pull/<n>/head` from the base repository** — never from a fork remote or a branch name — which covers fork PRs, deleted source branches, and force-pushed heads with one mechanism. The fetched commit is compared against the `headSha` the API reported; if a force-push moved the ref mid-ingestion, the workspace refetches once and re-pins to whatever git then has, and _that_ commit — not the API's earlier answer — is what the journey records as its pinned head, because git is the copy the analysis actually read. The PR's detail cache is invalidated once the journey is committed, so the module's next read of that PR is the first one that sees the move. The partial clone omits blobs, not commits, so merge-base discovery against the base branch needs no special casing.
- **Diff materialization** happens here at ingestion time, from local git, and is written into the run directory: the full rename-aware `baseSha..headSha` patch, per-file patches (what the renderer's diff surfaces are served from), the head-revision file tree listing, the seed-hunk index (`@app/journey/hunks` output), and the full old- and new-revision contents of every changed file (what context expansion and the just-the-code view are served from — [05](./05-frontend.md)). After this point, ingestion never consults git again. Journey _reading_ consults the clone for exactly one thing: serving files outside the changed set (free reading of any tree file), re-fetched on demand if the workspace was evicted.
- **Eviction**: workspaces are a cache. LRU by repository, generous cap; deleting one is always safe because re-cloning is always possible.

## The door

Ingestion's precondition checks — the only place "no" is an allowed answer (per the vision, analysis itself never fails):

| Check                                            | Rejection                                                    |
| ------------------------------------------------ | ------------------------------------------------------------ |
| URL parses to a PR                               | `invalid-url`                                                |
| `gh` installed and authenticated                 | `gh-unavailable` (with setup instructions)                   |
| GitHub reachable and within quota                | `github-parked` (carrying `resetAt`) or `github-unavailable` |
| PR visible to the viewer's login                 | `not-found` (indistinguishable from private, honestly so)    |
| PR state ingestible (open, or merged at any age) | `not-open` — only a PR closed _without_ being merged         |
| A harness installed and authenticated            | `no-harness` (with the exact install/login line to run)      |

That is the whole set — `DoorRejectionReason` in [`packages/contracts/src/github.ts`](../../packages/contracts/src/github.ts) is a closed union of exactly these seven. The last two are worth naming for the same reason the others are: a reviewer who cannot start an analysis because their quota is exhausted or because no agent is installed has a remedy, and a door that said only "could not open" would be hiding the one sentence that helps.

A merged PR is ingestible however old it is: the only state the door refuses is closed-without-merge, because that is the only one where there is genuinely nothing to walk. The seven-day window that shows up elsewhere is `MERGED_RETENTION` in [`prs/PrList.ts`](../../apps/server/src/prs/PrList.ts), which decides how long a merged PR lingers in the welcome screen's merged section — it is a listing decision, never a precondition on ingestion.

Door rejections are typed contract errors surfaced before a job exists; they are the _only_ error channel of `ingestion.start`.
