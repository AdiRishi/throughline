# Throughline — Technical Specification

The [vision](./VISION.md) says why; the [product specification](./PRODUCT.md) says what, surface by surface. This is how: the system that delivers those surfaces. Where this conflicts with either, they win and this document is wrong. Terms are defined in [`CONTEXT.md`](../CONTEXT.md); hard-to-reverse decisions get ADRs in [`docs/adr/`](./adr/AGENTS.md) as they are implemented.

This file is the map. Each area has its own document in [`docs/technical/`](./technical/) — read them in order:

1. [**Architecture**](./technical/01-architecture.md) — processes, packages, and the five seams the design hangs on.
2. [**Domain model & persistence**](./technical/02-domain-model.md) — the journey as data; coverage as a checked invariant; what lives on disk.
3. [**GitHub access & workspaces**](./technical/03-github.md) — everything rides `gh`, through one module whose rate discipline is structural.
4. [**The analysis pipeline**](./technical/04-analysis.md) — the harness seam (Codex + Claude now, ACP later), the staged runs, and repair-then-commit.
5. [**The frontend**](./technical/05-frontend.md) — state architecture and how the product surfaces map onto `@pierre/diffs` and `@pierre/trees`.

## Commitments that bind every document

- **Local-first, credentials-last.** No Throughline cloud. GitHub access rides the reviewer's `gh` login; analysis rides their own agent-harness logins (Codex, Claude). The app ships no model and holds no secrets of its own.
- **The guarantees are checked, not prompted.** Coverage, evidence resolution, and resurfacing rules are pure validators (`@app/journey`) the server enforces before persisting; the agent's freedom is bounded to refining a deterministic seed partition. "The agent always commits" is implemented as validate → repair → deterministic completion, so a valid journey always exists.
- **The server owns everything durable and slow**; the renderer is rebuildable from the wire; the shell stays a host. Immutable artifacts travel as unary RPCs, changing state as snapshot-then-live streams. Durable state lives in one SQLite database (`@effect/sql-sqlite-node` on `node:sqlite`); bulk run artifacts and clone workspaces stay on disk beside it.
- **External services are behind single choke points.** One `GitHub` module (semaphored, cached, parked on rate limits, retries bounded to transport failures); one `AnalysisHarness` seam (read-only enforced by sandbox/allowlist, scope-owned subprocesses).
- **Rendering is not reinvented.** Every diff surface is `@pierre/diffs`, every tree `@pierre/trees`; Throughline's frontend work is the journey, not diff plumbing.
- **The starter's ADRs stand** — process topology (0001), local trust (0002), single reconnector (0003), one web build (0004), raw-source packages (0005), Electron build shape (0006), test layout (0007).

## Known build-time risks

Named here so they are spiked early, not discovered late:

- **Emphasis/dimming inside Pierre diffs** — the cluster boundary's visual carrier rides `@pierre/diffs`' CSS/annotation seams; mechanism must be proven against a real `CodeView` first ([05](./technical/05-frontend.md)).
- **Packaged-app harness SDKs** — both SDKs spawn bundled platform binaries and must stay external to the server bundle under Electron's Node (ADR-0006 territory; verify packaged, [01](./technical/01-architecture.md)).
- **Plan quality at 40k lines** — the pipeline's stage split and disk-materialized inputs are designed for it, but prompt and stage tuning against real large PRs is expected iteration, not a risk to the architecture ([04](./technical/04-analysis.md)).
