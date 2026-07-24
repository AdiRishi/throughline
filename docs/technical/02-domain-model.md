# Domain Model & Persistence

The journey as data: the schemas that make the vision's guarantees checkable by a machine, and how the artifacts live on disk. Terms are `CONTEXT.md`'s; schemas live in `packages/contracts` as Effect Schema, sketched here in shorthand.

## The journey artifact

One PR, one journey, one row. A journey is **immutable**: it is the output of exactly one whole analysis run, committed in a single transaction at the end of ingestion, and never patched afterward. Reanalysis produces a new artifact that replaces the old one. Everything mutable (read state, display mode) lives outside it.

```ts
Journey {
  formatVersion: 1,               // the artifact blob's own version, independent of DB schema
  id: JourneyId,                  // unique per analysis run
  pr: { owner, repo, number },
  pinned: {
    headSha, baseSha,             // baseSha = merge-base(base branch, head) at analysis time
    analyzedAt,
  },
  provenance: { harnessKind, model?, usage? },   // which harness built it; honesty, not UI
  overview: Overview,
  clusters: Cluster[],            // in journey order
  hunks: Hunk[],                  // the complete partition, every changed line
  files: FileChange[],            // every changed file, with change kind & rename tracking
  hints: Hint[],
}
```

The pin is load-bearing: every line range, anchor, and evidence link in the artifact is a claim about `baseSha..headSha`, which is why a stale journey stays fully readable — its referents cannot drift.

## Hunks and the partition

**Hunks** are Throughline's atomic placement unit. Their derivation is two-phase, and the split of responsibility is the mechanism behind the coverage guarantee:

1. **Seed hunks are deterministic.** `@app/journey/hunks` parses the materialized diff (rename-aware, zero context lines) into seed hunks: maximal contiguous runs of changed lines per file. No agent involvement — the seeds and the changed-line set they cover are computed facts.
2. **The agent may only refine.** During analysis the agent may split a seed hunk into finer contiguous sub-ranges when it mixes concerns — never merge, never omit, never invent. A refinement of a partition is still a partition, so the agent structurally cannot break coverage; it can only fail to _assign_, which the validator catches.

```ts
Hunk {
  id: HunkId,                     // "h12" — dense, ordered by (path, position)
  path,                           // new path (old path for pure deletions)
  oldStart, oldLines,             // removed-line run in the base revision (0-length allowed)
  newStart, newLines,             // added-line run in the head revision (0-length allowed)
  seedId,                         // the seed hunk this is (a split of); = own id when unsplit
  home: ClusterId,
}
```

**Coverage, formalized.** For each changed file, the changed-line set is (removed old-side line numbers) ∪ (added new-side line numbers). The journey is valid iff the hunks' ranges partition that set exactly — no line uncovered, no line covered twice — and every hunk names exactly one existing home cluster. `@app/journey/coverage` implements this as a pure validator returning a precise violation list (used verbatim in the repair loop, [04](./04-analysis.md)); the server refuses to persist a journey that fails it. The guarantee is a checked invariant, not a prompt instruction.

## Clusters

```ts
Cluster {
  id: ClusterId,                  // "c3"
  position,                       // 1-based journey order
  title,
  weight: "core" | "supporting" | "mechanical",
  narrative: Narrative,           // leads the cluster page
  mapEntry: Narrative,            // the compressed 2–3 sentence Overview-map account
  buildsOn: ClusterId[],          // stated relationships to earlier clusters only
  fileOrder: path[],              // narrative order; every path hosting a homed hunk, exactly once
  resurfaced: { hunkId, note: Narrative }[],   // hunks homed elsewhere, revisited here
}
```

Scale figures shown in the Overview map (files touched, hunks homed) are **derived** at render time, never stored — stored aggregates can lie; derivations can't.

Resurfacing constraints, validated like coverage: a resurfaced hunk must exist, its home must be a different cluster, and (in v1) an earlier one — resurfacing is retrospective perspective, per the product docs.

## Narrative and evidence

