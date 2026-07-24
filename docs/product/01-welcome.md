# The Welcome Screen

What the app shows when no journey is open. Its intent is orientation and welcome: an overview of your review world — what's waiting for you, what you're in the middle of, what's done. It should feel calm and personal, like opening the app to a tidy desk.

**Design:** [`designs/01-welcome.png`](./designs/01-welcome.png)

## Built on your GitHub identity

Throughline sits on top of GitHub and authenticates through the **GitHub CLI** (`gh`). What you can see in Throughline is what your `gh` login can see — your repositories and their pull requests. There is no separate account, no separate permission model.

## What it shows

- **Your repositories, and their open PRs.** This is the primary content: the review work that exists for you right now.
- **PRs you've ingested are visibly distinct** — they have a journey, and the welcome screen shows where you are in it. A glance answers "what am I actively reviewing?"
- **Every saved journey remains available.** A PR opened through the pasted-URL door stays in the welcome index even when its repository is outside GitHub's viewer-affiliation list. It behaves like any other journey and can be reopened after navigating away or restarting the app.
- **Merged PRs move to their own section.** When a PR merges it leaves the open list and settles into a Merged section — still visible, because recently merged work is still part of your mental landscape. It lingers for about a week, then leaves on its own; the reviewer can dismiss it permanently sooner. Closure without clutter.
- **Saved journeys outlive the active windows.** If an ingested PR closes or its merge ages out of the one-week window, its immutable journey moves to a quiet Saved journeys section until the reviewer hides it.

## What the reviewer can do here

- **Open a PR** — the primary action; see [Ingestion](./02-ingestion.md).
- **Mark a PR reviewed** — a manual, local declaration of "I'm done with this," independent of journey progress.
- **Hide a PR** — remove it from view without any effect on GitHub.
- **Open settings** — a quiet gear in the title bar; harness choice and appearance live there, off the main surface.

All of this state is local, like read state — the welcome screen never writes to GitHub.

## Starting a journey

Two doors, one deliberately quieter than the other:

- **Pick from the list** — the primary path. Your open PRs are already here; clicking one begins ingestion (or reopens its journey if one exists).
- **Paste a PR URL** — a secondary affordance, visually subordinate. It exists for the PR that isn't in your list: a public repository you want to try Throughline on, a one-off review. Same pipeline, different door; once its journey is saved, that PR remains in the welcome index.
