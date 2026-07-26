# The Reading Experience

Where the reviewer spends nearly all their time: the frame, the navigation, and how a cluster's code is actually read. The right rail — guidance — has [its own document](./05-guidance.md).

**Designs:** [`designs/04-reading-cluster.png`](./designs/04-reading-cluster.png) (Journey mode, diff) · [`designs/04-reading-just-the-code.png`](./designs/04-reading-just-the-code.png) (Files mode, just-the-code)

## The frame

Three panels:

```
┌────────────┬──────────────────────────────┬──────────────┐
│ Navigation │  The code                    │  Guidance    │
│ (journey   │  (diff, or just the file)    │  (hints,     │
│  or files) │                              │   scroll-    │
│            │                              │   bound)     │
└────────────┴──────────────────────────────┴──────────────┘
```

The middle panel is the reading surface. When a cluster is open it shows the cluster page (below), with guidance riding alongside. When the [Overview](./03-overview.md) is open, the document takes over the middle _and_ right panels — guidance is a companion to code, and the Overview has no code.

Every diff surface is `@pierre/diffs`; every file tree is `@pierre/trees` (see PRODUCT.md, Technology foundations).

## The posture: an editor, receded

Applying the spine's "IDE, not a dashboard" principle, entering a cluster makes the frame **recede**: navigation minimizes to its essentials, the code takes the center, and guidance earns its width only when it has something to say. What remains is close to a plain editor — file tree, code, a margin of help — because sometimes the reviewer just wants to read code, and nothing about being in a review tool should take that away. (The [reference product](./external-references/README.md) is the cautionary example: its skeleton is right and its loudness leaves the code no room to breathe.)

## Left rail — navigation

A segmented control with two modes. The journey is the primary navigation; the file tree is the reading posture.

### Journey

The Overview entry, then the ordered clusters. Each cluster row shows exactly four things: its **position**, its **title**, its **weight** (quiet text label), and its **read progress**.

No badge rows, no color chips, no counts-of-counts. Everything else about a cluster lives in the middle panel when selected — nothing essential is ever behind a hover. A completed cluster reads as done at a glance; the journey's overall progress is visible at the top of the rail. A stale journey is flagged here (see [02-ingestion.md](./02-ingestion.md)).

### Files

The **project's real file tree** — not a synthetic list of changed paths. It looks and behaves like an editor's tree, because the intent is to feel like you're in the project, not in a report about it.

- **A pinned overview entry sits above the tree** — a permanent, file-like entry that opens the PR's Overview, and while a cluster is open it says which one by appending that cluster's position and title to its own label (`Overview — 3 · Token issuance`), so the tree never loses track of the step the reading is happening inside. In the receded posture this is what keeps the journey's own document one click away: docs-as-files, the way an editor would treat a README. The cluster's narrative is not filed here — it leads the cluster page instead, which is where reading a cluster starts.
- **Changed files are marked** the way an editor marks uncommitted changes — a quiet status indicator on the row, visible up the collapsed folder chain.
- **A filter narrows the tree to changed files only**, for when the full tree is noise. Full-tree-with-markers is the default posture; the filter is one toggle away.
- Opening any file shows it in the middle panel with every hunk labeled by — and linked to — its home cluster, so even free reading routes back to the journey. Read marks made here and in the journey view are the same marks; there is one read state, viewed two ways.

## The cluster page

One cluster is on screen at a time; the reviewer arrives from the Overview or the left rail and works the cluster to completion.

### The narrative leads

The cluster's narrative sits at the top of the page, where reading starts — never behind a hover, never in a sidebar footnote. It states what this step accomplishes, why it sits at this point in the journey, and how it builds on the clusters before it. Every claim in it links to the hunks, files, or symbols that evidence it (vision: every claim is evidence-backed).

