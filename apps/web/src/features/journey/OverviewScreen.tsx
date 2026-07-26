import { useAtom } from "@effect/atom-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { Cluster, ClusterId, Journey } from "@app/contracts";
import {
  computeClusterScales,
  type ClusterProgress,
  type ClusterScale,
} from "@app/journey/progress";

import { localApi } from "../../localApi.ts";
import { startIngestionAtom } from "../../state/journeyState.ts";
import { Markdown, type EvidenceHandlers } from "../../ui/Markdown.tsx";
import {
  Fact,
  Meter,
  QuietButton,
  Separator,
  WeightLabel,
  relativeTime,
} from "../../ui/primitives.tsx";
import { ReadingPanels, useJourney } from "./JourneyLayout.tsx";

/**
 * The Overview: where every journey starts.
 *
 * Three shaping decisions, all of them from the product documents rather than
 * from taste.
 *
 * **It is a document, so it takes the whole width.** `ReadingPanels` is rendered
 * with no right panel: guidance is a companion to *code*, and the Overview has no
 * code. What is left is one wide, quiet page, and the prose is held to ~72ch so
 * the measure stays readable instead of stretching to the window.
 *
 * **The map derives everything it can.** A cluster's account here is its own
 * `mapEntry`, its scale comes from `computeClusterScales`, and its progress comes
 * from the same `progress.clusters` the left rail reads. Nothing about a cluster
 * is restated in a second place, so the map and the territory cannot disagree —
 * which is the whole reason the artifact does not store map entries separately.
 *
 * **Nothing here judges.** Weight is a quiet text label, the attention strip is
 * guidance about where effort goes, and the accent colour never appears: colour
 * carries exactly one meaning in this product (emphasis of the open cluster's
 * hunks) and there are no hunks on this page. The reviewer's own words — the PR's
 * title, body, author and link — sit collapsed at the bottom, because the
 * reconstructed story leads and the raw metadata is reference material.
 *
 * @module features/journey/OverviewScreen
 */

