import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Cluster, ClusterId, DisplayMode, Hint } from "@app/contracts";
import { markKey, readMarkKeys } from "@app/journey/progress";

import {
  CodeSurface,
  type CodeSurfaceAnnotation,
  type CodeSurfaceFile,
  type CodeSurfaceHandle,
} from "../../journey/CodeSurface.tsx";
import {
  emphasisByFile,
  EMPTY_EMPHASIS,
  hunkRanges,
  type FileEmphasis,
  type SideRange,
} from "../../journey/emphasis.ts";
import { isTypingTarget } from "../../journey/keys.ts";
import { markFileAtom } from "../../state/journeyState.ts";
import type { EvidenceHandlers } from "../../ui/Markdown.tsx";
import { Fact, QuietButton, Separator } from "../../ui/primitives.tsx";
import { GuidanceRail } from "./GuidanceRail.tsx";
import { ReadingPanels, useJourney } from "./JourneyLayout.tsx";

/**
 * Free file reading.
 *
 * Sometimes the reviewer just wants to read code, and nothing about being in a
 * review tool should take that away. So the file tree is the project's real tree
 * and any path in it is openable — including paths the pull request never touched.
 *
 * The tension this screen resolves: reading freely must not drop the reviewer out
 * of the journey. It resolves it by **labelling every changed region with its home
 * cluster and linking there**, and by sharing one read state with the cluster page.
 * There is no second set of marks to reconcile — a file marked read here is read in
 * the journey, because a read mark is a (cluster, path) pair and this screen writes
 * the same pair the cluster page does.
 *
 * Three judgement calls, each following from a product rule:
 *
 * 1. **Accent keeps its one meaning.** The accent means "the current cluster's
 *    hunks" and free reading has no open cluster. So it is spent only when the
 *    reviewer *arrived from* one — carried in `?from=<clusterId>`, read leniently so
 *    a link without it still works. With no arrival cluster there is no accent at
 *    all, and every region is oriented by its home label instead.
 * 2. **Tabs are renderer ephemera.** The URL holds one thing: which file is open.
 *    The tab list is component state, so a reload lands on the file rather than on
 *    a restored workspace the reviewer never asked to keep.
 * 3. **An unchanged file renders as plain code**, whatever the journey's display
 *    mode is. A diff view of a file with no diff would be a pretence.
 * 4. **One keyboard language.** Reading is one experience on two screens, so the
 *    keystrokes are the cluster page's: `r` marks read, `n`/`p` walk the changed
 *    regions. Each is printed beside its click, never only in a tooltip.
 *
 * @module features/journey/FileScreen
 */

/** Nothing is ever resurfaced *into* free reading; there is no cluster to resurface into. */
const NO_RESURFACING: ReadonlySet<string> = new Set();

const FILE_ROUTE = "/pr/$owner/$repo/$number/file/$" as const;
const CLUSTER_ROUTE = "/pr/$owner/$repo/$number/cluster/$clusterId" as const;
const JOURNEY_ROUTE = "/pr/$owner/$repo/$number" as const;

/** The parent route's params, which every link off this screen has to carry. */
interface PrRouteParams {
  readonly owner: string;
  readonly repo: string;
  readonly number: string;
}

/** One walkable changed region: where the next-change control lands. */
interface Region {
  readonly side: "old" | "new";
  readonly line: number;
}

/**
 * A home cluster present in the open file. Membership comes from the partition, so
 * a cluster that homes only deleted lines is still listed (the file is marked read
 * for it either way); the count is of regions actually *drawn*, so the legend never
 * promises markers the display mode cannot show.
 */
interface HomeGroup {
  readonly cluster: Cluster;
  readonly regions: number;
}

/**
 * One of the file's hunks, resolved against what is on screen. Computed once and
 * used three times — the home labels, the region walk, and the footer legend — so
 * those three can never disagree about how much of the file is where.
 */
interface PlacedHunk {
  readonly home: Cluster;
  /** Null for a file-level change (binary, rename, mode): nothing to point at. */
  readonly anchor: SideRange | null;
}

