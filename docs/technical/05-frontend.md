# The Frontend

How `apps/web` renders the product: state architecture, the Pierre rendering foundations, and how each product surface maps onto them. Product behavior lives in `docs/product/`; the visual source of truth is [`docs/product/designs/`](../product/designs/README.md); this document is how it's built.

## State: the server owns it, atoms view it

Throughline adds **no new state-management library**. The reviewer's state of record — journeys, read state, PR lists, job progress — already lives in the server ([02](./02-domain-model.md)), and the starter's `@effect/atom-react` + push-bus architecture is precisely a client for that shape:

- **Server-owned state** arrives as unary fetches (immutable journey data) or snapshot-then-live streams (ingestion progress, read state, PR list), folded into Effect atoms. Reconnects replay snapshots; the UI can always be rebuilt from the wire.
- **Renderer-local state** is only ephemera: scroll positions, collapsed-narrative flags, the changed-files-filter toggle. Location — which PR, cluster, or file is open — lives in the URL (see Routing). React state and a few atoms suffice for the rest.
- Read marks are **optimistic**: the atom updates on click, the RPC persists, the `readState.subscribe` stream confirms (and reconciles other windows). A failed persist rolls back visibly rather than lying.

The judgment call, made: a second store (Zustand/Jotai) would duplicate what atoms already do here, and server-owned state is what makes "leavable" and multi-window coherence free. If atoms ever chafe, the seam is thin — atoms are only the fold-and-subscribe layer.

## Rendering foundations

Every diff surface is `@pierre/diffs` (React bindings); every tree is `@pierre/trees`. Committed integration points, from their actual APIs:

