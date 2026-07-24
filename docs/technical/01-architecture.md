# Architecture

The system shape: processes, packages, and the seams everything else in `docs/technical/` hangs on. Vocabulary follows the deep-module school: a **module** is an interface plus an implementation, a **seam** is where an interface lives, and a module is **deep** when a small interface hides a lot of behavior.

## Process topology

Throughline uses the three-process shape recorded in `docs/adr/`:

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

The monorepo keeps pure journey logic separate from host-specific runtime modules:

| Package                   | Role                                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`      | Schema-only journey, GitHub, ingestion, RPC, IPC, and auth contracts. The wire truth.                                                     |
| `packages/journey`        | Pure domain logic over contract types: seed-hunk derivation, coverage and evidence validation, split validation, and progress arithmetic. |
| `packages/shared`         | Host-agnostic runtime utilities.                                                                                                          |
| `packages/client-runtime` | Connection supervisor and typed RPC client.                                                                                               |
| `apps/server`             | GitHub access, workspaces, analysis, persistence, and HTTP + WebSocket RPC delivery.                                                      |
| `apps/web`                | Product UI: welcome, ingestion transition, overview, and reading experience.                                                              |
| `apps/desktop`            | Native host: server supervision, windows, menus, updates, and the schema-validated IPC bridge.                                            |

`@app/journey` exists because it passes the two-adapters test: the same partition and progress arithmetic runs on the server (validating agent output, persisting) and in the renderer (progress display, mapping hunks onto rendered diffs). It is pure — no I/O, no Effect services, functions from values to values — which also makes it the most heavily unit-tested code in the repo. It follows the subpath-exports-only rule (`@app/journey/hunks`, `/coverage`, `/progress`), like `@app/shared`.

The server domains stay as **directory modules inside `apps/server`** — one consumer means a package would be a hypothetical seam (deletion test: moving it out removes no complexity, adds a package boundary to maintain):

| Server module   | Interface it presents                                                                | Documented in                              |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `github/`       | `GitHub` — the only door to the GitHub API and `gh`                                  | [03-github.md](./03-github.md)             |
| `workspace/`    | `Workspaces` — clone/worktree lifecycle, diff materialization                        | [03-github.md](./03-github.md)             |
| `harness/`      | `AnalysisHarness` — run one structured analysis task on a local agent harness        | [04-analysis.md](./04-analysis.md)         |
| `analysis/`     | `Ingestion` — PR in, journey out, honest progress events                             | [04-analysis.md](./04-analysis.md)         |
| `journeys/`     | `JourneyStore` — SQLite-backed persistence: journeys, read state, PR state, settings | [02-domain-model.md](./02-domain-model.md) |
| `pullRequests/` | `PullRequestIndex` — viewer-affiliated PRs united with every locally saved journey   | [03-github.md](./03-github.md)             |

## The seams that matter

Five seams carry the whole design. Each is deliberately small; the depth lives behind it.

1. **The WS RPC contracts** (`packages/contracts`) — the renderer↔server seam. Unary RPCs carry immutable artifacts (a journey is fetched once); snapshot-then-live streams carry anything that moves (ingestion progress, PR lists, read state). Every stream uses the shared push-bus contract: versioned events, monotonic `sequence`, and snapshot replay on subscribe.
2. **`GitHub`** — one module, one choke point. Every byte to or from the GitHub API flows through it, including the cached detail reads that let `PullRequestIndex` refresh saved journeys outside the viewer-affiliation list. The index falls back to the immutable PR detail in the finalized `Workspaces` run when GitHub cannot supply one. This is what makes both the rate-limit discipline and saved-journey availability ([03](./03-github.md)) structural instead of aspirational.
3. **`AnalysisHarness`** — the seam the user's agent harnesses plug into. Codex and Claude are the two v1 adapters; ACP is a planned third. The interface is small enough (detect, run-with-schema, cancel-via-scope) that adding a harness never touches the pipeline. T3 Code (`~/forks/t3code`) proves this shape at much larger scale — five harnesses behind one provider interface — and is our reference for the subprocess-supervision details.
4. **`Ingestion`** — the pipeline as a module. Callers see "start job, watch events, get journey"; clone orchestration, prompt assembly, validation, and repair are implementation.
5. **`LocalApi`** (ADR-0004) — the renderer↔host seam. Browser degradation is part of every bridge capability's interface.

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

## Runtime constraints

- **Effect v4 everywhere** on the server and in transport; the vendored `.repos/effect` stays the idiom reference.
- **Persistence is SQLite via `@effect/sql-sqlite-node`** ([02](./02-domain-model.md)) — same pinned Effect version, riding Node's built-in `node:sqlite`: no native modules, verified under Electron's bundled Node (24.x under the pinned Electron; build targets stay under that floor, per ADR-0006).
- **The server runs under Electron's bundled Node when packaged** (ADR-0006). The harness SDKs (`@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`) both spawn their own bundled platform binaries — they must stay **external** to the server bundle and ship as packaged dependencies, and any change here is verified against a packaged app, per ADR-0006.
- **Auth follows ADR-0002:** one local trust level, bearer at the WS upgrade. Journeys contain the reviewer's own code visible to their own logins; nothing crosses an additional trust seam.
- **Analysis is read-only.** No harness run may mutate the workspace, and nothing anywhere writes to GitHub. These are enforced mechanically (sandbox modes, tool allowlists — see [04](./04-analysis.md)), not by prompt politeness.
