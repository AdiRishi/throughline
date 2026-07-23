# Throughline

Throughline is a PR comprehension system: it reconstructs the development journey behind a large pull request so a reviewer can read the change as an ordered story rather than a flat list of file diffs. This glossary is the ubiquitous language for that domain — see `docs/VISION.md` for the full product vision.

## Language

**Journey**:
The artifact Throughline produces for a pull request: the ordered sequence of clusters, with their narratives, that partitions the PR's diff into a comprehensible story. One PR, one journey; it is read-only for the reviewer.
_Avoid_: walkthrough, decomposition, story, report

**Cluster**:
One describable step of the journey: a set of hunks (possibly spanning many files) that together accomplish a single piece of the work, plus the narrative that explains it.
_Avoid_: step, chapter, section, group, commit

**Hunk**:
Throughline's atomic unit of placement — a contiguous run of changed lines that serves one concern. Derived from git's hunks, but may be split finer when a git hunk mixes concerns; it is never coarser.
_Avoid_: chunk, fragment, excerpt, diff block

**Home**:
The one cluster where a hunk is placed. Every hunk has exactly one home, and coverage is counted there and only there.
_Avoid_: owner, primary cluster

**Narrative**:
The prose a cluster carries: what this step does, why it sits at this point in the journey, and how it relates to the clusters before it. Every claim in a narrative links to the hunks, files, or symbols that evidence it.
_Avoid_: summary, description, explanation, commentary

**Resurfacing**:
Showing a hunk again in a cluster that is not its home, to communicate a cross-cutting perspective (typically how earlier clusters interact). A resurfaced hunk is always visibly marked as such — known code from a new angle, never new code.
_Avoid_: revisit, duplicate, re-show

**Coverage**:
The inviolable guarantee that every changed line of the pull request appears in exactly one home cluster — the homes together partition the full diff. Nothing is omitted, condensed, or left unplaced.
_Avoid_: completeness, summarization

**Weight**:
A cluster's attention classification — Core, Supporting, or Mechanical. Weight guides how much comprehension effort a cluster deserves; it never expresses risk or quality.
_Avoid_: importance, priority, severity, risk, complexity

**Overview**:
The journey-level narrative the agent writes deliberately: what the PR builds, the shape of the journey, and where to begin. Distinct from the PR's own description, which it never merely restates.
_Avoid_: summary, walkthrough, description

**Hint**:
A scroll-anchored piece of guidance attached to a specific region of code — a connection, an explanation, an orientation aid. Hints aid comprehension and never judge quality.
_Avoid_: comment, annotation, tip, suggestion

**Stale**:
The state of a journey whose pinned head commit no longer matches the PR's head. A stale journey stays fully readable; only a reviewer-triggered full reanalysis replaces it.
_Avoid_: outdated, expired, invalid
