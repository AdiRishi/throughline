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
  world,                                   // absolute path; repository/ + inputs/, the agent's whole world
  prompt,                                  // instructions + paths relative to world
  outputSchema,                            // JSON Schema the result must satisfy
  continuation?,                           // opaque adapter-owned token from a prior result
  onEvent,                                 // structured progress: started/completed/failed + activity
                                           // (current action, file, monotonic counters) from harness events
}

AnalysisResult {
  value,
  continuation,                            // opaque; pass back for same-thread repair turns
}
```

That is the entire interface: detect, run-with-schema, cancel-via-scope. Everything harness-specific — subprocess supervision, protocol, streaming, auth — is implementation behind it. This is T3 Code's provider architecture (`~/forks/t3code`, five harnesses behind one interface) shrunk to Throughline's actual need: **batch analysis with structured output**, no interactive sessions, no approvals, no tool bridging. Both SDKs manage their own CLI binaries, so "install the app" is the whole install.

| Adapter | Implementation                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex   | `@openai/codex-sdk`: `startThread({ workingDirectory, sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck })`, then `runStreamed(prompt, { outputSchema, signal })`; auth = the user's Codex CLI login, detected via a probe. |
| Claude  | `@anthropic-ai/claude-agent-sdk`: `query({ prompt, options: { cwd, allowedTools: read-only set, outputFormat: { type: "json_schema", schema }, abortController } })`; auth = the user's Claude Code login / `claude setup-token`.             |
| ACP     | _Planned, not v1._ `@agentclientprotocol/sdk` as a third adapter at the same seam — one adapter opens Gemini CLI, Cursor, Goose, and the rest. The seam is shaped so this lands without touching the pipeline.                                |

**Read-only is enforced, not requested**: Codex runs under `sandboxMode: "read-only"`; Claude gets a read-only tool allowlist (no write/edit tools, no shell). A harness that cannot enforce read-only cannot be a v1 adapter. Harness stderr/event streams are logged to the run directory verbatim — the honesty trail for a product whose output is an inference.

Harness selection: the app picks the first authenticated harness (order: Codex, Claude) unless the reviewer set one explicitly in **settings** — a small surface listing every detected harness with its install/auth state and one selection (T3 Code's provider settings page is the shape reference). The choice used is always recorded in the journey's `provenance`; changing it affects future analyses only — to apply it to an existing journey, rerun ingestion. No harness installed/authenticated is a door-level parked state with setup instructions, like `gh`.

## The read-only run world

Each run owns one world directory with two siblings:

```
world/
  repository/                  # git worktree pinned to headSha
  inputs/
    diff/full.patch
    diff/by-file/
    hunks.json
    files.json
```

The harness working directory is `world/`, and sandbox/allowlist enforcement
permits reads only within it. Transcripts and server-authored fallback logs live
beside `world/` in the run directory and are never exposed to the agent.

## Run inputs: the diff on disk, not in the prompt

A 40,000-line diff does not travel in a prompt. Ingestion materializes run inputs under `world/inputs/` ([03](./03-github.md)) and the agent instructions point at them by relative path:

- `inputs/diff/full.patch` and `inputs/diff/by-file/` — the pinned diff, whole and per file
- `inputs/hunks.json` — the seed-hunk index: every hunk id with its file and line ranges (or `fileKind`)
- `inputs/files.json` — changed files with change kinds and rename mapping

The agent reads what it needs the way agents are good at it — navigating `repository/`, the diff, and the surrounding codebase alike. Prompt size stays flat no matter how large the PR is.

## The staged pipeline

Analysis is a sequence of structured-output runs, each validated before the next begins. Two stages, because the two jobs want different attention: partitioning wants the whole change in view; narrating wants one cluster at a time.

**Stage 1 — the journey plan.** One run over the full diff and codebase. Output: the cluster list (titles, weights, order, `buildsOn`), every seed hunk's home assignment, any seed-hunk splits (sub-ranges + their homes), and file order per cluster. Validated by `@app/journey/coverage`: splits must exactly tile their seed, every hunk must have exactly one existing home, every changed line must be covered.

**Stage 2 — the words.** With the plan fixed, runs produce the Overview (brief, map entries, where-to-begin), each cluster's narrative, resurfacing selections with notes, and hints. Validated for referential integrity: every `tl:` link resolves, every anchor lies within its file at the pinned revision, resurfacing constraints hold. Cluster narration is one run per cluster against the frozen plan — restartable, parallelizable later, and each run's context is one cluster deep, not forty thousand lines wide. When narration resurfaces a hunk from a file outside the frozen home-file order, assembly appends that foreign file at its first occurrence in the resurfacing selection. The plan's home-file order stays fixed and every homed or resurfaced path still appears exactly once.

### Repair, then commit — never fail

Per the vision, analysis has no error terminal state. Each stage enforces that with a ladder of rungs:

1. **Validate** — the pure validators return precise, machine-generated violation lists ("h17 unassigned", "split of h4 leaves lines 210–214 uncovered", "link tl:symbol/… does not resolve").
2. **Repair loop** — violations go back with the previous result's opaque `continuation`, so each adapter resumes the same thread, up to 2 rounds. Most failures are near-misses; precise feedback fixes them cheaply. Continuations are process-local and need not survive a server restart because v1 jobs do not resume across restarts.
3. **Regenerate (stage 2 only)** — narration that still fails validation after repair is discarded and rerun fresh, once. Narration runs are per-cluster and cheap, and a clean second attempt beats deterministically mutilating prose.
4. **Deterministic completion** — at the floor, the pipeline finishes the artifact itself, honestly: unassigned hunks land in a synthesized final cluster titled for what it is ("Unplaced changes", weight Supporting, narrative saying exactly how it came to exist); invalid splits collapse back to their seed hunk; unresolvable links downgrade to plain text; an invalid hint is dropped (hints are optional aids; coverage is not). Every fallback is logged in the run directory.

The final rung is what makes "the agent always commits" an invariant of the _system_ rather than a hope about the model: the pipeline can always construct a valid journey from any stage-1 output, including an empty one — the degenerate journey (one cluster per file-cluster of seeds) is dreadful but valid, visible, and honest.

## Ingestion jobs

`Ingestion` (in `apps/server/src/analysis/`) orchestrates the whole flow as a supervised job — one active job per PR, a global cap of one running analysis at a time (harness runs are heavy; queued jobs say so honestly).

Phases are published through the shared snapshot-then-live push-bus contract and consumed directly by the transition UI — the narrated stages the product docs promise are these events, so the narration is honest by construction. `analyzing` events additionally carry a structured activity payload — the current action, a short trail of recent ones, and monotonic counters (files walked, symbols traced, call sites followed) — derived only from observed harness events, never invented; this is what the transition's live feed and counters render (design `02-ingestion`):

```
resolving → cloning → diffing → analyzing(stage, detail) → validating → saving → complete
                                                      ↘ (cancel) → cancelled
                                                      ↘ (operational fault) → failed
