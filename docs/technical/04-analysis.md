# The Analysis Pipeline

How a PR becomes a journey: the harness seam the reviewer's own agents plug into, the staged pipeline that produces the artifact, and the validation machinery that turns the vision's guarantees into checked invariants.

## The harness seam

Throughline does not ship a model. Analysis runs on the **reviewer's own local agent harnesses**, riding their existing logins — Codex and Claude out of the box. The seam is `AnalysisHarness`, in `apps/server/src/harness/`:

```ts
AnalysisHarness {
  kind: "codex" | "claude" | ...,         // open set; unknown kinds degrade to "unavailable"
  detect(): HarnessStatus,                 // { installed, version, auth: authenticated|unauthenticated|unknown }
  run(task: AnalysisTask): AnalysisResult  // scoped: closing the scope cancels the subprocess
}

AnalysisTask {
  worktree,                                // absolute path; the agent's whole world
  prompt,                                  // instructions + relative paths to run inputs
  outputSchema,                            // JSON Schema the result must satisfy
  onEvent,                                 // structured progress: started/completed/failed + activity
                                           // (current action, file, monotonic counters) from harness events
}
```

That is the entire interface: detect, run-with-schema, cancel-via-scope. Everything harness-specific — executable discovery, subprocess supervision, protocol, streaming, auth — is implementation behind it. T3 Code (`~/forks/t3code`) supplies two relevant patterns: its provider runtime owns scoped process lifecycles, and its smaller `textGeneration/` modules perform schema-constrained batch work through local CLIs. Throughline follows the second shape and reuses the first's process discipline; it does not import T3's interactive session, approval, or tool-bridge architecture.

| Adapter | Starting point and spike gate                                                                                                                                                                                                                                                                                                                        |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex   | Prefer T3 Code's current batch path: supervise the user's `codex exec` process through Effect's `ChildProcessSpawner`. Before fixing the adapter transport, prove schema-constrained output, a mechanically read-only sandbox, correction turns, cancellation, useful activity events, auth detection, and packaged execution under Electron's Node. |
| Claude  | Prefer T3 Code's current batch path: supervise `claude -p` with structured output through the same process layer. Prove the read-only tool policy, correction turns, cancellation, event fidelity, auth detection, and packaged execution at the same gate.                                                                                          |
| ACP     | _Planned, not v1._ Add an ACP process adapter only after Codex and Claude establish the seam. The pipeline must not learn ACP session concepts.                                                                                                                                                                                                      |

These process choices are defaults, not an SDK commitment. If a CLI cannot satisfy the gate and an SDK can, only that adapter changes; `AnalysisHarness` and the pipeline do not. An SDK or bundled platform binary is then added to the server's external dependencies and desktop artifact staging together, followed by packaged verification.

**Read-only is enforced, not requested**: each adapter must select a sandbox or tool policy that makes workspace mutation unavailable. A harness mode that cannot enforce this is unavailable to Throughline, even if the CLI itself is installed and authenticated. The server's hydrated login-shell environment is the source for executable discovery and harness auth; adapter processes are scope-owned, and their stderr/event streams are logged to the run directory verbatim — the honesty trail for a product whose output is an inference.

