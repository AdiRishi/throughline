/**
 * The welcome screen: your repositories, your PRs, your review state.
 *
 * Orientation and welcome — what is waiting, what you are in the middle of,
 * what is done. Everything on it is local: marking reviewed, hiding, dismissing
 * a merged PR. GitHub is never written to.
 *
 * @module features/welcome/WelcomeScreen
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { PrListEntry, PrListView, RepoPrGroup } from "@app/contracts";
import { parsePrUrl } from "@app/shared/prUrl";

import { toDate } from "../../lib/time.ts";
import { ingestionActions } from "../../state/ingestion.ts";
import { welcomeAtoms } from "../../state/welcome.ts";
import {
  Bar,
  Button,
  countdown,
  formatCount,
  Notice,
  relativeTime,
  SegmentedProgress,
} from "../../ui/primitives.tsx";

export function WelcomeScreen() {
  const view = useAtomValue(welcomeAtoms.view);
  const loading = useAtomValue(welcomeAtoms.loading);
  const refresh = useAtomSet(welcomeAtoms.refresh);

  // Refresh on focus and on explicit user action only — an idle Throughline
  // issues zero requests, and that is a rule for the UI as much as the server.
  useEffect(() => {
    const onFocus = () => refresh();
    globalThis.addEventListener("focus", onFocus);
    return () => globalThis.removeEventListener("focus", onFocus);
  }, [refresh]);

  const openCount = view.repos.reduce((total, repo) => total + repo.entries.length, 0);

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-4xl px-8 pt-14 pb-24">
        <Greeting view={view} openCount={openCount} loading={loading} />

        <StatusBanner view={view} onRefresh={() => refresh()} />

        <div className="mt-10 space-y-9">
          {view.repos.map((group) => (
            <RepoSection key={`${group.owner}/${group.repo}`} group={group} />
          ))}
        </div>

        {view.merged.length > 0 && <MergedSection entries={view.merged} />}

        {openCount === 0 && view.status.kind === "ok" && (
          <p className="mt-8 text-[13px] text-muted">
            No open pull requests involve you right now. Paste a URL below to review any pull
            request you can see.
          </p>
        )}

        <PasteDoor />
      </main>
    </div>
  );
}

function Greeting({
  view,
  openCount,
  loading,
}: {
  readonly view: PrListView;
  readonly openCount: number;
  readonly loading: boolean;
}) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const entries = view.repos.flatMap((repo) => repo.entries);
  const inJourney = entries.filter(
    (entry) => entry.journey !== null && !entry.journey.complete,
  ).length;
  const finished = entries.filter((entry) => entry.journey?.complete === true).length;
  const stale = entries.filter((entry) => entry.journey?.stale === true).length;
  const fresh = entries.filter((entry) => entry.journey === null).length;

  const headline = loading
    ? "Looking for your reviews"
    : openCount === 0
      ? "Nothing waiting"
      : `${capitalize(spell(openCount))} review${openCount === 1 ? "" : "s"} waiting`;

  const parts: string[] = [];
  if (inJourney > 0) parts.push(`${spell(inJourney)} mid-journey`);
  if (stale > 0) parts.push(`${spell(stale)} stale`);
  if (finished > 0) parts.push(`${spell(finished)} finished`);
  if (fresh > 0) parts.push(`${spell(fresh)} not analyzed yet`);

  return (
    <header className="tl-enter">
      <p className="text-[13px] text-muted">{today}</p>
      <h1 className="mt-1 text-[28px] font-semibold tracking-tight">{headline}</h1>
      <p className="mt-2 text-[14px] text-muted">
        {parts.length > 0 ? `${capitalize(parts.join(", "))}. ` : ""}
        Everything here is local — GitHub is never written to.
      </p>
    </header>
  );
}

function StatusBanner({
  view,
  onRefresh,
}: {
  readonly view: PrListView;
  readonly onRefresh: () => void;
}) {
  const { status } = view;
  if (status.kind === "ok" || status.kind === "loading") return null;

  return (
    <div className="mt-8">
      {status.kind === "gh-unavailable" ? (
        <Notice
          title={
            status.reason === "not-installed"
              ? "The GitHub CLI isn’t installed"
              : "The GitHub CLI isn’t signed in"
          }
        >
          <p>{status.detail}</p>
          <p className="mt-1 text-faint">
            Throughline sees exactly what your <code className="font-mono">gh</code> login sees.
            There is no separate account.
          </p>
        </Notice>
      ) : status.kind === "parked" ? (
        <Notice title="GitHub’s rate limit is reached">
          <p>
            Throughline has stopped sending requests until{" "}
            {toDate(status.resetAt).toLocaleTimeString()} — including this screen’s refresh.
            Journeys you already have stay fully readable.
          </p>
        </Notice>
      ) : (
        <Notice title="Couldn’t reach GitHub" action={<Button onClick={onRefresh}>Retry</Button>}>
          <p>{status.detail}</p>
        </Notice>
      )}
    </div>
  );
}

function RepoSection({ group }: { readonly group: RepoPrGroup }) {
  return (
    <section className="tl-enter">
      <h2 className="mb-2.5 font-mono text-[11px] tracking-[0.12em] text-faint uppercase">
        {group.owner} / {group.repo}
      </h2>
      <div className="space-y-2">
        {group.entries.map((entry) => (
          <PrRow key={`${entry.pr.ref.number}`} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function PrRow({ entry }: { readonly entry: PrListEntry }) {
  const navigate = useNavigate();
  const setReviewed = useAtomSet(welcomeAtoms.setReviewed);
  const setHidden = useAtomSet(welcomeAtoms.setHidden);
  const start = useAtomSet(ingestionActions.start);
  const [hovered, setHovered] = useState(false);

  const { pr, journey } = entry;
  const open = () => {
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: {
        owner: pr.ref.owner,
        repo: pr.ref.repo,
        number: String(pr.ref.number),
      },
    });
  };

  const reanalyze = () => {
    start({ target: { kind: "ref", pr: pr.ref }, reanalyze: true });
    open();
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      tabIndex={0}
      className="group flex cursor-pointer items-center justify-between gap-6 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-border-strong focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
    >
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-semibold tracking-tight">{pr.title}</span>
          <span className="shrink-0 font-mono text-[12px] text-faint">#{pr.ref.number}</span>
          {entry.marks.reviewed && (
            <span className="shrink-0 text-[11px] text-faint">· reviewed</span>
          )}
          {pr.isDraft && <span className="shrink-0 text-[11px] text-faint">· draft</span>}
        </div>
        <p className="mt-0.5 truncate font-mono text-[12px] text-muted">
          {pr.authorLogin} · opened {relativeTime(toDate(pr.createdAt))} ·{" "}
          {formatCount(pr.changedFiles)} files ·{" "}
          <span className="text-addition">+{formatCount(pr.additions)}</span>{" "}
          <span className="text-deletion">−{formatCount(pr.deletions)}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {entry.ingesting ? (
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <span className="tl-pulse inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            Analyzing
          </span>
        ) : journey === null ? (
          hovered ? (
            <RowActions
              onReviewed={() => setReviewed({ pr: pr.ref, value: !entry.marks.reviewed })}
              onHide={() => setHidden({ pr: pr.ref, value: true })}
              reviewed={entry.marks.reviewed}
              primaryLabel="Open journey"
              onPrimary={open}
            />
          ) : (
            <span className="text-[13px] text-faint">Not analyzed</span>
          )
        ) : (
          <div className="w-72 text-right">
            <p className="text-[13px] text-muted">
              {journey.complete
                ? "Journey finished — every line seen"
                : `Reading · cluster ${journey.currentClusterPosition ?? 1} of ${journey.clusterCount}`}
            </p>
            <SegmentedProgress className="mt-1.5" fractions={journey.clusterFractions} />
            {journey.stale && (
              <div className="mt-2 flex items-center justify-end gap-2">
                <span className="rounded border border-border-strong px-1.5 py-[1px] font-mono text-[10px] tracking-wider text-muted">
                  STALE
                </span>
                <span className="text-[11.5px] text-muted">
                  pinned to <span className="font-mono">{journey.pinnedHeadSha.slice(0, 7)}</span> ·
                  PR moved ahead
                </span>
                <Button
                  onClick={(event) => {
                    event.stopPropagation();
                    reanalyze();
                  }}
                >
                  Reanalyze
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RowActions({
  onReviewed,
  onHide,
  onPrimary,
  reviewed,
  primaryLabel,
}: {
  readonly onReviewed: () => void;
  readonly onHide: () => void;
  readonly onPrimary: () => void;
  readonly reviewed: boolean;
  readonly primaryLabel: string;
}) {
  return (
    <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      <Button onClick={onReviewed}>{reviewed ? "Unmark reviewed" : "Mark reviewed"}</Button>
      <Button onClick={onHide}>Hide</Button>
      <Button tone="primary" onClick={onPrimary}>
        {primaryLabel}
      </Button>
    </div>
  );
}

function MergedSection({ entries }: { readonly entries: ReadonlyArray<PrListEntry> }) {
  const dismiss = useAtomSet(welcomeAtoms.dismissMerged);
  const navigate = useNavigate();

  return (
    <section className="tl-enter mt-10">
      <h2 className="mb-2.5 font-mono text-[11px] tracking-[0.12em] text-faint uppercase">
        Merged
      </h2>
      <div className="space-y-2">
        {entries.map((entry) => {
          const mergedAt = entry.pr.mergedAt === null ? null : toDate(entry.pr.mergedAt);
          const daysLeft =
            mergedAt === null ? 0 : 7 - Math.floor((Date.now() - mergedAt.getTime()) / 86_400_000);
          return (
            <div
              key={entry.pr.ref.number}
              className="flex items-center justify-between gap-4 rounded-lg border border-border bg-surface/60 px-4 py-2.5"
            >
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/pr/$owner/$repo/$number",
                    params: {
                      owner: entry.pr.ref.owner,
                      repo: entry.pr.ref.repo,
                      number: String(entry.pr.ref.number),
                    },
                  })
                }
                className="flex min-w-0 cursor-pointer items-center gap-2.5 text-left"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-done" aria-hidden />
                <span className="truncate text-[14px] text-muted">{entry.pr.title}</span>
                <span className="shrink-0 font-mono text-[12px] text-faint">
                  #{entry.pr.ref.number}
                </span>
              </button>
              <div className="flex shrink-0 items-center gap-3 text-[12px] text-faint">
                {entry.journey?.complete === true && (
                  <span className="text-muted">Journey finished — every line seen</span>
                )}
                {mergedAt !== null && (
                  <span>
                    merged {relativeTime(mergedAt)} · {countdown(daysLeft)}
                  </span>
                )}
                <button
                  type="button"
                  aria-label="Dismiss"
                  title="Dismiss"
                  onClick={() => dismiss(entry.pr.ref)}
                  className="cursor-pointer rounded p-1 transition-colors hover:bg-raised hover:text-foreground"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The quieter of the two doors. It exists for the pull request that is not in
 * your list — a public repository you want to try Throughline on, a one-off.
 */
function PasteDoor() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const ref = parsePrUrl(value);
    if (ref === null) {
      setError("That doesn’t look like a GitHub pull request URL.");
      return;
    }
    setError(null);
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: { owner: ref.owner, repo: ref.repo, number: String(ref.number) },
    });
  };

  return (
    <div className="mt-12 max-w-2xl">
      <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3">
        <span className="text-faint" aria-hidden>
          ⌕
        </span>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          placeholder="Review a PR that isn’t in your list — paste its URL"
          className="min-w-0 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-faint focus:outline-none"
        />
        <Button onClick={submit} disabled={value.trim().length === 0}>
          Open
        </Button>
      </div>
      {error !== null && <p className="mt-2 text-[12px] text-muted">{error}</p>}
    </div>
  );
}

const NUMBERS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

function spell(value: number): string {
  return NUMBERS[value] ?? String(value);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
