# Throughline — Product Specification

The [vision](./VISION.md) is the goal and direction: what Throughline is and why it must exist. The product specification is the specifics: what the product actually does, surface by surface, to achieve that vision. Where the two conflict, the vision wins and the specification is wrong. Terms are defined in [`CONTEXT.md`](../CONTEXT.md).

This file is the map. Each surface has its own document in [`docs/product/`](./product/) — read them in order, the same way a journey is read:

1. [**The welcome screen**](./product/01-welcome.md) — the app's front door: your repositories, your PRs, your review state.
2. [**Ingestion & freshness**](./product/02-ingestion.md) — from PR to journey; the transition experience; what happens when the PR moves on.
3. [**The Overview page**](./product/03-overview.md) — where every journey starts: the story and the map of the change.
4. [**The reading experience**](./product/04-reading.md) — the heart of the product: the frame, the navigation, and how a cluster's code is read.
5. [**Guidance & hints**](./product/05-guidance.md) — the scroll-bound margin of help beside the code.

Throughline's own screen designs live in [`docs/product/designs/`](./product/designs/README.md) — the visual source of truth for layout, hierarchy, and tone; the written documents stay the source of truth for behavior. Screenshots of other products that inspired (and warned) us live in [`docs/product/external-references/`](./product/external-references/README.md) — inspiration, not direction.

This specification captures intent, behavior, and feel — plus the technology commitments that shape the product. It deliberately does not enumerate every state and permutation; deeper architecture lives in the technical docs.

## Product shape

Throughline is a desktop application built on top of GitHub. It opens onto a welcome screen of your repositories and open PRs; from there the reviewer opens a PR — picked from the list or pasted as a URL — and Throughline analyzes it and opens its journey. One artifact, one reading experience.

## Technology foundations

Where excellent building blocks exist, Throughline does not reinvent them:

- **Diff rendering: [`@pierre/diffs`](https://diffs.com)** — every diff surface in the product. Its stacked/split layouts back our inline and split modes; its annotation and line-anchor APIs are the seam the guidance rail and the just-the-code view's change markers hang on.
- **File trees: [`@pierre/trees`](https://trees.software)** — the Files tab and any other tree surface.
- Both are Apache-2.0 open source from The Pierre Computer Co. ([pierrecomputer/pierre](https://github.com/pierrecomputer/pierre)) — polished, sophisticated, and maintained.
- **GitHub access: the GitHub CLI (`gh`)** — authentication and repository/PR access ride on the reviewer's existing `gh` login. No separate account or permission model.

## The core loop

1. **Ingest.** From the welcome screen, the reviewer opens a PR — picked from their list or pasted as a URL. Throughline clones and analyzes it through a designed, honest transition. Per the vision's always-commit principle, analysis cannot fail into an error state — every PR yields a journey.
2. **Orient.** The reviewer lands on the journey's **Overview** — the story of the change and the map of its clusters.
3. **Walk.** The reviewer moves through clusters in order, reading each cluster's files and marking them read as they go.
4. **Finish.** The journey is complete when every hunk has been read in its home cluster. Because of the coverage guarantee, "the journey is finished" means, provably, "every changed line was presented at its home and acknowledged" — nothing omitted, nothing skipped silently.

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
- A path touched by more than one cluster has one read mark per `(cluster, path)`. In Files mode, marking read applies to the currently selected cluster's home hunks in that file; switching home changes the mark being viewed.
- File counts and coverage percentages are distinct: counts report marked cluster-file entries, while percentages are always weighted by homed hunks.
- Progress persists across sessions and survives app restarts.
- Read state is the mechanism that makes the coverage guarantee tangible: the journey's progress reaching 100% _is_ the proof that nothing was omitted — every line was presented at its home and acknowledged there.

## Design principles

These bind every surface documented in `docs/product/`:

- **An IDE, not a dashboard.** Reading a cluster should feel like sitting in your own editor — files on the left, code in the middle, quiet. The frame recedes when reading begins; the code has room to breathe.
- **Calm by default.** One accent color. Color carries exactly one meaning: emphasis of the current cluster's hunks. No severity palettes, no chip rows.
- **Chrome must earn its place.** The reading experience's interaction set is deliberately small: journey/files toggle, display mode (inline, just-the-code, or split), mark-read, expand-context, changed-files filter, and navigation. A control that doesn't serve reading the journey doesn't ship.
- **Nothing essential behind a hover.** Hover may preview; it may never be the only home of information.
- **Prose sits next to the code it explains.** Narrative is anchored, scroll-synced, and evidence-linked — never a detached wall of text.

## Not in v1

- No commenting, approving, or any write-back to the review platform — Throughline is where you understand the change; judgment actions happen on GitHub.
- No chat or agent panel.
- No configuration of the clustering — the journey is read-only, per the vision.
- No stacked-PR awareness; one PR, one journey.

## Open questions

- **Overview map form:** the Overview's cluster map is structured text for now — does it ever warrant a visual (graph) rendering, and can that stay inside the vision's one-opinionated-shape rule?
