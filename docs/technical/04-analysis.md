# The Analysis Pipeline

How a PR becomes a journey: the harness seam the reviewer's own agents plug into, the staged pipeline that produces the artifact, and the validation machinery that turns the vision's guarantees into checked invariants.

## The harness seam

Throughline does not ship a model. Analysis runs on the **reviewer's own local agent harnesses**, riding their existing logins — Codex and Claude out of the box. The seam is `AnalysisHarness`, in `apps/server/src/harness/`:

```ts
AnalysisHarness {                          // the selecting service over the adapters
  report(selected): HarnessReport,         // every adapter's install/auth state, plus the active one
  invalidate,                              // re-probe, after the reviewer installs something
  open(options & { selected }),            // a session on the active harness
}

HarnessAdapter {                           // one per harness, in apps/server/src/harness/
  kind: "codex" | "claude",                // HarnessKind — a closed union in the contracts
  label,                                   // "Codex", "Claude Code"
  probe: HarnessProbe,                     // { installed, version, auth, detail }
  open(options): HarnessSession            // scoped: closing the scope kills the subprocess
}

HarnessSessionOptions {
  worktree,                                // absolute path; the agent's whole world
  outputSchema,                            // JSON Schema every turn's result must satisfy
  onActivity,                              // observed activity: read | search | command | step
  label,                                   // names the transcript file: plan, narrate-c3, overview
}

HarnessSession {
  kind, model,
  ask(prompt),                             // the first turn; returns the parsed JSON
  correct(prompt),                         // a correction turn on the SAME thread
  usage, transcript,                       // tokens observed, and the honesty trail
}
```

That is the entire interface: probe, open a session, ask and correct against a schema, cancel-via-scope. A run is a short-lived **session** rather than a single call because the repair ladder below needs its correction turn on a thread that already has the diff in context — both SDKs resume a thread, so the seam exposes that instead of making the pipeline re-establish context on every rung. Two details of the shape are load-bearing: `auth` carries a fourth state past `authenticated | unauthenticated | unknown` — `missing`, which is what a harness that is not installed at all reports — and `HarnessKind` is a closed union in `packages/contracts`, so a third harness is a contract change rather than a string; the unknown-kind branch in `AnalysisHarness` exists only so that a stale setting degrades to "unavailable" instead of breaking the app. Everything harness-specific — subprocess supervision, protocol, streaming, auth — is implementation behind it. This is T3 Code's provider architecture (`~/forks/t3code`, five harnesses behind one interface) shrunk to Throughline's actual need: **batch analysis with structured output**, no interactive sessions, no approvals, no tool bridging. Neither SDK brings its own binary: both adapters probe the reviewer's own globally installed CLI (`codex --version`, `claude --version`) and report "not installed" with the exact line to run (`npm i -g @openai/codex`, `npm i -g @anthropic-ai/claude-code`), so installing Throughline is only half of the install.

| Adapter | Implementation                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex   | `@openai/codex-sdk`: `startThread({ workingDirectory, sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck })`, then `runStreamed(prompt, { outputSchema, signal })`; auth = the user's Codex CLI login, detected via a probe. |
| Claude  | `@anthropic-ai/claude-agent-sdk`: `query({ prompt, options: { cwd, allowedTools: read-only set, outputFormat: { type: "json_schema", schema }, abortController } })`; auth = the user's Claude Code login / `claude setup-token`.             |
| ACP     | _Planned, not v1._ `@agentclientprotocol/sdk` as a third adapter at the same seam — one adapter opens Gemini CLI, Cursor, Goose, and the rest. The seam is shaped so this lands without touching the pipeline.                                |

**Read-only is enforced, not requested**: Codex runs under `sandboxMode: "read-only"`; Claude gets a read-only tool allowlist (no write/edit tools, no shell). A harness that cannot enforce read-only cannot be a v1 adapter. Harness stderr/event streams are logged to the run directory verbatim — the honesty trail for a product whose output is an inference.

**Every property in the output schemas is `required`, and optionality is expressed in the value.** This is not a style choice; it is a constraint the provider imposes. OpenAI's structured-output mode rejects any schema whose `required` array omits a key of `properties` — the request fails outright with `'required' is required to be supplied and to be an array including every key in properties`, which in practice means the plan stage returns nothing and the journey silently drops to the deterministic floor. So `PLAN_SCHEMA`, `OVERVIEW_SCHEMA`, and `CLUSTER_SCHEMA` in `apps/server/src/analysis/prompts.ts` mark everything required and let "absent" be an empty array (a hunk with no splits declares `splits: []`). Any new field added to those schemas has to follow the same rule, and the failure mode if it does not is a working-looking app that quietly stops using its harness.

