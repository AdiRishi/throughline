# Throughline — Product Vision

> **One-liner:** Throughline turns a large pull request into an ordered story of intentional steps, so a reviewer can follow the development journey instead of scrolling a flat list of file diffs.

## The problem

The way code gets written has changed faster than the way code gets reviewed.

Most substantial changes are now written with coding agents. A single unit of work that used to arrive as a 1,000–3,000 line pull request now routinely arrives as 10,000, 20,000, or 40,000 lines. The PR is still one coherent piece of work — but at that size, coherence is invisible to the person who has to review it.

Today's review tools were built for the old world. GitHub shows a file tree on the left and diffs on the right, ordered by path. That presentation answers exactly one question — *what changed in each file* — and is silent on the questions that actually determine review quality:

- **What was the plan?** What sequence of moves does this change decompose into?
- **What belongs together?** Which files are one logical step, and which are three unrelated ones that happen to sit in the same directory?
- **What depends on what?** Which parts are foundations, and which parts build on them?

When a human writes a large change by hand, they don't touch files in alphabetical order. They work in a deliberate sequence: build one piece, build the next, then write the code that connects them. Each phase touches a cluster of files that belong together. That journey — the order and the clustering — *is* the intent of the change. It's how the author understood their own work.

A file-ordered diff destroys that structure. The reviewer receives the end state with the journey stripped out, and is left to reverse-engineer intent from 40,000 lines of alphabetized fragments. In practice, they don't. Review at this scale degrades into skimming, spot-checking, and approving on trust — precisely when the volume of agent-written code means review matters more than it ever has.

## The insight

The journey is not gone. It's latent in the diff.

Any coherent change has an intelligible decomposition — a way of splitting it into steps such that each step is small enough to hold in your head, internally cohesive, and meaningfully ordered relative to the others. The author (human or agent) had one. The diff still contains the evidence of it: which symbols reference which, which modules are new versus modified, which pieces are load-bearing and which are glue.

An AI agent that reads the whole diff can reconstruct that decomposition. Not the literal minute-by-minute history — that doesn't matter — but a *faithful, intelligible ordering*: the journey a thoughtful developer would describe if you asked them "walk me through this change."

That narrative thread — the one idea that connects every part of the change into a story — is the change's **throughline**. Recovering it is the product.

## What Throughline is

Throughline is a code review companion. You give it a pull request URL. An AI agent dissects the full diff and reconstructs the development journey behind it, presenting the change as an **ordered sequence of clusters**:

- **A cluster** is a set of changed hunks — possibly spanning many files, possibly only part of a file — that together accomplish one describable step of the work.
- **Each cluster carries a narrative**: what this step does, why it comes at this point in the sequence, and how it relates to the clusters before it.
- **The sequence is ordered for comprehension**: foundations before the things built on them, parts before the code that binds the parts together.

The reviewer then reviews the PR *cluster by cluster*, in order — reading a story with a beginning, middle, and end, rather than a dump of files.

The journey is the agent's, and it is read-only. The reviewer walks it; they don't merge, split, or reorder clusters. One authoritative decomposition keeps the narrative coherent and keeps the reviewer's attention where it belongs — on judging the code, not curating the presentation of it.

### The core guarantee: a partition, not a summary

Throughline never summarizes the diff — it **partitions** it. Every changed line in the PR belongs to exactly one cluster, and the clusters together are exactly the full diff. Nothing is omitted, condensed, or paraphrased away. A reviewer who walks every cluster has, provably, seen every line.

This is the property that separates Throughline from "AI PR summary" tools. A summary asks the reviewer to trust prose *instead of* reading the code. Throughline reorganizes the code so the reviewer can actually read all of it. The narrative is a lens over the diff, never a replacement for it.

### A concrete example

Suppose a PR adds authentication to an application — 12,000 lines across 90 files. On GitHub, that's an alphabetical wall. Throughline presents it as a journey:

1. **The auth module** — token issuance, session handling, credential verification. A self-contained foundation with no UI.
2. **The login and signup UI** — screens, forms, and client-side state. Built against the auth module's interface, but reviewable as its own coherent piece.
3. **The binding** — route guards, session wiring, redirects. The connective code that brings parts one and two together into a working feature.

Each step is a few thousand lines with a clear job — reviewable. And crucially, the *shape* of the change is now visible: a reviewer who understands the boundary between step 1 and step 2 understands the architecture of the feature, before reading a single line closely.

## Principles

1. **The journey is an inference, honestly presented.** The agent proposes a plausible, useful decomposition — it does not claim to know the author's actual chronology. The product's claim is "here is an intelligible way through this change," not "here is what happened."
2. **The agent always commits.** There is no "too tangled to decompose" and no low-confidence escape hatch. Every PR gets the best journey the agent can construct; a messy change gets an honest journey through a messy change, never an error state.
3. **Complete coverage, always.** The partition guarantee is inviolable. If a line can't be confidently placed, it lands in an explicit cluster the reviewer can see — never on the floor.
4. **Judgment stays with the human.** Throughline structures the review; it does not perform it. It doesn't approve, score, or flag code quality. It makes the reviewer more capable, not more passive.
5. **The diff is the ground truth.** Narrative always links back to the actual hunks it describes. Prose that can't be checked against code is not allowed to exist in the product.

## What Throughline is not

- **Not an automated reviewer.** It finds structure, not bugs. Tools that comment "this might be a null pointer" solve a different problem.
- **Not a summarizer.** Summaries compress the diff; Throughline covers it completely and reorganizes it.
- **Not a replacement for the review platform.** Approval, discussion, and merge stay where they are. Throughline is where you go to *understand* the change.

## Who it's for

The engineer responsible for reviewing large, substantially agent-written pull requests — their own agents' output or a teammate's. Today they face a choice between spending days on a 40,000-line diff or approving it on faith. Throughline exists to make the third option real: genuinely understanding the change in a sitting.

## What success looks like

- A reviewer opens a PR they would previously have skimmed, and instead walks it cluster by cluster to the end — every line seen, in an order that made sense.
- Reviewers can articulate the *architecture* of a change ("it's the auth module, then the UI, then the wiring") after minutes, not hours.
- "Too big to review" stops being a reason to approve on trust.

## Open questions

Deliberately unresolved; this document will grow as they're answered.

- **Review state:** Throughline may track per-cluster review progress ("clusters 1–3 reviewed, cluster 4 remaining"). Whether it does — and whether that state feeds back to the review platform in any form — is undecided.
