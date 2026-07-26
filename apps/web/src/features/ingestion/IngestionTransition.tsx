/**
 * The transition: what is actually happening, while it happens.
 *
 * Every line on this screen comes from the job stream. There is no invented
 * progress because there is no other data source — the stages shown are a
 * grouped view of the pipeline's real phases, the activity lines are observed
 * harness events, and the counters are derived from those events and nothing
 * else. That is why there is no percentage: none exists.
 *
 * @module features/ingestion/IngestionTransition
 */
import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";

import type { IngestionJob, IngestionPhase, PrRef } from "@app/contracts";

import { ingestionActions } from "../../state/ingestion.ts";
import { Button, formatCount } from "../../ui/primitives.tsx";

type StageState = "pending" | "active" | "done";

interface Stage {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly state: StageState;
  readonly trail: ReadonlyArray<string>;
  readonly current: string | null;
}

/**
 * Three stages, grouped from the job's real phases. The grouping lives here —
 * in the renderer — precisely so the wire keeps carrying what happened rather
 * than what we chose to show.
 */
function stagesFor(job: IngestionJob): ReadonlyArray<Stage> {
  const order: ReadonlyArray<IngestionPhase> = [
    "queued",
    "resolving",
    "cloning",
    "diffing",
    "analyzing",
    "validating",
    "saving",
    "complete",
  ];
  const at = order.indexOf(job.phase);
  const reached = (phase: IngestionPhase) => at >= order.indexOf(phase);

  const activity = job.activity;
  const planning = job.phase === "analyzing" && activity?.stage === "plan";
  const narrating =
    (job.phase === "analyzing" && activity?.stage === "narrate") ||
    job.phase === "validating" ||
    job.phase === "saving";

  const cloneDetail =
    job.facts.headSha === null
      ? "Fetching the pull request’s head and the base it targets"
      : `${job.facts.headSha.slice(0, 7)} and its base` +
        (job.facts.worktreeFiles === null
          ? ""
          : ` — ${formatCount(job.facts.worktreeFiles)} files on disk`);

  const readDetail =
    job.facts.changedFiles === null
      ? "Walking the diff and the code around it"
      : `Walking the diff and the code around it — ${formatCount(job.facts.changedFiles)} changed files` +
        (job.facts.additions === null || job.facts.deletions === null
          ? ""
          : `, +${formatCount(job.facts.additions)} −${formatCount(job.facts.deletions)}`) +
        ", and the modules they land in";

  const constructDetail =
    activity?.clustersTotal == null
      ? "Ordering the clusters; writing each one’s narrative"
      : `Writing each cluster’s narrative — ${activity.clustersDone ?? 0} of ${activity.clustersTotal}`;

  return [
    {
      key: "clone",
      title: "Cloning the repository",
      detail: cloneDetail,
      state: reached("analyzing") ? "done" : reached("cloning") ? "active" : "pending",
      current: null,
      trail: [],
    },
    {
      key: "read",
      title: "Reading the change",
      detail: readDetail,
      state: narrating || reached("validating") ? "done" : planning ? "active" : "pending",
      current: planning ? formatLine(activity?.current) : null,
      trail: planning ? (activity?.trail ?? []).map(formatLine) : [],
    },
    {
      key: "construct",
      title: "Constructing the journey",
      detail: constructDetail,
      state: job.phase === "complete" ? "done" : narrating ? "active" : "pending",
      current: narrating ? formatLine(activity?.current) : null,
      trail: narrating ? (activity?.trail ?? []).map(formatLine) : [],
    },
  ];
}

function formatLine(
  line: { readonly verb: string; readonly detail: string } | null | undefined,
): string {
  if (line === null || line === undefined) return "";
  return `${line.verb} ${line.detail}`.trim();
}

