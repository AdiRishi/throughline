import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useMemo, useState } from "react";

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
}: {
  readonly pr: PullRequestSummary;
  readonly job: IngestionJob | undefined;
  readonly localState: LocalPrState;
  readonly onAnalyze: (pr: PrRef) => void;
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
        {pr.journey.exists || job?.phase.type === "complete" ? (
          <Link
            to="/journey/$owner/$repo/$number"
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
        ) : (
          <button
            className="text-action"
            onClick={() => onAnalyze(pr.ref)}
            disabled={job !== undefined && job.phase.type !== "failed"}
          >
            Build journey →
          </button>
        )}
      </div>
    </article>
  );
}

export function WelcomeScreen() {
  const pullRequestView = useAtomValue(productAtoms.pullRequests);
  const ingestion = useAtomValue(productAtoms.ingestion);
  const viewerResult = useAtomValue(productAtoms.viewer);
  const prStateResult = useAtomValue(productAtoms.prState);
  const startIngestion = useAtomSet(productAtoms.startIngestion);
  const refresh = useAtomSet(productAtoms.refreshPullRequests);
  const [url, setUrl] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const localState = AsyncResult.isSuccess(prStateResult)
    ? prStateResult.value
    : { reviewed: [], hidden: [], dismissedMerged: [] };

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

  const analyze = (pr: PrRef) => startIngestion({ pr });
  const jobFor = (pr: PrRef) =>
    ingestion.jobs.find((job) => samePr(job.pr, pr) && job.phase.type !== "cancelled");

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

      {addOpen && (
        <form
          className="add-pr"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) startIngestion({ url: url.trim() });
          }}
        >
          <label htmlFor="pr-url">GitHub pull request URL</label>
          <div>
            <input
              id="pr-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/owner/repository/pull/42"
              autoFocus
            />
            <button className="primary-button">Build journey</button>
          </div>
        </form>
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
            />
          ))}
        </section>
      )}
    </main>
  );
}
