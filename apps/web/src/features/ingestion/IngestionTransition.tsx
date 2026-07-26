import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { AnalysisActivity, IngestionJob, PrListSnapshot, PrRef } from "@app/contracts";

import {
  cancelIngestionAtom,
  journeyAtom,
  prListAtom,
  refKey,
  startIngestionAtom,
} from "../../state/journeyState.ts";
import { DiffCounts, Notice, PrimaryButton, QuietButton, Separator } from "../../ui/primitives.tsx";

/**
 * The wait, designed.
 *
 * Ingestion takes real minutes on a real pull request, and this screen is the
 * first thing the product ever shows a reviewer — so it is a narration, not a
 * spinner. Three commitments from `docs/product/02-ingestion.md` decide every
 * choice here:
 *
 * 1. **It narrates what is actually happening.** The three stages are a *grouped
 *    view of the job's own phases* — nothing else. Cloning covers
 *    queued/resolving/cloning, reading covers diffing and the `plan` analysis
 *    stage, constructing covers the `narrate` stage plus validating and saving.
 *    Each stage's detail is assembled from fields the server actually sent
 *    (`headSha`, `filesOnDisk`, `changedFiles`, `additions`/`deletions`,
 *    `stageProgress`, `detail`), so a fact appears exactly when it becomes true.
 * 2. **It is honest.** There is no progress bar and no percentage anywhere,
 *    because the stream carries no such number and inventing one would be a lie
 *    told during the reviewer's first minute in the product. The one fraction on
 *    screen — narration's "3 of 7" — is real, because narration runs per cluster.
 *    The counters are the harness's own observations and keep the harness's own
 *    names; relabelling `filesRead` as anything more impressive would be a claim
 *    nobody made.
 * 3. **It is leavable.** The job lives on the server, so leaving costs nothing
 *    and the copy says so plainly.
 *
 * A failure here is *operational* — a clone, a harness, a disk — never
 * analytical. "Too tangled to decompose" is not an outcome the pipeline can
 * produce, so no copy on this surface may hint that the change defeated it.
 *
 * @module features/ingestion/IngestionTransition
 */

/** Cloning, reading, constructing: the three stages the reviewer follows. */
type StageState = "done" | "active" | "pending";

interface Stage {
  readonly title: string;
  readonly detail: ReactNode;
  readonly state: StageState;
  /** Rendered inside the stage that produced it, so the feed can't misattribute. */
  readonly extra?: ReactNode;
}

