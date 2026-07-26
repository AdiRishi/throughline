# Guidance & Hints

The right rail of the [reading experience](./04-reading.md): scroll-bound help. It carries every **hint** (see `CONTEXT.md`) the page can bind — the open cluster's hints on a cluster page, every hint anchored in the open file on a file page, whichever cluster it rides — in the order their anchors appear in the code. Position is spent on prominence rather than on membership: the hints anchored to a file currently on screen float to the top of the rail and read at full strength, and the rest stay legible beneath them, because a hint that disappears the moment you scroll past its anchor is a hint the reviewer cannot get back to. These are the things a thoughtful colleague would murmur while reading over your shoulder.

**Design:** the rail appears in both reading designs — [`designs/04-reading-cluster.png`](./designs/04-reading-cluster.png) and [`designs/04-reading-just-the-code.png`](./designs/04-reading-just-the-code.png).

Hints bind in every display mode, including just-the-code — reading in silence still carries its guidance, anchored there to the subtle changed-region markers — with one honest exception. A hint anchored to the **old** side has nothing to attach to in just-the-code, where the head revision is on screen and the deleted lines are not, so those hints are held back there rather than bound to whatever line now sits at that number. The rail says so at its foot: how many hints are waiting and that the diff is where to read them, because a hint that silently disappears is worse than one that explains its absence. A deleted file is the exception's exception — it has no head revision to show in silence, so it reads as its deletion diff even in just-the-code, and its old-side hints bind against that.

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

- **It follows; it is never operated.** Position in the code drives it: no filters, no tabs, no sort, no kind selector. The collapse toggle below is the single control the rail carries, because a rail that cannot be closed is not quiet.
- **Anchored, always.** Clicking a hint scrolls the code to its anchor; scrolling the code brings its hints alongside.
- **Quiet.** The rail may be collapsed entirely, and reading with it closed must remain a complete experience — the cluster's narrative still leads the page.
