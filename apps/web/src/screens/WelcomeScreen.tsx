import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Check, MagnifyingGlass, X } from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect, useMemo, useState } from "react";

import type { IngestionJob, LocalPrState, PrRef, PullRequestSummary } from "@app/contracts";

import { BackButton, WindowControls } from "../components/AppChrome.tsx";
import { productAtoms } from "../state/product.ts";

function samePr(left: PrRef, right: PrRef): boolean {
  return left.owner === right.owner && left.repo === right.repo && left.number === right.number;
}

function isIn(refs: ReadonlyArray<PrRef>, ref: PrRef): boolean {
  return refs.some((candidate) => samePr(candidate, ref));
}

function phaseLabel(job: IngestionJob): string {
  switch (job.phase.type) {
    case "queued":
      return `Queued · ${job.phase.position} ahead`;
    case "analyzing":
      return job.phase.detail.action;
    case "complete":
      return "Journey ready";
    case "failed":
      return job.phase.detail;
    default:
      return job.phase.type;
  }
}

function phaseIndex(job: IngestionJob): number {
  switch (job.phase.type) {
    case "queued":
    case "resolving":
    case "cloning":
      return 0;
    case "diffing":
      return 1;
    case "analyzing":
      return job.phase.stage === "planning" ? 1 : 2;
    case "validating":
    case "saving":
    case "complete":
      return 2;
    default:
      return -1;
  }
}

