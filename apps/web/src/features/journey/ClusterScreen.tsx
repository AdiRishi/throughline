import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Cluster, DisplayMode, FileChange, Hint, Hunk, Narrative } from "@app/contracts";
import { computeClusterProgress, markKey, readMarkKeys } from "@app/journey/progress";

import {
  CodeSurface,
  type CodeSurfaceAnnotation,
  type CodeSurfaceFile,
  type CodeSurfaceHandle,
} from "../../journey/CodeSurface.tsx";
import { EMPTY_EMPHASIS, emphasisByFile, hunkRanges } from "../../journey/emphasis.ts";
import { markFileAtom, setDisplayModeAtom } from "../../state/journeyState.ts";
import { Markdown, type EvidenceHandlers } from "../../ui/Markdown.tsx";
import { DiffCounts, Notice, WeightLabel } from "../../ui/primitives.tsx";
import { GuidanceRail } from "./GuidanceRail.tsx";
import { ReadingPanels, useJourney } from "./JourneyLayout.tsx";

/**
 * The cluster page — where a reviewer spends nearly all of their time.
 *
 * One cluster is on screen at a time, and the page is stacked in the order the
 * reviewer needs it:
 *
 * 1. **A compact header.** Position, title, weight, and the cluster's scale. Every
 *    number is derived from the artifact at render time; none of it is stored, so
 *    the page cannot disagree with the partition it is showing.
 * 2. **The narrative leads.** Not a hover, not a sidebar footnote — the prose that
 *    says what this step accomplishes sits where reading starts. It collapses to its
 *    title once the reviewer has begun, so orienting costs nothing on the first
 *    visit and nothing on every scroll-to-top afterward.
 * 3. **The code.** One `CodeSurface` over `cluster.fileOrder`, and **file order is
 *    narrative order** — the sequence the cluster's story wants, never alphabetical.
 *
 * The decision that shapes everything below the narrative: **the full file is
 * always present, and the cluster boundary is carried by emphasis rather than by
 * exclusion.** Hunks homed here are emphasised; hunks homed elsewhere are dimmed and
 * labelled with their home, one click away. That costs some vertical space and buys
 * the product its central claim — the partition becomes *visible*, because every
 * hunk on screen declares where it belongs.
 *
 * Mark-read is the primary interaction of the whole product, so it is one click and
 * one keystroke per file, it lives in the file header where the eye already is, and
 * marking collapses the file so the page shortens as the reviewer advances. The
 * countable unit excludes resurfaced-only files: coverage lives at home, and a
 * hunk resurfaced here and marked here would quietly be counted twice.
 *
 * @module features/journey/ClusterScreen
 */

/** Where the reader is: which file `r` marks, and which region `n`/`p` steps. */
interface Cursor {
  readonly clusterId: string;
  /** Null means "follow the top of the viewport". */
  readonly path: string | null;
  /** -1 means "no region visited yet"; `n` starts at the first. */
  readonly region: number;
}