```

**Failure is operational, never analytical.** A job can fail — a clone error, a harness crash, a full disk, auth expiring mid-run — and says so plainly, with retry as the remedy (a rerun is a fresh job). What cannot exist is an analytical failure: "too tangled to decompose" is not an outcome, and the repair ladder above is what guarantees it. The vision's always-commit principle constrains the _model's_ escape hatches, not the laws of physics; UI and code must never conflate the two.

- **Leavable**: the job is server-side; the renderer may disconnect, navigate away, or the window may close. Reconnection replays the snapshot and resumes watching. Completion while away is simply a completed journey on the welcome screen.
- **Cancellable**: `ingestion.cancel` closes the job's scope; the harness subprocess dies with it (scope-owned lifecycles, T3 Code's pattern). A cancelled job leaves no partial journey — persistence is a single atomic write at the end.
- **Server restart during a run**: the job is gone, honestly — the PR shows as not-ingested and can be started again. Workspaces and thread-resumability make the retry cheap. (Durable job resume is an explicit non-goal for v1; the seam it would live behind is `Ingestion`.)
- **Reanalysis** is the same pipeline, full from the top, against the new head; on success the new journey atomically replaces the old and read state resets (product 02's rule, made true by `journeyId` pairing).

## RPC surface

The renderer/server seam uses these `packages/contracts` methods (shapes per [02](./02-domain-model.md)):

| RPC                                                                                       | Kind                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `github.viewer`                                                                           | unary (cached identity/status)                                                                                          |
| `github.prs`                                                                              | snapshot+live stream uniting viewer-affiliated PRs with locally saved journeys, enriched with progress and stale state  |
| `github.refreshPrs`                                                                       | unary trigger used on focus and explicit refresh; respects cache minimums and global parking                            |
| `github.retry`                                                                            | unary recovery trigger that clears retryable parked state, invalidates GitHub caches, and reloads the PR index          |
| `ingestion.start`, `ingestion.cancel`                                                     | unary (door rejections are `ingestion.start`'s only errors)                                                             |
| `ingestion.subscribe`                                                                     | stream                                                                                                                  |
| `journey.get`, `journey.filePatch`, `journey.fileContent`, `journey.tree`                 | unary (immutable per journey — cacheable forever client-side); file content is a discriminated text/image/binary result |
| `readState.get`, `readState.markFile`, `readState.unmarkFile`, `readState.setDisplayMode` | unary                                                                                                                   |
| `readState.subscribe`                                                                     | stream (multi-window consistency for free)                                                                              |
| `prState.reviewed`, `prState.hide`, `prState.dismissMerged`                               | unary                                                                                                                   |
| `harness.status`                                                                          | unary (settings + welcome-screen setup surfaces)                                                                        |
| `settings.get`, `settings.update`                                                         | unary (harness selection)                                                                                               |
