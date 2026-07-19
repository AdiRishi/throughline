# Throughline — Product Specification

The [vision](./VISION.md) is the goal and direction: what Throughline is and why it must exist. The product specification is the specifics: what the product actually does, surface by surface, to achieve that vision. Where the two conflict, the vision wins and the specification is wrong. Terms are defined in [`CONTEXT.md`](../CONTEXT.md).

This file is the map. Each surface has its own document in [`docs/product/`](./product/) — read them in order, the same way a journey is read:

1. [**Ingestion & freshness**](./product/01-ingestion.md) — from PR URL to journey; what happens when the PR moves on.
2. [**The Overview page**](./product/02-overview.md) — where every journey starts: the story and the map of the change.
3. [**The cluster view**](./product/03-cluster-view.md) — the heart of the product: how a cluster's code is read.
4. [**Layout & panels**](./product/04-layout.md) — the three-panel frame, navigation, and the guidance rail.

Technology choices live in the technical docs, not here.

## Product shape

Throughline is a desktop application. The reviewer gives it a pull request URL; Throughline analyzes the PR and opens its journey. That is the entire surface area of v1 — one input, one artifact, one reading experience.

## The core loop

1. **Ingest.** The reviewer pastes a PR URL. Throughline fetches the change and builds the journey, showing visible progress. Per the vision's always-commit principle, this step cannot fail into an error state — every PR yields a journey.
2. **Orient.** The reviewer lands on the journey's **Overview** — the story of the change and the map of its clusters.
3. **Walk.** The reviewer moves through clusters in order, reading each cluster's files and marking them read as they go.
4. **Finish.** The journey is complete when every hunk has been read in its home cluster. Because of the coverage guarantee, "the journey is finished" means, provably, "every changed line has been seen."

## Weight

Every cluster carries exactly one weight — comprehension guidance for where attention should go, per the vision's principle that Throughline guides understanding but never judges quality:

- **Core** — the substance of the change; read closely.
- **Supporting** — necessary but derivative work: tests, wiring, plumbing that follows from the core.
- **Mechanical** — churn with no decision content: renames, generated code, lockfiles, formatting.

Weight is displayed as a quiet text label, not a color system. It never expresses risk, severity, or quality — those words are banned from the product (see `CONTEXT.md`). A Mechanical cluster still counts fully toward coverage; weight changes emphasis, never the guarantee.

## Read state and progress

Read tracking is built in from v1 and is **local-only** — nothing is ever written back to GitHub.

- The unit of marking is **a file within a cluster**. Marking it read collapses it.
- A cluster's progress is the fraction of its homed hunks read; the journey's progress aggregates across clusters.
- Progress persists across sessions and survives app restarts.
- Read state is the mechanism that makes the coverage guarantee tangible: the journey's progress reaching 100% *is* the proof that every line was seen.

## Design principles

These bind every surface documented in `docs/product/`:

- **Calm by default.** One accent color. Color carries exactly one meaning: emphasis of the current cluster's hunks. No severity palettes, no chip rows.
- **Chrome must earn its place.** The v1 interaction set is deliberately small: journey/files toggle, inline/split toggle, mark-read, expand-context, and navigation. A control that doesn't serve reading the journey doesn't ship.
- **Nothing essential behind a hover.** Hover may preview; it may never be the only home of information.
- **Prose sits next to the code it explains.** Narrative is anchored, scroll-synced, and evidence-linked — never a detached wall of text.

## Not in v1

- No commenting, approving, or any write-back to the review platform — Throughline is where you understand the change; judgment actions happen on GitHub.
- No chat or agent panel.
- No configuration of the clustering — the journey is read-only, per the vision.
- No stacked-PR awareness; one PR, one journey.

## Open questions

- **Read state across reanalysis:** reanalyzing a stale journey produces new clusters, so per-cluster progress can't carry over as-is. Does progress reset entirely, or can read marks survive at the file level where files are unchanged?
- **Overview map form:** the Overview's cluster map is structured text for now — does it ever warrant a visual (graph) rendering, and can that stay inside the vision's one-opinionated-shape rule?
