# Throughline

**Turn a large pull request into an ordered story of intentional steps — so a reviewer can follow the development journey instead of scrolling a flat list of file diffs.**

## Why

The way code gets written has changed faster than the way code gets reviewed. Agent-written changes routinely arrive as 10,000–40,000 line pull requests, and today's review tools answer only one question about them — _what changed in each file_ — while staying silent on the ones that matter: what was the plan, what belongs together, what depends on what, where do I begin.

Before a reviewer can decide whether a change is _correct_, they first have to understand what it _is_. At this scale, understanding is the bottleneck. Throughline exists to remove it.

## What it is

Throughline is a desktop app and a **PR comprehension system** — a companion to code review, not a participant in it. Point it at a pull request and an AI agent reads the whole diff (and the codebase around it), then reconstructs the development journey behind the change: an ordered sequence of **clusters**, each a coherent step with a narrative explaining what it does and why it sits where it does.

The core guarantee: Throughline never summarizes the diff — it **partitions** it. Every changed line lands in exactly one home cluster, and finishing the journey provably means every change was presented and acknowledged. The narrative is a lens over the code, never a replacement for it.

## How it works

1. Choose an open or recently merged pull request from the welcome screen, or paste its GitHub URL.
2. Throughline pins the PR's current head, prepares a local Git workspace, and materializes a deterministic diff.
3. Your selected local agent harness reads the diff and surrounding repository in a read-only run world. Throughline validates its structured output, repairs it when necessary, and deterministically completes any coverage the model could not place.
4. The app opens the saved journey: an overview followed by ordered clusters over the real diff. Review files cluster by cluster, follow evidence-backed guidance, and mark each cluster-file pair read until coverage reaches 100%.

Analysis runs server-side, so navigating away or closing the renderer does not cancel it. Throughline runs one analysis at a time and reports its real queue position and observed activity.

## Local-only data

Throughline has no cloud service and writes nothing to GitHub. GitHub access uses your existing `gh` login; model access uses your existing Codex or Claude Code login. Harnesses receive a mechanically read-only workspace.

Each journey is an immutable snapshot pinned to the PR's base and head commits. If the PR moves, the saved journey remains readable and is marked stale; manual reanalysis creates a replacement snapshot and resets its read state.

Journeys, settings, local PR state, and per-cluster file read marks are stored in SQLite. Materialized diffs, transcripts, fallback logs, and repository caches remain beside it on local disk. The desktop app uses Electron's application-data directory; development uses `.throughline-data/` in this checkout.

## Prerequisites

- Node.js 24, pnpm 11.10, and Git.
- [GitHub CLI](https://cli.github.com/) authenticated with access to the repositories you review:

  ```bash
  gh auth login
  ```

- At least one authenticated analysis harness:

  ```bash
  codex login          # Codex
  claude setup-token   # Claude Code; an interactive Claude login also works
  ```

Throughline automatically selects the first authenticated harness, Codex then Claude, unless you choose one explicitly in Settings.

## Development

Install the workspace:

```bash
pnpm install
```

Run the browser or desktop app:

```bash
pnpm dev            # local server + browser UI with HMR
pnpm dev:server     # local server process only
pnpm dev:web        # Vite browser process only
pnpm dev:desktop    # Electron shell + web HMR; builds the server and shell first
```

Validate the repository:

```bash
pnpm check          # typecheck + lint + formatting check
pnpm test           # Vitest across all workspace packages
```

Build or run compiled output:

```bash
pnpm build          # build every buildable app and package
pnpm build:desktop  # build the web app, local server, and Electron shell
pnpm start:desktop  # start the previously built Electron shell
```

Create a desktop artifact:

```bash
pnpm dist:desktop
pnpm dist:desktop -- --platform mac --target dmg
```

The packaging command defaults to the host platform and writes artifacts to `release/dist/`. Supported targets are DMG on macOS, NSIS on Windows, and AppImage on Linux. Signing, notarization, icons, and release metadata still require product-specific distribution configuration.

## The documents

The documentation remains authoritative:

| Document                                   | What it holds                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [`docs/VISION.md`](./docs/VISION.md)       | Why Throughline must exist, what it is, and the principles that bind it                                |
| [`docs/PRODUCT.md`](./docs/PRODUCT.md)     | The product specification — the map into the per-surface docs in [`docs/product/`](./docs/product/)    |
| [`docs/TECHNICAL.md`](./docs/TECHNICAL.md) | The technical specification — the map into the per-area docs in [`docs/technical/`](./docs/technical/) |
| [`CONTEXT.md`](./CONTEXT.md)               | The domain glossary — journey, cluster, hunk, home, coverage, and the rest of the shared language      |

Read them in that order; where they conflict, the vision wins.

## The stack

- **[Effect](https://effect.website) v4 + Electron + React 19** — a supervised local server, typed RPC/IPC contracts, and one web build that runs in the shell and browser.
- **SQLite** — durable journeys and local read state, with immutable run artifacts stored beside it.
- **[`@pierre/diffs`](https://diffs.com) and [`@pierre/trees`](https://trees.software)** — the rendering foundations for every diff surface and file tree.
- **GitHub CLI (`gh`)** — the single read-only gateway to GitHub authentication and PR access.
- **Codex and Claude Code** — interchangeable local analysis harnesses behind one read-only interface.