function IngestionTransition({
  job,
  pullRequest,
  onLeave,
  onRetry,
}: {
  readonly job: IngestionJob;
  readonly pullRequest: PullRequestSummary | undefined;
  readonly onLeave: () => void;
  readonly onRetry: () => void;
}) {
  const current = phaseIndex(job);
  const title = pullRequest?.title ?? `Pull request #${job.pr.number}`;
  const head = pullRequest?.headSha.slice(0, 7);
  const repository = `${job.pr.owner}/${job.pr.repo}`;
  const stages = [
    {
      title: "Cloning the repository",
      detail: `${repository}${head ? ` at ${head}` : ""} and its base — pinned locally`,
    },
    {
      title: "Reading the change",
      detail: pullRequest
        ? `Walking the diff and the code around it — ${pullRequest.changedFiles} changed files, +${pullRequest.additions.toLocaleString()} −${pullRequest.deletions.toLocaleString()}`
        : "Walking the diff and the code around it",
    },
    {
      title: "Constructing the journey",
      detail: "Ordering the clusters; writing each one’s narrative",
    },
  ];
  return (
    <main className={`ingestion-page ${job.phase.type}`} aria-live="polite">
      <header className="ingestion-chrome">
        <div>
          <WindowControls />
          <BackButton onClick={onLeave} />
        </div>
        <span>
          {repository} #{job.pr.number}
        </span>
      </header>
      <section className="ingestion-transition">
        <header>
          <p>
            {repository} · #{job.pr.number}
            {head ? ` · head ${head}` : ""}
          </p>
          <h1>{title}</h1>
        </header>
        {job.phase.type === "failed" ? (
          <div className="ingestion-failure">
            <strong>The run stopped.</strong>
            <p>{job.phase.detail}</p>
            <button className="secondary-button" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <ol>
              {stages.map((stage, index) => (
                <li
                  key={stage.title}
                  className={index < current ? "complete" : index === current ? "active" : ""}
                >
                  <span className="ingestion-marker">
                    {index < current && <Check size={12} weight="bold" />}
                  </span>
                  <div>
                    <strong>{stage.title}</strong>
                    <p>{stage.detail}</p>
                    {index === current && job.phase.type === "analyzing" && (
                      <div className="ingestion-activity">
                        <strong>{job.phase.detail.action}</strong>
                        {job.phase.detail.recent.length > 0 && (
                          <ul>
                            {job.phase.detail.recent.slice(0, 3).map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {job.phase.type === "analyzing" && (
              <div className="ingestion-counts">
                <div>
                  <strong>{job.phase.detail.filesWalked}</strong>
                  <span>files walked</span>
                </div>
                <div>
                  <strong>{job.phase.detail.symbolsTraced}</strong>
                  <span>symbols traced</span>
                </div>
                <div>
                  <strong>{job.phase.detail.callSitesFollowed}</strong>
                  <span>call sites followed</span>
                </div>
              </div>
            )}
            <p className="ingestion-leave-note">
              A change this size takes a few minutes to read properly. You can leave — the journey
              opens when you come back. These stages are the real ones; there is no percentage
              because none exists.
            </p>
          </>
        )}
      </section>
    </main>
  );
}

function relativeTime(value: DateTime.Utc): string {
  const elapsed = Math.max(0, Date.now() - DateTime.toEpochMillis(value));
  const hours = Math.floor(elapsed / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function mergedExpiry(value: DateTime.Utc | null): string {
  if (value === null) return "leaves within a week";
  const remaining = Math.max(
    0,
    Math.ceil((DateTime.toEpochMillis(value) + 7 * 86_400_000 - Date.now()) / 86_400_000),
  );
  if (remaining === 0) return "leaves today";
  if (remaining === 1) return "leaves tomorrow";
  return `leaves in ${remaining} days`;
}

function ProgressBar({ pr }: { readonly pr: PullRequestSummary }) {
  const percentage =
    pr.journey.totalHunks === 0
      ? 0
      : Math.round((pr.journey.readHunks / pr.journey.totalHunks) * 100);
  return (
    <span className="progress-inline" aria-label={`${percentage}% read`}>
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className={percentage >= (index + 1) * 20 ? "complete" : ""} />
      ))}
    </span>
  );
}

function PrRow({
  pr,
  job,
  localState,
  onAnalyze,
  onDismiss,
  onUpdateState,
}: {
  readonly pr: PullRequestSummary;
  readonly job: IngestionJob | undefined;
  readonly localState: LocalPrState;
  readonly onAnalyze: (pr: PrRef) => void;
  readonly onDismiss?: (pr: PrRef) => void;
  readonly onUpdateState: (kind: "reviewed" | "hidden", pr: PrRef, value: boolean) => void;
}) {
  const reviewed = isIn(localState.reviewed, pr.ref);
  if (pr.state === "merged") {
    return (
      <article className="pr-row merged">
        <div>
          <span className="merged-dot" aria-hidden />
          <h3>{pr.title}</h3>
          <span className="pr-number">#{pr.ref.number}</span>
        </div>
        <div className="merged-state">
          {pr.journey.exists && <span>Journey finished — every line seen</span>}
          <span>
            merged {pr.mergedAt === null ? "recently" : relativeTime(pr.mergedAt)} ·{" "}
            {mergedExpiry(pr.mergedAt)}
          </span>
          {onDismiss !== undefined && (
            <button aria-label={`Dismiss ${pr.title}`} onClick={() => onDismiss(pr.ref)}>
              <X size={12} weight="bold" />
            </button>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className={`pr-row ${reviewed ? "reviewed" : ""} ${pr.journey.stale ? "stale" : ""}`}>
      <div className="pr-main">
        <div className="pr-title-line">
          <h3>{pr.title}</h3>
          <span className="pr-number">#{pr.ref.number}</span>
          {pr.isDraft && <span className="quiet-tag">Draft</span>}
        </div>
        <p className="pr-meta">
          {pr.author.login} · opened {relativeTime(pr.updatedAt)} · {pr.changedFiles} files ·{" "}
          <span className="added">+{pr.additions.toLocaleString()}</span>{" "}
          <span className="deleted">−{pr.deletions.toLocaleString()}</span>
        </p>
        {job && job.phase.type !== "complete" && (
          <div className={`ingestion-strip ${job.phase.type}`}>
            <span className="spinner" aria-hidden />
            <span>{phaseLabel(job)}</span>
          </div>
        )}
      </div>
      <div className="pr-action">
        {pr.journey.exists || job?.phase.type === "complete" ? (
          <div className="journey-actions">
            {pr.journey.stale && <span className="stale-tag">Stale</span>}
            <Link
              to="/pr/$owner/$repo/$number"
              params={{
                owner: pr.ref.owner,
                repo: pr.ref.repo,
                number: String(pr.ref.number),
              }}
              className="journey-progress-action"
            >
              <span>
                {pr.journey.stale
                  ? "Journey pinned to an older head"
                  : pr.journey.readHunks > 0
                    ? `${Math.min(pr.journey.readHunks, pr.journey.totalHunks)} of ${pr.journey.totalHunks} hunks read`
                    : "Open journey"}
              </span>
              <ProgressBar pr={pr} />
            </Link>
            {pr.journey.stale && (
              <button
                className="secondary-button rebuild-action"
                onClick={() => onAnalyze(pr.ref)}
                disabled={job !== undefined && job.phase.type !== "failed"}
              >
                Reanalyze
              </button>
            )}
          </div>
        ) : (
          <>
            <span className="not-analyzed">Not analyzed</span>
            <div className="pr-local-actions">
              <button onClick={() => onUpdateState("reviewed", pr.ref, !reviewed)}>
                {reviewed ? "Undo reviewed" : "Mark reviewed"}
              </button>
              <button onClick={() => onUpdateState("hidden", pr.ref, true)}>Hide</button>
              <button
                className="open-journey"
                onClick={() => onAnalyze(pr.ref)}
                disabled={job !== undefined && job.phase.type !== "failed"}
              >
                Open journey
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

export function WelcomeScreen() {
  const navigate = useNavigate();
  const pullRequestView = useAtomValue(productAtoms.pullRequests);
  const pullRequestsResult = useAtomValue(productAtoms.pullRequestsResult);
  const ingestion = useAtomValue(productAtoms.ingestion);
  const viewerResult = useAtomValue(productAtoms.viewer);
  const harnessesResult = useAtomValue(productAtoms.harnesses);
  const prStateResult = useAtomValue(productAtoms.prState);
  const [prStateUpdateResult, updatePrState] = useAtom(productAtoms.updatePrState);
  const [startResult, startIngestion] = useAtom(productAtoms.startIngestion);
  const refresh = useAtomSet(productAtoms.refreshPullRequests);
  const [url, setUrl] = useState("");
  const [pendingPr, setPendingPr] = useState<PrRef | null>(null);
  const [hiddenTransitionId, setHiddenTransitionId] = useState<string | null>(null);
  const localState = AsyncResult.isSuccess(prStateUpdateResult)
    ? prStateUpdateResult.value
    : AsyncResult.isSuccess(prStateResult)
      ? prStateResult.value
      : { reviewed: [], hidden: [], dismissedMerged: [] };

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    if (pendingPr === null) return;
    const complete = ingestion.jobs.find(
      (job) => samePr(job.pr, pendingPr) && job.phase.type === "complete",
    );
    if (complete === undefined) return;
    setPendingPr(null);
    navigate({
      to: "/pr/$owner/$repo/$number",
      params: {
        owner: complete.pr.owner,
        repo: complete.pr.repo,
        number: String(complete.pr.number),
      },
    });
  }, [ingestion.jobs, navigate, pendingPr]);

  const visible = pullRequestView.pullRequests.filter(
    (pr) =>
      !isIn(localState.hidden, pr.ref) &&
      !(pr.state === "merged" && isIn(localState.dismissedMerged, pr.ref)),
  );
  const open = visible.filter((pr) => pr.state === "open");
  const merged = visible.filter((pr) => pr.state === "merged");
  const repositories = useMemo(() => {
    const grouped = new Map<string, Array<PullRequestSummary>>();
    for (const pr of open) {
      const name = `${pr.ref.owner}/${pr.ref.repo}`;
      grouped.set(name, [...(grouped.get(name) ?? []), pr]);
    }
    return [...grouped];
  }, [open]);

  const analyze = (pr: PrRef) => {
    setHiddenTransitionId(null);
    setPendingPr(pr);
    startIngestion({ pr });
  };
  const jobFor = (pr: PrRef) =>
    ingestion.jobs.find((job) => samePr(job.pr, pr) && job.phase.type !== "cancelled");
  const transitionJob =
    ingestion.jobs.find(
      (job) =>
        job.id !== hiddenTransitionId &&
        job.phase.type !== "complete" &&
        job.phase.type !== "cancelled" &&
        job.phase.type !== "failed",
    ) ?? ingestion.jobs.find((job) => job.id !== hiddenTransitionId && job.phase.type === "failed");
  const transitionPr = transitionJob
    ? pullRequestView.pullRequests.find((pr) => samePr(pr.ref, transitionJob.pr))
    : undefined;

  if (!AsyncResult.isSuccess(viewerResult)) {
    return <main className="journey-loading">Connecting to GitHub…</main>;
  }

  const viewer = viewerResult.value;
  if (viewer.state !== "authenticated") {
    return (
      <main className="welcome-page setup-page">
        <p className="eyebrow">Local setup</p>
        <h1>Connect GitHub to begin.</h1>
        <p>
          Throughline reads pull requests through the GitHub CLI and keeps every artifact on this
          machine.
        </p>
        <pre>gh auth login</pre>
        <button className="primary-button" onClick={() => refresh()}>
          Check again
        </button>
      </main>
    );
  }
  const harnesses = AsyncResult.isSuccess(harnessesResult) ? harnessesResult.value : [];
  const analysisReady = AsyncResult.isSuccess(harnessesResult)
    ? harnesses.some((harness) => harness.auth === "authenticated")
    : null;
  if (transitionJob) {
    return (
      <IngestionTransition
        job={transitionJob}
        pullRequest={transitionPr}
        onLeave={() => {
          setPendingPr(null);
          setHiddenTransitionId(transitionJob.id);
        }}
        onRetry={() => analyze(transitionJob.pr)}
      />
    );
  }
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date());

  return (
    <main className="welcome-page">
      <section className="welcome-heading">
        <p>{date}</p>
        <h1>
          {open.length} {open.length === 1 ? "review" : "reviews"} waiting
        </h1>
        <p>
          Pick up a journey or open a new one. Everything here is local — GitHub is never written
          to.
        </p>
      </section>

      {AsyncResult.isFailure(pullRequestsResult) && (
        <section className="setup-banner">
          <strong>GitHub is temporarily unavailable.</strong>
          <p>{String(pullRequestsResult.cause)}</p>
        </section>
      )}

      {analysisReady === false && (
        <section className="setup-banner">
          <strong>Connect an analysis harness to build journeys.</strong>
          <p>Authenticate Codex or Claude Code, then choose it in settings.</p>
          <Link to="/settings">Open settings →</Link>
        </section>
      )}

      {AsyncResult.isFailure(startResult) && (
        <div className="state-error">{String(startResult.cause)}</div>
      )}

      {!pullRequestView.ready ? (
        <div className="empty-state">Opening your review desk…</div>
      ) : repositories.length === 0 ? (
        <div className="empty-state">
          <h2>Your desk is clear.</h2>
          <p>Add an open pull request by URL to build its first journey.</p>
        </div>
      ) : (
        <div className="repo-groups">
          {repositories.map(([repository, pullRequests]) => (
            <section key={repository} className="repo-group">
              <header>
                <h2>{repository}</h2>
                <span>{pullRequests.length} open</span>
              </header>
              {pullRequests.map((pr) => (
                <PrRow
                  key={pr.url}
                  pr={pr}
                  job={jobFor(pr.ref)}
                  localState={localState}
                  onAnalyze={analyze}
                  onUpdateState={(kind, pr, value) => updatePrState({ kind, pr, value })}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      {merged.length > 0 && (
        <section className="recently-merged">
          <h2>Merged</h2>
          {merged.map((pr) => (
            <PrRow
              key={pr.url}
              pr={pr}
              job={jobFor(pr.ref)}
              localState={localState}
              onAnalyze={analyze}
              onUpdateState={(kind, pr, value) => updatePrState({ kind, pr, value })}
              onDismiss={(pr) => updatePrState({ kind: "dismissedMerged", pr, value: true })}
            />
          ))}
        </section>
      )}

      <form
        className="add-pr"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = url.trim();
          if (!trimmed) return;
          const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(trimmed);
          if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
            setPendingPr({
              owner: match[1],
              repo: match[2],
              number: Number(match[3]),
            });
          }
          setHiddenTransitionId(null);
          startIngestion({ url: trimmed });
        }}
      >
        <MagnifyingGlass size={13} aria-hidden />
        <label htmlFor="pr-url" className="sr-only">
          GitHub pull request URL
        </label>
        <input
          id="pr-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Review a PR that isn’t in your list — paste its URL"
        />
        <button className="secondary-button">Open</button>
      </form>
    </main>
  );
}
