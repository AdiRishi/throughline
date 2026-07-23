# The Overview Page

Where every journey starts. The Overview is a first-class artifact the agent writes deliberately — never a restatement of the PR description (see **Overview** in `CONTEXT.md`). Its job is orientation: after reading it, the reviewer should be able to say what the change builds and name its parts, before reading a single diff closely.

It is detailed — a good map, not an essay. Density comes from structure, not prose length.

On screen, the Overview is a document, and it reads like one: it takes over the middle **and** right panels together. The guidance rail is a companion to code, and the Overview has no code — one wide, quiet page.

## Content, in order

### 1. The change, in brief

A few sentences: what this PR builds and why it exists. Written from the reconstructed understanding of the code, not paraphrased from the PR description.

### 2. The map of the journey

The heart of the page: one entry per cluster, in journey order. Each entry carries:

- **Position and title** — matching the left rail exactly.
- **Weight** — Core, Supporting, or Mechanical, as a quiet label.
- **A two-to-three sentence account** of what the cluster does and why it sits at this point in the sequence. This is the same narrative the cluster page leads with, compressed — the map and the territory always agree.
- **Its relationships** — which earlier clusters it builds on, stated plainly ("binds the auth module (1) to the login UI (2)").
- **Its scale** — files touched and hunks homed, so the reviewer can budget attention before starting.

Reading only the map should leave the reviewer able to articulate the architecture of the change — the vision's minutes-not-hours test.

### 3. Where to begin

A short closing orientation: the recommended entry point (normally cluster 1), plus honest guidance on attention — e.g. which Mechanical clusters can be walked quickly. Guidance about _attention_, never judgment about _quality_.

## The PR's own words

The PR title, description, author, and link are available on the page but visually secondary — collapsed behind a single expandable section. The reconstructed story leads; the raw metadata is reference material.

## Open questions

- **Map form:** the map is structured text for now. Does it ever warrant a visual (graph) rendering of cluster relationships — and can that stay inside the vision's one-opinionated-shape rule?
