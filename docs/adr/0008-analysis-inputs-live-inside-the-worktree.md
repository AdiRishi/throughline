# Analysis Inputs Live Inside The Worktree

The materialized run inputs the agent reads — `full.patch`, `hunks.json`, `files.json` — are written **twice**: once into the durable run directory (`<dataRoot>/runs/…`), and once into `.throughline/` **inside the worktree** the harness runs in. The prompts point at the worktree copy.

The reason is the read-only enforcement itself. A harness confined to a working directory is under no obligation to read outside it — Codex runs under a sandbox rooted at `workingDirectory`, and Claude's `Read` tool is scoped to `cwd`. Handing the agent an absolute path into a sibling directory is exactly the kind of thing that works on one adapter and silently fails on the next, and "the agent could not read its inputs" is indistinguishable from "the agent did a bad job" once the run is over.

The durable copy is not redundant. The worktree is removed when the run ends; the run directory is what `journey.filePatch` and `journey.fileContent` are served from for the rest of the journey's life, and what the honesty trail (transcripts, fallbacks) is written into. Duplicating a few megabytes of patch text is the cheap half of that trade.

Consequence: `.throughline/` appears as an untracked directory in the worktree during a run. That is harmless — nothing commits from the worktree, and it is deleted with it — but a future adapter that runs `git status` and reasons about cleanliness needs to know it is there.