It is **collapsible**: expanded while nothing in the cluster has been read, and collapsed from the moment the first file is marked read, so it orients on arrival without taxing every scroll-to-top afterward. Collapsed it keeps a one-line lead drawn from its own opening paragraph — a narrative has no title to fall back to, and recognizing _which_ story this is takes only a line — with the full prose one click away, never only on hover. It also never scrolls out of reach: the narrative holds its own band above the code, and it is the code beneath it that scrolls.

### Whole files, emphasis carries the boundary

Below the narrative, every file this cluster touches, as **full file diffs**:

- **File order is narrative order.** Files appear in the order the cluster's story wants them read — chosen by the agent, never alphabetical.
- **Hunks homed to this cluster are emphasized** in the accent — the same accent that marks the reviewer's place everywhere else in the product (the rail's current row, a filled meter), because "this is where you are" is one idea and wears one colour. Resurfaced hunks are accented too, since they are also this cluster's business, but carry an inset bar as well: the reviewer must never lose the difference between known code seen from a new angle and code they have not read.
- **Hunks homed to other clusters are dimmed**, labeled with their home cluster, and one click from it. The full file is always present; the cluster boundary is carried by emphasis, not exclusion. This also makes the partition itself visible — every hunk on screen declares where it belongs.
- **Unchanged regions are collapsed** and expandable in place, for as much surrounding context as the reviewer wants.

### Three ways to see the code

One display mode at a time, per journey — switch it and it stays that way until you switch it again. On screen it reads as two controls — a **Diff | Code** toggle in the top bar, and the diff's **inline or split** arrangement in the file headers where the eye already is — but both always set the journey-wide mode. There is no per-file divergence:

- **Inline** (default) — the unified diff.
- **Just the code** — every trace of diff UI falls away, leaving the file's new state as plain code, with only a subtle marker in the margin showing which regions changed. For when the reviewer just wants to _read_ — silence, with orientation. Hints anchored to the new side still bind here, against those markers. Hints anchored to removed lines cannot: this mode shows the head revision only, so the lines they point at are not on screen, and rather than move them to some approximate line the guidance rail holds them back and says how many are waiting on the diff. A deleted file is the one exception — it has no head revision to show in silence, so it falls back to its deletion diff, and its old-side hints bind there.
- **Split** — side-by-side, for the reviewers who prefer it. Available, not emphasized.

The mode changes how code renders, never what counts: read state, coverage, and emphasis semantics are identical in all three.

### Resurfacing

A resurfaced hunk — shown here although its home is elsewhere, because this cluster's story needs it — is rendered like an emphasized hunk but **visibly marked as a revisit**, with its home cluster named and linked. The distinction the reviewer must never lose: emphasized-and-marked means "known code from a new angle," not "new code." Resurfaced hunks do not count toward this cluster's progress; coverage lives at home.

## Reading interactions

The complete interaction set of this experience:

- **Display mode** — inline, just-the-code, or split.
- **Mark read** — per file within the cluster. Marking a file read collapses it and advances the cluster's progress. This is the primary interaction of the whole product; it should be effortless (one click, one keystroke).
- **Expand context** — open collapsed unchanged regions.
- **Changed-files filter** — narrow or widen the file tree.
- **Open and close tabs**, in free file reading only — files opened from the tree stack up as an editor's tab strip, each carrying its read marker and a close button that is visible at rest rather than revealed on hover. Free reading means having more than one file open, and closing the last tab is a way of saying you are done reading loose, so it lands the reviewer back in the journey — at the cluster they arrived from when that is known, at the Overview when it is not. The strip is renderer state, not journey state: a reload lands on the file the URL names, not on a restored workspace nobody asked to keep.
- **Navigate** — next/previous file within the cluster; next/previous cluster in the journey; next/previous changed region within the open file.

Nothing else. No per-file button rows, no comment affordances, no complexity filters.

## Completion

When every file in the cluster is marked read, the cluster is complete — reflected immediately in the left rail and the Overview map. Completing the last cluster completes the journey: every hunk acknowledged at its home, the coverage guarantee discharged.