export function IngestionTransition({
  ref: prRef,
  job,
  onBack,
  onOpen,
}: {
  readonly ref: PrRef;
  readonly job: IngestionJob | null;
  readonly onBack: () => void;
  readonly onOpen: () => void;
}): ReactNode {
  const key = refKey(prRef);
  const journeyResult = useAtomValue(journeyAtom(key));
  const refreshJourney = useAtomRefresh(journeyAtom(key));
  const [startResult, start] = useAtom(startIngestionAtom);
  const cancel = useAtomSet(cancelIngestionAtom);
  const prList = useAtomValue(prListAtom);

  // The start RPC's atom is shared with the welcome screen's door, so its
  // failure is only ours to show once this surface has actually asked.
  const [startRequested, setStartRequested] = useState(false);

  const phase = job?.phase ?? null;
  const entry = findEntry(prList, prRef);

  /**
   * A journey is immutable, so `journeyAtom` is cached and never refetches on its
   * own — which means the artifact a finishing job just wrote is invisible until
   * something asks again. That ask happens here, once per settled phase: on
   * `complete`, and also when a job we watched disappears from the stream, which
   * is how a completed job that the server has already retired looks from here.
   */
  const handledPhase = useRef<string | null>(null);
  const watchedLive = useRef(false);
  useEffect(() => {
    if (phase !== null && isLive(phase)) {
      watchedLive.current = true;
      handledPhase.current = null;
      return;
    }
    if (handledPhase.current === phase) return;
    handledPhase.current = phase;
    const finished = phase === "complete" || (phase === null && watchedLive.current);
    if (!finished) return;
    watchedLive.current = false;
    refreshJourney();
    onOpen();
  }, [phase, refreshJourney, onOpen]);

  const startRun = (reanalyze: boolean) => {
    setStartRequested(true);
    start({ ref: prRef, reanalyze });
  };

  const header = (
    <TransitionHeader
      prRef={prRef}
      title={job?.prTitle ?? entry?.title ?? `Pull request #${prRef.number}`}
      headSha={job?.headSha ?? entry?.headSha ?? null}
    />
  );

  const startFailure =
    startRequested && AsyncResult.isFailure(startResult) ? messageOf(startResult.cause) : null;

  return (
    <div id="ingestion-transition" className="flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between px-3">
        <button
          type="button"
          id="ingestion-back"
          onClick={onBack}
          className="cursor-pointer rounded-md px-2 py-1 text-[13px] text-muted transition-colors hover:text-foreground"
        >
          ← Back
        </button>
        <span className="font-mono text-[12px] text-faint">
          {prRef.owner}/{prRef.repo} #{prRef.number}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[620px] flex-col justify-center gap-8 px-6 py-12">
          {header}
          {job === null ? (
            <Doorstep
              journeyMissing={AsyncResult.isFailure(journeyResult)}
              settled={AsyncResult.isNotInitial(journeyResult) && !journeyResult.waiting}
              starting={startResult.waiting}
              failure={startFailure}
              journeyFailure={
                AsyncResult.isFailure(journeyResult) && !isJourneyMissing(journeyResult.cause)
                  ? messageOf(journeyResult.cause)
                  : null
              }
              onStart={() => startRun(false)}
              onRetryLookup={refreshJourney}
            />
          ) : job.phase === "failed" ? (
            <Stopped job={job} failure={startFailure} onAnalyzeAgain={() => startRun(true)} />
          ) : job.phase === "cancelled" ? (
            <Cancelled failure={startFailure} onAnalyzeAgain={() => startRun(true)} />
          ) : (
            <Live job={job} prRef={prRef} onCancel={() => cancel(prRef)} />
          )}
        </div>
      </div>
    </div>
  );
}

/** `owner/repo · #418 · head f47c19d` over the pull request's own title. */
function TransitionHeader({
  prRef,
  title,
  headSha,
}: {
  readonly prRef: PrRef;
  readonly title: string;
  readonly headSha: string | null;
}) {
  return (
    <header className="tl-rise">
      <p className="flex items-center gap-2 font-mono text-[13px] text-muted">
        <span>
          {prRef.owner}/{prRef.repo}
        </span>
        <Separator />
        <span>#{prRef.number}</span>
        {headSha !== null && (
          <>
            <Separator />
            <span>head {shortSha(headSha)}</span>
          </>
        )}
      </p>
      <h1 className="mt-2 text-[26px] leading-[1.2] font-semibold tracking-[-0.01em]">{title}</h1>
    </header>
  );
}