export function IngestionTransition({
  pr,
  title,
  job,
  onStart,
  starting,
}: {
  readonly pr: PrRef;
  readonly title: string | null;
  readonly job: IngestionJob | null;
  readonly onStart: (() => void) | undefined;
  readonly starting: boolean;
}) {
  const cancel = useAtomSet(ingestionActions.cancel);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 pt-16 pb-24">
        <header className="tl-enter">
          <p className="font-mono text-[13px] text-muted">
            {pr.owner}/{pr.repo} · #{pr.number}
            {job?.facts.headSha != null && (
              <>
                {" "}
                · head <span className="text-foreground">{job.facts.headSha.slice(0, 7)}</span>
              </>
            )}
          </p>
          <h1 className="mt-2 text-[26px] font-semibold tracking-tight">
            {title ?? job?.title ?? "Opening this pull request"}
          </h1>
        </header>

        {job === null ? (
          <StartPrompt onStart={onStart} starting={starting} />
        ) : job.phase === "failed" ? (
          <FailureState job={job} onRetry={onStart} />
        ) : job.phase === "cancelled" ? (
          <CancelledState onRetry={onStart} />
        ) : (
          <RunningState job={job} onCancel={() => cancel(job.jobId)} />
        )}
      </div>
    </div>
  );
}

function StartPrompt({
  onStart,
  starting,
}: {
  readonly onStart?: (() => void) | undefined;
  readonly starting: boolean;
}) {
  return (
    <div className="tl-enter mt-10">
      <p className="max-w-xl text-[14px] leading-relaxed text-muted">
        Throughline hasn’t analyzed this pull request yet. Analysis clones the repository, reads the
        change and the code around it, and constructs a journey you can walk to the end.
      </p>
      <div className="mt-5 flex items-center gap-3">
        <Button tone="primary" onClick={onStart} disabled={starting || onStart === undefined}>
          {starting ? "Starting…" : "Analyze this pull request"}
        </Button>
        <Link to="/" className="text-[13px] text-muted transition-colors hover:text-foreground">
          Back
        </Link>
      </div>
    </div>
  );
}

