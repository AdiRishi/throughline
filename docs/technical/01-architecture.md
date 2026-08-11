# Architecture

The system shape: processes, packages, and the seams everything else in `docs/technical/` hangs on. Vocabulary follows the deep-module school: a **module** is an interface plus an implementation, a **seam** is where an interface lives, and a module is **deep** when a small interface hides a lot of behavior.

## Process topology

Throughline keeps the T3-aligned starter's three-process shape unchanged:

```
┌──────────────────────────┐ fd3 bootstrap + fd4 lifetime ┌──────────────────────────┐
│  Electron shell           │ ───────────────────────▶ │  Local Effect server      │
│  (apps/desktop)           │   supervised lifecycle   │  (apps/server)            │
│  windows, menus, updates  │                          │  GitHub, workspaces,      │
└──────────┬───────────────┘                          │  analysis, persistence    │
           │ IPC bridge                                └──────────┬───────────────┘
┌──────────▼───────────────┐        WS RPC (one build)            │
│  Renderer (apps/web)      │ ◀────────────────────────────────────┘
│  welcome, journey reading │
└──────────────────────────┘
```

The shell resolves the authoritative port and writes it with the bootstrap credential as one envelope on inherited fd3. It also holds fd4 open for the lifetime of the parent; if the shell exits or crashes, the pipe closes and the server exits rather than becoming an orphan. Environment fallbacks remain available to a deliberately standalone server, but the desktop spawn clears inherited server configuration before providing its resolved values. Readiness checks and the renderer always receive the shell's resolved URL; no desktop path derives or assumes the preferred port.

The division of labor is the important commitment:

- **The server owns durable Throughline domain state and slow work.** GitHub access, clone workspaces, the analysis pipeline, journey persistence, read state, and analysis settings live here. An ingestion run survives renderer reloads and disconnections while the app process remains alive.
- **The renderer owns presentation, portable web preferences, and ephemera.** It holds no domain state the server cannot rebuild from; refreshing the page mid-ingestion reconnects and resumes watching through the single connection supervisor and snapshot-then-live push-bus pattern. Browser-capable preferences such as theme stay behind `LocalApi` and use web storage in a plain browser.
- **The shell owns being a good host.** It gains no Throughline domain knowledge; its jobs stay server supervision, windows, lifecycle, updates, host settings, native-theme synchronization, and the IPC bridge.

Everything is local-first: there is no Throughline cloud or Throughline-operated telemetry backend. Optional OTLP export goes only to a reviewer-configured endpoint. The reviewer's own `gh` login and their own agent-harness logins are the only external credentials in the system.

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
| `apps/desktop`             | Keeps the starter's host role; changes only for host integration, lifecycle, or packaging — never product domain state.                            |

`@app/journey` exists because it passes the two-adapters test: the same partition and progress arithmetic runs on the server (validating agent output, persisting) and in the renderer (progress display, mapping hunks onto rendered diffs). It is pure — no I/O, no Effect services, functions from values to values — which also makes it the most heavily unit-tested code in the repo. It follows the subpath-exports-only rule (`@app/journey/hunks`, `/coverage`, `/progress`), like `@app/shared`.

Everything else stays a **directory module inside `apps/server`** — one consumer means a package would be a hypothetical seam (deletion test: moving it out removes no complexity, adds a package boundary to maintain):

| Server module | Interface it presents                                                                         | Documented in                              |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `github/`     | `GitHub` — the only door to the GitHub API and `gh`                                           | [03-github.md](./03-github.md)             |
| `workspace/`  | `Workspaces` — clone/worktree lifecycle, diff materialization                                 | [03-github.md](./03-github.md)             |
| `harness/`    | `AnalysisHarness` — run one structured analysis task on a local agent harness                 | [04-analysis.md](./04-analysis.md)         |
| `analysis/`   | `Ingestion` — PR in, journey out, honest progress events                                      | [04-analysis.md](./04-analysis.md)         |
| `journeys/`   | `JourneyStore` — SQLite-backed persistence: journeys, read state, PR state, analysis settings | [02-domain-model.md](./02-domain-model.md) |

