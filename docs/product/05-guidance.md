# Guidance & Hints

The right rail of the [reading experience](./04-reading.md): scroll-bound help. As the reviewer moves through the code, the rail attaches to their position and surfaces **hints** (see `CONTEXT.md`) anchored to the code in view — the things a thoughtful colleague would murmur while reading over your shoulder.

Hints bind in every display mode, including just-the-code: reading in silence still carries its guidance, anchored there to the subtle changed-region markers.

## What a hint can be

Candidate hint kinds — deliberately drafted for later review, not yet final:

- **Connection** — "this registration implements the interface added in cluster 1; its other half is in `AuthService.ts`." Cross-file and cross-cluster threads, made visible at the moment you're looking at one end.
- **Complexity companion** — a plain-words walkthrough of a genuinely dense region in view: the invariant a loop maintains, what a gnarly type expression actually says, the order things happen in an async flow.
- **Ripple context** — facts from the surrounding codebase the diff can't show: "this function has twelve call sites; this PR changes the behavior of two of them."
- **Pattern echo** — "the same transformation as the previous three files" — telling the reviewer a region is mechanical repetition they can walk quickly, without the product ever deciding for them.
- **Behavioral before/after** — "errors on this path used to be swallowed; they now surface as typed failures." What the change _means_, stated at the moment the code shows _how_.
- **Resurfacing note** — on a revisited hunk: why the journey brought it back here, and what to see in it this time.

All hints are comprehension, never judgment — no "this looks wrong," no severity. Like all narrative, every hint anchors to the exact code it describes (vision: every claim is evidence-backed).

## Rules that keep it a margin, not a dashboard

- **It follows; it is never operated.** Position in the code drives it. No filters, no tabs, no controls in v1.
- **Anchored, always.** Clicking a hint scrolls the code to its anchor; scrolling the code brings its hints alongside.
- **Quiet.** The rail may be collapsed entirely, and reading with it closed must remain a complete experience — the cluster's narrative still leads the page.
