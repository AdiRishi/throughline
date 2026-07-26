import * as DateTime from "effect/DateTime";

import type { PrListEntry } from "@app/contracts";

import { Fact, leavesIn, relativeTime } from "../../ui/primitives.tsx";
import { controlId } from "./welcomeCopy.ts";

/**
 * A merged pull request, settling.
 *
 * Closure without clutter: a merged PR is still part of the reviewer's mental
 * landscape for about a week, so it leaves the open list but stays visible — one
 * quiet line carrying what became of the journey and when the row itself will go.
 * Saying "leaves in 4 days" out loud is what makes the section feel tidy instead
 * of accumulating: the reviewer never has to wonder whether it is their job to
 * clean up.
 *
 * The row is deliberately a third the height of an open row. Nothing here is
 * waiting on anyone, so nothing here competes for attention.
 *
 * @module features/welcome/MergedRow
 */

export function MergedRow({
  entry,
  onDismiss,
}: {
  readonly entry: PrListEntry;
  readonly onDismiss: () => void;
}) {
  const { pr, journey } = entry;
  const mergedAt = pr.mergedAt === null ? null : DateTime.toDate(pr.mergedAt);

  return (
    <li>
      <div
        className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5"
        data-pr={`${pr.ref.owner}/${pr.ref.repo}#${pr.ref.number}`}
      >
        {/* A neutral bullet, not a coloured status dot: the one accent in this
            product means emphasis of the current cluster's hunks and nothing else. */}
        <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-border-strong" />
        <span className="min-w-0 truncate text-[13px] font-medium">{pr.title}</span>
        <span className="shrink-0 font-mono text-[12px] text-faint">#{pr.ref.number}</span>

        <span className="ml-auto flex shrink-0 items-center gap-3">
          {journey !== null && <span className="text-[12px] text-muted">{outcome(journey)}</span>}
          <Fact>
            {mergedAt === null
              ? "merged"
              : `merged ${relativeTime(mergedAt)} · ${leavesIn(mergedAt)}`}
          </Fact>
          <button
            type="button"
            id={controlId("dismiss-merged", pr.ref)}
            onClick={onDismiss}
            aria-label={`Dismiss ${pr.title}`}
            className="cursor-pointer rounded px-1 text-[14px] leading-none text-faint transition-colors hover:text-foreground"
          >
            ×
          </button>
        </span>
      </div>
    </li>
  );
}

/**
 * What became of the journey — the coverage guarantee's closing statement when it
 * was earned, and an honest "you stopped here" when it was not. Never a verdict
 * on the merge.
 */
function outcome(journey: NonNullable<PrListEntry["journey"]>): string {
  if (journey.complete) return "Journey finished — every line seen";
  const position = journey.currentClusterPosition;
  return position === null
    ? "Journey left unfinished"
    : `Journey left at cluster ${position} of ${journey.clusterCount}`;
}
