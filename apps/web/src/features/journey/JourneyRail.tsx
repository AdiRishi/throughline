import { Link, useParams } from "@tanstack/react-router";
import { useMemo } from "react";

import type { Cluster } from "@app/contracts";
import { toPercent, type ClusterProgress } from "@app/journey/progress";

import { JourneyMeter, WeightLabel } from "../../ui/primitives.tsx";
import { FileTreeRail } from "./FileTreeRail.tsx";
import { useJourney } from "./JourneyLayout.tsx";
import { SegmentedControl } from "./JourneyTopBar.tsx";

/**
 * Navigation, in two postures.
 *
 * **Journey** is the primary navigation: the ordered clusters, which is the
 * product's actual claim — that a large change has an intelligible order. A cluster
 * row shows exactly four things: position, title, weight, read progress. Not
 * because four is a magic number, but because everything else about a cluster lives
 * in the middle panel when it is selected, and a rail that summarises clusters
 * invites the reviewer to judge them from the rail instead of reading them.
 *
 * So: no badge rows, no colour chips, no counts-of-counts, and nothing essential
 * behind a hover. Weight is a quiet text label — it guides attention and must never
 * read as risk or quality. The current cluster is marked with the accent, which is
 * consistent with the accent's one meaning: *this* cluster is the one whose hunks
 * are emphasised in the code.
 *
 * **Files** is the reading posture: the project's real tree, because sometimes the
 * reviewer just wants to read code and nothing about being in a review tool should
 * take that away. Its filter sits at the bottom of the rail, out of the way of the
 * tree it narrows.
 *
 * @module features/journey/JourneyRail
 */

