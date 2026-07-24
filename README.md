# Throughline

**Turn a large pull request into an ordered story of intentional steps — so a reviewer can follow the development journey instead of scrolling a flat list of file diffs.**

## Why

The way code gets written has changed faster than the way code gets reviewed. Agent-written changes routinely arrive as 10,000–40,000 line pull requests, and today's review tools answer only one question about them — _what changed in each file_ — while staying silent on the ones that matter: what was the plan, what belongs together, what depends on what, where do I begin.

Before a reviewer can decide whether a change is _correct_, they first have to understand what it _is_. At this scale, understanding is the bottleneck. Throughline exists to remove it.

## What it is

Throughline is a desktop app and a **PR comprehension system** — a companion to code review, not a participant in it. Point it at a pull request and an AI agent reads the whole diff (and the codebase around it), then reconstructs the development journey behind the change: an ordered sequence of **clusters**, each a coherent step with a narrative explaining what it does and why it sits where it does.

The core guarantee: Throughline never summarizes the diff — it **partitions** it. Every changed line lands in exactly one home cluster, and finishing the journey provably means every change was presented and acknowledged. The narrative is a lens over the code, never a replacement for it.

## The documents

This project is being built documentation-first. The docs are the product right now:

| Document                                   | What it holds                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [`docs/VISION.md`](./docs/VISION.md)       | Why Throughline must exist, what it is, and the principles that bind it                                |
| [`docs/PRODUCT.md`](./docs/PRODUCT.md)     | The product specification — the map into the per-surface docs in [`docs/product/`](./docs/product/)    |
| [`docs/TECHNICAL.md`](./docs/TECHNICAL.md) | The technical specification — the map into the per-area docs in [`docs/technical/`](./docs/technical/) |
| [`CONTEXT.md`](./CONTEXT.md)               | The domain glossary — the ubiquitous language (journey, cluster, hunk, home, coverage…)                |

Read them in that order; where they conflict, the vision wins.

## The stack

- **[Effect](https://effect.website) v4 + Electron + React 19** — the app shell: a supervised local Effect server, typed RPC/IPC contracts, one web build that runs in the shell and the browser.
- **[`@pierre/diffs`](https://diffs.com) and [`@pierre/trees`](https://trees.software)** — the rendering foundations for every diff surface and file tree. Throughline's job is the journey, not reinventing diff viewers.
- **GitHub CLI (`gh`)** — authentication and PR access ride on your existing login.

> **Status:** early. The documentation leads; the app code is still the starter scaffold Throughline will be built into.

## Development

Requires Node 24 and pnpm 11.

```bash
pnpm install
pnpm dev            # server + web UI in your browser, with HMR
pnpm dev:desktop    # the Electron shell
pnpm check          # typecheck + lint + format
pnpm test           # vitest across every package
```