- **The cluster page's middle panel is one `CodeView`** — its virtualized multi-file stack is built for exactly this. Items: one `diff` item per file in the cluster's `fileOrder`, created by `parseDiffFromFile` from the pinned old/new contents returned in one `journey.files` batch. The resulting `FileDiffMetadata` is non-partial, so unchanged regions collapse by default (`expandUnchanged: false`) and expand in place (`expansionLineCount`) all the way to the file boundaries without another request. The single-file patch/content RPCs remain the immutable artifact seam; the batch RPC removes cluster-sized waterfalls.
- **Display modes** map directly: inline → `diffStyle: "unified"`; split → `diffStyle: "split"`; **just-the-code** → the same `CodeView` with `file` items (head-revision contents from `journey.fileContent`) instead of `diff` items, changed regions marked in the margin via line annotations. One mode journey-wide, restored from `ReadState.displayMode`; the top bar's Diff | Code toggle and the file headers' inline/split control both set that one mode — placement is reach, not scope (product 04).
- **Line anchors** — cluster labels on foreign hunks, resurfacing marks, hint anchors, read-mark affordances — ride `lineAnnotations` + `renderAnnotation` (each annotation is `{ side, lineNumber, metadata }` rendering arbitrary React). Navigation ("one click from its home cluster", hint-click) rides the `CodeViewHandle.scrollTo` targets.
- **Changed-region navigation** — the footer's "region N of M" and the `[` / `]` previous/next-change keys walk the open file's changed regions via the same `scrollTo` targets, identically in every display mode. `r` toggles the focused file's read mark.
- **Emphasis and dimming** carry the cluster boundary: homed hunks emphasized (the product's single accent use), foreign hunks dimmed and labeled. Pierre has no per-range dim prop, so this rides its CSS seam (`useCSSClasses` + scoped custom CSS addressing hunk line ranges), with annotation-rendered overlays as the fallback. **This is the one integration risk in the frontend and the first thing the implementation spikes** — the seam is chosen; the exact mechanism must be proven against a real `CodeView` before the reading experience is built on it.
- **Non-textual changes** render as what they are: images as images (old and new where both exist), other binaries as a quiet placard naming the change ("binary file added"), pure renames and mode changes as single labeled rows. Each is one file-level hunk ([02](./02-domain-model.md)) with the same emphasis, home-labeling, and mark-read semantics as any diff. Deleted files render in their clusters as deletion diffs, and appear as ghosted rows when the changed-files filter is on; the full tree stays the head revision.
- **The file tree** is a `FileTree` model over the full head-revision path list (`journey.tree`) — the project's real tree, per the product. Changed-file markers use the built-in git-status lane (`setGitStatus`); per-row extras (home-cluster count, read state) use `renderRowDecoration`; the changed-files filter is `resetPaths` between full and changed-only sets; the pinned overview entry renders above the tree in the header slot.
- **Theming**: Shiki dual themes (`{ dark, light }` + `themeType`) follow the app's existing theme plumbing (`useTheme`); trees are themed to match via CSS variables. One accent color, as the product demands.

## Surface by surface

**Welcome** — folds `github.prs` + `harness.status` + local `prState` into one list. Ingested PRs carry derived journey progress; parked states ([03](./03-github.md): `gh` missing, rate-limit parked; [04](./04-analysis.md): no harness) render as calm, instructive banners. Refresh is on-focus and manual only — the no-polling rule is a UI rule too.

**Ingestion transition** — a direct rendering of the `ingestion.subscribe` stream: the displayed stages are a grouped view of the job's phases, the live activity lines and counters render the `analyzing` payload ([04](./04-analysis.md)), and there is no invented progress because there is no other data source. Reconnect mid-run replays the snapshot and the transition resumes where reality is.

**Overview** — `journey.overview` rendered as a document across the middle+right panels: Markdown with `tl:` links resolved to navigation, map entries joined with per-cluster derived scale and live progress. The PR's own words sit collapsed at the bottom, from `journey.get` metadata.

**Cluster page** — narrative block (collapsible, `tl:`-linked) above the `CodeView` described above. Mark-read is one interaction, two homes: a per-file affordance in the file header (`renderCustomHeader`) and a keystroke; marking collapses the item (`collapsed`) and advances every progress display through one derivation (`@app/journey/progress`).

**Guidance rail** — hints for the open cluster, positioned by anchor. Scroll-sync is viewport-driven: the rail observes which file+line ranges are visible (intersection observers over the rendered rows) and floats the hints whose anchors intersect; clicking a hint scrolls the code via `scrollTo`. Hints anchored only to the old side are omitted in just-the-code ([02](./02-domain-model.md)). The rail is collapsible and the page is complete without it, per the product.

**Free file reading** — opening any file from the tree renders its full diff with every hunk labeled by home cluster; same read state, same marks, viewed from the file side. Open files sit in tabs — renderer ephemera; the URL holds only the active file. Files outside the changed set are served from the repository clone ([03](./03-github.md)).

**Settings** — detected harnesses with install/auth state (`harness.status`) and the active-harness selection (`settings.update`), plus theme. Calm, one page; T3 Code's provider settings page is the shape reference ([04](./04-analysis.md)).

## Routing

**TanStack Router**, with a **code-based route tree** — a handful of routes doesn't earn the file-based codegen plugin, and migrating to it later is mechanical. Browser history works in both hosts: the server already serves an SPA `index.html` fallback for unknown paths, and the packaged renderer is served same-origin by the local server (ADR-0004), so reloads and back/forward land correctly everywhere.

```
/                              welcome
/settings                      harness selection, appearance
/pr/$owner/$repo/$number       journey layout — resolves the journey; renders the
  │                            ingestion transition while one is running or absent
  ├─ /                         overview
  ├─ /cluster/$clusterId       cluster page
  └─ /file/$                   free file reading (splat: file paths contain slashes)
```

Params are typed end-to-end (TanStack's headline feature), so navigation from `tl:` links, the left rail, and hint clicks all go through one typed `navigate` surface. The rule of thumb: state that should survive a reload is in the URL; state that shouldn't (scroll, toggles) never is.