export function JourneyRail() {
  const { envelope, journey, progress, railMode, setRailMode, changedOnly, setChangedOnly } =
    useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const clusterRoute = useParams({
    from: "/pr/$owner/$repo/$number/cluster/$clusterId",
    shouldThrow: false,
  });
  const fileRoute = useParams({
    from: "/pr/$owner/$repo/$number/file/$",
    shouldThrow: false,
  });
  const activeClusterId = clusterRoute?.clusterId ?? null;
  // The Overview is the journey's index route: neither a cluster nor a file.
  const onOverview = activeClusterId === null && fileRoute === undefined;

  /**
   * Progress is ordered by position and the artifact's clusters are keyed by id, so
   * the rows are joined once here rather than looked up per render inside the list.
   */
  const rows = useMemo<ReadonlyArray<ClusterRow>>(() => {
    const byId = new Map(journey.clusters.map((cluster) => [cluster.id, cluster] as const));
    return progress.clusters.flatMap((clusterProgress) => {
      const cluster = byId.get(clusterProgress.clusterId);
      return cluster === undefined ? [] : [{ cluster, progress: clusterProgress }];
    });
  }, [journey.clusters, progress.clusters]);

  const activeIndex = rows.findIndex((row) => row.cluster.id === activeClusterId);
  const previous = activeIndex <= 0 ? undefined : rows[activeIndex - 1];
  const next = activeIndex === -1 ? undefined : rows[activeIndex + 1];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="p-2">
        <SegmentedControl
          fill
          label="left rail mode"
          value={railMode}
          onChange={setRailMode}
          options={[
            { value: "journey", label: "Journey", id: "rail-mode-journey" },
            { value: "files", label: "Files", id: "rail-mode-files" },
          ]}
        />
      </div>

      {railMode === "journey" ? (
        <>
          <div className="border-b border-border px-3 pb-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12px] text-muted">Journey</span>
              <span className="text-[12px] text-muted">
                <span className="text-foreground">{toPercent(progress.fraction)}%</span> ·{" "}
                {progress.filesRead} of {progress.filesTotal} files
              </span>
            </div>
            {/* One segment per cluster: the reviewer is walking steps, not filling
                a bar, and an uneven fill is the honest picture of where they are. */}
            <JourneyMeter
              className="mt-2"
              segments={progress.clusters.map((cluster) => cluster.fraction)}
            />
            {progress.complete && (
              <p className="mt-2 text-[11px] text-muted">complete · every hunk seen at its home</p>
            )}
            {/* Staleness is flagged where the journey is navigated, because a stale
                journey stays fully readable — it is a faithful map of an older head,
                not a failure. */}
            {envelope.stale && (
              <p className="mt-2 text-[11px] text-muted">
                stale · pinned to{" "}
                <span className="font-mono">{journey.pinned.headSha.slice(0, 7)}</span>; the pull
                request has moved on
              </p>
            )}
          </div>

          <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="journey">
            <Link
              to="/pr/$owner/$repo/$number"
              params={params}
              id="rail-overview"
              aria-current={onOverview ? "page" : undefined}
              className={`flex items-center gap-2 rounded-md px-2 py-2 transition-colors ${
                onOverview ? "bg-raised text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              <span aria-hidden className="w-4 shrink-0 text-center text-[12px] text-faint">
                §
              </span>
              <span className="text-[13px]">Overview</span>
            </Link>

            {rows.length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-muted">
                This journey has no clusters to walk.
              </p>
            ) : (
              rows.map((row) => (
                <ClusterRailRow
                  key={row.cluster.id}
                  row={row}
                  params={params}
                  active={row.cluster.id === activeClusterId}
                />
              ))
            )}
          </nav>

          {/* Next/previous cluster — the journey's own step navigation, which only
              means anything while a cluster is open. */}
          {activeIndex !== -1 && (
            <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
              {previous === undefined ? (
                <span />
              ) : (
                <Link
                  to="/pr/$owner/$repo/$number/cluster/$clusterId"
                  params={{ ...params, clusterId: previous.cluster.id }}
                  id="rail-previous-cluster"
                  className="min-w-0 truncate text-[11px] text-muted transition-colors hover:text-foreground"
                >
                  &larr; {previous.cluster.position} · {previous.cluster.title}
                </Link>
              )}
              {next !== undefined && (
                <Link
                  to="/pr/$owner/$repo/$number/cluster/$clusterId"
                  params={{ ...params, clusterId: next.cluster.id }}
                  id="rail-next-cluster"
                  className="shrink-0 text-[11px] text-muted transition-colors hover:text-foreground"
                >
                  {next.cluster.position} &rarr;
                </Link>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <FileTreeRail />
          <div className="border-t border-border px-3 py-2.5">
            <ChangedOnlySwitch value={changedOnly} onChange={setChangedOnly} />
          </div>
        </>
      )}
    </div>
  );
}

interface ClusterRow {
  readonly cluster: Cluster;
  readonly progress: ClusterProgress;
}

/**
 * Position, title, weight, read progress. The check reads "done at a glance"
 * without a second colour, and the counts are files — the unit the reviewer marks.
 */
function ClusterRailRow({
  row,
  params,
  active,
}: {
  readonly row: ClusterRow;
  readonly params: { readonly owner: string; readonly repo: string; readonly number: string };
  readonly active: boolean;
}) {
  const { cluster, progress } = row;
  return (
    <Link
      to="/pr/$owner/$repo/$number/cluster/$clusterId"
      params={{ ...params, clusterId: cluster.id }}
      id={`rail-cluster-${cluster.position}`}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-2 rounded-md px-2 py-2 transition-colors ${
        active ? "bg-raised" : "hover:bg-raised/60"
      }`}
    >
      {/* The accent marks the current cluster, and only the current cluster. */}
      {active && (
        <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" />
      )}
      <span
        aria-hidden
        className={`w-4 shrink-0 text-right text-[11px] ${active ? "text-foreground" : "text-faint"}`}
      >
        {cluster.position}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-[13px] ${active ? "font-medium text-foreground" : "text-foreground/90"}`}
        >
          {cluster.title}
        </span>
        <WeightLabel weight={cluster.weight} className="block leading-tight" />
      </span>
      <span
        className={`shrink-0 font-mono text-[11px] ${active ? "text-foreground" : "text-muted"}`}
      >
        {progress.complete && (
          <span aria-hidden className="mr-1">
            ✓
          </span>
        )}
        {progress.filesRead}/{progress.filesTotal}
      </span>
    </Link>
  );
}

/**
 * The changed-files filter. Full-tree-with-markers is the default posture, so this
 * is off until the full tree becomes noise. A switch and not a segmented control,
 * because it narrows one thing rather than choosing between two.
 */
function ChangedOnlySwitch({
  value,
  onChange,
}: {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      id="changed-files-only"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="flex cursor-pointer items-center gap-2.5 text-[12px] text-muted transition-colors hover:text-foreground"
    >
      <span
        aria-hidden
        className={`relative h-[16px] w-[28px] shrink-0 rounded-full transition-colors ${
          value ? "bg-foreground" : "bg-border-strong"
        }`}
      >
        <span
          className={`absolute top-[2px] h-[12px] w-[12px] rounded-full bg-card transition-[left] duration-150 ${
            value ? "left-[14px]" : "left-[2px]"
          }`}
        />
      </span>
      Changed files only
    </button>
  );
}