Harness selection: the app picks the first authenticated harness (order: Codex, Claude) unless the reviewer set one explicitly in **settings** — a small surface listing every detected harness with its install/auth state and one selection (T3 Code's provider settings page is the shape reference). The choice used is always recorded in the journey's `provenance`; changing it affects future analyses only — to apply it to an existing journey, rerun ingestion. No harness installed/authenticated is a door-level parked state with setup instructions, like `gh`.

## Run inputs: the diff on disk, not in the prompt

A 40,000-line diff does not travel in a prompt. Ingestion materializes run inputs into the run directory ([03](./03-github.md)):

- `diff/full.patch` and `diff/by-file/` — the pinned diff, whole and per file
- `hunks.json` — the seed-hunk index: every hunk id with its file and line ranges (or `fileKind`)
- `files.json` — changed files with change kinds and rename mapping

The agent is not pointed at that directory, though. `stageAgentInputs` copies the three inputs it needs _into the worktree_ under `.throughline/` — `diff.patch`, `hunks.json`, `files.json` — and those relative paths (`AGENT_FILES` in `apps/server/src/analysis/prompts.ts`) are what the prompts name; `.git/info/exclude` keeps the directory out of `git status` for anyone who looks. The alternative, handing the agent an absolute path into the run directory, depends on each harness's rules for reading outside its working directory, which differ and are part of neither SDK's contract — whereas a path under the agent's own working directory is unambiguously readable in both, and the worktree is disposable, so writing into it costs nothing. The per-file chunks stay behind: they serve the reading surfaces, not the agent.

The agent reads what it needs the way agents are good at it — navigating files in a worktree, diff and surrounding codebase alike. Prompt size stays flat no matter how large the PR is.

## The staged pipeline

Analysis is a sequence of structured-output runs: the plan run is gated before any narration begins, and the assembled artifact is checked once before it is persisted. Two stages, because the two jobs want different attention: partitioning wants the whole change in view; narrating wants one cluster at a time.

**Stage 1 — the journey plan.** One run over the full diff and codebase. Output: the cluster list (titles, weights, order, `buildsOn`), every seed hunk's home assignment, any seed-hunk splits (each part's old and new line counts plus its home — Throughline computes where each part starts, so a refinement of the partition is a partition by construction and the agent cannot hand back overlapping or gapped sub-ranges even if it tries), and file order per cluster. That output is then neither trusted nor rejected — `materializePlan` in `@app/journey/plan` materializes it against the deterministic seeds, and the materializer's own rules are what make the vision's properties true by construction: an assignment or split naming a hunk or cluster that does not exist is ignored, a split whose parts do not add up to their seed collapses back to the whole hunk, and any seed the plan forgot is homed to a synthesized cluster. What earns a correction turn is the subset of the materializer's fallbacks a second attempt could plausibly fix — input it had to throw away because it referenced something unreal, and seeds left with no home — rather than completion that reflects a choice we made, like dropping a cluster nothing landed in. The `@app/journey/coverage` validators state the guarantees themselves — splits must exactly tile their seed, every hunk must have exactly one existing home, every changed line must be covered — and run once, over the finished artifact, as the check the server will not persist without.

**Stage 2 — the words.** With the plan fixed, each cluster's own run produces its `narrative`, its `mapEntry` for the Overview map, its resurfacing selections with notes, and its hints; the Overview — `brief`, `whereToBegin`, and the two-or-three-word `attention` phrase per cluster — is written by a final run after every cluster, deliberately, because it is a first-class artifact about the whole journey and by then the journey exists. Referential integrity is not asked of these runs; it is imposed on their output. `assembleNarration` (also `@app/journey/plan`) downgrades every `tl:` link that does not resolve to plain text, clamps or drops every hint anchor that does not fit its file at the pinned revision, and drops resurfacing whose home is not an earlier cluster — recording each as a fallback instead of sending the run back for another attempt, because prose is the one output whose shortfall costs nothing structural. Cluster narration is one run per cluster against the frozen plan — restartable, parallelizable later, and each run's context is one cluster deep, not forty thousand lines wide.

### Repair, then commit — never fail

Per the vision, analysis has no error terminal state. Each stage enforces that with a ladder of rungs:

