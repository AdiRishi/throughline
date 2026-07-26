/**
 * The Overview: where every journey starts.
 *
 * A first-class artifact the agent writes deliberately — never a restatement of
 * the pull request's description. Its job is orientation: after reading it, the
 * reviewer should be able to say what the change builds and name its parts,
 * before reading a single diff closely.
 *
 * It is a document, and it reads like one: it takes the middle *and* right
 * panels together, because guidance is a companion to code and this page has
 * none.
 *
 * @module features/journey/OverviewPage
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";

import type { Cluster } from "@app/contracts";
import { clusterScale } from "@app/journey/progress";

import { Narrative, type EvidenceTarget } from "../../lib/markdown.tsx";
import { Bar, formatCount, WeightLabel } from "../../ui/primitives.tsx";
import { useJourney } from "./context.tsx";

export function OverviewPage() {
  const { journey, progress, labelForHunk } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const navigate = useNavigate();
  const [showPrWords, setShowPrWords] = useState(false);

  const goToCluster = (clusterId: string) =>
    void navigate({
      to: "/pr/$owner/$repo/$number/cluster/$clusterId",
      params: { owner: params.owner, repo: params.repo, number: params.number, clusterId },
    });

  const onEvidence = (target: EvidenceTarget) => {
    if (target.kind === "hunk") {
      const hunk = journey.hunks.find(
        (candidate) => candidate.id === target.hunkId || candidate.seedId === target.hunkId,
      );
      if (hunk !== undefined) goToCluster(hunk.home);
      return;
    }
    void navigate({
      to: "/pr/$owner/$repo/$number/file/$",
      params: { ...params, _splat: target.path },
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto w-full max-w-3xl px-10 pt-10 pb-24">
        <Section label="The change, in brief">
          <div className="text-[15px] leading-[1.7]">
            <Narrative
              labelForHunk={labelForHunk}
              markdown={journey.overview.brief.markdown}
              onEvidence={onEvidence}
            />
          </div>
        </Section>

        <Section label="The map of the journey" className="mt-10">
          <div className="divide-y divide-border border-t border-border">
            {journey.clusters.map((cluster) => (
              <MapEntry
                key={cluster.id}
                cluster={cluster}
                allClusters={journey.clusters}
                journeyHunks={journey.hunks}
                fraction={
                  progress.clusters.find((entry) => entry.clusterId === cluster.id)?.hunksHomed
                    ? progress.clusters.find((entry) => entry.clusterId === cluster.id)!.hunksRead /
                      progress.clusters.find((entry) => entry.clusterId === cluster.id)!.hunksHomed
                    : 0
                }
                onOpen={() => goToCluster(cluster.id)}
                onEvidence={onEvidence}
              />
            ))}
          </div>
        </Section>

        <Section label="Where to begin" className="mt-10">
          <div className="text-[15px] leading-[1.7]">
            <Narrative
              labelForHunk={labelForHunk}
              markdown={journey.overview.whereToBegin.markdown}
              onEvidence={onEvidence}
            />
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {journey.clusters.map((cluster, index) => (
              <span key={cluster.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => goToCluster(cluster.id)}
                  className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] transition-colors hover:border-border-strong"
                >
                  <span className="mr-1.5 font-mono text-faint">{cluster.position}</span>
                  {attentionHint(cluster)}
                </button>
                {index < journey.clusters.length - 1 && (
                  <span className="text-faint" aria-hidden>
                    →
                  </span>
                )}
              </span>
            ))}
          </div>
        </Section>

        {/* The reconstructed story leads; the raw metadata is reference material. */}
        <div className="mt-12 rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setShowPrWords((value) => !value)}
            className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-[13px] text-muted">
              <span className="mr-2 font-mono text-[11px] text-faint">
                {showPrWords ? "▾" : "▸"}
              </span>
              The PR’s own words — title, description, author, link
            </span>
            <span className="text-[12px] text-faint">{showPrWords ? "expanded" : "collapsed"}</span>
          </button>
          {showPrWords && (
            <div className="border-t border-border px-4 py-4">
              <p className="text-[14px] font-medium">{journey.prSnapshot.title}</p>
              <p className="mt-1 font-mono text-[12px] text-muted">
                {journey.prSnapshot.authorLogin} ·{" "}
                <a
                  href={journey.prSnapshot.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-border-strong underline-offset-2 hover:decoration-accent"
                >
                  {journey.pr.owner}/{journey.pr.repo}#{journey.pr.number}
                </a>
              </p>
              <pre className="mt-3 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-muted">
                {journey.prSnapshot.body.trim().length === 0
                  ? "(no description)"
                  : journey.prSnapshot.body}
              </pre>
            </div>
          )}
        </div>

        <Provenance />
      </article>
    </div>
  );
}

