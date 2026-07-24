# Docs

Durable documentation for this repository. Code comments explain a file; the documents here explain the system.

- **[`TECHNICAL.md`](./TECHNICAL.md)** + **[`technical/`](./technical/)** — the technical specification: how the system delivering `PRODUCT.md` is built. Where it conflicts with the vision or product docs, they win.
- **[`adr/`](./adr/AGENTS.md)** — Architecture Decision Records: why the hard-to-reverse decisions were made. Start here to understand anything in the codebase that looks surprising.
- **`plans/`** — implementation plans for coordinated initiatives (created when the first plan is needed; see the ADR guidance for the spirit of the split: plans say _what we intend to build_, ADRs say _why a decision was made_).
- **`../.repos/`** — vendored read-only reference repositories (Effect source pinned to the installed version), managed by `pnpm sync:repos`.

Top-level project documentation (README, agent guidance) is maintained separately and intentionally minimal for now.
