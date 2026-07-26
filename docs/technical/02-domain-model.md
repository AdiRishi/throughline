# Domain Model & Persistence

The journey as data: the schemas that make the vision's guarantees checkable by a machine, and how the artifacts live on disk. Terms are `CONTEXT.md`'s; schemas live in `packages/contracts` as Effect Schema, sketched here in shorthand.

## The journey artifact

One PR, one journey, one row. A journey is **immutable**: it is the output of exactly one whole analysis run, committed in a single transaction at the end of ingestion, and never patched afterward. Reanalysis produces a new artifact that replaces the old one. Everything mutable (read state, display mode) lives outside it.

```ts
Journey {
  formatVersion: 1,               // the artifact blob's own version, independent of DB schema
  id: JourneyId,                  // unique per analysis run
  pr: { owner, repo, number },
  prWords: PrWords,               // { title, body, author, url, createdAt } — the PR's own words, pinned
  pinned: {
    headSha, baseSha,             // baseSha = merge-base(base branch, head) at analysis time
    baseRef,                      // the base branch that merge-base was taken against
    analyzedAt,
  },
  provenance: { harnessKind, model?, usage?, fallbacks },   // which harness built it, and every fallback it stood on; honesty, not UI
  overview: Overview,             // { brief, whereToBegin, attention } — the map's entries derive from clusters' mapEntry
  clusters: Cluster[],            // in journey order
  hunks: Hunk[],                  // the complete partition, every changed line
  files: FileChange[],            // every changed file, with change kind & rename tracking
  hints: Hint[],
}
```

The pin is load-bearing: every line range, anchor, and evidence link in the artifact is a claim about `baseSha..headSha`, which is why a stale journey stays fully readable — its referents cannot drift. `baseRef` is pinned beside the SHAs because a merge-base does not say which branch it was a merge-base _with_, and a journey has to be able to explain what it compared against long after that branch has moved. The PR's own words are copied in for the same reason rather than fetched when the Overview renders them: reference material shown beneath prose written against it must not drift out from under that prose.

Two fields exist to keep the artifact honest about itself. `provenance.fallbacks` is one machine-written note per deterministic fallback the pipeline had to stand on, and empty is the good case — a journey that needed [04](./04-analysis.md)'s floor says so in the artifact, not only in its run directory's log. The Overview's `attention` is one `{ clusterId, phrase }` note per cluster, in journey order: the closing strip's "1 read closely → 4 walk quickly". The phrasing is the agent's, so it is stored rather than derived; but a cluster the agent skipped gets its phrase from its weight during assembly, so the strip is never partial and never disagrees with the clusters it labels.

## Hunks and the partition

**Hunks** are Throughline's atomic placement unit. Their derivation is two-phase, and the split of responsibility is the mechanism behind the coverage guarantee:

1. **Seed hunks are deterministic.** `@app/journey/hunks` parses the materialized diff (rename-aware, zero context lines) into seed hunks: maximal contiguous runs of changed lines per file. No agent involvement — the seeds and the changed-line set they cover are computed facts.
2. **The agent may only refine.** During analysis the agent may split a seed hunk into finer contiguous sub-ranges when it mixes concerns — never merge, never omit, never invent. A refinement of a partition is still a partition, so the agent structurally cannot break coverage; it can only fail to _assign_, which the validator catches.
3. **Files without textual hunks are still covered.** A changed file that yields no changed lines — a binary change, a pure rename, a mode/symlink/submodule change, an emptied or empty-added file — contributes exactly one synthetic **file-level hunk** at seed time, carrying a `fileKind` instead of line ranges. It is homed, validated, and counted like any other hunk (the agent may never split one), so the partition covers every changed _file_, not merely every changed line.