function RunningState({
  job,
  onCancel,
}: {
  readonly job: IngestionJob;
  readonly onCancel: () => void;
}) {
  const stages = stagesFor(job);
  const counters = job.activity?.counters ?? null;

  return (
    <>
      {job.queuePosition > 0 && (
        <p className="mt-8 text-[13px] text-muted">
          Waiting for another analysis to finish — one runs at a time, because they are heavy.
        </p>
      )}

      <ol className="mt-10 space-y-1">
        {stages.map((stage, index) => (
          <StageRow key={stage.key} stage={stage} last={index === stages.length - 1} />
        ))}
      </ol>

      {counters !== null && (
        <div className="mt-10 flex gap-12 border-t border-border pt-6">
          <Counter
            value={`${formatCount(counters.filesWalked)}`}
            of={counters.filesTotal > 0 ? formatCount(counters.filesTotal) : undefined}
            label="files walked"
          />
          <Counter value={formatCount(counters.symbolsTraced)} label="symbols traced" />
          <Counter value={formatCount(counters.callSitesFollowed)} label="call sites followed" />
        </div>
      )}

      <div className="mt-8 rounded-lg border border-border bg-surface px-5 py-4">
        <p className="text-[14px] leading-relaxed text-muted">
          A change this size takes a few minutes to read properly. You can leave — the journey opens
          when you come back. These stages are the real ones; there is no percentage because none
          exists.
        </p>
        {job.activity !== null && job.activity.repairRounds > 0 && (
          <p className="mt-2 text-[13px] text-faint">
            {job.activity.repairRounds} correction round
            {job.activity.repairRounds === 1 ? "" : "s"} so far — the checker found something and
            asked for a fix.
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          <Link to="/" className="text-[13px] text-muted transition-colors hover:text-foreground">
            ← Leave it running
          </Link>
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer text-[13px] text-faint transition-colors hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

function StageRow({ stage, last }: { readonly stage: Stage; readonly last: boolean }) {
  return (
    <li className="flex gap-4">
      <div className="flex w-5 shrink-0 flex-col items-center">
        <span
          className={`mt-1 flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
            stage.state === "done"
              ? "border-border-strong bg-raised text-foreground"
              : stage.state === "active"
                ? "border-accent"
                : "border-border"
          }`}
        >
          {stage.state === "done" ? (
            <span className="text-[10px]">✓</span>
          ) : stage.state === "active" ? (
            <span className="tl-pulse h-[7px] w-[7px] rounded-full bg-accent" />
          ) : null}
        </span>
        {!last && (
          <span
            className={`mt-1 w-px flex-1 ${
              stage.state === "done"
                ? "bg-border-strong"
                : stage.state === "active"
                  ? "tl-trace"
                  : "bg-border"
            }`}
          />
        )}
      </div>

      <div className={`min-w-0 pb-8 ${stage.state === "pending" ? "opacity-45" : ""}`}>
        <p className="text-[15px] font-semibold tracking-tight">{stage.title}</p>
        <p className="mt-1 text-[14px] leading-relaxed text-muted">{stage.detail}</p>
        {stage.current !== null && stage.current.length > 0 && (
          <p className="mt-3 truncate font-mono text-[12px] text-foreground">now {stage.current}</p>
        )}
        {stage.trail
          .filter((line) => line.length > 0)
          .map((line, index) => (
            <p
              // eslint-disable-next-line react/no-array-index-key -- the trail is positional
              key={index}
              className="truncate font-mono text-[12px] text-faint"
              style={{ opacity: 1 - index * 0.22 }}
            >
              {line}
            </p>
          ))}
      </div>
    </li>
  );
}

function Counter({
  value,
  of,
  label,
}: {
  readonly value: string;
  readonly of?: string | undefined;
  readonly label: string;
}) {
  return (
    <div>
      <p className="text-[22px] font-semibold tracking-tight tabular-nums">
        {value}
        {of !== undefined && <span className="text-faint"> / {of}</span>}
      </p>
      <p className="mt-0.5 text-[12px] text-muted">{label}</p>
    </div>
  );
}

function FailureState({
  job,
  onRetry,
}: {
  readonly job: IngestionJob;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="tl-enter mt-10">
      <div className="rounded-lg border border-border bg-surface px-5 py-4">
        <p className="text-[15px] font-semibold tracking-tight">
          {job.failure?.message ?? "The run stopped."}
        </p>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          This stopped while {phaseGerund(job.failure?.phase ?? job.phase)}. It is an operational
          fault, not a verdict about the change — running it again is the remedy.
        </p>
        {job.failure !== null && job.failure.detail.length > 0 && (
          <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-raised p-3 font-mono text-[12px] whitespace-pre-wrap text-muted">
            {job.failure.detail}
          </pre>
        )}
        <div className="mt-4 flex items-center gap-3">
          <Button tone="primary" onClick={onRetry} disabled={onRetry === undefined}>
            Try again
          </Button>
          <Link to="/" className="text-[13px] text-muted transition-colors hover:text-foreground">
            Back
          </Link>
        </div>
      </div>
    </div>
  );
}

function CancelledState({ onRetry }: { readonly onRetry?: (() => void) | undefined }) {
  return (
    <div className="tl-enter mt-10">
      <p className="text-[14px] text-muted">
        You cancelled this run. Nothing was saved — a journey is written in one piece, at the end.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <Button tone="primary" onClick={onRetry} disabled={onRetry === undefined}>
          Analyze again
        </Button>
        <Link to="/" className="text-[13px] text-muted transition-colors hover:text-foreground">
          Back
        </Link>
      </div>
    </div>
  );
}

function phaseGerund(phase: IngestionPhase): string {
  switch (phase) {
    case "resolving":
      return "resolving the pull request";
    case "cloning":
      return "cloning the repository";
    case "diffing":
      return "reading the diff";
    case "analyzing":
      return "constructing the journey";
    case "validating":
      return "checking coverage";
    case "saving":
      return "saving the journey";
    default:
      return "starting up";
  }
}