Narrative is Markdown with one extension: evidence links, using `tl:` URIs — `tl:hunk/h12`, `tl:file/src/auth/token.ts`, `tl:symbol/src/auth/token.ts#issueToken`. The renderer resolves them to navigation (scroll to hunk, open file); the validator resolves them against the journey and the pinned tree. Per the vision, prose that can't be checked doesn't ship: unresolvable links are a validation failure fed back to the agent, and the deterministic last resort is downgrading the link to plain text with the run's log recording the loss — the claim survives, its broken anchor doesn't.

```ts
Narrative { markdown }            // evidence is *in* the text; no parallel refs array to drift
```

## Hints

```ts
Hint {
  id, clusterId,                  // hints ride the cluster whose reading they accompany
  kind: "connection" | "complexity" | "ripple" | "pattern-echo" | "behavior" | "resurfacing",
  anchor: { path, side: "old" | "new", startLine, endLine },
  body: Narrative,
}
```

Anchors may cover unchanged lines (ripple context legitimately points at code the diff didn't touch) but must lie within the file at the pinned revision. Hints bind in every display mode; in just-the-code they attach to the changed-region margin markers ([05](./05-frontend.md)).

## Read state

Local-only, mutable, owned by the server, one document per journey. The unit of marking is the product's: **a file within a cluster**.

```ts
ReadState {
  journeyId,                      // marks are meaningless against any other journey
  readFiles: { clusterId, path }[],
  displayMode: "inline" | "just-the-code" | "split",   // sticky per journey (see product 04)
  updatedAt,
}
```

Progress is derived by `@app/journey/progress`, never stored: a cluster's progress is homed-hunks-in-read-files over homed-hunks; the journey's progress aggregates across clusters; resurfaced hunks count nowhere but home. `journeyId` pairing makes reanalysis-resets automatic — a new journey simply has no read state yet.

## Welcome-screen local state and settings

Two small stores of local verbs and preferences — all invisible to GitHub:

```ts
LocalPrState {
  reviewed: PrRef[],              // manual "I'm done" declarations
  hidden: PrRef[],
  dismissedMerged: PrRef[],       // merged PRs dismissed before their ~week expires
}

Settings {
  harness?: "codex" | "claude",   // explicit harness override; absent = auto-select (see 04)
}
```

## Persistence

One SQLite database, owned by `JourneyStore`, under a server-owned data root (passed by the shell from Electron's `userData`; a per-checkout default in dev). The driver is **`@effect/sql-sqlite-node`** — it ships at the same pinned Effect version and sits on Node's built-in `node:sqlite`, so there is no native module to rebuild and it is verified working under Electron's bundled Node.

```
<dataRoot>/
  throughline.db                          // everything stateful (below)
  runs/<owner>/<repo>/<number>/<runId>/   // harness transcripts, materialized diffs, fallback logs
  workspaces/<owner>/<repo>/              // one bare clone per repository; worktrees per run (see 03)
```

The split is **hybrid, blob-style**: the database holds state; bulk, non-queryable artifacts stay files.

| Table        | Shape                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journeys`   | One row per PR: indexed metadata columns (PR ref, `journeyId`, pinned SHAs, `analyzedAt`, provenance) + the `Journey` artifact as a JSON blob, decoded through its contract schema on read. |
| `read_state` | One row per journey: `ReadState` as above.                                                                                                                                                  |
| `pr_state`   | `LocalPrState` marks.                                                                                                                                                                       |
| `settings`   | App settings.                                                                                                                                                                               |

The journey stays a blob rather than relational rows because it is immutable and read whole — decomposing it into tables buys schema-migration surface without a query workload to justify it. What SQLite buys over flat files is what grows with the app: transactions (reanalysis = replace the journey row + delete its read state, atomically, in one statement batch), indexed listing for the welcome screen, and a single-writer store that won't degrade into a directory of many small files.

Schema migrations run at server boot (the Effect sql migrator). The artifact blob carries `formatVersion`; an undecodable or future-versioned blob is treated as absent — re-ingest, never crash.

## Staleness

Never stored. A journey is stale iff its pinned `headSha` differs from the PR's current head as reported by the `GitHub` module's cached view — computed at the moment of display, so it can't be stale about being stale.
