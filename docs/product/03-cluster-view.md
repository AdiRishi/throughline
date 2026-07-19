# The Cluster View

The heart of the product: where a cluster's code is actually read. One cluster is on screen at a time; the reviewer arrives from the Overview or the left rail and works the cluster to completion.

## The narrative leads

The cluster's narrative sits at the top of the page, always visible where reading starts — never behind a hover, never in a sidebar footnote. It states what this step accomplishes, why it sits at this point in the journey, and how it builds on the clusters before it. Every claim in it links to the hunks, files, or symbols that evidence it (vision principle 5).

## The code: whole files, emphasis carries the boundary

Below the narrative, every file this cluster touches, as **full file diffs**:

- **File order is narrative order.** Files appear in the order the cluster's story wants them read — chosen by the agent, never alphabetical.
- **Hunks homed to this cluster are emphasized.** This is the product's single use of accent color.
- **Hunks homed to other clusters are dimmed**, labeled with their home cluster, and one click from it. The full file is always present; the cluster boundary is carried by emphasis, not exclusion. This also makes the partition itself visible — every hunk on screen declares where it belongs.
- **Unchanged regions are collapsed** and expandable in place, for as much surrounding context as the reviewer wants.

## Resurfacing

A resurfaced hunk — shown here although its home is elsewhere, because this cluster's story needs it — is rendered like an emphasized hunk but **visibly marked as a revisit**, with its home cluster named and linked. The distinction the reviewer must never lose: emphasized-and-marked means "known code from a new angle," not "new code." Resurfaced hunks do not count toward this cluster's progress; coverage lives at home.

## Reading interactions

The complete interaction set of this view:

- **Inline / split toggle** — one global setting for how diffs render, reviewer's preference, remembered across sessions.
- **Mark read** — per file within the cluster. Marking a file read collapses it and advances the cluster's progress. This is the primary interaction of the whole product; it should be effortless (one click, one keystroke).
- **Expand context** — open collapsed unchanged regions.
- **Navigate** — next/previous file within the cluster; next/previous cluster in the journey.

Nothing else. No per-file button rows, no comment affordances, no complexity filters.

## Completion

When every file in the cluster is marked read, the cluster is complete — reflected immediately in the left rail and the Overview map. Completing the last cluster completes the journey: every hunk seen at its home, the coverage guarantee discharged.