1. **Validate** — the pure validators return precise, machine-generated violation lists ("h17 unassigned", "split of h4 leaves lines 210–214 uncovered", "link tl:symbol/… does not resolve").
2. **Repair loop** — violations go back to the same thread (both SDKs resume threads) as a correction turn, up to 2 rounds. Most failures are near-misses; precise feedback fixes them cheaply. In practice this is the plan run's rung: stage 2 has no violation list to send back, for the reason rung 3 gives.
3. **Abandon the run (stage 2 only)** — narration is not gated before the next run begins, so a narration run fails only when the harness itself does: it crashed, its login expired, or it returned something that was not the JSON its schema demanded. There is nothing to correct on a thread that never produced a usable answer, so the run is abandoned rather than reopened: the cluster is recorded in the journey's `fallbacks` as one the harness could not narrate, and the rung below writes its prose instead. Only words are lost this way — the plan is already frozen, so a failed narration costs one cluster's paragraphs and nothing coverage depends on.
4. **Deterministic completion** — at the floor, the pipeline finishes the artifact itself, honestly: unassigned hunks land in a synthesized final cluster titled for what it is ("Unplaced changes", weight Supporting, narrative saying exactly how it came to exist); invalid splits collapse back to their seed hunk; unresolvable links downgrade to plain text; an invalid hint is dropped (hints are optional aids; coverage is not). Every fallback is logged in the run directory.

The final rung is what makes "the agent always commits" an invariant of the _system_ rather than a hope about the model: the pipeline can always construct a valid journey from any stage-1 output, including an empty one — the degenerate journey (one cluster per top-level directory of the change, titled for exactly that — "Changes in `apps/`", "Changes at the repository root") is dreadful but valid, visible, and honest.

## Ingestion jobs

`Ingestion` (in `apps/server/src/analysis/`) orchestrates the whole flow as a supervised job — one active job per PR, a global cap of one running analysis at a time (harness runs are heavy; queued jobs say so honestly).

Phases, published as a snapshot-then-live stream (the starter's push-bus pattern) and consumed directly by the transition UI — the narrated stages the product docs promise are these events, so the narration is honest by construction. `analyzing` events additionally carry a structured activity payload — the current action, a short trail of recent ones, and monotonic counters — derived only from observed harness events, never invented; this is what the transition's live feed and counters render (design `02-ingestion`).

The counters are `changedFilesOpened`, `filesRead`, `searchesRun`, and `steps` (`AnalysisCounters` in `packages/contracts/src/ingestion.ts`), and their names are the whole point: they are exactly the four things a harness event actually tells us — a file the agent read, whether that file was one of the changed ones, a search it ran, and anything else it did, which we can only honestly call a step. An earlier draft of this document promised "files walked, symbols traced, call sites followed", which reads better and cannot be honestly derived — nothing in a harness event stream distinguishes a symbol lookup from any other read, so those counters could only have been invented, which is the one thing this payload forbids. Where a nicer label would require a guess, the honest label wins:

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

Added to `packages/contracts` (shapes per [02](./02-domain-model.md)):

| RPC                                                                                       | Kind                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `github.viewer`, `github.refreshPrs`, `github.resolveUrl`                                 | unary (`github.viewer` is cached; `github.refreshPrs` is the explicit re-fetch, `github.resolveUrl` is door validation for a pasted URL)    |
| `github.subscribePrs`                                                                     | stream (snapshot then live — the welcome screen's whole data source, server-enriched with each PR's journey state: exists, progress, stale) |
| `ingestion.start`, `ingestion.cancel`                                                     | unary (door rejections are `ingestion.start`'s only errors)                                                                                 |
| `ingestion.subscribe`                                                                     | stream                                                                                                                                      |
| `journey.get`, `journey.filePatch`, `journey.fileContent`, `journey.tree`                 | unary (immutable per journey — cacheable forever client-side)                                                                               |
| `readState.get`, `readState.markFile`, `readState.unmarkFile`, `readState.setDisplayMode` | unary                                                                                                                                       |
| `readState.subscribe`                                                                     | stream (multi-window consistency for free)                                                                                                  |
| `prState.setReviewed`, `prState.setHidden`, `prState.dismissMerged`                       | unary                                                                                                                                       |
| `harness.status`                                                                          | unary (settings + welcome-screen setup surfaces)                                                                                            |
| `settings.get`, `settings.update`                                                         | unary (harness selection)                                                                                                                   |
