# Design QA

## Scope

This pass validates the browser build against the five authoritative screen designs in
`docs/product/designs/`. The source designs are 2× captures, so each comparison used a
1× browser viewport with device scale factor 1:

| Surface         | Reference                                           | Browser viewport |
| --------------- | --------------------------------------------------- | ---------------- |
| Welcome         | `docs/product/designs/01-welcome.png`               | 1360 × 880       |
| Ingestion       | `docs/product/designs/02-ingestion.png`             | 1362 × 762       |
| Overview        | `docs/product/designs/03-overview.png`              | 1360 × 1010      |
| Reading cluster | `docs/product/designs/04-reading-cluster.png`       | 1680 × 1250      |
| Files           | `docs/product/designs/04-reading-just-the-code.png` | 1680 × 960       |

The implementation was exercised at `http://localhost:7537` in the in-app Browser.
Repository names, pull request titles, cluster counts, timestamps, and analysis activity
are live application data, so comparisons judge their layout and presentation rather than
requiring the fixtures to contain the reference image's exact copy.

## Evidence

The QA artifacts are in `/private/tmp/throughline-visual-qa/`. Every comparison places the
reference on the left and the implementation on the right.

| Surface         | Implementation capture          | Comparison                       |
| --------------- | ------------------------------- | -------------------------------- |
| Welcome         | `welcome-after-pass1.png`       | `welcome-comparison-pass1.png`   |
| Ingestion       | `ingestion-after-pass1.png`     | `ingestion-comparison-pass1.png` |
| Overview        | `overview-after-pass1.png`      | `overview-comparison-pass1.png`  |
| Reading cluster | `cluster-after-pass1.png`       | `cluster-comparison-pass1.png`   |
| Files           | `file-after-pass1-expanded.png` | `file-comparison-pass1.png`      |

Responsive evidence:

- `welcome-responsive-680.png` — 680 px viewport, no horizontal overflow.
- `reading-responsive-800.png` — 800 px viewport, no horizontal overflow; supporting
  rails collapse while the reading surface remains usable.

## Findings and resolution

### P0

- The Overview and reading surfaces did not preserve the designed application frame and
  could overflow horizontally. They now use the designed 264 px journey rail, fluid
  document stage, and 312 px guidance rail, with the Overview document constrained to
  780 px.
- Desktop-shell and page headers competed for vertical space. The browser build now has
  one compact surface-specific header on journey routes and the designed title bar on
  Welcome.

### P1

- Welcome rows, review progress, inactive and merged states, ingestion stages, and the
  persistent paste-URL entry did not match the source hierarchy. They now follow the
  reference dimensions, spacing, state colors, and interaction hierarchy.
- Overview lacked the designed quiet-document composition. It now presents the brief,
  journey map, recommended route, and pull-request words in the reference order and
  proportions.
- Reading mode lacked the designed narrative, guidance, file state, and navigation
  hierarchy. Those surfaces now match the reference structure while retaining live
  cluster and file data.
- Files mode now uses the tree and diff libraries through their public APIs and theme
  variables. The selected themes are the closest native GitHub light/dark variants; no
  shadow-DOM or rendering hacks were introduced.

### P2

- Typography, borders, shadows, muted colors, badges, icons, disclosure affordances,
  hover actions, and compact spacing were aligned across all five surfaces.
- Dark appearance, narrow Welcome, and narrow reading layouts were normalized to the same
  visual system.

No unresolved P0, P1, or P2 findings remain.

## Interaction validation

- Started a real analysis from the paste-URL form and observed the clone, read, and
  journey-construction presentation.
- Left an active ingestion safely with Back.
- Opened and closed the pull-request words disclosure.
- Navigated from the journey map into a cluster.
- Expanded the cluster narrative and collapsed/restored Guidance.
- Switched between Journey and Files navigation.
- Selected files through the native tree.
- Switched between Diff and Code.
- Marked a file read and unread.
- Changed appearance to dark mode in Settings.

Fresh Welcome and journey sessions produced no Browser console warnings or errors.

## Layout validation

- Overview at 1680 px: journey rail 264 px, document 780 px, page scroll width 1680 px.
- Reading at 1680 px: journey rail 264 px, reading stage 1104 px, guidance 312 px, page
  scroll width 1680 px.
- Welcome at 680 px: page scroll width 680 px.
- Reading at 800 px: page scroll width 800 px.

## Automated validation

- `pnpm check` — passed.
- `pnpm test` — passed, including contracts, shared, lint plugin, client runtime, journey,
  web, desktop, server, and scripts suites.

final result: passed
