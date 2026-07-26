/**
 * The journey rail: the Overview entry, then the ordered clusters.
 *
 * Each row shows exactly four things — position, title, weight, read progress.
 * No badge rows, no colour chips, no counts-of-counts: everything else about a
 * cluster lives in the middle panel when it is selected, and nothing essential
 * is ever behind a hover.
 *
 * @module features/journey/JourneyRail
 */
import { Link, useParams } from "@tanstack/react-router";

import { WeightLabel } from "../../ui/primitives.tsx";
import { useJourney } from "./context.tsx";

export function JourneyRail() {
  const { journey, progress, stale } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const routeParams = { owner: params.owner, repo: params.repo, number: params.number };

  const percent = Math.round(
    (progress.hunksHomed === 0 ? 0 : progress.hunksRead / progress.hunksHomed) * 100,
  );
  return (
    <nav className="flex h-full flex-col overflow-y-auto">
      <div className="px-3 pb-3">
        <div className="flex items-baseline justify-between text-[12px]">
          <span className="text-muted">Journey</span>
          <span className="text-muted tabular-nums">
            {percent}% · {progress.filesRead} of {progress.filesTotal} files
          </span>
        </div>
        <span className="mt-1.5 block h-[3px] overflow-hidden rounded-full bg-border">
          <span
            className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </span>
        {stale && (
          <p className="mt-2 text-[11px] text-muted">
            <span className="mr-1.5 rounded border border-border-strong px-1 py-[1px] font-mono text-[9px] tracking-wider">
              STALE
            </span>
            pinned to <span className="font-mono">{journey.pinned.headSha.slice(0, 7)}</span> · the
            PR moved ahead
          </p>
        )}
      </div>

      <div className="px-2 pb-6">
        <Link
          to="/pr/$owner/$repo/$number"
          params={routeParams}
          activeOptions={{ exact: true }}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors hover:bg-raised data-[status=active]:bg-raised data-[status=active]:font-medium"
        >
          <span className="w-3 shrink-0 text-center font-mono text-[11px] text-faint">§</span>
          <span>Overview</span>
        </Link>

        {journey.clusters.map((cluster) => {
          const clusterProgress = progress.clusters.find((entry) => entry.clusterId === cluster.id);
          const complete = clusterProgress?.complete === true;
          return (
            <Link
              key={cluster.id}
              to="/pr/$owner/$repo/$number/cluster/$clusterId"
              params={{ ...routeParams, clusterId: cluster.id }}
              className="mt-0.5 flex items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors hover:bg-raised data-[status=active]:bg-raised"
            >
              <span className="mt-[2px] w-3 shrink-0 text-center font-mono text-[11px] text-faint">
                {cluster.position}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-tight">{cluster.title}</span>
                <WeightLabel weight={cluster.weight} className="mt-0.5 block" />
              </span>
              <span
                className={`mt-[1px] shrink-0 font-mono text-[11px] tabular-nums ${
                  complete ? "text-foreground" : "text-faint"
                }`}
              >
                {complete && <span className="mr-0.5">✓</span>}
                {clusterProgress?.filesRead ?? 0}/{clusterProgress?.filesTotal ?? 0}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
