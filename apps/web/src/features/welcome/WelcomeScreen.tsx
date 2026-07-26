import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { GitHubHealth, HarnessReport, HarnessStatus, PrRef, Viewer } from "@app/contracts";

import {
  dismissMergedAtom,
  harnessReportAtom,
  prListAtom,
  refKey,
  refreshPrsAtom,
  setHiddenAtom,
  setReviewedAtom,
  startIngestionAtom,
} from "../../state/journeyState.ts";
import { Fact, Notice, QuietButton } from "../../ui/primitives.tsx";
import { MergedRow } from "./MergedRow.tsx";
import { PrRow } from "./PrRow.tsx";
import { UrlDoor } from "./UrlDoor.tsx";
import { canSeeGitHub, doorDetail, summarize, type DoorFailure } from "./welcomeCopy.ts";

/**
 * The front door: an overview of the reviewer's review world.
 *
 * Its job is orientation, not throughput — what is waiting, what I am
 * mid-journey on, what is done — so it opens the way a person opens their day: a
 * date, one honest sentence about the state of the list, then the list itself
 * grouped by repository. A tidy desk, not a dashboard.
 *
 * Three shaping rules:
 *
 * - **Nothing polls.** The list is a snapshot-then-live stream, and the only
 *   things that ask GitHub for a fresh one are window focus and the reviewer's own
 *   Refresh. That is the whole freshness model, so focus is wired here rather than
 *   left to a timer somewhere.
 * - **Parked states sit above the list, as instructions.** A missing `gh`, an
 *   exhausted quota, no usable harness — each has a remedy, and the remedy is the
 *   content. They are Notices in the calm tone: the accent colour is reserved for
 *   emphasis of a cluster's hunks and is not spent on alarm here.
 * - **The door answers before it navigates.** Opening a PR starts (or joins)
 *   ingestion and only then routes to the journey, so a door rejection is a
 *   sentence on this screen instead of a transition that can never begin.
 *
 * @module features/welcome/WelcomeScreen
 */

