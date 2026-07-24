# AGENTS.md

## Task Completion Requirements

- `pnpm check` and `pnpm test` must pass before considering tasks completed.

## Project Snapshot

Throughline is a PR comprehension system: a desktop app that turns a large pull request into an ordered journey of clusters a reviewer can walk to the end. The app code is currently the Effect v4 starter it is being built into: an Electron shell supervising a local Effect server (HTTP + WebSocket RPC), with one React web build that runs in the shell and in a plain browser.

## Documentation — read before designing or building anything

This project is documentation-first; the docs are authoritative over any assumption. In reading (and precedence) order:

1. [`docs/VISION.md`](./docs/VISION.md) — why Throughline exists and the principles that bind it. Where documents conflict, the vision wins.
2. [`docs/PRODUCT.md`](./docs/PRODUCT.md) → [`docs/product/`](./docs/product/) — what the product does, surface by surface.
3. [`docs/TECHNICAL.md`](./docs/TECHNICAL.md) → [`docs/technical/`](./docs/technical/) — how it's built: architecture, domain model, GitHub access, the analysis pipeline, the frontend.
4. [`CONTEXT.md`](./CONTEXT.md) — the domain glossary (journey, cluster, hunk, home, coverage…). Use these terms exactly, including their listed _avoid_ words.
5. [`docs/adr/`](./docs/adr/AGENTS.md) — why the hard-to-reverse decisions were made.

Any change that contradicts these documents is wrong until the documents are changed first.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Tests

Unit tests live in each package's `tests/` directory, mirroring the source tree: the test for `src/state/connection.ts` is `tests/state/connection.test.ts`. Never colocate `.test.ts` files under `src/`. When adding a package, include `tests/**` in its `tsconfig.json` or the tests silently stop typechecking (see `docs/adr/0007`).

## Package Roles

- `apps/desktop`: Electron shell. Spawns and supervises the local server, owns windows/menus/updates, and exposes a schema-validated IPC bridge to the renderer.
- `apps/server`: Effect HTTP + WebSocket RPC server. Serves the built web app, handles the bearer-auth exchange, and publishes lifecycle events.
- `apps/web`: React/Vite UI. Connects to the server over WebSocket RPC; the same build runs in the shell and in a plain browser.
- `packages/contracts`: effect/Schema contracts for the WS RPC surface, the IPC bridge, and the auth/bootstrap types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Runtime utilities consumed by multiple apps. Explicit subpath exports (e.g. `@app/shared/Net`) — no barrel index.
- `packages/client-runtime`: Client transport: the connection supervisor and typed RPC client. Subpath exports only (`/connection`, `/rpc`, `/authorization`).
- `scripts`: Repo tooling — dev runner, desktop packaging, reference-repo sync.
- `oxlint-plugin-app`: Custom oxlint rules (Node namespace imports, HostProcess injection, hoisted Schema compilers, @effect/vitest in tests). Wired via `jsPlugins` in `.oxlintrc.json`.

## Vendored Repositories

`.repos/` holds read-only vendored reference repos. See `.repos/AGENTS.md` for more details.

- When writing Effect code, read `.repos/effect/LLMS.md` first and inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design.
