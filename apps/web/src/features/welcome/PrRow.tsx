import * as DateTime from "effect/DateTime";

import type { PrJourneyState, PrListEntry } from "@app/contracts";

import {
  DiffCounts,
  JourneyMeter,
  Meter,
  PrimaryButton,
  QuietButton,
  relativeTime,
  Separator,
} from "../../ui/primitives.tsx";
import { controlId, journeyStateOf, type JourneyRowState } from "./welcomeCopy.ts";

/**
 * One open pull request, as a line in the reviewer's world.
 *
 * The row reads left to right as **what it is → where I am in it → what I can
 * do**: identity and diff facts on the left, the journey's state and meter on the
 * right, the row's actions under them. That order is what lets a glance answer
 * "what am I actively reviewing?" without reading a single button.
 *
 * Two decisions worth knowing:
 *
 * 1. **The actions are always visible, never revealed on hover.** The design shows
 *    them on the active row only; the product rule that nothing essential lives
 *    behind a hover outranks that. The cost is four controls per row, paid for by
 *    keeping three of them quiet and emphasising only the door.
 * 2. **The meter counts *completed clusters*, not a percentage.** The wire gives
 *    `currentClusterPosition` — the first cluster with unread files — so every
 *    cluster before it is provably fully read and every cluster from it on is
 *    provably not. Filling exactly those segments is the strongest claim this
 *    payload supports; the precise position stays in the text beside it.
 *
 * @module features/welcome/PrRow
 */

/** Past this, one segment per cluster is a hairline; the fraction reads better. */
const SEGMENT_LIMIT = 12;

export function PrRow({
  entry,
  opening,
  onOpen,
  onReanalyze,
  onToggleReviewed,
  onHide,
}: {
  readonly entry: PrListEntry;
  /** True while this row's door is waiting on the server. */
  readonly opening: boolean;
  readonly onOpen: () => void;
  readonly onReanalyze: () => void;
  readonly onToggleReviewed: () => void;
  readonly onHide: () => void;
}) {
  const { pr, journey } = entry;
  const state = journeyStateOf(entry);

  return (
    <li>
      <div
        // A reviewed PR settles back without leaving the list: it is still part of
        // the landscape, it is just no longer asking for anything.
        className={`rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong hover:bg-raised ${
          entry.reviewed ? "opacity-70" : ""
        }`}
        data-pr={`${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`}
      >
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            {/* The title is a door too — the docs make clicking a PR the primary
                path, and a title that does nothing on click is a trap. */}
            <button
              type="button"
              onClick={onOpen}
              className="flex max-w-full cursor-pointer items-baseline gap-2 text-left"
            >
              <span className="min-w-0 truncate text-[15px] font-semibold">{pr.title}</span>
              <span className="shrink-0 font-mono text-[12px] text-faint">#{pr.ref.number}</span>
            </button>

            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted">
              <span>{pr.author}</span>
              <Separator />
              <span>opened {relativeTime(DateTime.toDate(pr.createdAt))}</span>
              <Separator />
              <span className="font-mono">
                {pr.changedFiles.toLocaleString()} {pr.changedFiles === 1 ? "file" : "files"}
              </span>
              <Separator />
              <DiffCounts additions={pr.additions} deletions={pr.deletions} />
              {pr.isDraft && (
                <>
                  <Separator />
                  <span>draft</span>
                </>
              )}
              {entry.reviewed && (
                <>
                  <Separator />
                  <span>marked reviewed</span>
                </>
              )}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            <StateLine state={state} journey={journey} />
            {journey !== null && journey.clusterCount > 0 && <ClusterProgress journey={journey} />}
            <div className="flex items-center gap-1.5">
              {state === "stale" && (
                <QuietButton
                  id={controlId("reanalyze", pr.ref)}
                  onClick={onReanalyze}
                  disabled={opening}
                >
                  Reanalyze
                </QuietButton>
              )}
              <QuietButton id={controlId("toggle-reviewed", pr.ref)} onClick={onToggleReviewed}>
                {entry.reviewed ? "Unmark reviewed" : "Mark reviewed"}
              </QuietButton>
              <QuietButton id={controlId("hide-pr", pr.ref)} onClick={onHide}>
                Hide
              </QuietButton>
              <PrimaryButton
                id={controlId("open-journey", pr.ref)}
                onClick={onOpen}
                disabled={opening}
              >
                {opening ? "Opening…" : "Open journey"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * One line, one honest state. Every branch is a fact off the wire: none of them
 * guesses, and none of them grades the pull request.
 */
function StateLine({
  state,
  journey,
}: {
  readonly state: JourneyRowState;
  readonly journey: PrJourneyState | null;
}) {
  if (state === "analyzing") {
    return <span className="text-[13px] text-muted">Analyzing…</span>;
  }
  if (journey === null) {
    return <span className="text-[13px] text-muted">Not analyzed</span>;
  }
  if (state === "stale") {
    return (
      <span className="flex items-center gap-2">
        {/* A quiet text label, not a badge: stale is a state, never a severity. */}
        <span className="rounded border border-border-strong px-1.5 py-px font-mono text-[10px] tracking-[0.14em] text-muted">
          STALE
        </span>
        <span className="text-[12px] text-muted">
          journey pinned to <span className="font-mono">{journey.pinnedHeadSha.slice(0, 7)}</span> ·
          PR moved ahead
        </span>
      </span>
    );
  }
  if (state === "finished") {
    return <span className="text-[13px] text-muted">Journey finished — every line seen</span>;
  }
  const position = journey.currentClusterPosition;
  return (
    <span className="text-[13px] text-muted">
      {position === null ? "Reading" : `Reading · cluster ${position} of ${journey.clusterCount}`}
    </span>
  );
}

function ClusterProgress({ journey }: { readonly journey: PrJourneyState }) {
  // A journey of forty clusters would render forty hairlines; the aggregate
  // fraction the server already derived is the calmer honest fallback.
  if (journey.clusterCount > SEGMENT_LIMIT) {
    return <Meter fraction={journey.progress} className="w-[220px]" />;
  }
  if (journey.complete) return <Segments of={journey.clusterCount} filled={journey.clusterCount} />;
  const position = journey.currentClusterPosition;
  // No current position on an incomplete journey means no cluster boundary to
  // fill to. Picking one anyway would be the meter inventing a claim, so the
  // fraction speaks instead.
  if (position === null) return <Meter fraction={journey.progress} className="w-[220px]" />;
  return <Segments of={journey.clusterCount} filled={Math.max(0, position - 1)} />;
}

function Segments({ of, filled }: { readonly of: number; readonly filled: number }) {
  return (
    <JourneyMeter
      segments={Array.from({ length: of }, (_, index) => (index < filled ? 1 : 0))}
      className="w-[220px]"
    />
  );
}