```ts
Hunk {
  id: HunkId,                     // "h12" for a seed — dense, ordered by (path, position);
                                  // a refinement's parts take their seed's id: "h12.1", "h12.2", …
  path,                           // new path (old path for pure deletions)
  oldStart, oldLines,             // removed-line run in the base revision (0-length allowed)
  newStart, newLines,             // added-line run in the head revision (0-length allowed)
  fileKind?,                      // file-level hunks only: binary | rename | mode | symlink | submodule | empty
  seedId,                         // the seed hunk this is (a split of); = own id when unsplit
  home: ClusterId,
}
```

Only the seeds are a dense `h1…hN`; naming a split's parts after their seed is what keeps an id self-describing. `h12.2` says both which computed range it came from and that it is the second part of that range, so a run directory, an agent's answer, and an evidence link can all be traced back to the same seed even in a journey where no bare `h12` survives.

**Coverage, formalized.** For each changed file, the changed-line set is (removed old-side line numbers) ∪ (added new-side line numbers). The journey is valid iff the hunks' ranges partition that set exactly — no line uncovered, no line covered twice — every changed file with no changed lines carries exactly one file-level hunk, and every hunk names exactly one existing home cluster. The split parts that make this exact are materialized rather than trusted: a plan declares only each part's line counts and `@app/journey/plan` walks a cursor from the seed's own start ([ADR 0012](../adr/0012-split-hunks-declare-line-counts-and-the-plan-materializes-starts.md)), which is what makes the partition contiguous by construction and the validator below a real check rather than a hope. `@app/journey/coverage` implements this as a pure validator returning a precise violation list (used verbatim in the repair loop, [04](./04-analysis.md)); the server refuses to persist a journey that fails it. The guarantee is a checked invariant, not a prompt instruction.

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
  fileOrder: path[],              // narrative order; every path hosting a homed or resurfaced hunk, exactly once
  resurfaced: { hunkId, note: Narrative }[],   // hunks homed elsewhere, revisited here
}
```

Scale figures shown in the Overview map (files touched, hunks homed) are **derived** at render time, never stored — stored aggregates can lie; derivations can't.

Resurfacing constraints, validated like coverage: a resurfaced hunk must exist, its home must be a different cluster, and (in v1) an earlier one — resurfacing is retrospective perspective, per the product docs.

## Narrative and evidence

Narrative is Markdown with one extension: evidence links, using `tl:` URIs — `tl:hunk/h12`, `tl:file/src/auth/token.ts`, `tl:symbol/src/auth/token.ts#issueToken`. The renderer resolves them to navigation (scroll to hunk, open file); the validator resolves them against the journey and the pinned tree. A `tl:symbol` link resolves iff the symbol string occurs textually in the referenced file at the pinned head — deliberately no language tooling, so the check stays cheap and unambiguous. Per the vision, prose that can't be checked doesn't ship — but an unresolvable link is not sent back to the harness. `assembleNarration` in `@app/journey/plan` resolves every link against the journey and the pinned tree and rewrites the ones that do not resolve to plain text, recording each in `provenance.fallbacks`. That is deliberate rather than a shortcut: the alternative is spending a correction turn on prose, and prose is the one output whose failure costs nothing structural — the plan is already frozen, so a downgraded link loses a convenience while coverage, homes, and the partition are all untouched. Correction turns are spent where they buy something ([04](./04-analysis.md)'s ladder, on the plan), and the downgrade is the floor that makes the pipeline terminate.

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