function Section({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h2 className="mb-3 font-mono text-[10.5px] tracking-[0.14em] text-faint uppercase">
        {label}
      </h2>
      {children}
    </section>
  );
}

function MapEntry({
  cluster,
  allClusters,
  journeyHunks,
  fraction,
  onOpen,
  onEvidence,
}: {
  readonly cluster: Cluster;
  readonly allClusters: ReadonlyArray<Cluster>;
  readonly journeyHunks: Parameters<typeof clusterScale>[1];
  readonly fraction: number;
  readonly onOpen: () => void;
  readonly onEvidence: (target: EvidenceTarget) => void;
}) {
  const { labelForHunk } = useJourney();
  // Scale figures are derived at render time, never stored: a stored aggregate
  // can lie, a derivation cannot.
  const scale = clusterScale(cluster, journeyHunks);

  // Relationships are stated plainly — "the auth module (1)", not "c1".
  const buildsOnLabel =
    cluster.buildsOn.length === 0
      ? null
      : cluster.buildsOn
          .map((id) => {
            const target = allClusters.find((entry) => entry.id === id);
            return target === undefined ? id : `${target.title} (${target.position})`;
          })
          .join(" and ");

  return (
    <div className="group py-5">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="mt-[1px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border border-border font-mono text-[11px] text-muted transition-colors group-hover:border-border-strong group-hover:text-foreground"
        >
          {cluster.position}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div className="flex items-baseline gap-2.5">
              <button
                type="button"
                onClick={onOpen}
                className="cursor-pointer text-[15px] font-semibold tracking-tight decoration-border-strong underline-offset-4 hover:underline"
              >
                {cluster.title}
              </button>
              <WeightLabel weight={cluster.weight} />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-[11.5px] text-faint">
                {formatCount(scale.filesTouched)} files · {formatCount(scale.hunksHomed)} hunks
              </span>
              <Bar fraction={fraction} className="w-14" />
            </div>
          </div>
          <div className="mt-1.5 text-[14px] leading-[1.65] text-muted">
            <Narrative
              labelForHunk={labelForHunk}
              markdown={cluster.mapEntry.markdown}
              onEvidence={onEvidence}
            />
          </div>
          {buildsOnLabel !== null && (
            <p className="mt-1.5 text-[12.5px] text-faint">Builds on {buildsOnLabel}.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Honesty, not decoration: which harness built this journey, and whether the
 * pipeline had to complete anything itself.
 */
function Provenance() {
  const { journey } = useJourney();
  const [open, setOpen] = useState(false);
  const { provenance } = journey;

  return (
    <div className="mt-6 text-[12px] text-faint">
      <p>
        Analyzed with {provenance.harnessKind}
        {provenance.model === null ? "" : ` (${provenance.model})`} at{" "}
        <span className="font-mono">{journey.pinned.headSha.slice(0, 7)}</span>.
        {provenance.fallbacks.length > 0 && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-muted"
            >
              {provenance.fallbacks.length} step
              {provenance.fallbacks.length === 1 ? "" : "s"} the pipeline completed itself
            </button>
          </>
        )}
      </p>
      {open && (
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {provenance.fallbacks.map((note, index) => (
            // eslint-disable-next-line react/no-array-index-key -- order is the identity
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Attention guidance, never a verdict on the code. */
function attentionHint(cluster: Cluster): string {
  switch (cluster.weight) {
    case "core":
      return "read closely";
    case "supporting":
      return "read for wiring";
    case "mechanical":
      return "walk quickly";
  }
}
