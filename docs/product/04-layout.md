# Layout & Panels

The frame everything sits in: three panels, in the spirit of the reference product but radically decluttered.

```
┌────────────┬──────────────────────────────┬──────────────┐
│ Journey    │  Overview or cluster view    │  Guidance    │
│ (or Files) │  (the code)                  │  (the lens)  │
└────────────┴──────────────────────────────┴──────────────┘
```

The middle panel is the reading surface — the [Overview](./02-overview.md) or the [cluster view](./03-cluster-view.md). This document covers the two rails around it.

## Left rail — navigation

Two tabs. The journey is the primary navigation; the file tree is the escape hatch.

### Journey tab (default)

The Overview entry, then the ordered clusters. Each cluster row shows exactly four things:

- its **position** in the journey,
- its **title**,
- its **weight** (quiet text label),
- its **read progress**.

No badge rows, no color chips, no counts-of-counts. Everything else about a cluster lives in the middle panel when selected — nothing essential is ever behind a hover. The row for a completed cluster reads as done at a glance; the journey's overall progress is visible at the top of the rail. A stale journey is flagged here (see [01-ingestion.md](./01-ingestion.md)).

### Files tab

The file tree of the whole PR, for "just show me this file." Opening a file shows its full diff in the middle panel with every hunk labeled by — and linked to — its home cluster, so even the escape hatch routes back to the journey. Read marks made here and in the journey view are the same marks; there is one read state, viewed two ways.

## Right rail — guidance

A scroll-synced lens over whatever the middle panel shows. As the reviewer moves through code, the rail surfaces the narrative fragments anchored to the hunks currently in view: what this specific change does within the step, and links to the symbols and files that evidence it.

Rules that keep it a lens and not a dashboard:

- **It follows; it is never operated.** Position in the code drives it. No filters, no tabs, no controls in v1.
- **Anchored, always.** Every fragment points at the exact hunk range it describes; clicking a fragment scrolls the code to its anchor, and scrolling the code brings its fragments into view. Prose that can't be checked against code doesn't ship (vision principle 5).
- **Quiet.** The rail may be collapsed entirely; reading the code with no rail must remain a complete experience, because the narrative also lives at the top of the cluster view.
