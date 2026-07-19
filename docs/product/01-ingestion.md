# Ingestion & Freshness

How a pull request becomes a journey, and what happens when the pull request moves on.

## Input

The input is a GitHub pull request URL — pasted into the app, nothing else required. v1 accepts exactly this one input form; raw diffs, local branches, and other platforms are out of scope.

## The analysis run

When a URL is submitted, Throughline builds the journey. From the reviewer's perspective:

- **Progress is visible and honest.** The run reports what it is doing in plain stages (fetching the change, reading the code, constructing the journey) — not a spinner of unknown duration. Long runs on huge PRs are expected; the reviewer should be able to walk away and come back.
- **The run always completes.** Per the vision's always-commit principle, there is no "analysis failed" terminal state for a valid, reachable PR. A change with no clean structure gets an honest journey through a messy change — the degenerate floor being a small number of coarse clusters. (Unreachable input — bad URL, no access to the repository — is rejected _before_ analysis begins, at submission time. Once a run starts, it finishes.)
- **A journey is a snapshot.** It is pinned to the PR's head commit at the moment of analysis. That pin is what makes coverage, read state, and every narrative claim stable and verifiable.

## Freshness

Pull requests keep moving after analysis. Throughline handles this with an explicit, simple model:

- **Stale is a visible state, not a failure.** When the PR's head no longer matches the journey's pinned commit, the journey is marked **stale** — visibly, wherever the journey is shown. A stale journey remains fully readable, and read progress can still be made against it; it is simply a faithful map of an older head.
- **Reanalysis is manual and full.** The reviewer — never the app on its own — triggers reanalysis. Reanalysis is a complete rebuild against the new head: a new journey, new clusters, new narratives. There is no incremental patching of an existing journey; a journey is only ever the product of one whole analysis.

## Open questions

- **Read state across reanalysis:** a rebuilt journey has new clusters, so per-cluster progress cannot carry over as-is. Does progress reset entirely, or can file-level read marks survive where a file is unchanged between heads?
