/**
 * Free file reading.
 *
 * Sometimes the reviewer just wants to read code, and nothing about being in a
 * review tool should take that away. Opening any file from the tree shows it
 * with every hunk labelled by — and linked to — its home cluster, so even free
 * reading routes back to the journey. Read marks made here and in the journey
 * view are the same marks; there is one read state, viewed two ways.
 *
 * @module features/journey/FilePage
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import type { Cluster, Hunk } from "@app/contracts";

import { CodeSurface, type FileSpec } from "./CodeSurface.tsx";
import { useJourney } from "./context.tsx";
import { RegionBar } from "./RegionBar.tsx";

export function FilePage() {
  const params = useParams({ from: "/pr/$owner/$repo/$number/file/$" });
  const navigate = useNavigate();
  const { journey, markFile, isFileRead, guidanceOpen, setGuidanceOpen } = useJourney();

  const path = params._splat ?? "";

  const files = useMemo((): ReadonlyArray<FileSpec> => {
    const byId = new Map(journey.clusters.map((entry) => [entry.id, entry]));
    const hunks = journey.hunks.filter((hunk) => hunk.path === path);
    const foreign: Array<{ hunk: Hunk; home: Cluster | undefined }> = hunks.map((hunk) => ({
      hunk,
      home: byId.get(hunk.home),
    }));

    return [
      {
        path,
        change: journey.files.find((file) => file.path === path),
        // From the file side every hunk is "somewhere else's" — the labels are
        // the point, and emphasis belongs to the cluster pages.
        homed: [],
        foreign,
        resurfaced: [],
        markable: null,
      },
    ];
  }, [journey, path]);

  /** The clusters this file participates in, so read marks stay reachable here. */
  const participating = useMemo(() => {
    const ids = new Set(
      journey.hunks.filter((hunk) => hunk.path === path).map((hunk) => hunk.home),
    );
    return journey.clusters
      .filter((cluster) => ids.has(cluster.id))
      .toSorted((left, right) => left.position - right.position);
  }, [journey, path]);

  const goToCluster = useCallback(
    (clusterId: string) =>
      void navigate({
        to: "/pr/$owner/$repo/$number/cluster/$clusterId",
        params: {
          owner: params.owner,
          repo: params.repo,
          number: params.number,
          clusterId,
        },
      }),
    [navigate, params],
  );

  const changed = journey.files.some((file) => file.path === path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-9 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-muted">
          {path.split("/").map((segment, index, all) => (
            <span key={`${segment}-${index}`} className="flex items-center gap-1.5">
              <span className={index === all.length - 1 ? "text-foreground" : ""}>{segment}</span>
              {index < all.length - 1 && <span className="text-faint">›</span>}
            </span>
          ))}
          {!changed && <span className="ml-2 text-faint">· unchanged in this PR</span>}
        </div>
        {!guidanceOpen && (
          <button
            type="button"
            onClick={() => setGuidanceOpen(true)}
            className="shrink-0 cursor-pointer rounded border border-border px-1.5 py-[1px] font-mono text-[11px] text-faint transition-colors hover:border-border-strong hover:text-foreground"
          >
            |← guidance
          </button>
        )}
      </header>

      {participating.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[12px]">
          <span className="text-faint">Homes hunks in</span>
          {participating.map((cluster) => {
            const read = isFileRead(cluster.id, path);
            return (
              <span
                key={cluster.id}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-[2px]"
              >
                <button
                  type="button"
                  onClick={() => goToCluster(cluster.id)}
                  className="cursor-pointer text-muted transition-colors hover:text-foreground"
                >
                  {cluster.position} · {cluster.title}
                </button>
                <button
                  type="button"
                  title={read ? "Unmark read" : "Mark read in this cluster"}
                  onClick={() => markFile(cluster.id, path, !read)}
                  className={`ml-1 cursor-pointer rounded-full border px-1.5 text-[10px] transition-colors ${
                    read
                      ? "border-foreground bg-foreground text-background"
                      : "border-border-strong text-faint hover:text-foreground"
                  }`}
                >
                  {read ? "read" : "mark"}
                </button>
              </span>
            );
          })}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <CodeSurface
          files={files}
          surface="file"
          onOpenCluster={goToCluster}
          emptyMessage={`${path} isn’t available from this journey’s workspace.`}
        />
      </div>

      <RegionBar>
        <span className="truncate">{path}</span>
        <span className="text-faint">{changed ? "head revision" : "unchanged"}</span>
      </RegionBar>
    </div>
  );
}