export function WelcomeScreen() {
  const snapshot = useAtomValue(prListAtom);
  const harnessResult = useAtomValue(harnessReportAtom);
  const navigate = useNavigate();

  const refreshPrs = useAtomSet(refreshPrsAtom, { mode: "promiseExit" });
  const setReviewed = useAtomSet(setReviewedAtom, { mode: "promiseExit" });
  const setHidden = useAtomSet(setHiddenAtom, { mode: "promiseExit" });
  const dismissMerged = useAtomSet(dismissMergedAtom, { mode: "promiseExit" });
  const startIngestion = useAtomSet(startIngestionAtom, { mode: "promiseExit" });

  /** A failed local mark or a rejected door, said out loud. Never swallowed. */
  const [note, setNote] = useState<ScreenNote | null>(null);
  /** Which row is waiting on the server, so its door can say so. */
  const [opening, setOpening] = useState<string | null>(null);

  /**
   * Every verb on this screen can fail, and each failure has to name the verb it
   * belongs to — a rejected mark described as a rejected door would be worse than
   * silence. The wire `detail` is the only explanation; we add the subject.
   */
  const report = useCallback(
    (title: string) =>
      (exit: Exit.Exit<unknown, DoorFailure>): boolean => {
        if (Exit.isSuccess(exit)) return true;
        setNote({ title, detail: doorDetail(exit.cause) });
        return false;
      },
    [],
  );

  /**
   * A refresh the reviewer asked for says so when it fails. A refresh triggered by
   * window focus never does.
   *
   * The distinction is not cosmetic. Focus arrives at moments the reviewer did not
   * choose — including the instant the shell shows its window, while the socket is
   * still opening — and an error attributed to nothing they did is worse than
   * silence, especially when the very next thing to happen is the connection coming
   * up with a fresh snapshot. Everything a silent failure could have reported is
   * already on this screen anyway: a missing `gh`, an exhausted quota, and an
   * unreachable server are all states of the snapshot, drawn by ParkedNotices.
   */
  const refresh = useCallback(
    (explicit: boolean) =>
      void refreshPrs().then((exit) => {
        if (explicit) report("Throughline could not refresh from GitHub")(exit);
      }),
    [refreshPrs, report],
  );

  /**
   * Refresh on focus. Focus and the reviewer's own Refresh are the *only* two
   * triggers — nothing polls — so this listener is half the freshness model. The
   * server enforces its own minimum interval and refuses outright while parked,
   * which is why the renderer may ask on every focus without debouncing here.
   *
   * The wrapper matters: handing `refresh` to the listener directly would pass it
   * the focus event, and every event object is truthy — every focus would report.
   */
  useEffect(() => {
    const onFocus = () => refresh(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const openJourney = useCallback(
    async (ref: PrRef, reanalyze: boolean): Promise<void> => {
      setNote(null);
      setOpening(refKey(ref));
      const started = await startIngestion({ ref, reanalyze });
      setOpening(null);
      if (!report("Throughline could not open that pull request")(started)) return;
      void navigate({
        to: "/pr/$owner/$repo/$number",
        params: { owner: ref.owner, repo: ref.repo, number: String(ref.number) },
      });
    },
    [startIngestion, navigate, report],
  );

  if (snapshot === null) {
    return (
      <Shell viewer={null} refreshing={false} onRefresh={() => refresh(true)}>
        <p className="tl-fade text-[13px] text-muted">Reading your pull requests from gh…</p>
      </Shell>
    );
  }

  const summary = summarize(snapshot);
  const harness = AsyncResult.isSuccess(harnessResult) ? harnessResult.value : null;
  // A repository whose every PR was hidden arrives as a group with no entries; a
  // heading with nothing under it reads as a loading failure, so it is dropped
  // here rather than trusted not to happen.
  const groups = snapshot.groups.filter((group) => group.entries.length > 0);

  return (
    <Shell
      viewer={snapshot.viewer}
      refreshing={snapshot.refreshing}
      onRefresh={() => refresh(true)}
    >
      <div className="tl-rise">
        <p className="text-[13px] text-muted">{summary.today}</p>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight">{summary.headline}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{summary.subtitle}</p>
      </div>

      <ParkedNotices
        viewer={snapshot.viewer}
        github={snapshot.github}
        harness={harness}
        note={note}
        onDismissNote={() => setNote(null)}
      />

      {groups.length === 0 ? (
        <EmptyList canSee={canSeeGitHub(snapshot)} />
      ) : (
        groups.map((group) => (
          <section key={`${group.owner}/${group.repo}`} className="mt-8">
            <h2 className="font-mono text-[11px] tracking-[0.14em] text-faint uppercase">
              {group.owner} / {group.repo}
            </h2>
            <ul className="mt-3 space-y-2">
              {group.entries.map((entry) => {
                const ref = entry.pr.ref;
                return (
                  <PrRow
                    key={refKey(ref)}
                    entry={entry}
                    opening={opening === refKey(ref)}
                    onOpen={() => void openJourney(ref, false)}
                    onReanalyze={() => void openJourney(ref, true)}
                    onToggleReviewed={() =>
                      void setReviewed({ ref, value: !entry.reviewed }).then(
                        report("Throughline could not save that mark"),
                      )
                    }
                    onHide={() =>
                      void setHidden({ ref, value: true }).then(
                        report("Throughline could not hide that pull request"),
                      )
                    }
                  />
                );
              })}
            </ul>
          </section>
        ))
      )}

      {snapshot.merged.length > 0 && (
        <section className="mt-8">
          <h2 className="font-mono text-[11px] tracking-[0.14em] text-faint uppercase">Merged</h2>
          <ul className="mt-3 space-y-2">
            {snapshot.merged.map((entry) => (
              <MergedRow
                key={refKey(entry.pr.ref)}
                entry={entry}
                onDismiss={() =>
                  void dismissMerged(entry.pr.ref).then(
                    report("Throughline could not dismiss that pull request"),
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}

      <UrlDoor />
    </Shell>
  );
}

/**
 * The slim title bar and the reading column. A title bar rather than a heading
 * because the two controls that belong to the *app* rather than to the list —
 * refresh and settings — should never sit inside the reviewer's content.
 */
function Shell({
  viewer,
  refreshing,
  onRefresh,
  children,
}: {
  readonly viewer: Viewer | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-5">
        <span className="text-[13px] font-semibold tracking-tight">Throughline</span>
        {/* Ambient fact first, then the two controls, as the design orders it:
            who Throughline is looking through, then what can be done about it. */}
        <div className="flex items-center gap-4">
          {viewer !== null && <Fact>{describeViewer(viewer)}</Fact>}
          {/* A word, not an icon: refresh is half the freshness model, so its
              state has to be readable without hovering anything. */}
          <button
            type="button"
            id="refresh-prs"
            onClick={onRefresh}
            disabled={refreshing}
            className="cursor-pointer text-[12px] text-muted transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <Link
            id="open-settings"
            to="/settings"
            aria-label="Settings"
            className="text-faint transition-colors hover:text-foreground"
          >
            <GearGlyph />
          </Link>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[900px] px-8 pt-12 pb-24">{children}</div>
      </main>
    </div>
  );
}

/**
 * Every parked state, above the list, in the order a reviewer would hit them:
 * can Throughline see GitHub at all, can it ask right now, and can it analyze
 * when asked. All in the calm tone — these have remedies, so they are
 * instructions, not alarms.
 */
function ParkedNotices({
  viewer,
  github,
  harness,
  note,
  onDismissNote,
}: {
  readonly viewer: Viewer;
  readonly github: GitHubHealth;
  readonly harness: HarnessReport | null;
  readonly note: ScreenNote | null;
  readonly onDismissNote: () => void;
}) {
  const showViewer = viewer.auth !== "authenticated";
  const showParked = github.status === "parked";
  const showFailing = github.status === "failing" && github.detail !== null;
  const showHarness = harness !== null && harness.active === null;

  if (!showViewer && !showParked && !showFailing && !showHarness && note === null) return null;

  return (
    <div className="mt-8 space-y-3">
      {showViewer && (
        <Notice
          title={
            viewer.auth === "missing"
              ? "The GitHub CLI was not found"
              : "The GitHub CLI is not signed in"
          }
        >
          {/* `detail` is authored setup instruction; it is shown verbatim. The
              fallback has to be a remedy too — a parked state with no way out is
              the one thing this Notice must never be. */}
          {spoken(
            viewer.detail,
            viewer.auth === "missing"
              ? "Install the GitHub CLI, then run gh auth login. Throughline reads your pull requests through it and shows exactly what that login can see."
              : "Run gh auth login in a terminal, then refresh. Throughline shows exactly what that login can see.",
          )}
        </Notice>
      )}

      {showParked && (
        <Notice title="GitHub’s request quota is exhausted">
          {spoken(
            github.detail,
            "Throughline has stopped asking GitHub until the quota resets. Nothing — not even a refresh — sends a request before then.",
          )}
          {github.resetAt !== null && (
            <p className="mt-1">
              <Fact>resets at {formatReset(github.resetAt)}</Fact>
            </p>
          )}
        </Notice>
      )}

      {showFailing && <Notice title="gh could not reach GitHub">{github.detail}</Notice>}

      {showHarness && (
        <Notice title="No analysis harness is available">
          <p>
            Throughline analyzes with your own local agent harness, riding your own login. Nothing
            usable was found.
          </p>
          {harness.harnesses.length > 0 && (
            <ul className="mt-2 space-y-1">
              {harness.harnesses.map((status) => (
                <li key={status.kind}>
                  <span className="font-mono text-[12px]">{status.label}</span>{" "}
                  {spoken(status.detail, describeHarness(status))}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2">
            <Link
              to="/settings"
              className="underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-current"
            >
              Settings
            </Link>{" "}
            lists every harness Throughline can find.
          </p>
        </Notice>
      )}

      {note !== null && (
        <Notice
          title={note.title}
          action={
            <QuietButton id="dismiss-note" onClick={onDismissNote}>
              Dismiss
            </QuietButton>
          }
        >
          {note.detail}
        </Notice>
      )}
    </div>
  );
}

/**
 * An empty list is a designed state: it says what will appear here and points at
 * the other door, so the app never looks broken to someone who simply has no open
 * pull requests today.
 *
 * `canSee` splits the two reasons the list can be empty. "No open pull requests"
 * is a claim about GitHub, and Throughline is only entitled to make it when it
 * could actually ask; otherwise the empty list is about Throughline, and saying so
 * is what keeps this screen from reporting a fact it does not have.
 */
function EmptyList({ canSee }: { readonly canSee: boolean }) {
  return (
    <div className="mt-8 rounded-lg border border-dashed border-border px-5 py-10 text-center">
      <p className="text-[13px] font-medium">
        {canSee ? "No open pull requests" : "Nothing to list yet"}
      </p>
      <p className="mx-auto mt-2 max-w-[440px] text-[13px] leading-relaxed text-muted">
        {canSee
          ? "Open pull requests your gh login can see appear here, grouped by repository. Paste a URL below to review one that isn’t in your list."
          : "Open pull requests your gh login can see appear here, grouped by repository. Once Throughline can reach GitHub again, this fills in on the next refresh."}
      </p>
    </div>
  );
}

/**
 * A failure, with the verb it belongs to. Two fields rather than one string
 * because the wire only ever supplies the explanation; naming the subject is this
 * screen's job, and getting it wrong misattributes the failure.
 */
interface ScreenNote {
  readonly title: string;
  readonly detail: string;
}

/**
 * A wire `detail` is authored copy when it exists, so it wins outright — but the
 * field is a plain string and an empty one would leave a Notice with a title and
 * no remedy, which is the one thing a parked state must never be.
 */
function spoken(detail: string | null, fallback: string): string {
  return detail !== null && detail.trim().length > 0 ? detail : fallback;
}

/**
 * Why one harness cannot be used, from `installed` and `auth` together — a
 * probe that could not determine sign-in is its own answer and must not be
 * reported as "not signed in".
 */
function describeHarness(status: HarnessStatus): string {
  if (!status.installed) return "is not installed";
  if (status.auth === "unauthenticated") return "is installed but not signed in";
  if (status.auth === "unknown")
    return "is installed; Throughline could not confirm it is signed in";
  return "is installed but not usable right now";
}

function describeViewer(viewer: Viewer): string {
  if (viewer.auth === "missing") return "gh not found";
  if (viewer.auth === "unauthenticated") return "gh not signed in";
  return viewer.login === null ? "authenticated via gh" : `@${viewer.login} · authenticated via gh`;
}

/**
 * Local wall-clock, because "when can I ask again" is a question about now. The
 * weekday appears only when the reset is not today — a bare time would otherwise
 * read as "soon" when it is not.
 */
function formatReset(resetAt: DateTime.Utc): string {
  const date = DateTime.toDate(resetAt);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString(
    undefined,
    today
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  );
}

function GearGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden
    >
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
    </svg>
  );
}