## The seams that matter

Five seams carry the whole design. Each is deliberately small; the depth lives behind it.

1. **The WS RPC contracts** (`packages/contracts`) — the renderer↔server seam. Unary RPCs for immutable artifacts (a journey is fetched once), snapshot-then-live streams for anything that moves (ingestion progress, PR lists, read state). The starter's push-bus pattern — versioned events, monotonic `sequence`, snapshot replay on subscribe — is the template for every stream.
2. **`GitHub`** — one module, one choke point. Every byte to or from the GitHub API flows through it, which is what makes the rate-limit discipline ([03](./03-github.md)) enforceable instead of aspirational.
3. **`AnalysisHarness`** — the seam the user's agent harnesses plug into. Codex and Claude are the two v1 adapters; ACP is a planned third. The interface is small enough (detect, run-with-schema, cancel-via-scope) that adding a harness never touches the pipeline. T3 Code (`~/forks/t3code`) is the reference for scoped subprocess supervision and structured batch generation, not a provider subsystem to copy wholesale; Throughline has no interactive sessions, approvals, or tool bridge.
4. **`Ingestion`** — the pipeline as a module. Callers see "start job, watch events, get journey"; clone orchestration, prompt assembly, validation, and repair are implementation.
5. **`LocalApi`** (existing) — the renderer↔host seam. Unchanged; any new bridge capability must define its browser degradation.

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
- **The connection supervisor is the only reconnect owner.** RPC-protocol retries stay disabled and a session is single-use. Every reconnect attempt resolves the current target and obtains fresh credentials before constructing a new session, preventing nested retry loops and replayed WebSocket tickets. Snapshot-then-live subscriptions attach to each fresh session and distinguish recoverable transport loss from domain failure.
- **There is one renderer build and one host seam.** Components do not branch on Electron. `LocalApi` delegates to the preload bridge when present and defines a browser degradation for every capability; a capability that cannot degrade belongs behind server RPC instead.
- **Workspace packages ship raw TypeScript.** Their export maps point at `src`; `@app/shared` and `@app/client-runtime` remain subpath-only while the schema-only `@app/contracts` keeps its root export. Product work does not add package build steps or barrels.
- **Persistence is SQLite via `@effect/sql-sqlite-node`** ([02](./02-domain-model.md)) — same pinned Effect version, riding Node's built-in `node:sqlite`: no native modules, verified under Electron's bundled Node. Build targets remain conservatively below the pinned runtime and are raised only after packaged verification.
- **Electron main and preload remain CommonJS bundles.** Effect v4 is ESM-only, so it is bundled into those CJS entries; only Electron's runtime module and `electron-updater` remain external. Development does not exercise this packaged load shape, so module-format, externalization, or build-target changes require packaged verification.
- **The packaged server is currently one bundle.** `apps/server` bundles every non-Node dependency, and the desktop artifact stages no server-side `node_modules`. Harness adapters should preserve that shape when possible by supervising the user's installed CLI. If an adapter requires a runtime package or platform binary, the server external list and artifact staging change together and are verified against a packaged app.
- **Global fetch is the HTTP client in the shell and server.** Do not replace `FetchHttpClient` with the npm-undici-backed Node client without packaged verification; the latter has failed at module load under Electron's Node even when development worked.
- **One local trust level is authorized once per WebSocket.** The shell passes a process-lifetime bootstrap credential over fd3. A client exchanges it for a 30-day in-memory bearer; browsers then trade that bearer, in an HTTP header, for a five-minute single-use WebSocket ticket. `/ws` redeems the ticket from the URL, while clients capable of setting upgrade headers may present the bearer directly. The long-lived bearer is never accepted from the WebSocket query string, and RPC handlers do not repeat authorization checks.
- **Analysis is read-only.** No harness run may mutate the workspace, and nothing anywhere writes to GitHub. These are enforced mechanically (sandbox modes, tool allowlists — see [04](./04-analysis.md)), not by prompt politeness.