/** The running job: stages, the live feed, the counters, and the leaving note. */
function Live({
  job,
  prRef,
  onCancel,
}: {
  readonly job: IngestionJob;
  readonly prRef: PrRef;
  readonly onCancel: () => void;
}) {
  const active = activeStage(job);
  const activity = job.activity;
  const stageState = (index: number): StageState =>
    index < active ? "done" : index === active ? "active" : "pending";

  // The activity payload belongs to whichever stage the analysis is in right
  // now — attributing a `narrate` feed to "reading the change" would be a lie
  // about which stage is doing the work.
  const activityBlock = (index: number): ReactNode =>
    activity !== null && job.phase === "analyzing" && stageState(index) === "active" ? (
      <ActivityFeed activity={activity} />
    ) : undefined;

  const stages: ReadonlyArray<Stage> = [
    {
      title: "Cloning the repository",
      state: stageState(0),
      detail: cloneDetail(job, prRef),
      // Cloning has no activity stream, so the server's literal one-line account
      // of the phase is the only live signal it can offer.
      extra:
        stageState(0) === "active" && job.headSha !== null && job.detail !== null ? (
          <p className="mt-2 truncate font-mono text-[12px] text-faint">{job.detail}</p>
        ) : undefined,
    },
    {
      title: "Reading the change",
      state: stageState(1),
      detail: readDetail(job),
      extra: activityBlock(1),
    },
    {
      title: "Constructing the journey",
      state: stageState(2),
      detail: constructDetail(job, stageState(2)),
      extra: activityBlock(2),
    },
  ];

  return (
    <>
      {job.phase === "queued" && <QueuedLine position={job.queuePosition} />}
      <StageList stages={stages} />
      {activity !== null && <Counters activity={activity} changedFiles={job.changedFiles} />}
      {job.phase === "complete" ? (
        <p className="tl-fade text-[13px] text-muted">The journey is ready — opening it now.</p>
      ) : (
        <>
          <p className="rounded-lg border border-border bg-card px-4 py-3.5 text-[13px] leading-relaxed text-muted">
            {job.changedFiles === null
              ? "Reading a change properly takes a few minutes."
              : "A change this size takes a few minutes to read properly."}{" "}
            You can leave — the journey opens when you come back. These stages are the real ones;
            there is no percentage because none exists.
          </p>
          <div>
            <QuietButton id="cancel-ingestion" onClick={onCancel}>
              Cancel analysis
            </QuietButton>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Analysis runs one at a time because a harness run is heavy. While queued,
 * nothing is happening yet — so every stage stays pending and this line, not a
 * breathing stage, carries the honest reason.
 */
function QueuedLine({ position }: { readonly position: number | null }) {
  return (
    <p className="tl-fade flex items-center gap-2.5 text-[13px] text-muted">
      <span className="tl-breathe h-[6px] w-[6px] shrink-0 rounded-full bg-accent" aria-hidden />
      <span>
        Queued — one analysis runs at a time.
        {position !== null &&
          ` This pull request is ${position <= 1 ? "next" : `number ${position}`} in line.`}
      </span>
    </p>
  );
}

function StageList({ stages }: { readonly stages: ReadonlyArray<Stage> }) {
  return (
    <ol id="ingestion-stages" className="tl-rise">
      {stages.map((stage, index) => {
        const last = index === stages.length - 1;
        return (
          <li key={stage.title} className="grid grid-cols-[18px_1fr] gap-x-4">
            <div className="flex flex-col items-center">
              <StageDot state={stage.state} />
              {!last && (
                <span
                  className={`relative mt-1.5 w-px flex-1 overflow-hidden ${CONNECTOR[stage.state]}`}
                  aria-hidden
                />
              )}
            </div>
            <div className={last ? "" : "pb-9"}>
              <p
                className={`text-[15px] font-semibold ${
                  stage.state === "pending" ? "text-muted" : "text-foreground"
                }`}
              >
                {stage.title}
                {/* The dot's meaning must not live in colour alone. */}
                <span className="sr-only"> — {STAGE_STATE_LABEL[stage.state]}</span>
              </p>
              {/* The live stage's detail sits a step brighter than the rest: it is
                  the one line on the rail that is currently true. */}
              <div
                className={`mt-1 text-[13px] leading-relaxed ${
                  stage.state === "active" ? "text-foreground/80" : "text-muted"
                }`}
              >
                {stage.detail}
              </div>
              {stage.extra}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const STAGE_STATE_LABEL: Record<StageState, string> = {
  done: "done",
  active: "happening now",
  pending: "not started",
};

/**
 * The rail carries the accent only as far as the run has actually got: a stretch
 * already travelled is quietly lit, the stretch leaving the live stage carries
 * the sweep, and nothing ahead of the run is coloured at all. When the last
 * stage is the live one there is no connector left to sweep, which is honest —
 * the breathing dot is the only thing still moving.
 */
const CONNECTOR: Record<StageState, string> = {
  done: "bg-accent/30",
  active: "bg-border tl-sweep",
  pending: "bg-border",
};

function StageDot({ state }: { readonly state: StageState }) {
  if (state === "done") {
    return (
      <span
        aria-hidden
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-border-strong bg-raised text-muted"
      >
        <svg
          viewBox="0 0 12 12"
          className="h-[10px] w-[10px]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 6.4 4.8 8.7 9.5 3.6" />
        </svg>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        aria-hidden
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-accent/50 bg-accent-soft"
      >
        <span className="tl-breathe h-[6px] w-[6px] rounded-full bg-accent" />
      </span>
    );
  }
  return (
    <span aria-hidden className="h-[18px] w-[18px] shrink-0 rounded-full border border-border" />
  );
}

/**
 * What the agent is doing, and what it just did. The trail fades out behind the
 * current line: it is context for reading the present one, not a log to study.
 */
function ActivityFeed({ activity }: { readonly activity: AnalysisActivity }) {
  return (
    <div className="mt-3 space-y-1">
      {activity.action !== null && (
        // Keyed by the action so each new one fades in rather than swapping text.
        <p key={activity.action} className="tl-fade truncate font-mono text-[12px]">
          <span className="text-faint">now </span>
          {activity.action}
        </p>
      )}
      {/* Driven by the fade slots rather than the trail: the display is three
          fixed positions the trail fills as far as it reaches, so neither the
          class nor the line can ever be missing. */}
      {TRAIL_FADE.map((fade, index) => {
        const line = activity.trail[index];
        if (line === undefined) return null;
        return (
          <p key={`${index}:${line}`} className={`truncate font-mono text-[12px] ${fade}`}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

/** Three lines of trail, each quieter than the last. */
const TRAIL_FADE = ["text-muted", "text-faint", "text-faint/60"] as const;

/**
 * The harness's own observations, under the harness's own names. `changedFiles`
 * is the only denominator that exists, and it belongs to exactly one of these.
 */
function Counters({
  activity,
  changedFiles,
}: {
  readonly activity: AnalysisActivity;
  readonly changedFiles: number | null;
}) {
  return (
    <div className="flex flex-wrap gap-x-10 gap-y-5 border-t border-border pt-6">
      <Counter
        value={activity.counters.changedFilesOpened}
        total={changedFiles}
        label="changed files opened"
      />
      <Counter value={activity.counters.filesRead} total={null} label="files read" />
      <Counter value={activity.counters.searchesRun} total={null} label="searches run" />
    </div>
  );
}

function Counter({
  value,
  total,
  label,
}: {
  readonly value: number;
  readonly total: number | null;
  readonly label: string;
}) {
  return (
    <div>
      {/* Sans, not mono: at this size the number is the headline of its own
          label, and `tabular-nums` is what stops it jittering as it ticks. */}
      <p className="text-[22px] leading-none font-semibold tabular-nums">
        {value.toLocaleString()}
        {total !== null && <span className="text-faint"> / {total.toLocaleString()}</span>}
      </p>
      <p className="mt-2 text-[12px] text-muted">{label}</p>
    </div>
  );
}

/**
 * No journey and no job. The remedy is the content: one sentence of what will
 * happen, and the one button that starts it. A door rejection (`gh` missing, no
 * harness, a rate limit) is shown verbatim, because the detail *is* the
 * instruction.
 */
function Doorstep({
  journeyMissing,
  settled,
  starting,
  failure,
  journeyFailure,
  onStart,
  onRetryLookup,
}: {
  readonly journeyMissing: boolean;
  readonly settled: boolean;
  readonly starting: boolean;
  readonly failure: string | null;
  readonly journeyFailure: string | null;
  readonly onStart: () => void;
  readonly onRetryLookup: () => void;
}) {
  // Until the lookup settles there is nothing true to say yet, and claiming
  // "no journey" a beat early would offer to rebuild one that already exists.
  if (!settled) {
    return <p className="tl-fade text-[13px] text-muted">Looking for this journey…</p>;
  }

  if (journeyFailure !== null) {
    return (
      <Notice
        title="This journey could not be read"
        action={
          <QuietButton id="retry-journey-lookup" onClick={onRetryLookup}>
            Try again
          </QuietButton>
        }
      >
        <p>{journeyFailure}</p>
      </Notice>
    );
  }

  return (
    <>
      <p className="tl-rise text-[13px] leading-relaxed text-muted">
        {journeyMissing ? "There is no journey for this pull request yet. " : ""}
        Throughline clones the repository, reads the change and the code around it, then constructs
        the journey — an ordered walk through every changed line, cluster by cluster.
      </p>
      {failure !== null && (
        <Notice title="Ingestion did not start" tone="attention">
          <p>{failure}</p>
        </Notice>
      )}
      <div className="tl-rise">
        <PrimaryButton id="start-ingestion" onClick={onStart} disabled={starting}>
          {starting ? "Starting…" : "Analyze this pull request"}
        </PrimaryButton>
      </div>
    </>
  );
}

/**
 * A stopped run. The message is the server's, verbatim, and the framing is
 * strictly operational — the pipeline cannot fail *analytically*, so nothing
 * here may suggest the change was too much for it.
 */
function Stopped({
  job,
  failure,
  onAnalyzeAgain,
}: {
  readonly job: IngestionJob;
  readonly failure: string | null;
  readonly onAnalyzeAgain: () => void;
}) {
  const message = job.failure?.message ?? "The run stopped.";
  const detail = job.detail !== null && job.detail !== message ? job.detail : null;
  const retryable = job.failure?.retryable ?? true;
  return (
    <>
      <Notice title="The run stopped" tone="attention">
        <p>{message}</p>
        {detail !== null && <p className="mt-2 font-mono text-[12px] text-faint">{detail}</p>}
      </Notice>
      <p className="text-[13px] leading-relaxed text-muted">
        Faults here are operational — the clone, the harness, the disk. Analyzing again starts a
        fresh run from the top.
        {retryable ? "" : " This one may need attention outside Throughline first."}
      </p>
      {failure !== null && (
        <Notice title="Ingestion did not start" tone="attention">
          <p>{failure}</p>
        </Notice>
      )}
      <div>
        {retryable ? (
          <PrimaryButton id="retry-ingestion" onClick={onAnalyzeAgain}>
            Analyze again
          </PrimaryButton>
        ) : (
          <QuietButton id="retry-ingestion" onClick={onAnalyzeAgain}>
            Analyze again
          </QuietButton>
        )}
      </div>
    </>
  );
}

/** Cancelling leaves nothing behind — persistence is one atomic write at the end. */
function Cancelled({
  failure,
  onAnalyzeAgain,
}: {
  readonly failure: string | null;
  readonly onAnalyzeAgain: () => void;
}) {
  return (
    <>
      <p className="tl-rise text-[13px] leading-relaxed text-muted">
        This analysis was cancelled, so there is no journey for this pull request. Nothing partial
        was kept — a new run starts from the top.
      </p>
      {failure !== null && (
        <Notice title="Ingestion did not start" tone="attention">
          <p>{failure}</p>
        </Notice>
      )}
      <div className="tl-rise">
        <PrimaryButton id="retry-ingestion" onClick={onAnalyzeAgain}>
          Analyze again
        </PrimaryButton>
      </div>
    </>
  );
}

// ── The phase → stage grouping ──────────────────────────────────────────────

/**
 * The one place phases become stages. `queued` deliberately returns -1: nothing
 * has started, and a breathing dot over "cloning" would claim otherwise.
 * `failed` and `cancelled` never reach here — the job stops carrying a phase to
 * place, so those states render without the stage list rather than guessing
 * where the run stopped.
 */
function activeStage(job: IngestionJob): number {
  switch (job.phase) {
    case "queued":
      return -1;
    case "resolving":
    case "cloning":
      return 0;
    case "diffing":
      return 1;
    case "analyzing":
      return job.stage === "narrate" ? 2 : 1;
    case "validating":
    case "saving":
      return 2;
    case "complete":
      return 3;
    default:
      return -1;
  }
}

function isLive(phase: string): boolean {
  return phase !== "complete" && phase !== "failed" && phase !== "cancelled";
}

/**
 * Only the machinery speaks monospace: the repository path and the sha are
 * things the reviewer can copy and check, the prose between them is not.
 */
function cloneDetail(job: IngestionJob, prRef: PrRef): ReactNode {
  const repo = <span className="font-mono">{`${prRef.owner}/${prRef.repo}`}</span>;
  if (job.headSha === null) {
    // Before the head resolves, the server's literal account is all there is —
    // and it is machinery, so it stays monospace end to end.
    if (job.detail !== null) return <span className="font-mono">{job.detail}</span>;
    return <>{repo} and its base</>;
  }
  return (
    <>
      {repo} at <span className="font-mono">{shortSha(job.headSha)}</span> and its base
      {job.filesOnDisk !== null && <> — {job.filesOnDisk.toLocaleString()} files on disk</>}
    </>
  );
}

function readDetail(job: IngestionJob): ReactNode {
  const opening = "Walking the diff and the code around it";
  const { changedFiles, additions, deletions } = job;
  if (changedFiles === null) return opening;
  const counts =
    additions === null || deletions === null ? null : (
      <DiffCounts additions={additions} deletions={deletions} />
    );
  return (
    <>
      {opening} — {changedFiles.toLocaleString()} changed files
      {counts !== null && <>, {counts}</>}, and the modules they land in
    </>
  );
}

/**
 * The only fraction on this surface, and it is a real one: narration runs once
 * per cluster, so "3 of 7" counts finished runs. Validating and saving have no
 * fraction, so they speak through the job's own one-line account instead.
 */
function constructDetail(job: IngestionJob, state: StageState): ReactNode {
  const opening = "Ordering the clusters; writing each one's narrative";
  if (state !== "active") return opening;
  if (job.phase === "validating" || job.phase === "saving") return job.detail ?? opening;
  const progress = job.stageProgress;
  if (progress === null || progress.total === 0) return opening;
  return (
    <>
      {opening} — {progress.done} of {progress.total}
      {progress.label !== null && <span className="text-faint"> · {progress.label}</span>}
    </>
  );
}

// ── Small helpers ───────────────────────────────────────────────────────────

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** The PR's title and head from the cached GitHub view, before a job exists. */
function findEntry(
  list: PrListSnapshot | null,
  prRef: PrRef,
): { readonly title: string; readonly headSha: string } | null {
  if (list === null) return null;
  const matches = (candidate: PrRef) =>
    candidate.owner === prRef.owner &&
    candidate.repo === prRef.repo &&
    candidate.number === prRef.number;
  for (const group of list.groups) {
    for (const entry of group.entries) {
      if (matches(entry.pr.ref)) return { title: entry.pr.title, headSha: entry.pr.headSha };
    }
  }
  for (const entry of list.merged) {
    if (matches(entry.pr.ref)) return { title: entry.pr.title, headSha: entry.pr.headSha };
  }
  return null;
}

function messageOf(cause: Cause.Cause<unknown>): string {
  const error: unknown = Cause.squash(cause);
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/** A missing journey is the normal state before ingestion, not a fault to report. */
function isJourneyMissing(cause: Cause.Cause<unknown>): boolean {
  const error: unknown = Cause.squash(cause);
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "JourneyNotFoundError"
  );
}