export function OverviewScreen() {
  const { envelope, journey, progress } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const navigate = useNavigate();

  const goToCluster = useCallback(
    (clusterId: string) => {
      void navigate({
        to: "/pr/$owner/$repo/$number/cluster/$clusterId",
        params: { ...params, clusterId },
      });
    },
    [navigate, params],
  );

  const goToFile = useCallback(
    (path: string) => {
      void navigate({ to: "/pr/$owner/$repo/$number/file/$", params: { ...params, _splat: path } });
    },
    [navigate, params],
  );

  /**
   * Evidence has to resolve to *somewhere on this page's terms*: the Overview
   * renders no code, so a hunk link means "take me to the cluster this hunk is
   * homed to" — the one place the reviewer can read it in context. A symbol is a
   * file plus a name, and until the file surface frames symbols it resolves to
   * the file, which is never wrong, only less precise.
   */
  const handlers = useMemo<EvidenceHandlers>(
    () => ({
      onHunk: (hunkId) => {
        const hunk = journey.hunks.find((candidate) => candidate.id === hunkId);
        if (hunk === undefined) return;
        goToCluster(hunk.home);
      },
      onFile: goToFile,
      onSymbol: (path) => goToFile(path),
    }),
    [journey.hunks, goToCluster, goToFile],
  );

  const clusters = useMemo(
    () => [...journey.clusters].toSorted((left, right) => left.position - right.position),
    [journey.clusters],
  );
  const titles = useMemo(() => buildTitleIndex(journey), [journey]);
  const scales = useMemo(
    () => new Map(computeClusterScales(journey).map((scale) => [scale.clusterId, scale])),
    [journey],
  );
  const progressById = useMemo(
    () => new Map(progress.clusters.map((entry) => [entry.clusterId, entry])),
    [progress.clusters],
  );

  const brief = journey.overview.brief.markdown.trim();
  const whereToBegin = journey.overview.whereToBegin.markdown.trim();
  // Attention notes name clusters, so they are ordered by the journey rather
  // than by however the agent happened to emit them.
  const attention = useMemo(() => {
    // The strip is one chip per cluster, in journey order — so a second note
    // naming a cluster already on the strip is not a second chip. Deduplicating
    // here is also what makes the cluster id a stable list key.
    const seen = new Set<ClusterId>();
    return journey.overview.attention
      .flatMap((note) => {
        const cluster = titles.get(note.clusterId);
        if (cluster === undefined || seen.has(note.clusterId)) return [];
        seen.add(note.clusterId);
        return [{ clusterId: note.clusterId, position: cluster.position, phrase: note.phrase }];
      })
      .toSorted((left, right) => left.position - right.position);
  }, [journey.overview.attention, titles]);

  return (
    <ReadingPanels
      middle={
        <div id="overview" className="min-h-0 flex-1 overflow-y-auto">
          <article className="tl-fade mx-auto max-w-[72ch] px-8 pt-10 pb-24">
            {envelope.stale && (
              <StaleLine journey={journey} currentHeadSha={envelope.currentHeadSha} />
            )}

            <Section label="The change, in brief">
              {brief.length === 0 ? (
                <Quiet>
                  No brief was written for this journey. The map below still names every cluster, in
                  order.
                </Quiet>
              ) : (
                <Markdown markdown={brief} handlers={handlers} className="text-[14px]" />
              )}
            </Section>

            <Section label="The map of the journey">
              {clusters.length === 0 ? (
                <Quiet>This journey has no clusters.</Quiet>
              ) : (
                <div className="border-t border-border">
                  {clusters.map((cluster) => (
                    <MapEntry
                      key={cluster.id}
                      cluster={cluster}
                      scale={scales.get(cluster.id) ?? null}
                      clusterProgress={progressById.get(cluster.id) ?? null}
                      relationship={describeRelationship(cluster, titles)}
                      handlers={handlers}
                      params={params}
                    />
                  ))}
                </div>
              )}
            </Section>

            {(whereToBegin.length > 0 || attention.length > 0) && (
              <Section label="Where to begin">
                {whereToBegin.length > 0 && (
                  <Markdown markdown={whereToBegin} handlers={handlers} className="text-[13px]" />
                )}
                {attention.length > 0 && (
                  <div
                    className={`flex flex-wrap items-center gap-x-2 gap-y-2 ${whereToBegin.length > 0 ? "mt-5" : ""}`}
                  >
                    {attention.map((note, index) => (
                      <div key={note.clusterId} className="flex items-center gap-2">
                        {index > 0 && (
                          <span aria-hidden className="text-[12px] text-faint">
                            →
                          </span>
                        )}
                        <span className="flex items-baseline gap-2 rounded-md border border-border px-2.5 py-1">
                          <span className="font-mono text-[11px] text-faint">{note.position}</span>
                          <span className="text-[12px] text-muted">{note.phrase}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            <PrWordsPanel journey={journey} />
          </article>
        </div>
      }
    />
  );
}

// ── The map ─────────────────────────────────────────────────────────────────

/**
 * One cluster on the map.
 *
 * The header row — position, title, weight, scale, progress — *is* the link, so
 * the whole row is one honest click target and the prose below it stays selectable
 * text. (An invisible overlay link covering the entry would take the click but
 * cost the reader their text selection, and this is a document.)
 */
function MapEntry({
  cluster,
  scale,
  clusterProgress,
  relationship,
  handlers,
  params,
}: {
  readonly cluster: Cluster;
  readonly scale: ClusterScale | null;
  readonly clusterProgress: ClusterProgress | null;
  readonly relationship: string | null;
  readonly handlers: EvidenceHandlers;
  readonly params: { readonly owner: string; readonly repo: string; readonly number: string };
}) {
  const mapEntry = cluster.mapEntry.markdown.trim();
  const complete = clusterProgress?.complete === true && clusterProgress.filesTotal > 0;

  return (
    <div className="border-b border-border py-4">
      <Link
        id={`map-entry-${cluster.position}`}
        to="/pr/$owner/$repo/$number/cluster/$clusterId"
        params={{ ...params, clusterId: cluster.id }}
        className="group grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-x-4 rounded-md"
      >
        {/* The position is information, not decoration — it is how the reviewer
            cross-references the map against the rail — so it is announced. */}
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-raised text-[12px] text-muted transition-colors group-hover:text-foreground">
          {cluster.position}
        </span>
        <span className="flex items-baseline justify-between gap-4">
          <span className="flex min-w-0 items-baseline gap-2">
            {/* Titles wrap rather than truncate: the rail is where a title is
                abbreviated for space, and the map is where it is read in full. */}
            <span className="text-[13px] font-medium decoration-border-strong underline-offset-4 group-hover:underline">
              {cluster.title}
            </span>
            <WeightLabel weight={cluster.weight} />
          </span>
          <span className="flex shrink-0 items-center gap-3">
            {scale !== null && (
              <Fact>
                {count(scale.filesTouched, "file")} · {count(scale.hunksHomed, "hunk")}
              </Fact>
            )}
            {/* Done reads as done: a check and its count, never a full bar the
                reviewer has to interpret. The meter is decorative to assistive
                tech, so live progress carries the same figure in words. */}
            {complete && clusterProgress !== null ? (
              <span className="font-mono text-[12px] whitespace-nowrap text-muted">
                <span aria-hidden>✓</span> {clusterProgress.filesRead}/{clusterProgress.filesTotal}
                <span className="sr-only"> files read</span>
              </span>
            ) : (
              clusterProgress !== null &&
              clusterProgress.filesTotal > 0 && (
                <>
                  <span className="sr-only">
                    {clusterProgress.filesRead} of {clusterProgress.filesTotal} files read
                  </span>
                  <Meter fraction={clusterProgress.fraction} className="w-8" />
                </>
              )
            )}
          </span>
        </span>
      </Link>

      {/* Aligned to the title, not to the square: the account continues the
          heading rather than sitting under the numbering. */}
      <div className="pl-11">
        {mapEntry.length > 0 && (
          <Markdown
            markdown={mapEntry}
            handlers={handlers}
            className="mt-1.5 text-[13px] text-muted"
          />
        )}
        {relationship !== null && <p className="mt-2 text-[12px] text-muted">{relationship}</p>}
      </div>
    </div>
  );
}

/**
 * Relationships, stated plainly from `buildsOn` and nothing else.
 *
 * The verb is always "builds on", never one inferred from how many earlier
 * clusters are named. A cluster with two dependencies is not necessarily *binding*
 * them, and Throughline never makes a claim about the code it cannot back — if
 * this step is the binding, the agent says so in its own account above.
 */
function describeRelationship(cluster: Cluster, titles: ClusterTitles): string | null {
  const named = cluster.buildsOn.flatMap((id) => {
    const target = titles.get(id);
    return target === undefined ? [] : [`${target.title} (${target.position})`];
  });
  if (named.length === 0) return null;
  return `Builds on ${joinPhrase(named)}.`;
}

function joinPhrase(items: ReadonlyArray<string>): string {
  const last = items.at(-1) ?? "";
  if (items.length <= 1) return last;
  if (items.length === 2) return `${items[0] ?? ""} and ${last}`;
  return `${items.slice(0, -1).join(", ")}, and ${last}`;
}

/** Cluster ids resolved to the two things a relationship has to name. */
type ClusterTitles = ReadonlyMap<ClusterId, { readonly position: number; readonly title: string }>;

function buildTitleIndex(journey: Journey): ClusterTitles {
  return new Map(
    journey.clusters.map((cluster) => [
      cluster.id,
      { position: cluster.position, title: cluster.title },
    ]),
  );
}

// ── Staleness ───────────────────────────────────────────────────────────────

/**
 * Stale is a visible state, not a failure — so it is a quiet line above the
 * brief, not a banner. The copy has to carry the whole model: the journey is
 * pinned, it stays readable, and reanalysis is a full rebuild that starts read
 * progress over (a rebuilt journey is a new journey, and coverage is only
 * meaningful against the journey it was earned in).
 */
function StaleLine({
  journey,
  currentHeadSha,
}: {
  readonly journey: Journey;
  readonly currentHeadSha: string | null;
}) {
  const [result, start] = useAtom(startIngestionAtom);
  const failed = AsyncResult.isFailure(result);

  return (
    <div className="flex items-start justify-between gap-6 border-b border-border pb-6">
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Stale</p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          This journey is pinned to{" "}
          <span className="font-mono">{sha7(journey.pinned.headSha)}</span>
          {currentHeadSha === null ? (
            <> and the pull request has moved ahead of it.</>
          ) : (
            <>
              {" "}
              and the pull request is now at{" "}
              <span className="font-mono">{sha7(currentHeadSha)}</span>.
            </>
          )}{" "}
          Everything below stays fully readable. Reanalyzing rebuilds the journey against the new
          head — a new journey, with read progress starting fresh.
        </p>
        {failed && (
          <p className="mt-2 text-[12px] text-muted">
            Reanalysis could not start. Try again in a moment.
          </p>
        )}
      </div>
      <QuietButton
        id="reanalyze-journey"
        disabled={result.waiting}
        onClick={() => start({ ref: journey.pr, reanalyze: true })}
      >
        {result.waiting ? "Starting…" : "Reanalyze"}
      </QuietButton>
    </div>
  );
}

function sha7(sha: string): string {
  return sha.slice(0, 7);
}

// ── The PR's own words ──────────────────────────────────────────────────────

/**
 * Collapsed by default, and deliberately last. The reconstructed story leads;
 * this is reference material, and a reviewer who wants it knows they want it.
 */
function PrWordsPanel({ journey }: { readonly journey: Journey }) {
  const [open, setOpen] = useState(false);
  const words = journey.prWords;
  const body = words.body.trim();

  return (
    <div className="mt-12">
      <button
        id="pr-words"
        type="button"
        aria-expanded={open}
        aria-controls="pr-words-panel"
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-border-strong"
      >
        <span className="flex min-w-0 items-center gap-2.5 text-[13px] text-muted">
          <span aria-hidden className="text-[10px] text-faint">
            {open ? "▾" : "▸"}
          </span>
          The PR&rsquo;s own words — title, description, author, link
        </span>
        <span className="shrink-0 text-[11px] text-faint">{open ? "expanded" : "collapsed"}</span>
      </button>

      {open && (
        <div
          id="pr-words-panel"
          className="tl-rise mt-3 rounded-lg border border-border bg-card px-5 py-4"
        >
          <p className="text-[14px] font-medium">{words.title}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-2">
            <Fact>{words.author}</Fact>
            <Separator />
            <Fact>opened {relativeTime(DateTime.toDateUtc(words.createdAt))}</Fact>
          </p>
          {body.length === 0 ? (
            <Quiet className="mt-4">This pull request has no description.</Quiet>
          ) : (
            /* No evidence handlers: this is the author's prose, not narrative —
               it has no `tl:` links to resolve, and pretending otherwise would
               blur which words are the agent's. */
            <Markdown markdown={body} className="mt-4 text-[13px] text-muted" />
          )}
          <div className="mt-5">
            <QuietButton
              id="open-pr-external"
              onClick={() => {
                // The only failure here is the shell refusing the URL, and the
                // URL came from GitHub — there is nothing to tell the reviewer.
                void localApi()
                  .openExternal(words.url)
                  .catch(() => {});
              }}
            >
              Open on GitHub
            </QuietButton>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page furniture ──────────────────────────────────────────────────────────

/** Small-caps section label. The page owns the hierarchy; the prose does not. */
function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <section className="mt-11 first:mt-0">
      <h2 className="text-[11px] font-medium tracking-[0.14em] text-faint uppercase">{label}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** An absent piece of the artifact, said plainly rather than left blank. */
function Quiet({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <p className={`text-[13px] leading-relaxed text-muted ${className ?? ""}`}>{children}</p>;
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}