Harness selection: the app picks the first authenticated harness (order: Codex, Claude) unless the reviewer set one explicitly in **settings** — a small surface listing every detected harness with its install/auth state and one selection (T3 Code's provider settings page is the shape reference). The choice used is always recorded in the journey's `provenance`; changing it affects future analyses only — to apply it to an existing journey, rerun ingestion. No harness installed/authenticated is a door-level parked state with setup instructions, like `gh`.

## Run inputs: the diff on disk, not in the prompt

A 40,000-line diff does not travel in a prompt. Ingestion materializes run inputs into the run directory ([03](./03-github.md)) and the worktree's agent instructions point at them by path:

- `diff/full.patch` and `diff/by-file/` — the pinned diff, whole and per file
- `hunks.json` — the seed-hunk index: every hunk id with its file and line ranges (or `fileKind`)
- `files.json` — changed files with change kinds and rename mapping

The agent reads what it needs the way agents are good at it — navigating files in a worktree, diff and surrounding codebase alike. Prompt size stays flat no matter how large the PR is.

## The staged pipeline

Analysis is a sequence of structured-output runs, each validated before the next begins. Two stages, because the two jobs want different attention: partitioning wants the whole change in view; narrating wants one cluster at a time.

**Stage 1 — the journey plan.** One run over the full diff and codebase. Output: the cluster list (titles, weights, order, `buildsOn`), every seed hunk's home assignment, any seed-hunk splits (sub-ranges + their homes), and file order per cluster. Validated by `@app/journey/coverage`: splits must exactly tile their seed, every hunk must have exactly one existing home, every changed line must be covered.

**Stage 2 — the words.** With the plan fixed, runs produce the Overview (brief, map entries, where-to-begin), each cluster's narrative, resurfacing selections with notes, and hints. Validated for referential integrity: every `tl:` link resolves, every anchor lies within its file at the pinned revision, resurfacing constraints hold. Cluster narration is one run per cluster against the frozen plan — restartable, parallelizable later, and each run's context is one cluster deep, not forty thousand lines wide.

### Repair, then commit — never fail

Per the vision, analysis has no error terminal state. Each stage enforces that with a ladder of rungs:

1. **Validate** — the pure validators return precise, machine-generated violation lists ("h17 unassigned", "split of h4 leaves lines 210–214 uncovered", "link tl:symbol/… does not resolve").
2. **Repair loop** — violations go back as a correction task, including the invalid result and precise violation list, up to 2 rounds. An adapter may preserve a provider continuation internally, but pipeline correctness cannot depend on resumable threads.
3. **Regenerate (stage 2 only)** — narration that still fails validation after repair is discarded and rerun fresh, once. Narration runs are per-cluster and cheap, and a clean second attempt beats deterministically mutilating prose.
4. **Deterministic completion** — at the floor, the pipeline finishes the artifact itself, honestly: unassigned hunks land in a synthesized final cluster titled for what it is ("Unplaced changes", weight Supporting, narrative saying exactly how it came to exist); invalid splits collapse back to their seed hunk; unresolvable links downgrade to plain text; an invalid hint is dropped (hints are optional aids; coverage is not). Every fallback is logged in the run directory.

The final rung is what makes "the agent always commits" an invariant of the _system_ rather than a hope about the model: the pipeline can always construct a valid journey from any stage-1 output, including an empty one — the degenerate journey (one cluster per file-cluster of seeds) is dreadful but valid, visible, and honest.

## Ingestion jobs

`Ingestion` (in `apps/server/src/analysis/`) orchestrates the whole flow as a supervised job — one active job per PR, a global cap of one running analysis at a time (harness runs are heavy; queued jobs say so honestly).

Phases, published as a snapshot-then-live stream (the starter's push-bus pattern) and consumed directly by the transition UI — the narrated stages the product docs promise are these events, so the narration is honest by construction. `analyzing` events additionally carry a structured activity payload — the current action, a short trail of recent ones, and monotonic counters (files walked, symbols traced, call sites followed) — derived only from observed harness events, never invented; this is what the transition's live feed and counters render (design `02-ingestion`):

```
resolving → cloning → diffing → analyzing(stage, detail) → validating → saving → complete
                                                      ↘ (cancel) → cancelled
                                                      ↘ (operational fault) → failed
```

**Failure is operational, never analytical.** A job can fail — a clone error, a harness crash, a full disk, auth expiring mid-run — and says so plainly, with retry as the remedy (a rerun is a fresh job). What cannot exist is an analytical failure: "too tangled to decompose" is not an outcome, and the repair ladder above is what guarantees it. The vision's always-commit principle constrains the _model's_ escape hatches, not the laws of physics; UI and code must never conflate the two.

- **Leavable while the app is running**: the renderer may disconnect, navigate away, reload, or remain minimized. Reconnection replays the snapshot and resumes watching. On macOS, closing the last window leaves the app and server running; on Windows and Linux, the platform-standard last-window close quits the app and therefore ends the run.
- **Cancellable**: `ingestion.cancel` closes the job's scope; the harness subprocess dies with it (scope-owned lifecycles, T3 Code's pattern). A cancelled job leaves no partial journey — persistence is a single atomic write at the end.
- **App quit or server restart during a run**: the job is gone, honestly — fd4 binds a desktop-spawned server to the shell, and jobs are intentionally in-memory. The PR shows as not-ingested and can be started again. Materialized inputs make the retry cheaper. Durable job resume is an explicit non-goal for v1; the seam it would live behind is `Ingestion`.
- **Reanalysis** is the same pipeline, full from the top, against the new head; on success the new journey atomically replaces the old and read state resets (product 02's rule, made true by `journeyId` pairing).

## RPC surface

Added to `packages/contracts` (shapes per [02](./02-domain-model.md)):

| RPC                                                                                       | Kind                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.viewer`, `github.prs`                                                             | unary (cached; `github.prs` also as a snapshot+live stream for the welcome screen, server-enriched with each PR's journey state — exists, progress, stale) |
| `ingestion.start`, `ingestion.cancel`                                                     | unary (door rejections are `ingestion.start`'s only errors)                                                                                                |
| `ingestion.subscribe`                                                                     | stream                                                                                                                                                     |
| `journey.get`, `journey.filePatch`, `journey.fileContent`, `journey.tree`                 | unary (immutable per journey — cacheable forever client-side)                                                                                              |
| `readState.get`, `readState.markFile`, `readState.unmarkFile`, `readState.setDisplayMode` | unary                                                                                                                                                      |
| `readState.subscribe`                                                                     | stream (multi-window consistency for free)                                                                                                                 |
| `prState.reviewed`, `prState.hide`, `prState.dismissMerged`                               | unary                                                                                                                                                      |
| `harness.status`                                                                          | unary (settings + welcome-screen setup surfaces)                                                                                                           |
| `settings.get`, `settings.update`                                                         | unary (harness selection)                                                                                                                                  |