Anchors may cover unchanged lines (ripple context legitimately points at code the diff didn't touch) but must lie within the file at the pinned revision. Hints bind in every display mode; in just-the-code they attach to the changed-region margin markers ([05](./05-frontend.md)). One deliberate display-mode consequence: an anchor lying only on the old side has nothing to attach to in just-the-code — the head revision is on screen and the deleted lines are not — so such hints render in inline and split and are omitted there, with the guidance rail saying how many are waiting on the diff rather than dropping them silently. A deleted file is the exception that follows from the same rule: it has no head revision to show, so it falls back to its deletion diff even in just-the-code, and its old-side hints bind against that.

A database written by a build whose migrations differed is not readable by this one, and the migrator cannot tell: it records ids, not shapes. `ensureReadableSchema` in [`journeys/schemaGuard.ts`](../../apps/server/src/journeys/schemaGuard.ts) therefore probes the real tables and columns before the client opens the file and, on a mismatch, moves the database aside — never deletes it — so migrations run onto a clean one. That is the right recovery precisely because nothing here is a source of truth: a journey is rebuildable and read progress costs one reanalysis, while the alternative is an app that opens and does nothing ([ADR 0008](../adr/0008-a-schema-guard-stands-between-the-migrator-and-a-dead-app.md)).

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

AppSettings {
  harness: "codex" | "claude" | null,   // explicit harness override; null = auto-select (see 04)
}
```

The override is nullable rather than optional because absence has to stay free to mean something else: `UpdateSettingsInput`, the patch `settings.update` takes, is the same field with the key made optional, so omitting it means _leave the override alone_ while sending `null` means _clear it_. The stored document has no such distinction to trade on — a missing row simply reads as `{ harness: null }`.

## Persistence

One SQLite database, owned by `JourneyStore`, under a server-owned data root (passed by the shell from Electron's `userData`; a per-checkout default in dev). The driver is **`@effect/sql-sqlite-node`** — it ships at the same pinned Effect version and sits on Node's built-in `node:sqlite`, so there is no native module to rebuild and it is verified working under Electron's bundled Node.

```
<dataRoot>/
  throughline.db                          // everything stateful (below)
  runs/<owner>/<repo>/<number>/<runId>/   // harness transcripts, materialized diffs, fallback logs
  workspaces/<owner>/<repo>/              // one bare clone per repository; worktrees per run (see 03)
```

The split is **hybrid, blob-style**: the database holds state; bulk, non-queryable artifacts stay files.

| Table        | Shape                                                                                                                                                                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `journeys`   | One row per PR, keyed `owner/repo#number`: indexed metadata columns (PR ref, `journeyId`, pinned SHAs, `analyzedAt`, harness kind, `formatVersion`) and the cluster/hunk/file counts the welcome screen lists, beside the `Journey` artifact as a JSON blob, decoded through its contract schema on read. |
| `read_state` | One row per journey: `ReadState` as above.                                                                                                                                                                                                                                                                |
| `pr_state`   | `LocalPrState` marks.                                                                                                                                                                                                                                                                                     |
| `settings`   | App settings.                                                                                                                                                                                                                                                                                             |

The journey stays a blob rather than relational rows because it is immutable and read whole — decomposing it into tables buys schema-migration surface without a query workload to justify it. What SQLite buys over flat files is what grows with the app: transactions (reanalysis = replace the journey row + delete its read state, atomically, in one statement batch), indexed listing for the welcome screen, and a single-writer store that won't degrade into a directory of many small files.

The three counts beside the blob are the schema's one denormalization, and a safe one: they let the welcome screen's list render without decoding a single artifact, and they cannot go stale, because one statement writes them and the blob together. `formatVersion` is lifted out of the blob for a related reason — the decision to ignore a future-versioned artifact has to be reachable without first decoding the artifact it is a decision about.

**No ORM.** Data access is Effect's own SQL stack, in-tree at the pinned version: `SqliteClient`'s tagged-template statements (always parameter-bound), with rows decoded through `effect/Schema` codecs compiled once at module scope — a small row struct per table for the indexed columns, and the blob columns through the very contract schemas the wire speaks (`Journey`, `ReadState`, `LocalPrState`, `AppSettings`), so each shape has exactly one definition. An external ORM would add a second schema language to drift against `packages/contracts` for a surface of four tables and a dozen statements, all owned by the one `JourneyStore` module.

Schema migrations run at server boot (`SqliteMigrator`). The artifact blob carries `formatVersion`; an undecodable or future-versioned blob is treated as absent — re-ingest, never crash.

## Staleness

Never stored. A journey is stale iff its pinned `headSha` differs from the PR's current head as reported by the `GitHub` module's cached view — computed at the moment of display, so it can't be stale about being stale.
