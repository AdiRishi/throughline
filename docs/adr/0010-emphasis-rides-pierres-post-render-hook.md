# Emphasis Rides Pierre's Post-Render Hook, Not Its Line Backgrounds

The technical spec named this the one integration risk in the frontend: the cluster boundary is carried by emphasising homed hunks and dimming foreign ones, and `@pierre/diffs` has no per-range dim prop. Spiked against a real `CodeView`, the mechanism is:

- **`options.unsafeCSS`** defines what emphasized, revisited, and dimmed _look_ like, addressing rows through the library's own `data-line` / `data-line-type` / `data-column-number` attributes. It is injected into each item's shadow root, and our app's CSS custom properties (`--color-accent`) inherit into it, so the one accent stays one accent.
- **`options.onPostRender(node, instance, phase, context)`** decides which rows are which. It is the only **per-item, per-line** seam — `unsafeCSS` is global to the whole `CodeView` — and it receives the item context, so it knows which file it is decorating. It runs on every render pass of a visible item, so it stays O(rows on screen).

Two things this deliberately does _not_ do:

**It does not repaint line backgrounds.** The first attempt set `--diffs-line-bg` on homed lines, which destroyed the addition/deletion colouring underneath. Green and red are the diff's own language and are not ours to spend; emphasis is an accent bar in the margin, and dimming is opacity. The product's "one accent colour, one meaning" rule survives precisely because the accent is a _marker_ rather than a fill.

**It does not exclude foreign hunks.** The full file is always present and every hunk on screen declares where it belongs — which is what makes the partition itself visible.

Two further constraints of the library that any change here has to respect: a controlled `CodeView` ignores an updated item unless its `version` changes (a new object with the same `version` is silently discarded), and diffs parsed from patch text are `isPartial`, so Pierre refuses to offer context expansion on them. Both are why items carry a computed `version` and why diffs are built with `parseDiffFromFile` from the materialized old and new revisions rather than from the patch — which is also what makes "expand context" native behaviour instead of something we would have had to build.