export function FileScreen() {
  const params = useParams({ from: FILE_ROUTE });
  const path = params._splat ?? "";
  const routeParams = useMemo<PrRouteParams>(
    () => ({ owner: params.owner, repo: params.repo, number: params.number }),
    [params.owner, params.repo, params.number],
  );

  const navigate = useNavigate();
  const { journey, readState, displayMode, guidanceOpen, setGuidanceOpen, setRailMode } =
    useJourney();

  const surfaceHandle = useRef<CodeSurfaceHandle | null>(null);
  const setSurfaceHandle = useCallback((handle: CodeSurfaceHandle | null) => {
    surfaceHandle.current = handle;
  }, []);

  /**
   * Arriving from a narrative's `tl:file/…` link should put the left rail in the
   * posture that matches what is on screen — the project's tree. Once, on mount:
   * the segmented control stays the reviewer's to move afterwards.
   */
  useEffect(() => {
    setRailMode("files");
  }, [setRailMode]);

  // ── The arrival cluster ───────────────────────────────────────────────────
  //
  // Read from the raw search string rather than a typed search schema: the route
  // deliberately carries no schema (location is the URL's only job here), and a
  // link that omits `from` must still open the file.
  const location = useLocation();
  const fromParam = new URLSearchParams(location.searchStr).get("from");
  // Sticky across tab switches. Switching tabs is not leaving the cluster, so the
  // emphasis must not flip out from under the reviewer mid-session.
  const [arrivalId, setArrivalId] = useState<string | null>(fromParam);
  if (fromParam !== null && fromParam !== arrivalId) setArrivalId(fromParam);
  const arrival = useMemo(
    () => journey.clusters.find((cluster) => cluster.id === arrivalId) ?? null,
    [journey.clusters, arrivalId],
  );

  // ── Tabs ──────────────────────────────────────────────────────────────────

  const [tabs, setTabs] = useState<ReadonlyArray<string>>(() => (path === "" ? [] : [path]));
  /**
   * Closing the active tab navigates, and navigation lands a render or more later,
   * so for those renders the URL still names the file that was just closed. Without
   * remembering that, the render-time reconcile below would put the closed tab
   * straight back. Cleared the moment the route moves on, so the same path can be
   * opened again from the tree.
   */
  const closing = useRef<string | null>(null);
  if (closing.current !== null && closing.current !== path) closing.current = null;
  // Reconciled during render rather than in an effect: the tab strip must never
  // render a frame that is missing the file the URL already names.
  if (path !== "" && closing.current !== path && !tabs.includes(path)) setTabs([...tabs, path]);

  const openTab = useCallback(
    (next: string) => {
      void navigate({ to: FILE_ROUTE, params: { ...routeParams, _splat: next } });
    },
    [navigate, routeParams],
  );

  const closeTab = useCallback(
    (target: string) => {
      const index = tabs.indexOf(target);
      const remaining = tabs.filter((tab) => tab !== target);
      setTabs(remaining);
      if (target !== path) return;
      closing.current = target;
      const neighbour = remaining[Math.min(index, remaining.length - 1)];
      if (neighbour !== undefined) {
        openTab(neighbour);
        return;
      }
      // Nothing left open: back into the journey, at the cluster the reviewer came
      // from when that is known, and at the Overview when it is not.
      void (arrival === null
        ? navigate({ to: JOURNEY_ROUTE, params: routeParams })
        : navigate({ to: CLUSTER_ROUTE, params: { ...routeParams, clusterId: arrival.id } }));
    },
    [tabs, path, openTab, arrival, navigate, routeParams],
  );

  // ── The file's place in the partition ─────────────────────────────────────

  const fileHunks = useMemo(
    () => journey.hunks.filter((hunk) => hunk.path === path),
    [journey.hunks, path],
  );
  const changed = useMemo(
    () => journey.files.some((file) => file.path === path),
    [journey.files, path],
  );
  /**
   * A deleted file has no head revision to show in silence, so just-the-code falls
   * back to its deletion diff — which means its old side is on screen there, and
   * old-side hunks still have somewhere to be labelled and scrolled to.
   */
  const deleted = useMemo(
    () => journey.files.some((file) => file.path === path && file.kind === "deleted"),
    [journey.files, path],
  );

  /**
   * A file outside the changed set has no patch, so it can only ever render as
   * plain code — the journey-wide mode does not apply to a file with no diff.
   */
  const surfaceMode: DisplayMode = changed ? displayMode : "just-the-code";

  /** Whether the old side is rendered at all: what a label or a region can anchor to. */
  const oldSideOnScreen = surfaceMode !== "just-the-code" || deleted;

  /**
   * The one pass. A hunk whose home the artifact does not carry is skipped rather
   * than labelled with a cluster nobody can open, and a hunk with lines only on a
   * side that is not rendered is left out of both the labels and the walk.
   */
  const placed = useMemo<ReadonlyArray<PlacedHunk>>(() => {
    const byId = new Map<string, Cluster>(
      journey.clusters.map((cluster) => [cluster.id as string, cluster]),
    );
    const entries: PlacedHunk[] = [];
    for (const hunk of fileHunks) {
      const home = byId.get(hunk.home);
      if (home === undefined) continue;
      const ranges = hunkRanges(hunk);
      const anchor = anchorRange(ranges, oldSideOnScreen);
      if (anchor === null && ranges.length > 0) continue;
      entries.push({ home, anchor });
    }
    return entries;
  }, [fileHunks, journey.clusters, oldSideOnScreen]);

  /** Every home cluster represented in this file, in journey order. */
  const homeGroups = useMemo<ReadonlyArray<HomeGroup>>(() => {
    const homed = new Set<string>(fileHunks.map((hunk) => hunk.home));
    const drawn = new Map<string, number>();
    for (const entry of placed) {
      if (entry.anchor === null) continue;
      drawn.set(entry.home.id, (drawn.get(entry.home.id) ?? 0) + 1);
    }
    return journey.clusters
      .filter((cluster) => homed.has(cluster.id))
      .toSorted((left, right) => left.position - right.position)
      .map((cluster) => ({ cluster, regions: drawn.get(cluster.id) ?? 0 }));
  }, [fileHunks, placed, journey.clusters]);

  /** Which clusters home each *open tab*, precomputed once — hunks run to tens of thousands. */
  const homesByPath = useMemo(() => {
    const map = new Map<string, Set<ClusterId>>();
    for (const hunk of journey.hunks) {
      const existing = map.get(hunk.path);
      if (existing === undefined) map.set(hunk.path, new Set([hunk.home]));
      else existing.add(hunk.home);
    }
    return map;
  }, [journey.hunks]);

  // ── Emphasis: by home, not by open cluster ────────────────────────────────

  const emphasis = useMemo<FileEmphasis>(() => {
    if (fileHunks.length === 0) return EMPTY_EMPHASIS;
    /**
     * With no arrival cluster there is nothing to accent, so the two modes part
     * ways. Just-the-code keeps the neutral margin markers — they are the *only*
     * orientation once the diff UI falls away. A diff already shows what changed,
     * and dimming every hunk there would fade the whole file the reviewer opened
     * to read.
     */
    if (arrival === null && surfaceMode !== "just-the-code") return EMPTY_EMPHASIS;
    // A cluster id no cluster owns focuses nothing and dims every homed hunk,
    // which is exactly the no-arrival reading.
    return (
      emphasisByFile({
        hunks: fileHunks,
        clusterId: arrival?.id ?? "",
        resurfacedIds: NO_RESURFACING,
      }).get(path) ?? EMPTY_EMPHASIS
    );
  }, [fileHunks, arrival, surfaceMode, path]);

  /** The footer legend explains margin markers, so it only shows bars when there are any. */
  const markersDrawn = emphasis.focus.length > 0 || emphasis.dim.length > 0;

  const files = useMemo<ReadonlyArray<CodeSurfaceFile>>(
    () => [{ path, emphasis, collapsed: false, header: null }],
    [path, emphasis],
  );

  // ── Region navigation ─────────────────────────────────────────────────────

  const regions = useMemo<ReadonlyArray<Region>>(
    () =>
      placed
        // A file-level hunk (binary, rename, mode change) has no lines to walk to.
        .flatMap((entry) =>
          entry.anchor === null ? [] : [{ side: entry.anchor.side, line: entry.anchor.start }],
        )
        .toSorted((left, right) => left.line - right.line),
    [placed],
  );

  /**
   * A cursor, not a scroll position: the surface reports which *files* are on
   * screen, not which line, so this is where the reviewer last *stepped*. It
   * therefore starts at "nowhere yet" — claiming region 1 before the reviewer has
   * been taken there would be a readout that is simply untrue, and the first step
   * would then skip it. Keyed by path so switching tabs starts over.
   */
  const [cursor, setCursor] = useState<{ readonly path: string; readonly index: number }>({
    path,
    index: -1,
  });
  const regionIndex = cursor.path === path ? cursor.index : -1;

  const step = useCallback(
    (delta: number) => {
      if (regions.length === 0) return;
      const next =
        regionIndex < 0
          ? delta > 0
            ? 0
            : regions.length - 1
          : (regionIndex + delta + regions.length) % regions.length;
      setCursor({ path, index: next });
      const region = regions[next];
      if (region !== undefined) surfaceHandle.current?.scrollToLine(path, region.side, region.line);
    },
    [regions, regionIndex, path],
  );

  // ── Home labels on every region ───────────────────────────────────────────

  const annotations = useMemo<ReadonlyArray<CodeSurfaceAnnotation>>(
    () =>
      placed.map((entry) => ({
        path,
        side: entry.anchor?.side ?? "new",
        // Line 0 renders above the file's first line, which is where a whole-file
        // change (binary, rename, mode) belongs.
        line: entry.anchor?.start ?? 0,
        render: () => <HomeLabel cluster={entry.home} routeParams={routeParams} />,
      })),
    [placed, path, routeParams],
  );

  // ── Read state: the same marks the cluster page writes ────────────────────

  const marks = useMemo(
    () => (readState === null ? new Set<string>() : readMarkKeys(readState)),
    [readState],
  );
  const markFile = useAtomSet(markFileAtom);
  const markResult = useAtomValue(markFileAtom);
  const markFailed = AsyncResult.isFailure(markResult);

  const soleHome = homeGroups.length === 1 ? (homeGroups[0]?.cluster ?? null) : null;
  const soleHomeRead = soleHome !== null && marks.has(markKey(soleHome.id, path));

  const toggleRead = useCallback(() => {
    if (soleHome === null) return;
    markFile({
      journeyId: journey.id,
      clusterId: soleHome.id,
      path,
      read: !soleHomeRead,
    });
  }, [soleHome, soleHomeRead, markFile, journey.id, path]);

  /**
   * The same keystrokes the cluster page binds, because reading is one experience
   * on two screens: `r` marks read, `n`/`p` walk the changed regions. Both are
   * printed on screen — a keystroke nobody can discover is not an affordance — and
   * both are no-ops when the file has nothing to mark or no regions to walk.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (isTypingTarget(event.target)) return;
      switch (event.key) {
        case "n":
          step(1);
          break;
        case "p":
          step(-1);
          break;
        case "r":
          if (soleHome === null) return;
          toggleRead();
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, soleHome, toggleRead]);

  // ── Guidance ──────────────────────────────────────────────────────────────

  /**
   * Every hint anchored in this file, whichever cluster it rides — free reading has
   * no open cluster to filter by, and a hint about code on screen is guidance about
   * code on screen. Sorted by anchor because the rail reads top to bottom with the
   * file. Whether an old-side anchor can bind is the rail's judgement, not this
   * screen's — it owns that rule for every surface.
   */
  const hints = useMemo<ReadonlyArray<Hint>>(
    () =>
      journey.hints
        .filter((hint) => hint.anchor.path === path)
        .toSorted((left, right) => left.anchor.startLine - right.anchor.startLine),
    [journey.hints, path],
  );

  const oldSideBindablePaths = useMemo<ReadonlySet<string>>(
    () => (deleted ? new Set([path]) : new Set<string>()),
    [deleted, path],
  );

  const [visiblePaths, setVisiblePaths] = useState<ReadonlyArray<string>>([]);
  const onVisibleChange = useCallback((paths: ReadonlyArray<string>) => setVisiblePaths(paths), []);
  const onHintClick = useCallback((hint: Hint) => {
    surfaceHandle.current?.scrollToLine(hint.anchor.path, hint.anchor.side, hint.anchor.startLine);
  }, []);

  /**
   * Evidence in a hint's narrative navigates the way it does everywhere else. On
   * this screen "go to a hunk" means: scroll to it when it is in the open file,
   * and otherwise open the file that holds it — free reading stays free.
   */
  const evidenceHandlers = useMemo<EvidenceHandlers>(
    () => ({
      onHunk: (hunkId) => {
        const hunk = journey.hunks.find((candidate) => candidate.id === hunkId);
        if (hunk === undefined) return;
        if (hunk.path !== path) {
          openTab(hunk.path);
          return;
        }
        const anchor = anchorRange(hunkRanges(hunk), oldSideOnScreen);
        if (anchor !== null) surfaceHandle.current?.scrollToLine(path, anchor.side, anchor.start);
      },
      onFile: (target) => openTab(target),
      // There is no symbol index in the artifact, so a symbol resolves as far as
      // its file. Claiming a line we cannot know would be worse than not moving.
      onSymbol: (target) => openTab(target),
    }),
    [journey.hunks, path, oldSideOnScreen, openTab],
  );

  // ── Render ────────────────────────────────────────────────────────────────

  if (path === "") {
    return (
      <ReadingPanels
        middle={
          <Parked title="no file open">
            open a file from the tree to read it here. every changed region will name the cluster it
            is homed in.
          </Parked>
        }
      />
    );
  }

  return (
    <ReadingPanels
      middle={
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            id="file-tabs"
            role="tablist"
            aria-label="open files"
            className="flex h-[38px] shrink-0 items-stretch overflow-x-auto border-b border-border bg-card"
          >
            {tabs.map((tab, index) => (
              <Tab
                key={tab}
                index={index}
                path={tab}
                label={tabLabel(tab, tabs)}
                active={tab === path}
                marker={readMarker(homesByPath.get(tab), tab, marks)}
                onOpen={openTab}
                onClose={closeTab}
              />
            ))}
          </div>

          <div className="flex h-[34px] shrink-0 items-center justify-between gap-4 border-b border-border px-4">
            <Breadcrumb path={path} />
            <div className="flex shrink-0 items-center gap-3 text-[12px]">
              {markFailed && (
                <span className="text-muted">that read mark didn&rsquo;t persist</span>
              )}
              {soleHome !== null && (
                <QuietButton
                  id="mark-read"
                  onClick={toggleRead}
                  title={
                    soleHomeRead
                      ? "clear this file's read mark for its home cluster"
                      : "mark this file read for its home cluster"
                  }
                >
                  <span className="flex max-w-[22rem] items-center gap-1.5 truncate">
                    {soleHomeRead && <span aria-hidden>✓</span>}
                    {soleHomeRead ? "read for" : "mark read for"}{" "}
                    <span className="font-mono">{soleHome.position}</span> · {soleHome.title}
                    {/* The keystroke is printed beside the click, so the product's
                        primary interaction has both of the homes the docs ask for. */}
                    <Chord>r</Chord>
                  </span>
                </QuietButton>
              )}
              {homeGroups.length > 1 && (
                // Hunks spanning several clusters are never guessed at: the file is
                // marked read where it is homed, one cluster at a time.
                <span className="text-muted">
                  homed in {homeGroups.length} clusters —{" "}
                  {homeGroups.map((group, index) => (
                    <Fragment key={group.cluster.id}>
                      {index > 0 && ", "}
                      <Link
                        to={CLUSTER_ROUTE}
                        params={{ ...routeParams, clusterId: group.cluster.id }}
                        className="font-mono text-muted underline decoration-border-strong underline-offset-2 transition-colors hover:text-foreground"
                      >
                        {group.cluster.position}
                      </Link>
                    </Fragment>
                  ))}{" "}
                  · mark read on each cluster&rsquo;s page
                </span>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <CodeSurface
              journeyId={journey.id}
              files={files}
              displayMode={surfaceMode}
              annotations={annotations}
              onVisibleChange={onVisibleChange}
              surfaceRef={setSurfaceHandle}
              emptyMessage="this file isn’t available at the journey’s pinned revision — its contents may have left the workspace. reanalyze the pull request to rebuild them."
            />
          </div>

          <div className="flex h-[34px] shrink-0 items-center justify-between gap-6 border-t border-border bg-card px-4 text-[11px]">
            <div className="flex min-w-0 items-center gap-2.5 whitespace-nowrap">
              <Fact>{path}</Fact>
              <Separator />
              <span className="text-muted">
                {surfaceMode === "just-the-code" ? "head revision" : "base…head"}
              </span>
              {regions.length > 0 && (
                <>
                  <Separator />
                  <span className="text-muted">
                    {regionIndex < 0
                      ? `${regions.length} changed ${plural(regions.length, "region")}`
                      : `region ${regionIndex + 1} of ${regions.length}`}
                  </span>
                  <Separator />
                  {/* Two keycaps and one label — the design's shape, carrying both
                      directions the docs' interaction set names. The keys are printed
                      rather than tucked into a tooltip, so the keystroke is never
                      something the reviewer has to discover. */}
                  <Keycap
                    id="prev-change"
                    chord="p"
                    name="previous change"
                    onClick={() => step(-1)}
                  />
                  <Keycap
                    id="next-change"
                    chord="n"
                    name="next change"
                    label="next change"
                    onClick={() => step(1)}
                  />
                </>
              )}
              {changed && regions.length === 0 && (
                <>
                  <Separator />
                  <span className="text-muted">no changed lines</span>
                </>
              )}
              {!changed && (
                <>
                  <Separator />
                  <span className="text-muted">not changed in this pull request</span>
                </>
              )}
            </div>

            <div className="flex min-w-0 shrink items-center gap-4 overflow-hidden">
              {homeGroups.map((group, index) => (
                <LegendEntry
                  key={group.cluster.id}
                  group={group}
                  routeParams={routeParams}
                  isArrival={arrival !== null && arrival.id === group.cluster.id}
                  showMarker={markersDrawn}
                  withUnit={index === 0}
                />
              ))}
            </div>
          </div>
        </div>
      }
      right={
        guidanceOpen ? (
          <GuidanceRail
            hints={hints}
            visiblePaths={visiblePaths}
            displayMode={surfaceMode}
            oldSideBindablePaths={oldSideBindablePaths}
            onHintClick={onHintClick}
            evidenceHandlers={evidenceHandlers}
            onCollapse={() => setGuidanceOpen(false)}
          />
        ) : undefined
      }
    />
  );
}

/**
 * Which range a region's label and the next-change control anchor to. The new side
 * is preferred because it is the side the reviewer is reading; when the old side is
 * not on screen at all, an old-only hunk has no anchor and is left unlabelled
 * rather than labelled somewhere it is not.
 */
function anchorRange(ranges: ReadonlyArray<SideRange>, oldSideOnScreen: boolean): SideRange | null {
  const onNew = ranges.find((range) => range.side === "new");
  if (onNew !== undefined) return onNew;
  if (!oldSideOnScreen) return null;
  return ranges[0] ?? null;
}

/**
 * A tab's marker, in the editor's own language: a check once the file is read
 * everywhere it is homed, a dot while it still owes reading. A file outside the
 * changed set has no marks to carry and so carries no marker.
 */
function readMarker(
  homes: ReadonlySet<ClusterId> | undefined,
  path: string,
  marks: ReadonlySet<string>,
): "read" | "unread" | null {
  if (homes === undefined || homes.size === 0) return null;
  for (const home of homes) {
    if (!marks.has(markKey(home, path))) return "unread";
  }
  return "read";
}

function Tab({
  index,
  path,
  label,
  active,
  marker,
  onOpen,
  onClose,
}: {
  readonly index: number;
  readonly path: string;
  readonly label: string;
  readonly active: boolean;
  readonly marker: "read" | "unread" | null;
  readonly onOpen: (path: string) => void;
  readonly onClose: (path: string) => void;
}) {
  return (
    <div
      className={`flex items-center gap-1 border-r border-border pr-1.5 pl-3 ${
        active ? "bg-background text-foreground" : "text-muted"
      }`}
    >
      <button
        type="button"
        role="tab"
        id={`file-tab-${index}`}
        aria-selected={active}
        onClick={() => onOpen(path)}
        className="flex cursor-pointer items-center gap-1.5 py-1 font-mono text-[12px] whitespace-nowrap transition-colors hover:text-foreground"
      >
        <span>{label}</span>
        {marker === "read" && (
          <span aria-label="read" className="text-[10px] text-faint">
            ✓
          </span>
        )}
        {marker === "unread" && (
          <span aria-label="not read yet" className="text-[9px] leading-none text-faint">
            ●
          </span>
        )}
      </button>
      {/* Visible at rest rather than revealed on hover: a control the reviewer
          cannot see is a control that does not exist. */}
      <button
        type="button"
        id={`close-tab-${index}`}
        aria-label={`close ${label}`}
        onClick={() => onClose(path)}
        className="cursor-pointer rounded px-1 text-[13px] leading-none text-faint opacity-60 transition-opacity hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}

/** `src › app › router.tsx`. Folders are not destinations here, so nothing is a link. */
function Breadcrumb({ path }: { readonly path: string }) {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return (
    <nav
      aria-label="file path"
      className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[12px] text-muted"
    >
      {segments.map((segment, index) => (
        // Keyed by prefix, not index: `src/src/index.ts` has repeating segments.
        <Fragment key={segments.slice(0, index + 1).join("/")}>
          {index > 0 && (
            <span aria-hidden className="text-border-strong">
              ›
            </span>
          )}
          <span className={index === segments.length - 1 ? "text-foreground" : "truncate"}>
            {segment}
          </span>
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * The label that routes a region back to the journey. It sits on every region,
 * including the arrival cluster's own, because on this screen the home *is* the
 * information — free reading that cannot get back to the journey is just a file
 * viewer.
 */
function HomeLabel({
  cluster,
  routeParams,
}: {
  readonly cluster: Cluster;
  readonly routeParams: PrRouteParams;
}) {
  return (
    <div className="border-y border-border/60 px-4 py-1">
      <Link
        to={CLUSTER_ROUTE}
        params={{ ...routeParams, clusterId: cluster.id }}
        className="text-[11px] text-muted transition-colors hover:text-foreground"
      >
        <span className="font-mono">home: {cluster.position}</span> · {cluster.title}
      </Link>
    </div>
  );
}

/**
 * One footer legend entry. The accent bar appears for the arrival cluster only —
 * the accent's single meaning is "the current cluster's hunks", and spending it on
 * anything else would make it mean "changed", which the diff already says.
 */
function LegendEntry({
  group,
  routeParams,
  isArrival,
  showMarker,
  withUnit,
}: {
  readonly group: HomeGroup;
  readonly routeParams: PrRouteParams;
  readonly isArrival: boolean;
  readonly showMarker: boolean;
  readonly withUnit: boolean;
}) {
  return (
    <Link
      to={CLUSTER_ROUTE}
      params={{ ...routeParams, clusterId: group.cluster.id }}
      className="flex min-w-0 items-center gap-2 text-muted transition-colors hover:text-foreground"
    >
      {showMarker && (
        <span
          aria-hidden
          className={`h-3 w-[3px] shrink-0 rounded-full ${
            isArrival ? "bg-accent" : "bg-border-strong"
          }`}
        />
      )}
      {/* "changed —" explains a marker, so it is only said where a marker is drawn;
          with no markers the entry is simply the file's homes. The unit is spelled
          out once and then implied, as the design has it. A cluster whose only claim
          here is a whole-file change has no region count to give. */}
      <span className="truncate">
        {showMarker ? "changed — " : ""}
        {isArrival ? "this cluster" : `home: ${group.cluster.position} · ${group.cluster.title}`}
        {group.regions === 0
          ? ""
          : ` (${group.regions}${withUnit ? ` ${plural(group.regions, "region")}` : ""})`}
      </span>
    </Link>
  );
}

function Keycap({
  id,
  chord,
  name,
  label,
  onClick,
}: {
  readonly id: string;
  readonly chord: string;
  /** What the control is, for anyone not reading the glyphs. */
  readonly name: string;
  /** Printed beside the keycap when there is room for it. */
  readonly label?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      id={id}
      aria-label={name}
      title={name}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1.5 text-muted transition-colors hover:text-foreground"
    >
      <Chord>{chord}</Chord>
      {label}
    </button>
  );
}

/** A printed key: the one place a keystroke's look is defined. */
function Chord({ children }: { readonly children: string }) {
  return (
    <span
      aria-hidden
      className="rounded border border-border bg-raised px-1.5 py-0.5 font-mono text-[10px] leading-none"
    >
      {children}
    </span>
  );
}

/** English, not a count-of-counts: `1 region`, `4 regions`. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** A designed empty state, not a spinner: it says what to do next. */
function Parked({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="tl-fade max-w-[34rem] text-center">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{children}</p>
      </div>
    </div>
  );
}

/**
 * Tabs show basenames, and two open files can share one. Disambiguating with the
 * parent directory keeps the full path out of a tooltip — the only other place it
 * could go.
 */
function tabLabel(path: string, open: ReadonlyArray<string>): string {
  const base = basename(path);
  const ambiguous = open.some((other) => other !== path && basename(other) === base);
  if (!ambiguous) return base;
  const parent = basename(path.slice(0, Math.max(0, path.length - base.length - 1)));
  return parent === "" ? base : `${parent}/${base}`;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
