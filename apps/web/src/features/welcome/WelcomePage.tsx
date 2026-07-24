import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import type { PrRef, PrSummary, Viewer } from "@app/contracts";

import {
  CheckIcon,
  ChevronRightIcon,
  EyeOffIcon,
  LinkIcon,
  RefreshIcon,
  XIcon,
} from "../../components/Icons.tsx";
import { connectionAtoms } from "../../state/connection.ts";
import { productAtoms } from "../../state/product.ts";
import { effectiveHarnessKind } from "../settings/model.ts";
import {
  buildWelcomeSections,
  journeyListState,
  parsePullRequestUrl,
  RECENT_MERGED_WINDOW_MS,
  samePullRequestIdentity,
  waitingReviewCount,
  type WelcomePullRequest,
} from "./model.ts";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});
const DAY_MS = 24 * 60 * 60 * 1_000;

export function WelcomePage() {
  const connection = useAtomValue(connectionAtoms.state);
  const viewer = useAtomValue(productAtoms.viewer);
  const viewerResult = useAtomValue(productAtoms.viewerResult);
  const pullRequestList = useAtomValue(productAtoms.pullRequestList);
  const pullRequestListResult = useAtomValue(productAtoms.pullRequestListResult);
  const localPrState = useAtomValue(productAtoms.localPrState);
  const settings = useAtomValue(productAtoms.settings);
  const harnesses = useAtomValue(productAtoms.harnesses);
  const harnessStatusResult = useAtomValue(productAtoms.harnessStatusResult);
  const refreshHarnessesResult = useAtomValue(productAtoms.refreshHarnesses);
  const refreshResult = useAtomValue(productAtoms.refreshPullRequests);
  const retryGitHubResult = useAtomValue(productAtoms.retryGitHub);
  const startResult = useAtomValue(productAtoms.startIngestion);

  const refreshPullRequests = useAtomSet(productAtoms.refreshPullRequests);
  const refreshHarnesses = useAtomSet(productAtoms.refreshHarnesses);
  const retryGitHub = useAtomSet(productAtoms.retryGitHub);
  const startIngestion = useAtomSet(productAtoms.startIngestion);
  const setReviewed = useAtomSet(productAtoms.setReviewed);
  const setHidden = useAtomSet(productAtoms.setHidden);
  const dismissMerged = useAtomSet(productAtoms.setDismissedMerged);
  const navigate = useNavigate();
  const [pendingUrlPr, setPendingUrlPr] = useState<PrRef | null>(null);

  const now = pullRequestList.refreshedAt ?? DateTime.nowUnsafe();
  const sections = useMemo(
    () => buildWelcomeSections(pullRequestList.pullRequests, localPrState, now),
    [localPrState, now, pullRequestList.pullRequests],
  );
  const waiting = waitingReviewCount(sections);
  const canReadGitHub = connection.phase === "connected" && viewer?.auth === "authenticated";
  const hasUsableHarness = effectiveHarnessKind(harnesses, settings.harness) !== null;
  const canAnalyze = canReadGitHub && hasUsableHarness;

  useEffect(() => {
    if (!canReadGitHub) {
      return;
    }

    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") {
        refreshPullRequests(undefined);
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canReadGitHub, refreshPullRequests]);

  useEffect(() => {
    if (connection.phase !== "connected") {
      return;
    }

    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") {
        refreshHarnesses(undefined);
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [connection.phase, refreshHarnesses]);

  useEffect(() => {
    if (pendingUrlPr === null) {
      return;
    }
    if (AsyncResult.isFailure(startResult)) {
      setPendingUrlPr(null);
      return;
    }
    const started = Option.getOrNull(AsyncResult.value(startResult));
    if (started === null || !samePullRequestIdentity(started.pr, pendingUrlPr)) {
      return;
    }
    setPendingUrlPr(null);
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: {
        owner: started.pr.owner,
        repo: started.pr.repo,
        number: String(started.pr.number),
      },
    });
  }, [navigate, pendingUrlPr, startResult]);

  const openPullRequest = (pullRequest: PrSummary, forceIngestion = false) => {
    if (forceIngestion || pullRequest.journey === null) {
      if (!canAnalyze) {
        return;
      }
      startIngestion({ type: "ref", ref: pullRequest.ref });
    }
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: {
        owner: pullRequest.ref.owner,
        repo: pullRequest.ref.repo,
        number: String(pullRequest.ref.number),
      },
    });
  };

  return (
    <main className="welcome-page">
      <section className="welcome-intro" aria-labelledby="welcome-heading">
        <div>
          <p className="date-line">{DATE_FORMAT.format(DateTime.toDate(now))}</p>
          <h1 id="welcome-heading">
            {waiting === 0
              ? "Your review desk is clear"
              : `${waiting} ${waiting === 1 ? "review" : "reviews"} waiting`}
          </h1>
          <p className="welcome-summary">
            {describeReviewLandscape(sections.repositories.flatMap((group) => group.pullRequests))}
            {" Everything here is local — GitHub is never written to."}
          </p>
        </div>
        <button
          className="icon-button refresh-button"
          type="button"
          aria-label="Refresh pull requests"
          title="Refresh pull requests"
          disabled={!canReadGitHub || refreshResult.waiting}
          onClick={() => refreshPullRequests(undefined)}
        >
          <RefreshIcon className={refreshResult.waiting ? "is-spinning" : undefined} />
        </button>
      </section>

      <DoorStates
        connectionPhase={connection.phase}
        connectionError={connection.lastError}
        viewer={viewer}
        viewerFailed={AsyncResult.isFailure(viewerResult)}
        pullRequestsFailed={
          AsyncResult.isFailure(pullRequestListResult)
            ? causeMessage(pullRequestListResult.cause)
            : null
        }
        harnessesReady={AsyncResult.isSuccess(harnessStatusResult)}
        hasUsableHarness={hasUsableHarness}
        harnessRefreshWaiting={refreshHarnessesResult.waiting}
        retryWaiting={retryGitHubResult.waiting}
        onRefreshHarnesses={() => refreshHarnesses(undefined)}
        onRetry={() => retryGitHub(undefined)}
      />

      {AsyncResult.isFailure(startResult) ? (
        <p className="action-error" role="alert">
          {causeMessage(startResult.cause)}
        </p>
      ) : null}

      {canReadGitHub && !pullRequestList.ready ? (
        <LoadingReviews />
      ) : (
        <div className="review-sections">
          {sections.repositories.length === 0 ? (
            <section className="empty-reviews">
              <p className="eyebrow">Open pull requests</p>
              <h2>Nothing is waiting here.</h2>
              <p>Paste a GitHub pull request below when you want to start a journey.</p>
            </section>
          ) : (
            sections.repositories.map((repository) => (
              <section className="repository-section" key={repository.key}>
                <h2>
                  <span>{repository.owner}</span>
                  <span aria-hidden> / </span>
                  <strong>{repository.repo}</strong>
                </h2>
                <div className="pull-request-list">
                  {repository.pullRequests.map((row) => (
                    <PullRequestRow
                      key={row.pullRequest.url}
                      row={row}
                      canAnalyze={canAnalyze}
                      onOpen={() => openPullRequest(row.pullRequest)}
                      onReanalyze={() => openPullRequest(row.pullRequest, true)}
                      onReviewed={() =>
                        setReviewed({
                          pr: row.pullRequest.ref,
                          active: !row.reviewed,
                        })
                      }
                      onHide={() => setHidden({ pr: row.pullRequest.ref, active: true })}
                    />
                  ))}
                </div>
              </section>
            ))
          )}

          {sections.merged.length > 0 ? (
            <section className="merged-section" aria-labelledby="merged-heading">
              <h2 id="merged-heading">Merged recently</h2>
              <div className="merged-list">
                {sections.merged.map((row) => (
                  <CompactPullRequestRow
                    key={row.pullRequest.url}
                    row={row}
                    status={mergedRetentionLabel(row.pullRequest, now)}
                    onOpen={
                      row.pullRequest.journey === null && !canAnalyze
                        ? null
                        : () => openPullRequest(row.pullRequest)
                    }
                    dismissLabel="Dismiss permanently"
                    onDismiss={() => dismissMerged({ pr: row.pullRequest.ref, active: true })}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {sections.saved.length > 0 ? (
            <section className="merged-section" aria-labelledby="saved-heading">
              <h2 id="saved-heading">Saved journeys</h2>
              <div className="merged-list">
                {sections.saved.map((row) => (
                  <CompactPullRequestRow
                    key={row.pullRequest.url}
                    row={row}
                    status={savedJourneyLabel(row.pullRequest, now)}
                    onOpen={() => openPullRequest(row.pullRequest)}
                    dismissLabel="Hide saved journey"
                    onDismiss={() => setHidden({ pr: row.pullRequest.ref, active: true })}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <PullRequestUrlDoor
        disabled={!canAnalyze || startResult.waiting}
        onOpen={(url, pr) => {
          const existing = pullRequestList.pullRequests.find(
            (pullRequest) =>
              pullRequest.journey !== null && samePullRequestIdentity(pullRequest.ref, pr),
          );
          if (existing !== undefined) {
            void navigate({
              to: "/pr/$owner/$repo/$number",
              params: {
                owner: existing.ref.owner,
                repo: existing.ref.repo,
                number: String(existing.ref.number),
              },
            });
            return;
          }
          setPendingUrlPr(pr);
          startIngestion({ type: "url", url });
        }}
      />
    </main>
  );
}

function DoorStates({
  connectionPhase,
  connectionError,
  viewer,
  viewerFailed,
  pullRequestsFailed,
  harnessesReady,
  hasUsableHarness,
  harnessRefreshWaiting,
  retryWaiting,
  onRefreshHarnesses,
  onRetry,
}: {
  readonly connectionPhase: "idle" | "connecting" | "connected" | "reconnecting" | "blocked";
  readonly connectionError: string | null;
  readonly viewer: Viewer | null;
  readonly viewerFailed: boolean;
  readonly pullRequestsFailed: string | null;
  readonly harnessesReady: boolean;
  readonly hasUsableHarness: boolean;
  readonly harnessRefreshWaiting: boolean;
  readonly retryWaiting: boolean;
  readonly onRefreshHarnesses: () => void;
  readonly onRetry: () => void;
}) {
  if (connectionPhase !== "connected") {
    return (
      <DoorBanner
        title={
          connectionPhase === "blocked"
            ? "The local connection is parked"
            : "Connecting to your local server"
        }
      >
        {connectionError ??
          "Throughline will restore your review desk as soon as the local server is ready."}
      </DoorBanner>
    );
  }

  if (viewer?.auth === "unavailable") {
    return (
      <DoorBanner
        title="GitHub CLI is not available"
        actionLabel={retryWaiting ? "Checking…" : "Check again"}
        actionDisabled={retryWaiting}
        onAction={onRetry}
      >
        Install <code>gh</code>, sign in, then return here. Throughline uses only the repositories
        your existing GitHub CLI login can read.
      </DoorBanner>
    );
  }

  if (viewer?.auth === "unauthenticated") {
    return (
      <DoorBanner
        title="Sign in through GitHub CLI"
        actionLabel={retryWaiting ? "Checking…" : "Check again"}
        actionDisabled={retryWaiting}
        onAction={onRetry}
      >
        Run <code>gh auth login</code> in a terminal, then retry. Throughline does not create a
        separate account or request broader access.
      </DoorBanner>
    );
  }

  if (viewerFailed || pullRequestsFailed !== null) {
    return (
      <DoorBanner
        title="GitHub reads are paused"
        actionLabel={retryWaiting ? "Retrying…" : "Retry"}
        actionDisabled={retryWaiting}
        onAction={onRetry}
      >
        {pullRequestsFailed ??
          "Throughline could not read your GitHub identity. Nothing will retry until you ask."}
      </DoorBanner>
    );
  }

  if (harnessesReady && !hasUsableHarness) {
    return (
      <DoorBanner
        title="Choose an analysis harness"
        actionLabel={harnessRefreshWaiting ? "Checking…" : "Check again"}
        actionDisabled={harnessRefreshWaiting}
        onAction={onRefreshHarnesses}
      >
        Journeys need a signed-in selected harness.{" "}
        <Link className="text-link" to="/settings">
          Choose one in settings
        </Link>
        .
      </DoorBanner>
    );
  }

  return null;
}

function DoorBanner({
  title,
  children,
  actionLabel,
  actionDisabled = false,
  onAction,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly actionLabel?: string;
  readonly actionDisabled?: boolean;
  readonly onAction?: () => void;
}) {
  return (
    <aside className="door-banner">
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
      {actionLabel !== undefined && onAction !== undefined ? (
        <button
          className="button button-secondary"
          type="button"
          disabled={actionDisabled}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </aside>
  );
}

function LoadingReviews() {
  return (
    <section className="loading-reviews" aria-label="Loading pull requests" aria-busy="true">
      <span />
      <span />
      <span />
    </section>
  );
}

function PullRequestRow({
  row,
  canAnalyze,
  onOpen,
  onReanalyze,
  onReviewed,
  onHide,
}: {
  readonly row: WelcomePullRequest;
  readonly canAnalyze: boolean;
  readonly onOpen: () => void;
  readonly onReanalyze: () => void;
  readonly onReviewed: () => void;
  readonly onHide: () => void;
}) {
  const { pullRequest, reviewed } = row;
  const state = journeyListState(pullRequest.journey);

  return (
    <article className="pull-request-row" data-reviewed={reviewed || undefined}>
      <div className="pull-request-main">
        <button
          className="pull-request-title"
          type="button"
          disabled={pullRequest.journey === null && !canAnalyze}
          onClick={onOpen}
        >
          <span>{pullRequest.title}</span>
          <span className="pull-request-number">#{pullRequest.ref.number}</span>
        </button>
        <p className="pull-request-meta">
          {pullRequest.author.login} · updated {relativeTime(pullRequest.updatedAt)} ·{" "}
          {pullRequest.changedFiles} {pullRequest.changedFiles === 1 ? "file" : "files"} ·{" "}
          <span>+{pullRequest.additions.toLocaleString()}</span>{" "}
          <span>−{pullRequest.deletions.toLocaleString()}</span>
        </p>
      </div>

      <div className="pull-request-state">
        <JourneyState
          pullRequest={pullRequest}
          state={state}
          canAnalyze={canAnalyze}
          onOpen={onOpen}
          onReanalyze={onReanalyze}
        />
      </div>

      <div className="row-actions" aria-label={`Local actions for ${pullRequest.title}`}>
        <button className="quiet-action" type="button" onClick={onReviewed}>
          <CheckIcon />
          {reviewed ? "Marked reviewed" : "Mark reviewed"}
        </button>
        <button className="quiet-action" type="button" onClick={onHide}>
          <EyeOffIcon />
          Hide
        </button>
      </div>
    </article>
  );
}

function JourneyState({
  pullRequest,
  state,
  canAnalyze,
  onOpen,
  onReanalyze,
}: {
  readonly pullRequest: PrSummary;
  readonly state: ReturnType<typeof journeyListState>;
  readonly canAnalyze: boolean;
  readonly onOpen: () => void;
  readonly onReanalyze: () => void;
}) {
  const journey = pullRequest.journey;

  if (journey === null) {
    return (
      <button className="row-primary-action" type="button" disabled={!canAnalyze} onClick={onOpen}>
        Start journey
        <ChevronRightIcon />
      </button>
    );
  }

  if (state === "stale") {
    return (
      <div className="journey-state-detail">
        <div className="stale-line">
          <span className="state-label">Stale</span>
          <span>pinned to {journey.pinnedHeadSha.slice(0, 7)} · PR moved ahead</span>
          <button
            className="button button-secondary button-small"
            type="button"
            disabled={!canAnalyze}
            onClick={onReanalyze}
          >
            Reanalyze
          </button>
        </div>
        <ProgressThroughline progress={journey.progress} label="Previous journey progress" />
      </div>
    );
  }

  const label =
    state === "complete"
      ? "Journey finished — every home seen"
      : state === "reading"
        ? `Reading · ${journey.markedFiles} of ${journey.clusterFiles} files`
        : "Journey ready";

  return (
    <button className="journey-progress-button" type="button" onClick={onOpen}>
      <span>{label}</span>
      <ProgressThroughline progress={journey.progress} label={label} />
    </button>
  );
}

function ProgressThroughline({
  progress,
  label,
}: {
  readonly progress: number;
  readonly label: string;
}) {
  return (
    <span className="progress-throughline">
      <progress
        className="sr-only"
        aria-label={label}
        max={100}
        value={Math.round(progress * 100)}
      />
      {[0, 1, 2, 3, 4].map((segment) => {
        const segmentProgress = Math.min(1, Math.max(0, progress * 5 - segment));
        return (
          <svg key={segment} aria-hidden viewBox="0 0 100 3" preserveAspectRatio="none">
            <rect className="progress-segment-track" width="100" height="3" />
            <rect className="progress-segment-value" width={segmentProgress * 100} height="3" />
          </svg>
        );
      })}
    </span>
  );
}

function CompactPullRequestRow({
  row,
  status,
  onOpen,
  dismissLabel,
  onDismiss,
}: {
  readonly row: WelcomePullRequest;
  readonly status: string;
  readonly onOpen: (() => void) | null;
  readonly dismissLabel: string;
  readonly onDismiss: () => void;
}) {
  const { pullRequest } = row;
  const title = (
    <>
      <span>{pullRequest.title}</span>
      <span className="pull-request-number">#{pullRequest.ref.number}</span>
    </>
  );

  return (
    <article className="merged-row">
      <span className="merged-mark" aria-hidden />
      {onOpen === null ? (
        <p className="merged-title">{title}</p>
      ) : (
        <button className="merged-title" type="button" onClick={onOpen}>
          {title}
        </button>
      )}
      <p className="merged-status">{status}</p>
      <button
        className="icon-button merged-dismiss"
        type="button"
        aria-label={`${dismissLabel}: ${pullRequest.title}`}
        title={dismissLabel}
        onClick={onDismiss}
      >
        <XIcon />
      </button>
    </article>
  );
}

function PullRequestUrlDoor({
  disabled,
  onOpen,
}: {
  readonly disabled: boolean;
  readonly onOpen: (url: string, pr: NonNullable<ReturnType<typeof parsePullRequestUrl>>) => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="url-door"
      onSubmit={(event) => {
        event.preventDefault();
        const pr = parsePullRequestUrl(draft);
        if (pr === null) {
          setError("Paste a GitHub pull request URL, such as github.com/owner/repo/pull/42.");
          return;
        }
        setError(null);
        onOpen(draft.trim(), pr);
      }}
    >
      <LinkIcon aria-hidden />
      <label className="sr-only" htmlFor="pull-request-url">
        GitHub pull request URL
      </label>
      <input
        id="pull-request-url"
        type="url"
        inputMode="url"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (error !== null) {
            setError(null);
          }
        }}
        placeholder="Review a PR that isn’t in your list — paste its URL"
        aria-describedby={error === null ? undefined : "pull-request-url-error"}
        aria-invalid={error !== null}
        disabled={disabled}
      />
      <button
        className="button button-secondary"
        type="submit"
        disabled={disabled || draft.trim().length === 0}
      >
        Open
      </button>
      {error === null ? null : (
        <p id="pull-request-url-error" className="url-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function describeReviewLandscape(rows: ReadonlyArray<WelcomePullRequest>): string {
  let active = 0;
  let stale = 0;
  let fresh = 0;

  for (const row of rows) {
    const state = journeyListState(row.pullRequest.journey);
    if (state === "reading") {
      active += 1;
    } else if (state === "stale") {
      stale += 1;
    } else if (state === "not-analyzed" || state === "ready") {
      fresh += 1;
    }
  }

  const parts = [
    active > 0 ? `${active} mid-journey` : null,
    stale > 0 ? `${stale} stale` : null,
    fresh > 0 ? `${fresh} new` : null,
  ].filter((part): part is string => part !== null);

  return parts.length === 0 ? "" : `${parts.join(", ")}.`;
}

function relativeTime(at: DateTime.Utc): string {
  const age = DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(at);
  if (age < 60 * 60 * 1_000) {
    const minutes = Math.max(1, Math.floor(age / (60 * 1_000)));
    return `${minutes}m ago`;
  }
  if (age < DAY_MS) {
    return `${Math.floor(age / (60 * 60 * 1_000))}h ago`;
  }
  const days = Math.floor(age / DAY_MS);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function mergedRetentionLabel(pullRequest: PrSummary, now: DateTime.Utc): string {
  if (pullRequest.mergedAt === null) {
    return "merged recently";
  }
  const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(pullRequest.mergedAt);
  const remaining = Math.max(0, Math.ceil((RECENT_MERGED_WINDOW_MS - age) / DAY_MS));
  const mergedDays = Math.max(0, Math.floor(age / DAY_MS));
  const merged = mergedDays === 0 ? "merged today" : `merged ${mergedDays}d ago`;
  const leaves =
    remaining === 0
      ? "leaves today"
      : remaining === 1
        ? "leaves tomorrow"
        : `leaves in ${remaining} days`;
  const journey = pullRequest.journey?.progress === 1 ? "Journey finished · " : "";
  return `${journey}${merged} · ${leaves}`;
}

function savedJourneyLabel(pullRequest: PrSummary, now: DateTime.Utc): string {
  const journey = pullRequest.journey?.progress === 1 ? "Journey finished" : "Journey saved";
  if (pullRequest.state !== "merged" || pullRequest.mergedAt === null) {
    return `${journey} · pull request closed`;
  }
  const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(pullRequest.mergedAt);
  const days = Math.max(0, Math.floor(age / DAY_MS));
  return `${journey} · merged ${days === 0 ? "today" : `${days}d ago`}`;
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request did not complete. Try again when you’re ready.";
}
