# Architecture

The system shape: processes, packages, and the seams everything else in `docs/technical/` hangs on. Vocabulary follows the deep-module school: a **module** is an interface plus an implementation, a **seam** is where an interface lives, and a module is **deep** when a small interface hides a lot of behavior.

## Process topology

Throughline keeps the starter's three-process shape unchanged — the ADRs in `docs/adr/` all continue to apply:

```
┌──────────────────────────┐   spawn + fd3 envelope   ┌──────────────────────────┐
│  Electron shell           │ ───────────────────────▶ │  Local Effect server      │
│  (apps/desktop)           │      (ADR-0001/0002)     │  (apps/server)            │
│  windows, menus, updates  │                          │  GitHub, workspaces,      │
└──────────┬───────────────┘                          │  analysis, persistence    │
           │ IPC bridge                                └──────────┬───────────────┘
┌──────────▼───────────────┐        WS RPC (one build, ADR-0004)  │
│  Renderer (apps/web)      │ ◀────────────────────────────────────┘
│  welcome, journey reading │
└──────────────────────────┘
```

The division of labor is the important commitment:

- **The server owns everything durable and everything slow.** GitHub access, clone workspaces, the analysis pipeline, journey persistence, read state. An ingestion run survives the renderer closing its window because nothing about it lives in the renderer.
- **The renderer owns only presentation.** It holds no state the server can't rebuild it from; refreshing the page mid-ingestion reconnects and resumes watching (ADR-0003's supervisor plus the snapshot-then-live push-bus pattern).
- **The shell owns only being a good host.** It gains no Throughline domain knowledge; its jobs stay windows, lifecycle, updates, and the IPC bridge.

Everything is local-first: there is no Throughline cloud, no telemetry, no server other than the one the shell spawns. The reviewer's own `gh` login and their own agent-harness logins are the only credentials in the system.

## Package map

The monorepo gains one package and grows the server; the notes sample domain (marked for deletion in the starter) is removed in the same change that lands the first real domain code.

| Package                    | Role                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`       | Extended, stays schema-only: journey/cluster/hunk/hint schemas, GitHub view types, ingestion events, and the new RPC groups. The wire truth.       |
| `packages/journey` _(new)_ | Pure domain logic over contract types: seed-hunk derivation from patch text, partition/coverage validation, split validation, progress arithmetic. |
| `packages/shared`          | Unchanged role — host-agnostic runtime utilities.                                                                                                  |
| `packages/client-runtime`  | Unchanged — connection supervisor and typed RPC client.                                                                                            |
| `apps/server`              | Gains the domain modules below.                                                                                                                    |
| `apps/web`                 | Becomes the product UI: welcome, ingestion transition, overview, reading experience.                                                               |
| `apps/desktop`             | Essentially unchanged.                                                                                                                             |

`@app/journey` exists because it passes the two-adapters test: the same partition and progress arithmetic runs on the server (validating agent output, persisting) and in the renderer (progress display, mapping hunks onto rendered diffs). It is pure — no I/O, no Effect services, functions from values to values — which also makes it the most heavily unit-tested code in the repo. It follows the subpath-exports-only rule (`@app/journey/hunks`, `/coverage`, `/progress`), like `@app/shared`.

Everything else stays a **directory module inside `apps/server`** — one consumer means a package would be a hypothetical seam (deletion test: moving it out removes no complexity, adds a package boundary to maintain):

| Server module | Interface it presents                                                                | Documented in                              |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `github/`     | `GitHub` — the only door to the GitHub API and `gh`                                  | [03-github.md](./03-github.md)             |
| `workspace/`  | `Workspaces` — clone/worktree lifecycle, diff materialization                        | [03-github.md](./03-github.md)             |
| `harness/`    | `AnalysisHarness` — run one structured analysis task on a local agent harness        | [04-analysis.md](./04-analysis.md)         |
| `analysis/`   | `Ingestion` — PR in, journey out, honest progress events                             | [04-analysis.md](./04-analysis.md)         |
| `journeys/`   | `JourneyStore` — SQLite-backed persistence: journeys, read state, PR state, settings | [02-domain-model.md](./02-domain-model.md) |

## The seams that matter

Five seams carry the whole design. Each is deliberately small; the depth lives behind it.

1. **The WS RPC contracts** (`packages/contracts`) — the renderer↔server seam. Unary RPCs for immutable artifacts (a journey is fetched once), snapshot-then-live streams for anything that moves (ingestion progress, PR lists, read state). The starter's push-bus pattern — versioned events, monotonic `sequence`, snapshot replay on subscribe — is the template for every stream.
2. **`GitHub`** — one module, one choke point. Every byte to or from the GitHub API flows through it, which is what makes the rate-limit discipline ([03](./03-github.md)) enforceable instead of aspirational.
3. **`AnalysisHarness`** — the seam the user's agent harnesses plug into. Codex and Claude are the two v1 adapters; ACP is a planned third. The interface is small enough (detect, run-with-schema, cancel-via-scope) that adding a harness never touches the pipeline. T3 Code (`~/forks/t3code`) proves this shape at much larger scale — five harnesses behind one provider interface — and is our reference for the subprocess-supervision details.
4. **`Ingestion`** — the pipeline as a module. Callers see "start job, watch events, get journey"; clone orchestration, prompt assembly, validation, and repair are implementation.
5. **`LocalApi`** (existing, ADR-0004) — the renderer↔host seam. Unchanged; any new bridge capability must define its browser degradation.

## The ingestion data flow

The one sequence that touches every seam, end to end:

```
renderer ── ingestion.start(prRef) ──▶ Ingestion
  Ingestion ─▶ GitHub      : resolve PR, door checks (reachable? permitted?)
  Ingestion ─▶ Workspaces  : clone/fetch repo, add worktree at head, materialize diff
  Ingestion ─▶ @app/journey: derive seed hunks (deterministic)
  Ingestion ─▶ AnalysisHarness : staged structured runs over the workspace
  Ingestion ─▶ @app/journey: validate partition ▸ repair loop ▸ deterministic fallback
  Ingestion ─▶ JourneyStore: persist journey atomically, reset read state
  (throughout) Ingestion ──▶ push bus ── phase events ──▶ renderer transition UI
```

## Runtime constraints carried forward

- **Effect v4 everywhere** on the server and in transport; the vendored `.repos/effect` stays the idiom reference.
- **Persistence is SQLite via `@effect/sql-sqlite-node`** ([02](./02-domain-model.md)) — same pinned Effect version, riding Node's built-in `node:sqlite`: no native modules, verified under Electron's bundled Node (24.x under the pinned Electron; build targets stay under that floor, per ADR-0006).
- **The server runs under Electron's bundled Node when packaged** (ADR-0006). The harness SDKs (`@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`) both spawn their own bundled platform binaries — they must stay **external** to the server bundle and ship as packaged dependencies, and any change here is verified against a packaged app, per ADR-0006.
- **Packaged renderer entry documents are never served from a stale cache.** The shell versions its root navigation with the app version, and the local server sends `index.html` (including SPA fallbacks) with `Cache-Control: no-store`. Static assets may use a short private cache because Vite content-hashes their production filenames. This is required because ADR-0001 gives every release the same loopback origin.
- **Auth posture unchanged** (ADR-0002): one local trust level, bearer at the WS upgrade. Journeys contain the reviewer's own code visible to their own logins; nothing new crosses a trust boundary.
- **Analysis is read-only.** No harness run may mutate the workspace, and nothing anywhere writes to GitHub. These are enforced mechanically (sandbox modes, tool allowlists — see [04](./04-analysis.md)), not by prompt politeness.