export function ClusterScreen() {
  const { journey, readState, progress, displayMode, guidanceOpen, setGuidanceOpen } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number/cluster/$clusterId" });
  const navigate = useNavigate();

  const surfaceRef = useRef<CodeSurfaceHandle | null>(null);
  const [visiblePaths, setVisiblePaths] = useState<ReadonlyArray<string>>([]);
  const [cursor, setCursor] = useState<Cursor>({ clusterId: "", path: null, region: -1 });
  const [narrative, setNarrative] = useState<{ clusterId: string; open: boolean } | null>(null);

  const markFile = useAtomSet(markFileAtom);
  const markResult = useAtomValue(markFileAtom);
  const setDisplayMode = useAtomSet(setDisplayModeAtom);

  const clusters = useMemo(
    () => [...journey.clusters].toSorted((left, right) => left.position - right.position),
    [journey.clusters],
  );
  const clusterById = useMemo(
    () => new Map(journey.clusters.map((entry) => [String(entry.id), entry])),
    [journey.clusters],
  );
  const cluster = clusterById.get(params.clusterId) ?? null;

  const changeByPath = useMemo(
    () => new Map(journey.files.map((change) => [change.path, change])),
    [journey.files],
  );
  const deletedPaths = useMemo(
    () =>
      new Set(
        journey.files.filter((change) => change.kind === "deleted").map((change) => change.path),
      ),
    [journey.files],
  );

  const marks = useMemo(
    () => (readState === null ? new Set<string>() : readMarkKeys(readState)),
    [readState],
  );
  const clusterProgress = useMemo(
    () => (cluster === null ? null : computeClusterProgress(cluster, journey.hunks, marks)),
    [cluster, journey.hunks, marks],
  );

  /**
   * Narrative order, taken from progress rather than from `fileOrder` directly.
   * `computeClusterProgress` walks `fileOrder` and then appends any path holding a
   * homed hunk the artifact left out of it — so rendering its list means a homed
   * hunk can never be unreachable, and the cluster can always be completed. Both
   * lists are identical whenever the artifact keeps its own invariant.
   */
  const fileOrder = useMemo<ReadonlyArray<string>>(
    () => clusterProgress?.files.map((entry) => entry.path) ?? [],
    [clusterProgress],
  );

  /** The hunks this cluster resurfaces, indexed for emphasis and for annotations. */
  const resurfaced = useMemo(() => {
    const ids = new Set<string>();
    const notes = new Map<string, Narrative>();
    for (const entry of cluster?.resurfaced ?? []) {
      ids.add(String(entry.hunkId));
      notes.set(String(entry.hunkId), entry.note);
    }
    return { ids, notes };
  }, [cluster?.resurfaced]);

  /** A file present only as a resurfacing shows its home instead of a mark-read control. */
  const resurfacedHomeByPath = useMemo(() => {
    const result = new Map<string, Cluster>();
    for (const hunk of journey.hunks) {
      if (!resurfaced.ids.has(String(hunk.id))) continue;
      if (result.has(hunk.path)) continue;
      const home = clusterById.get(String(hunk.home));
      if (home !== undefined) result.set(hunk.path, home);
    }
    return result;
  }, [journey.hunks, resurfaced.ids, clusterById]);

  const emphasis = useMemo(
    () =>
      cluster === null
        ? new Map<string, never>()
        : emphasisByFile({
            hunks: journey.hunks,
            clusterId: cluster.id,
            resurfacedIds: resurfaced.ids,
          }),
    [cluster, journey.hunks, resurfaced.ids],
  );

  // ── Navigation ────────────────────────────────────────────────────────────

  const openCluster = useCallback(
    (clusterId: string) => {
      void navigate({
        to: "/pr/$owner/$repo/$number/cluster/$clusterId",
        params: { owner: params.owner, repo: params.repo, number: params.number, clusterId },
      });
    },
    [navigate, params.owner, params.repo, params.number],
  );

  const openFile = useCallback(
    (path: string) => {
      void navigate({
        to: "/pr/$owner/$repo/$number/file/$",
        params: { owner: params.owner, repo: params.repo, number: params.number, _splat: path },
      });
    },
    [navigate, params.owner, params.repo, params.number],
  );

  /**
   * Evidence resolution, and the rule behind it: a claim always lands on the code
   * that proves it. If that code is on this page the surface scrolls to it; if it
   * is homed in another cluster the reviewer goes there, because reading it out of
   * its home would break the one-place-per-hunk promise the page is making.
   */
  const evidenceHandlers = useMemo<EvidenceHandlers>(
    () => ({
      onHunk: (hunkId) => {
        const hunk = journey.hunks.find((candidate) => String(candidate.id) === hunkId);
        if (hunk === undefined) return;
        if (!fileOrder.includes(hunk.path)) {
          openCluster(String(hunk.home));
          return;
        }
        const target = scrollTarget(hunk, displayMode, deletedPaths);
        if (target === null) surfaceRef.current?.scrollToFile(hunk.path);
        else surfaceRef.current?.scrollToLine(hunk.path, target.side, target.line);
      },
      onFile: (path) => {
        if (fileOrder.includes(path)) surfaceRef.current?.scrollToFile(path);
        else openFile(path);
      },
      // Framing a symbol needs a symbol index the artifact does not carry, so a
      // symbol resolves to its file — honest, and never a dead link.
      onSymbol: (path) => {
        if (fileOrder.includes(path)) surfaceRef.current?.scrollToFile(path);
        else openFile(path);
      },
    }),
    [journey.hunks, fileOrder, displayMode, deletedPaths, openCluster, openFile],
  );

  // ── The reader's position ─────────────────────────────────────────────────

  const active: Cursor =
    cursor.clusterId === params.clusterId
      ? cursor
      : { clusterId: params.clusterId, path: null, region: -1 };

  // The viewport is the default source of truth; `j`/`k` pin it explicitly. Paths
  // are filtered against this cluster so a stale observation from the previous one
  // can never name the cursor.
  const cursorPath =
    active.path ?? visiblePaths.find((path) => fileOrder.includes(path)) ?? fileOrder[0] ?? null;

  const onVisibleChange = useCallback((paths: ReadonlyArray<string>) => {
    setVisiblePaths(paths);
  }, []);

  const attachSurface = useCallback((handle: CodeSurfaceHandle | null) => {
    surfaceRef.current = handle;
  }, []);

  const toggleRead = useCallback(
    (path: string, read: boolean) => {
      if (cluster === null) return;
      markFile({ journeyId: journey.id, clusterId: cluster.id, path, read });
    },
    [markFile, cluster, journey.id],
  );

  const chooseDisplayMode = useCallback(
    (mode: DisplayMode) => {
      setDisplayMode({ journeyId: journey.id, displayMode: mode });
    },
    [setDisplayMode, journey.id],
  );

  /** Every changed region in a file, in reading order — what `n`/`p` step through. */
  const regionsByPath = useMemo(() => {
    const result = new Map<string, ReadonlyArray<{ side: "old" | "new"; line: number }>>();
    for (const path of fileOrder) {
      const targets = journey.hunks
        .filter((hunk) => hunk.path === path)
        .flatMap((hunk) => {
          const target = scrollTarget(hunk, displayMode, deletedPaths);
          return target === null ? [] : [target];
        })
        .toSorted((left, right) => left.line - right.line);
      result.set(path, targets);
    }
    return result;
  }, [fileOrder, journey.hunks, displayMode, deletedPaths]);

  const cursorIndex = cursorPath === null ? -1 : fileOrder.indexOf(cursorPath);
  const clusterIndex =
    cluster === null ? -1 : clusters.findIndex((entry) => entry.id === cluster.id);
  const previous = clusterIndex <= 0 ? undefined : clusters[clusterIndex - 1];
  const next = clusterIndex === -1 ? undefined : clusters[clusterIndex + 1];

  const moveToFile = useCallback(
    (path: string | undefined) => {
      if (path === undefined) return;
      setCursor({ clusterId: params.clusterId, path, region: -1 });
      surfaceRef.current?.scrollToFile(path);
    },
    [params.clusterId],
  );

  const stepRegion = useCallback(
    (delta: number) => {
      if (cursorPath === null) return;
      const regions = regionsByPath.get(cursorPath) ?? [];
      if (regions.length === 0) return;
      // From `-1` (nothing stepped yet) `n` lands on the first region and `p`
      // clamps to it, so both keys start the reader at the top of the file's changes.
      const nextIndex = Math.min(Math.max(active.region + delta, 0), regions.length - 1);
      const region = regions[nextIndex];
      if (region === undefined) return;
      setCursor({ clusterId: params.clusterId, path: cursorPath, region: nextIndex });
      surfaceRef.current?.scrollToLine(cursorPath, region.side, region.line);
    },
    [cursorPath, regionsByPath, active.region, params.clusterId],
  );

  /**
   * The complete keyboard surface, and nothing beyond it: `r` marks, `j`/`k` walk
   * files, `]`/`[` walk clusters, `n`/`p` walk changed regions. Every one of them
   * is printed in the footer, because a keystroke nobody can discover is not an
   * affordance.
   */
  useEffect(() => {
    if (cluster === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isTypingTarget(event.target)) return;

      // Case-folded, so a reviewer holding shift still marks the file read — the
      // key badges read `R` and the footer reads `r`, and both must work.
      switch (event.key.length === 1 ? event.key.toLowerCase() : event.key) {
        case "r": {
          if (cursorPath === null) break;
          const file = clusterProgress?.files.find((entry) => entry.path === cursorPath);
          if (file === undefined || file.resurfacedOnly) break;
          toggleRead(cursorPath, !file.read);
          break;
        }
        case "j":
          moveToFile(fileOrder[cursorIndex + 1]);
          break;
        case "k":
          moveToFile(cursorIndex <= 0 ? undefined : fileOrder[cursorIndex - 1]);
          break;
        case "]":
          if (next !== undefined) openCluster(String(next.id));
          break;
        case "[":
          if (previous !== undefined) openCluster(String(previous.id));
          break;
        case "n":
          stepRegion(1);
          break;
        case "p":
          stepRegion(-1);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    cluster,
    cursorPath,
    clusterProgress,
    toggleRead,
    moveToFile,
    fileOrder,
    cursorIndex,
    next,
    previous,
    openCluster,
    stepRegion,
  ]);

  // ── The reading surface ───────────────────────────────────────────────────

  const files = useMemo<ReadonlyArray<CodeSurfaceFile>>(() => {
    if (cluster === null) return [];
    return fileOrder.map((path, fileIndex) => {
      const resurfacedHome = resurfacedHomeByPath.get(path);
      const resurfacedOnly =
        clusterProgress?.files.find((entry) => entry.path === path)?.resurfacedOnly ?? false;
      const read = marks.has(markKey(cluster.id, path));
      return {
        path,
        emphasis: emphasis.get(path) ?? EMPTY_EMPHASIS,
        // Marking a file read collapses it: the page shortens as the reviewer
        // advances, which is what makes a ninety-file cluster feel finishable.
        collapsed: read,
        header: (
          <ClusterFileHeader
            path={path}
            index={fileIndex}
            change={changeByPath.get(path)}
            read={read}
            countable={!resurfacedOnly}
            resurfacedHome={resurfacedOnly ? resurfacedHome : undefined}
            displayMode={displayMode}
            isCursor={path === cursorPath}
            onToggleRead={toggleRead}
            onChooseDisplayMode={chooseDisplayMode}
            onOpenCluster={openCluster}
          />
        ),
      };
    });
  }, [
    cluster,
    fileOrder,
    emphasis,
    marks,
    changeByPath,
    clusterProgress,
    resurfacedHomeByPath,
    displayMode,
    cursorPath,
    toggleRead,
    chooseDisplayMode,
    openCluster,
  ]);

  /**
   * Inline labels for the hunks that are *not* simply this cluster's own work.
   *
   * A foreign hunk says where it lives and offers one click to get there. A
   * resurfaced hunk is emphasised like a homed one, so it must announce itself as
   * resurfaced — the distinction between "known code from a new angle" and "new code"
   * is the one the reviewer can never be allowed to lose.
   */
  const annotations = useMemo<ReadonlyArray<CodeSurfaceAnnotation>>(() => {
    if (cluster === null) return [];
    const inCluster = new Set(fileOrder);
    const result: CodeSurfaceAnnotation[] = [];

    for (const hunk of journey.hunks) {
      if (!inCluster.has(hunk.path)) continue;
      const isResurfaced = resurfaced.ids.has(String(hunk.id));
      if (!isResurfaced && hunk.home === cluster.id) continue;

      const target = scrollTarget(hunk, displayMode, deletedPaths);
      // An old-side-only hunk has nothing to attach to where only the head
      // revision is on screen; a file-level hunk has no lines at all and labels
      // the top of the file instead.
      if (target === null && hunkRanges(hunk).length > 0) continue;
      const home = clusterById.get(String(hunk.home));
      if (home === undefined) continue;

      const note = isResurfaced ? resurfaced.notes.get(String(hunk.id)) : undefined;
      result.push({
        path: hunk.path,
        side: target?.side ?? "new",
        line: target?.line ?? 0,
        render: () =>
          isResurfaced ? (
            <ResurfacedLabel home={home} note={note} onOpenCluster={openCluster} />
          ) : (
            <ForeignLabel home={home} onOpenCluster={openCluster} />
          ),
      });
    }
    return result;
  }, [
    cluster,
    fileOrder,
    journey.hunks,
    resurfaced,
    displayMode,
    deletedPaths,
    clusterById,
    openCluster,
  ]);

  const hints = useMemo(() => {
    if (cluster === null) return [];
    // Anchor order, so the rail reads down the page the reviewer is reading. A
    // hint anchored outside this cluster's files (ripple context legitimately
    // points at code the cluster does not touch) sorts last rather than first,
    // which is where `indexOf`'s -1 would otherwise put it.
    const rank = (path: string) => {
      const index = fileOrder.indexOf(path);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    return journey.hints
      .filter((hint) => hint.clusterId === cluster.id)
      .toSorted((left, right) => {
        const byFile = rank(left.anchor.path) - rank(right.anchor.path);
        return byFile === 0 ? left.anchor.startLine - right.anchor.startLine : byFile;
      });
  }, [cluster, journey.hints, fileOrder]);

  const onHintClick = useCallback(
    (hint: Hint) => {
      const { path, side, startLine } = hint.anchor;
      if (fileOrder.includes(path)) surfaceRef.current?.scrollToLine(path, side, startLine);
      else openFile(path);
    },
    [fileOrder, openFile],
  );

  // ── Parked: the URL names a cluster this journey does not have ─────────────

  if (cluster === null || clusterProgress === null) {
    return (
      <ReadingPanels
        middle={
          <div className="flex h-full items-center justify-center p-8">
            <div className="max-w-md">
              <Notice
                title="that cluster is not in this journey"
                action={
                  <Link
                    id="open-overview"
                    to="/pr/$owner/$repo/$number"
                    params={{ owner: params.owner, repo: params.repo, number: params.number }}
                    className="text-[12px] text-accent underline decoration-accent/40 underline-offset-2"
                  >
                    open the overview
                  </Link>
                }
              >
                A reanalysis renumbers the journey, so a link from an older reading can name a
                cluster that no longer exists. The overview has the current sequence.
              </Notice>
            </div>
          </div>
        }
      />
    );
  }

  const narrativeText = cluster.narrative.markdown.trim();
  const narrativeOpen =
    narrative?.clusterId === params.clusterId ? narrative.open : clusterProgress.filesRead === 0;
  const resurfacedCount = cluster.resurfaced.length;

  return (
    <ReadingPanels
      middle={
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="flex shrink-0 items-baseline gap-3 border-b border-border px-6 py-3">
            <span className="font-mono text-[12px] text-faint">{cluster.position}</span>
            <h1 className="truncate text-[15px] font-medium">{cluster.title}</h1>
            <WeightLabel weight={cluster.weight} />
            <p className="ml-auto shrink-0 text-[12px] text-muted">
              {fileOrder.length} files · {clusterProgress.hunksTotal} hunks ·{" "}
              {clusterProgress.filesRead} read
              {resurfacedCount > 0 && ` · ${resurfacedCount} resurfaced`}
              {clusterProgress.complete && <span className="text-foreground"> · complete ✓</span>}
            </p>
          </header>

          {/*
            The narrative leads the page. Collapsed it keeps a one-line preview so
            the reviewer can see *which* story it is without expanding — the full
            prose is always one click away, never only on hover.
          */}
          <section className="shrink-0 border-b border-border px-6 py-3">
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] tracking-[0.12em] text-faint uppercase">narrative</span>
              {!narrativeOpen && clusterProgress.filesRead > 0 && (
                <span className="text-[11px] text-faint">· read ✓</span>
              )}
              {/* Nothing to toggle when the artifact carries no prose for this step. */}
              {narrativeText.length > 0 && (
                <button
                  type="button"
                  id="toggle-narrative"
                  aria-expanded={narrativeOpen}
                  onClick={() =>
                    setNarrative({ clusterId: params.clusterId, open: !narrativeOpen })
                  }
                  className="ml-auto cursor-pointer text-[11px] text-muted transition-colors hover:text-foreground"
                >
                  {narrativeOpen ? "collapse" : "expand"}{" "}
                  <span aria-hidden>{narrativeOpen ? "⌃" : "⌄"}</span>
                </button>
              )}
            </div>
            {narrativeText.length === 0 ? (
              // A journey built on the deterministic floor can reach here. Say so,
              // rather than leaving a labelled void: the partition below still holds.
              <p className="mt-1 text-[13px] text-faint">
                this cluster arrived without a narrative. the code below is still partitioned, and
                every hunk still declares its home.
              </p>
            ) : narrativeOpen ? (
              <div className="tl-fade mt-2 max-h-[32vh] max-w-[78ch] overflow-y-auto pr-2 text-[13px]">
                <Markdown markdown={narrativeText} handlers={evidenceHandlers} />
              </div>
            ) : (
              <p className="mt-1 truncate text-[13px] text-muted">{leadLine(narrativeText)}</p>
            )}
          </section>

          {progress.complete && (
            <section className="tl-rise shrink-0 border-b border-border px-6 py-3">
              <Notice
                title="the journey is complete"
                action={
                  <Link
                    id="open-overview"
                    to="/pr/$owner/$repo/$number"
                    params={{ owner: params.owner, repo: params.repo, number: params.number }}
                    className="text-[12px] text-accent underline decoration-accent/40 underline-offset-2"
                  >
                    back to the overview
                  </Link>
                }
              >
                Every hunk in this pull request was presented at its home cluster and acknowledged
                there — {progress.hunksTotal} hunks across {clusters.length} clusters. The coverage
                guarantee is discharged: nothing was omitted, and nothing was skipped silently.
              </Notice>
            </section>
          )}

          <div className="min-h-0 flex-1">
            <CodeSurface
              journeyId={journey.id}
              files={files}
              displayMode={displayMode}
              annotations={annotations}
              onVisibleChange={onVisibleChange}
              surfaceRef={attachSurface}
              emptyMessage="this cluster's files are not in the pinned revision any more. reanalyze the pull request to rebuild them."
            />
          </div>

          {AsyncResult.isFailure(markResult) && (
            <p className="shrink-0 border-t border-border bg-raised px-6 py-2 text-[11px] text-foreground">
              a read mark did not save, so it is not counted yet — mark the file again.
            </p>
          )}

          {/*
            The keyboard, printed. A keystroke nobody can discover is not an
            affordance — and this is the whole set, which is short enough to say in
            one line. Next/previous cluster is *only* here as a keystroke: the
            journey rail carries that step visibly, at the foot of the journey it
            belongs to, and a second pair of links would be chrome.
          */}
          <footer
            id="reading-keys"
            className="flex shrink-0 items-center justify-center gap-4 border-t border-border px-6 py-2 text-[11px] whitespace-nowrap text-faint"
          >
            <span>
              <Key>r</Key> read
            </span>
            <span>
              <Key>j</Key>
              <Key>k</Key> file
            </span>
            <span>
              <Key>[</Key>
              <Key>]</Key> cluster
            </span>
            <span>
              <Key>n</Key>
              <Key>p</Key> region
            </span>
          </footer>
        </div>
      }
      // Guidance stays in the guidance panel whether it is open or closed: closed
      // it keeps a hand's width, its label, and its count, so closing it is a
      // choice rather than a loss of information.
      right={
        guidanceOpen ? (
          <GuidanceRail
            hints={hints}
            visiblePaths={visiblePaths}
            displayMode={displayMode}
            oldSideBindablePaths={deletedPaths}
            onHintClick={onHintClick}
            evidenceHandlers={evidenceHandlers}
            onCollapse={() => setGuidanceOpen(false)}
          />
        ) : (
          <CollapsedGuidance count={hints.length} onOpen={() => setGuidanceOpen(true)} />
        )
      }
      {...(guidanceOpen ? {} : { rightClassName: "w-10" })}
    />
  );
}

/**
 * Guidance, closed. It keeps its name and how many hints are waiting, because the
 * rail may be closed for good — and a reviewer who cannot see that anything is
 * there has lost the information rather than dismissed it.
 */
function CollapsedGuidance({
  count,
  onOpen,
}: {
  readonly count: number;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-3">
      <button
        type="button"
        id="open-guidance"
        onClick={onOpen}
        title="show guidance"
        aria-label="show guidance"
        aria-expanded={false}
        className="cursor-pointer rounded-sm px-1 text-[13px] text-faint transition-colors hover:text-foreground"
      >
        <span aria-hidden>⇤</span>
      </button>
      <span className="text-[10px] tracking-[0.14em] text-faint uppercase [writing-mode:vertical-rl]">
        guidance
      </span>
      {count > 0 && <span className="font-mono text-[10px] text-faint">{count}</span>}
    </div>
  );
}

/**
 * The per-file header — and the home of the product's primary interaction.
 *
 * It carries exactly the documented set and nothing else: the path, a change-kind
 * hint where the kind is not "modified", the inline/split arrangement (which always
 * sets the journey-wide mode — there is no per-file divergence), and mark-read.
 * There is no collapse toggle: marking read is what collapses a file, and a second
 * control for the same state would be chrome that has not earned its place.
 */
function ClusterFileHeader({
  path,
  index,
  change,
  read,
  countable,
  resurfacedHome,
  displayMode,
  isCursor,
  onToggleRead,
  onChooseDisplayMode,
  onOpenCluster,
}: {
  readonly path: string;
  readonly index: number;
  readonly change: FileChange | undefined;
  readonly read: boolean;
  readonly countable: boolean;
  readonly resurfacedHome: Cluster | undefined;
  readonly displayMode: DisplayMode;
  readonly isCursor: boolean;
  readonly onToggleRead: (path: string, read: boolean) => void;
  readonly onChooseDisplayMode: (mode: DisplayMode) => void;
  readonly onOpenCluster: (clusterId: string) => void;
}) {
  const kind = changeKindHint(change);

  return (
    <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
      <span aria-hidden className="text-[10px] text-faint">
        {read ? "▸" : "▾"}
      </span>
      <span className="truncate font-mono text-[12px]">{path}</span>
      {kind !== null && (
        <span className="shrink-0 rounded border border-border px-1.5 py-px text-[11px] text-faint">
          {kind}
        </span>
      )}
      {change !== undefined && !change.binary && (
        <DiffCounts additions={change.additions} deletions={change.deletions} />
      )}
      {resurfacedHome !== undefined && (
        <button
          type="button"
          onClick={() => onOpenCluster(String(resurfacedHome.id))}
          title={`open cluster ${resurfacedHome.position}`}
          className="shrink-0 cursor-pointer rounded border border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent transition-colors hover:border-accent"
        >
          <span aria-hidden>↻ </span>
          resurfaced · home: {resurfacedHome.position} · {resurfacedHome.title}
        </button>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {countable ? (
          <>
            {/* Hidden in just-the-code: there is no diff there to arrange. */}
            {displayMode !== "just-the-code" && (
              <span className="flex items-center rounded-md border border-border text-[11px]">
                <ModeButton
                  id={`display-inline-${index}`}
                  active={displayMode === "inline"}
                  onClick={() => onChooseDisplayMode("inline")}
                >
                  Inline
                </ModeButton>
                <ModeButton
                  id={`display-split-${index}`}
                  active={displayMode === "split"}
                  onClick={() => onChooseDisplayMode("split")}
                >
                  Split
                </ModeButton>
              </span>
            )}
            <button
              type="button"
              id={`mark-read-${index}`}
              data-path={path}
              aria-pressed={read}
              onClick={() => onToggleRead(path, !read)}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[11px] text-muted transition-colors hover:border-border-strong hover:text-foreground"
            >
              <span aria-hidden>{read ? "✓" : "○"}</span>
              {read ? "Read" : "Mark read"}
              {/* The key badge rides the file `r` would mark, so the keystroke
                  says which file it means before it is pressed. */}
              {isCursor && <Key>R</Key>}
            </button>
          </>
        ) : (
          <span className="text-[11px] text-faint">
            doesn&rsquo;t count here — coverage lives at home
          </span>
        )}
      </div>
    </div>
  );
}

function ModeButton({
  id,
  active,
  onClick,
  children,
}: {
  readonly id: string;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      id={id}
      onClick={onClick}
      className={`cursor-pointer rounded-md px-2 py-1 transition-colors ${
        active ? "bg-raised text-foreground" : "text-faint hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

/** A hunk homed in another cluster: dimmed by emphasis, and told where it lives. */
function ForeignLabel({
  home,
  onOpenCluster,
}: {
  readonly home: Cluster;
  readonly onOpenCluster: (clusterId: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-1.5">
      <button
        type="button"
        onClick={() => onOpenCluster(String(home.id))}
        className="cursor-pointer rounded border border-border px-1.5 py-px font-mono text-[11px] text-muted transition-colors hover:border-border-strong hover:text-foreground"
      >
        home: {home.position} · {home.title}
      </button>
      <span className="truncate text-[11px] text-faint">
        not part of this cluster — one click to its home <span aria-hidden>→</span>
      </span>
    </div>
  );
}

/**
 * A resurfaced hunk. It is emphasised like a homed one, so it has to say out loud that it
 * is known code from a new angle — and carry the note explaining what to see in it
 * this time, where the reviewer is looking rather than in a rail they may have
 * closed.
 */
function ResurfacedLabel({
  home,
  note,
  onOpenCluster,
}: {
  readonly home: Cluster;
  readonly note: Narrative | undefined;
  readonly onOpenCluster: (clusterId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-1.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onOpenCluster(String(home.id))}
          className="cursor-pointer rounded border border-accent/40 px-1.5 py-px font-mono text-[11px] text-accent transition-colors hover:border-accent"
        >
          <span aria-hidden>↻ </span>
          resurfaced · home: {home.position} · {home.title}
        </button>
        <span className="truncate text-[11px] text-faint">
          known code from a new angle — it counts at home
        </span>
      </div>
      {note !== undefined && (
        <div className="max-w-[78ch] text-[12px] leading-relaxed text-muted">
          <Markdown markdown={note.markdown} />
        </div>
      )}
    </div>
  );
}

function Key({ children }: { readonly children: ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1 font-mono text-[10px] text-faint">
      {children}
    </kbd>
  );
}

/**
 * Where a hunk is reachable in the current display mode. The new side is preferred
 * because that is the revision the reviewer is reading; a pure deletion falls back
 * to the old side, which exists in a diff but not in just-the-code — except on a
 * deleted file, where the surface renders the deletion diff because there is no
 * head revision to show in silence.
 */
function scrollTarget(
  hunk: Hunk,
  displayMode: DisplayMode,
  deletedPaths: ReadonlySet<string>,
): { readonly side: "old" | "new"; readonly line: number } | null {
  const ranges = hunkRanges(hunk);
  const preferred = ranges.find((range) => range.side === "new") ?? ranges[0];
  if (preferred === undefined) return null;
  if (preferred.side === "old" && displayMode === "just-the-code" && !deletedPaths.has(hunk.path)) {
    return null;
  }
  return { side: preferred.side, line: preferred.start };
}

function changeKindHint(change: FileChange | undefined): string | null {
  if (change === undefined) return null;
  switch (change.kind) {
    case "added":
      return "new file";
    case "deleted":
      return "deleted";
    case "renamed":
      return change.oldPath === undefined ? "renamed" : `renamed from ${change.oldPath}`;
    case "copied":
      return change.oldPath === undefined ? "copied" : `copied from ${change.oldPath}`;
    case "type-changed":
      return "type changed";
    case "modified":
      return null;
  }
}

/**
 * A one-line preview of the collapsed narrative. Deliberately lossy — it exists so
 * the reviewer can recognise which story this is, never as the narrative's home,
 * which is one click away and unabridged.
 */
function leadLine(markdown: string): string {
  const [paragraph = ""] = markdown.trim().split(/\n{2,}/);
  return paragraph
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/tl:(?:hunk|file|symbol)\/\S+/g, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Never steal a keystroke from a field the reviewer is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}
