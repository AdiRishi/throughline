# External References

Screenshots of **other products, not Throughline** — the images the product documents mean when they say "the reference product." They are here to inspire and to warn, never to direct: where anything in them conflicts with our own documents, our documents win. Kept in-repo so the docs' judgments stay checkable.

## CodeRabbit's review UI

`cluster-view.png` · `file-view.png` · `overview-view.png` — CodeRabbit's PR review interface ("Layers"), captured reviewing a real PR.

**What we took:**

- The three-panel skeleton: navigation left, code center, contextual guidance right.
- "Layers" as ordered, numbered steps of a change — structurally our clusters.
- The scroll-synced right rail of per-range prose — the germ of our guidance rail.
- Per-file "mark viewed" with progress — the one interaction worth keeping.
- Scoping the middle panel's files to the selected layer.

**What we rejected:**

- The loudness: badge rows, severity color chips, button farms. The code has no room to breathe.
- Cluster descriptions living in hover cards — narrative hidden behind a hover.
- A judgment-first overview ("High-priority concerns" before comprehension exists).
- Chat/agent panels and complexity filters inside the reading experience.

## Pierre component samples

`diffs-com-sample-ui.png` · `trees-com-sample-ui.png` — the reference experiences of [`@pierre/diffs`](https://diffs.com) and [`@pierre/trees`](https://trees.software), our rendering foundations.

The Trees sample — editor-like file tree beside plain code — is the feeling the reading experience aims for: an IDE, not a dashboard.
