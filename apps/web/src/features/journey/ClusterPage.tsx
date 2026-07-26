/**
 * The cluster page: one step of the journey, worked to completion.
 *
 * The narrative leads, because that is where reading starts — never behind a
 * hover, never a sidebar footnote. Below it, every file this cluster touches as
 * a full file diff in the cluster's own narrative order, with the cluster
 * boundary carried by emphasis rather than by exclusion.
 *
 * @module features/journey/ClusterPage
 */
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Cluster, Hunk } from "@app/contracts";
import { clusterScale } from "@app/journey/progress";

import { Narrative, type EvidenceTarget } from "../../lib/markdown.tsx";
import { formatCount, WeightLabel } from "../../ui/primitives.tsx";
import { CodeSurface, type FileSpec } from "./CodeSurface.tsx";
import { useJourney } from "./context.tsx";
import { RegionBar } from "./RegionBar.tsx";

export function ClusterPage() {
  const params = useParams({ from: "/pr/$owner/$repo/$number/cluster/$clusterId" });
  const navigate = useNavigate();
  const {
    journey,
    progress,
    markFile,
    isFileRead,
    guidanceOpen,
    setGuidanceOpen,
    requestScroll,
    labelForHunk,
  } = useJourney();

  const cluster = journey.clusters.find((entry) => entry.id === params.clusterId) ?? null;
  const [narrativeOpen, setNarrativeOpen] = useState(true);

  // Expanded on arrival, collapsing to its title once read: it orients without
  // taxing every scroll-to-top afterwards.
  useEffect(() => {
    setNarrativeOpen(true);
  }, [params.clusterId]);

  const files = useMemo((): ReadonlyArray<FileSpec> => {
    if (cluster === null) return [];
    const byId = new Map(journey.clusters.map((entry) => [entry.id, entry]));
    const resurfacedById = new Map(cluster.resurfaced.map((entry) => [entry.hunkId, entry.note]));

    return cluster.fileOrder.map((path): FileSpec => {
      const hunks = journey.hunks.filter((hunk) => hunk.path === path);
      const homed: Hunk[] = [];
      const foreign: Array<{ hunk: Hunk; home: Cluster | undefined }> = [];
      const resurfaced: Array<{
        hunk: Hunk;
        home: Cluster | undefined;
        note: { markdown: string };
      }> = [];

      for (const hunk of hunks) {
        const note = resurfacedById.get(hunk.id);
        if (note !== undefined) {
          resurfaced.push({ hunk, home: byId.get(hunk.home), note });
        } else if (hunk.home === cluster.id) {
          homed.push(hunk);
        } else {
          foreign.push({ hunk, home: byId.get(hunk.home) });
        }
      }

      return {
        path,
        change: journey.files.find((file) => file.path === path),
        homed,
        foreign,
        resurfaced,
        // Resurfaced hunks do not count toward this cluster's progress, so a
        // file that only appears here as a revisit is not markable here.
        markable:
          homed.length > 0 ? { clusterId: cluster.id, read: isFileRead(cluster.id, path) } : null,
      };
    });
  }, [cluster, isFileRead, journey]);

  const onMark = useCallback(
    (path: string, read: boolean) => {
      if (cluster === null) return;
      markFile(cluster.id, path, read);
    },
    [cluster, markFile],
  );

  // Mark-read is the primary interaction of the whole product: one click, or
  // one keystroke on the first unread file in the cluster.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key !== "r" && event.key !== "R") return;
      const next = files.find((file) => file.markable !== null && !file.markable.read);
      if (next === undefined) return;
      event.preventDefault();
      onMark(next.path, true);
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [files, onMark]);

  if (cluster === null) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-muted">
        That cluster isn’t part of this journey.
      </div>
    );
  }

  const clusterProgress = progress.clusters.find((entry) => entry.clusterId === cluster.id);
  const scale = clusterScale(cluster, journey.hunks);
  const position = cluster.position;
  const previous = journey.clusters.find((entry) => entry.position === position - 1) ?? null;
  const next = journey.clusters.find((entry) => entry.position === position + 1) ?? null;

  const onEvidence = (target: EvidenceTarget) => {
    if (target.kind === "hunk") {
      requestScroll({ kind: "hunk", hunkId: target.hunkId });
      return;
    }
    const inCluster = cluster.fileOrder.includes(target.path);
    if (inCluster) {
      requestScroll({ kind: "file", path: target.path });
      return;
    }
    void navigate({
      to: "/pr/$owner/$repo/$number/file/$",
      params: {
        owner: params.owner,
        repo: params.repo,
        number: params.number,
        _splat: target.path,
      },
    });
  };

  const goToCluster = (clusterId: string) =>
    void navigate({
      to: "/pr/$owner/$repo/$number/cluster/$clusterId",
      params: {
        owner: params.owner,
        repo: params.repo,
        number: params.number,
        clusterId,
      },
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border px-5 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[13px] text-faint">{position}</span>
            <h1 className="text-[17px] font-semibold tracking-tight">{cluster.title}</h1>
            <WeightLabel weight={cluster.weight} />
          </div>
          <div className="flex shrink-0 items-center gap-3 font-mono text-[11.5px] text-faint">
            <span>
              {formatCount(scale.filesTouched)} files · {formatCount(scale.hunksHomed)} hunks ·{" "}
              {clusterProgress?.filesRead ?? 0} read
            </span>
            {!guidanceOpen && (
              <button
                type="button"
                onClick={() => setGuidanceOpen(true)}
                className="cursor-pointer rounded border border-border px-1.5 py-[1px] transition-colors hover:border-border-strong hover:text-foreground"
              >
                |← guidance
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-md border border-border bg-surface px-3.5 py-2.5">
          <div className="flex items-baseline justify-between gap-4">
            <span className="font-mono text-[10.5px] tracking-[0.14em] text-faint uppercase">
              Narrative
              {clusterProgress?.complete === true && (
                <span className="ml-2 tracking-normal text-muted normal-case">· read ✓</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setNarrativeOpen((value) => !value)}
              className="cursor-pointer text-[12px] text-muted transition-colors hover:text-foreground"
            >
              {narrativeOpen ? "collapse ⌃" : "expand ⌄"}
            </button>
          </div>
          {narrativeOpen && (
            <div className="mt-1.5 max-w-3xl text-[14px] leading-[1.65]">
              <Narrative
                labelForHunk={labelForHunk}
                markdown={cluster.narrative.markdown}
                onEvidence={onEvidence}
              />
            </div>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <CodeSurface
          files={files}
          onMark={onMark}
          onOpenCluster={goToCluster}
          emptyMessage="This cluster's files couldn't be loaded from the run directory."
        />
      </div>

      <RegionBar>
        {previous === null ? (
          <span className="text-faint">start of the journey</span>
        ) : (
          <button
            type="button"
            onClick={() => goToCluster(previous.id)}
            className="cursor-pointer truncate transition-colors hover:text-foreground"
          >
            ← {previous.position} · {previous.title}
          </button>
        )}
        {next === null ? (
          <span className="text-faint">end of the journey</span>
        ) : (
          <button
            type="button"
            onClick={() => goToCluster(next.id)}
            className="cursor-pointer truncate transition-colors hover:text-foreground"
          >
            {next.position} · {next.title} →
          </button>
        )}
      </RegionBar>
    </div>
  );
}
