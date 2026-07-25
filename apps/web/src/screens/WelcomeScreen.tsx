import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useEffect, useMemo, useState } from "react";

import type { IngestionJob, LocalPrState, PrRef, PullRequestSummary } from "@app/contracts";

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
      return `Queued · ${job.phase.position}`;
    case "analyzing":
      return `${job.phase.stage === "planning" ? "Mapping" : "Writing"} · ${job.phase.detail.action}`;
    case "complete":
      return "Journey ready";
    case "failed":
      return job.phase.detail;
    default:
      return job.phase.type;
  }
}

const INGESTION_STAGES = [
  "Resolve pull request",
  "Clone pinned head",
  "Read changed code",
  "Map the journey",
  "Write the narrative",
  "Validate coverage",
  "Save locally",
] as const;

function phaseIndex(job: IngestionJob): number {
  switch (job.phase.type) {
    case "queued":
    case "resolving":
      return 0;
    case "cloning":
      return 1;
    case "diffing":
      return 2;
    case "analyzing":
      return job.phase.stage === "planning" ? 3 : 4;
    case "validating":
      return 5;
    case "saving":
    case "complete":
      return 6;
    default:
      return -1;
  }
}

function IngestionTransition({
  job,
  title,
  onCancel,
  onRetry,
}: {
  readonly job: IngestionJob;
  readonly title: string;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
}) {
  const current = phaseIndex(job);
  return (
    <section className={`ingestion-transition ${job.phase.type}`} aria-live="polite">
      <header>
        <div>
          <p className="eyebrow">Building a journey</p>
          <h2>{title}</h2>
          <p>
            {job.pr.owner}/{job.pr.repo} · #{job.pr.number}
          </p>
        </div>
        {job.phase.type === "failed" ? (
          <button className="secondary-button" onClick={onRetry}>
            Try again
          </button>
        ) : (
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </header>
      {job.phase.type === "failed" ? (
        <div className="ingestion-failure">
          <strong>The run stopped.</strong>
          <p>{job.phase.detail}</p>
        </div>
      ) : (
        <>
          <ol>
            {INGESTION_STAGES.map((stage, index) => (
              <li
                key={stage}
                className={index < current ? "complete" : index === current ? "active" : ""}
              >
                <span>{index < current ? "✓" : String(index + 1).padStart(2, "0")}</span>
                {stage}
              </li>
            ))}
          </ol>
          {job.phase.type === "analyzing" && (
            <div className="ingestion-activity">
              <strong>{job.phase.detail.action}</strong>
              <div>
                <span>{job.phase.detail.filesWalked} files walked</span>
                <span>{job.phase.detail.symbolsTraced} symbols traced</span>
                <span>{job.phase.detail.callSitesFollowed} call sites followed</span>
              </div>
              {job.phase.detail.recent.length > 0 && (
                <ul>
                  {job.phase.detail.recent.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <p className="ingestion-leave-note">
            You can leave this screen. Throughline will keep the run safe and resumable here.
          </p>
        </>
      )}
    </section>
  );
}

function ProgressBar({ pr }: { readonly pr: PullRequestSummary }) {
  const percentage =
    pr.journey.totalHunks === 0
      ? 0
      : Math.round((pr.journey.readHunks / pr.journey.totalHunks) * 100);
  return (
    <span className="progress-inline" aria-label={`${percentage}% read`}>
      <span style={{ width: `${percentage}%` }} />
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
  return (
    <article className={`pr-row ${reviewed ? "reviewed" : ""}`}>
      <div className="pr-author" aria-hidden>
        {pr.author.avatarUrl ? (
          <img src={pr.author.avatarUrl} alt="" />
        ) : (
          pr.author.login.slice(0, 1).toUpperCase()
        )}
      </div>
      <div className="pr-main">
        <div className="pr-title-line">
          <span className="pr-number">#{pr.ref.number}</span>
          <h3>{pr.title}</h3>
          {pr.isDraft && <span className="quiet-tag">Draft</span>}
          {pr.journey.stale && <span className="stale-tag">Update available</span>}
        </div>
        <p className="pr-meta">
          {pr.author.login} · {pr.changedFiles} files ·{" "}
          <span className="added">+{pr.additions}</span>{" "}
          <span className="deleted">−{pr.deletions}</span>
        </p>
        {job && job.phase.type !== "complete" && (
          <div className={`ingestion-strip ${job.phase.type}`}>
            <span className="spinner" aria-hidden />
            <span>{phaseLabel(job)}</span>
          </div>
        )}
      </div>
      <div className="pr-action">
        <div className="pr-local-actions">
          <button onClick={() => onUpdateState("reviewed", pr.ref, !reviewed)}>
            {reviewed ? "Undo reviewed" : "Mark reviewed"}
          </button>
          <button onClick={() => onUpdateState("hidden", pr.ref, true)}>Hide</button>
        </div>
        {pr.journey.exists || job?.phase.type === "complete" ? (
          <div className="journey-actions">
            <Link
              to="/pr/$owner/$repo/$number"
              params={{
                owner: pr.ref.owner,
                repo: pr.ref.repo,
                number: String(pr.ref.number),
              }}
              className="text-action"
            >
              {pr.journey.readHunks > 0 ? "Continue" : "Begin"}
              <ProgressBar pr={pr} />
            </Link>
            {pr.journey.stale && (
              <button
                className="text-action rebuild-action"
                onClick={() => onAnalyze(pr.ref)}
                disabled={job !== undefined && job.phase.type !== "failed"}
              >
                Rebuild →
              </button>
            )}
          </div>
        ) : (
          <button
            className="text-action"
            onClick={() => onAnalyze(pr.ref)}
            disabled={job !== undefined && job.phase.type !== "failed"}
          >
            Build journey →
          </button>
        )}
        {onDismiss !== undefined && (
          <button className="text-action dismiss-action" onClick={() => onDismiss(pr.ref)}>
            Dismiss
          </button>
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
  const cancelIngestion = useAtomSet(productAtoms.cancelIngestion);
  const refresh = useAtomSet(productAtoms.refreshPullRequests);
  const [url, setUrl] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [pendingPr, setPendingPr] = useState<PrRef | null>(null);
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
    setPendingPr(pr);
    startIngestion({ pr });
  };
  const jobFor = (pr: PrRef) =>
    ingestion.jobs.find((job) => samePr(job.pr, pr) && job.phase.type !== "cancelled");
  const transitionJob =
    ingestion.jobs.find(
      (job) =>
        job.phase.type !== "complete" &&
        job.phase.type !== "cancelled" &&
        job.phase.type !== "failed",
    ) ?? ingestion.jobs.find((job) => job.phase.type === "failed");
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

  return (
    <main className="welcome-page">
      <section className="welcome-heading">
        <div>
          <p className="eyebrow">Review desk</p>
          <h1>Pull requests, made readable.</h1>
          <p>
            Welcome back{viewer.name ? `, ${viewer.name.split(" ")[0]}` : ""}. Pick up a journey or
            map a new change.
          </p>
        </div>
        <div className="welcome-actions">
          <button className="secondary-button" onClick={() => refresh()}>
            Refresh
          </button>
          <button className="primary-button" onClick={() => setAddOpen((value) => !value)}>
            Add pull request
          </button>
        </div>
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

      {addOpen && (
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
            startIngestion({ url: trimmed });
          }}
        >
          <label htmlFor="pr-url">GitHub pull request URL</label>
          <div>
            <input
              id="pr-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repository/pull/42"
            />
            <button className="primary-button">Build journey</button>
          </div>
        </form>
      )}

      {AsyncResult.isFailure(startResult) && (
        <div className="state-error">{String(startResult.cause)}</div>
      )}

      {transitionJob && (
        <IngestionTransition
          job={transitionJob}
          title={transitionPr?.title ?? `Pull request #${transitionJob.pr.number}`}
          onCancel={() => {
            setPendingPr(null);
            cancelIngestion(transitionJob.id);
          }}
          onRetry={() => analyze(transitionJob.pr)}
        />
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
          <h2>Recently merged</h2>
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
    </main>
  );
}
