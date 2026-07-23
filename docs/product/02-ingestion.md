# Ingestion & Freshness

How a pull request becomes a journey, and what happens when the pull request moves on.

## Input

Two ways in, both from the [welcome screen](./01-welcome.md): selecting one of your open PRs, or pasting a PR URL. They feed the same pipeline. GitHub is the only platform in v1; raw diffs and unpushed local branches are out of scope.

## What ingestion does

At the level this document cares about: Throughline clones the repository into a temporary workspace of its own — the PR's branch and the base it targets — sets up what it needs on disk, and then runs its AI analysis (one agent or a fleet; the shape of that machinery is a technical-doc concern) over the diff and the surrounding code to construct the journey.

Two behavioral commitments:

- **The run always completes.** Per the vision's always-commit principle, there is no "analysis failed" terminal state for a valid, reachable PR. A change with no clean structure gets an honest journey through a messy change. Unreachable input — a bad URL, a repository your `gh` login can't see — is rejected *before* ingestion begins, at the door.
- **A journey is a snapshot.** It is pinned to the PR's head commit at the moment of analysis. That pin is what makes coverage, read state, and every narrative claim stable and verifiable.

## The transition

Ingestion takes real time on real PRs, and the wait is a designed experience, not a loading spinner:

- **It narrates what is actually happening** — cloning the repository, reading the change, constructing the journey — as a sequence the reviewer can follow, with animation that is beautiful, clean, and calm. Delight here sets the tone for the whole product.
- **It is honest.** The stages shown are the stages happening. No invented progress bars, no fake percentages.
- **It is leavable.** On a huge PR the reviewer should feel free to walk away; the journey opens (or waits) when they come back.

## Freshness

Pull requests keep moving after analysis. Throughline handles this with an explicit, simple model:

- **Stale is a visible state, not a failure.** When the PR's head no longer matches the journey's pinned commit, the journey is marked **stale** — visibly, wherever the journey is shown. A stale journey remains fully readable, and read progress can still be made against it; it is simply a faithful map of an older head.
- **Reanalysis is manual and full.** The reviewer — never the app on its own — triggers reanalysis. Reanalysis is a complete rebuild against the new head: a new journey, new clusters, new narratives. There is no incremental patching of an existing journey; a journey is only ever the product of one whole analysis.
- **Reanalysis resets read state.** A rebuilt journey is a new journey, and progress starts fresh. No partial carry-over, no guessing which old marks still apply — the coverage guarantee is only meaningful against the journey it was earned in.
