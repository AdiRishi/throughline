import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import type { PrListEntry, PrListSnapshot, PrRef } from "@app/contracts";

/**
 * The words the welcome screen says about the list, derived and nothing else.
 *
 * The screen opens with a claim about the reviewer's world — "Three reviews
 * waiting", "One mid-journey, one stale, one new" — and a claim is exactly the
 * kind of thing a UI is tempted to invent. So every sentence here is computed
 * from the snapshot and only from the snapshot: the count is the count, and the
 * subtitle is a partition of the same set the rows below it render. If the data
 * cannot support a sentence, there is no sentence.
 *
 * It lives apart from the JSX because it is the part worth reading twice, and
 * because a pure function is the only honest way to keep two surfaces (headline
 * and rows) agreeing about one list.
 *
 * @module features/welcome/welcomeCopy
 */

/**
 * A row's journey state — mutually exclusive by construction, so the subtitle's
 * clauses always add up to the number of rows on screen.
 */
export type JourneyRowState = "analyzing" | "reading" | "stale" | "finished" | "fresh";

export function journeyStateOf(entry: PrListEntry): JourneyRowState {
  // A live job wins over whatever artifact exists: a reanalysis in flight is the
  // truest thing to say about the PR right now.
  if (entry.ingesting) return "analyzing";
  const journey = entry.journey;
  if (journey === null) return "fresh";
  // Stale outranks progress. A stale journey stays readable, but "this maps an
  // older head" is the fact the reviewer needs before "you are on cluster 3".
  if (journey.stale) return "stale";
  if (journey.complete) return "finished";
  return "reading";
}

/** `reviewed` is a local declaration, independent of journey progress. */
type SummaryBucket = JourneyRowState | "reviewed";

export interface WelcomeSummary {
  /** "Friday, July 25" — the personal, dated opening line. */
  readonly today: string;
  readonly headline: string;
  readonly subtitle: string;
}

/**
 * Everything here is local state over a read-only GitHub view, and saying so is
 * calming rather than legalistic — it is the reason the reviewer can mark, hide,
 * and walk away without consequence.
 */
const LOCAL_SENTENCE = "Everything here is local — GitHub is never written to.";

const BUCKET_PHRASE: Record<SummaryBucket, string> = {
  analyzing: "analyzing",
  reading: "mid-journey",
  stale: "stale",
  finished: "finished",
  fresh: "new",
  reviewed: "marked reviewed",
};

/** Liveliest first: what is moving, then what is waiting, then what is settled. */
const BUCKET_ORDER: ReadonlyArray<SummaryBucket> = [
  "analyzing",
  "reading",
  "stale",
  "finished",
  "fresh",
  "reviewed",
];

/**
 * Whether the list on screen is a trustworthy view of GitHub. The headline and
 * the empty state both have to answer this the same way, or the screen
 * contradicts itself in the one case where it knows the least.
 */
export function canSeeGitHub(snapshot: PrListSnapshot): boolean {
  return snapshot.viewer.auth === "authenticated" && snapshot.github.status === "ok";
}

export function summarize(snapshot: PrListSnapshot, now: Date = new Date()): WelcomeSummary {
  const today = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const entries = snapshot.groups.flatMap((group) => [...group.entries]);
  const counts = new Map<SummaryBucket, number>();
  for (const entry of entries) {
    const bucket: SummaryBucket = entry.reviewed ? "reviewed" : journeyStateOf(entry);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  // "Waiting" means waiting on the reviewer, so a PR they have declared done is
  // not counted — that declaration is the whole point of the reviewed mark.
  const waiting = entries.length - (counts.get("reviewed") ?? 0);

  if (entries.length === 0) {
    // An empty list means two very different things, and only one of them is
    // "nothing waiting". When `gh` is unusable or GitHub is parked, Throughline
    // does not know what is waiting — claiming otherwise would be the screen
    // inventing the one fact this headline exists to report. The Notice above
    // carries the remedy, so the headline only has to stop short of lying.
    return canSeeGitHub(snapshot)
      ? {
          today,
          headline: "Nothing waiting",
          subtitle: `No open pull requests for your gh login right now. ${LOCAL_SENTENCE}`,
        }
      : {
          today,
          headline: "Nothing to show yet",
          subtitle: `Throughline lists the pull requests your gh login can see, and it cannot see them right now. ${LOCAL_SENTENCE}`,
        };
  }

  const clauses = BUCKET_ORDER.flatMap((bucket) => {
    const count = counts.get(bucket) ?? 0;
    return count === 0 ? [] : [`${spell(count)} ${BUCKET_PHRASE[bucket]}`];
  });
  const decomposition = clauses.length === 0 ? "" : `${capitalize(clauses.join(", "))}. `;

  return {
    today,
    headline:
      waiting === 0
        ? "Nothing waiting"
        : `${capitalize(spell(waiting))} review${waiting === 1 ? "" : "s"} waiting`,
    subtitle: `${decomposition}${LOCAL_SENTENCE}`,
  };
}

/**
 * Small counts read as words because the line is a sentence about the
 * reviewer's day, not a metric; past twelve, digits are what a person would
 * actually write.
 */
const NUMBER_WORDS: ReadonlyArray<string> = [
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
  "eleven",
  "twelve",
];

function spell(count: number): string {
  return NUMBER_WORDS[count] ?? String(count);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Stable element ids so an end-to-end test can drive one specific row. A PR ref
 * is three fields and an id has to survive a CSS selector, so everything outside
 * `[a-z0-9-]` collapses to a hyphen.
 */
export function controlId(prefix: string, ref: PrRef): string {
  return `${prefix}-${ref.owner}-${ref.repo}-${ref.number}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-");
}

/**
 * The shape every failure the door can produce satisfies. Typed narrowly enough
 * to read a `DoorRejection`'s `detail` without a cast, and widely enough that a
 * transport or authorization failure passes through the same path.
 */
export interface DoorFailure {
  readonly _tag: string;
  readonly message?: string | undefined;
  readonly detail?: string | undefined;
}

const INCOMPLETE = "The request did not complete. Try again in a moment.";

/**
 * A door rejection's `detail` is written for the reviewer — the one place in the
 * product where an error message is authored copy — so it is shown verbatim and
 * never wrapped in a diagnosis of our own. Anything else falls back to its own
 * message rather than to an invented explanation of what went wrong.
 */
export function doorDetail(cause: Cause.Cause<DoorFailure>): string {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (error === undefined) return INCOMPLETE;
  if (error._tag === "DoorRejection" && error.detail !== undefined) return error.detail;
  return error.message !== undefined && error.message.length > 0 ? error.message : INCOMPLETE;
}
