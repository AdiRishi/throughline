/**
 * The reading surface: one `CodeView` over the files a page shows.
 *
 * Two things here carry the product rather than the plumbing.
 *
 * **Emphasis carries the cluster boundary.** The full file is always present;
 * hunks homed to the cluster being read are emphasized, hunks homed elsewhere
 * are dimmed and labelled with their home. Pierre has no per-range dim prop, so
 * this rides two seams together: `options.unsafeCSS` defines what emphasized
 * and dimmed *look* like, and `options.onPostRender` — the only per-item,
 * per-line hook — decides which rows are which. Doing it in CSS rather than by
 * excluding lines is what makes the partition itself visible: every hunk on
 * screen declares where it belongs.
 *
 * **Diffs are built from both revisions, not from the patch.** A patch-parsed
 * diff is partial, and Pierre refuses to offer expansion on a partial diff — so
 * "expand context" would silently not exist. Feeding it the full old and new
 * contents (which the run directory already materialized) makes expansion
 * native behaviour instead of a feature we would have had to build.
 *
 * @module features/journey/CodeSurface
 */
import { useAtomValue } from "@effect/atom-react";
import { parseDiffFromFile } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem } from "@pierre/diffs/react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Cluster, DisplayMode, FileChange, Hint, Hunk, Narrative } from "@app/contracts";

import { useTheme } from "../../hooks/useTheme.ts";
import { bundleKey, fileBundleAtom } from "../../state/journey.ts";
import { useJourney } from "./context.tsx";
import type { ScrollRequest } from "./context.tsx";

/** What one file on the surface is, from the reading experience's point of view. */
export interface FileSpec {
  readonly path: string;
  readonly change: FileChange | undefined;
  /** Hunks homed to the cluster being read — the product's single accent use. */
  readonly homed: ReadonlyArray<Hunk>;
  /** Hunks homed elsewhere: dimmed, labelled, one click from their home. */
  readonly foreign: ReadonlyArray<{ readonly hunk: Hunk; readonly home: Cluster | undefined }>;
  /** Known code from a new angle — emphasized, but visibly marked a revisit. */
  readonly resurfaced: ReadonlyArray<{
    readonly hunk: Hunk;
    readonly home: Cluster | undefined;
    readonly note: Narrative;
  }>;
  /** Null when this surface has no cluster to mark against (free file reading). */
  readonly markable: { readonly clusterId: Cluster["id"]; readonly read: boolean } | null;
}

interface AnnotationMeta {
  readonly kind: "foreign" | "resurfaced";
  readonly path: string;
  readonly hunkId: string;
  readonly homeId: string | null;
  readonly homeTitle: string;
  readonly homePosition: number;
  readonly note: string | null;
}

/** Rows we decorate, keyed by item id (which is the path). */
interface DecorationSpec {
  readonly homedNew: ReadonlyArray<readonly [number, number]>;
  readonly homedOld: ReadonlyArray<readonly [number, number]>;
  readonly foreignNew: ReadonlyArray<readonly [number, number]>;
  readonly foreignOld: ReadonlyArray<readonly [number, number]>;
  readonly resurfacedNew: ReadonlyArray<readonly [number, number]>;
  readonly resurfacedOld: ReadonlyArray<readonly [number, number]>;
}

const inAny = (ranges: ReadonlyArray<readonly [number, number]>, line: number): boolean =>
  ranges.some(([start, end]) => line >= start && line <= end);

function rangesOf(
  hunks: ReadonlyArray<Hunk>,
  side: "old" | "new",
): ReadonlyArray<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const hunk of hunks) {
    const start = side === "old" ? hunk.oldStart : hunk.newStart;
    const length = side === "old" ? hunk.oldLines : hunk.newLines;
    if (length > 0) ranges.push([start, start + length - 1]);
  }
  return ranges;
}

/**
 * Emphasis and dimming, defined once for the whole surface. `--diffs-line-bg`
 * is the library's highest-precedence background variable, so setting it keeps
 * hover and selection interplay working rather than fighting it.
 */
const SURFACE_CSS = `
  /*
   * A hunk that belongs to another cluster is still on screen — the full file
   * is always present — but it recedes, and its banner names its home.
   */
  [data-line][data-tl="dim"],
  [data-column-number][data-tl="dim"] {
    opacity: 0.45;
  }
  /*
   * Just-the-code drops every trace of diff UI, so "which regions changed" has
   * to be carried by the margin instead: a quiet marker for other clusters'
   * regions, the accent for this one's. Orientation, not decoration.
   */
  [data-line][data-tl="marker"] {
    box-shadow: inset 2px 0 0 0 var(--color-border-strong);
  }
  /*
   * Emphasis is a marker, not a repaint: the addition/deletion background is
   * the diff's own language and must survive. The accent bar is the cluster
   * boundary, and it is the only thing the accent is ever used for.
   */
  [data-line][data-tl="home"] {
    box-shadow: inset 2px 0 0 0 var(--color-accent);
  }
  [data-line][data-tl="revisit"] {
    box-shadow: inset 2px 0 0 0 var(--color-accent);
    outline: 1px dashed color-mix(in oklab, var(--color-accent) 45%, transparent);
    outline-offset: -1px;
  }
  [data-column-number][data-tl="home"],
  [data-column-number][data-tl="revisit"] {
    color: var(--color-accent);
  }
`;

export function CodeSurface({
  files,
  onOpenCluster,
  onMark,
  emptyMessage,
  surface = "cluster",
}: {
  readonly files: ReadonlyArray<FileSpec>;
  readonly onOpenCluster: (clusterId: string) => void;
  readonly onMark?: (path: string, read: boolean) => void;
  readonly emptyMessage?: string;
  /**
   * Which reading surface this is. A home label means two different things:
   * on a cluster page it says "this hunk is somebody else's"; on a file page,
   * where there is no cluster being read, it says where the hunk *is* read.
   */
  readonly surface?: "cluster" | "file";
}) {
  const {
    journey,
    displayMode,
    setDisplayMode,
    registerScrollHandler,
    setVisibleHints,
    setRegions,
  } = useJourney();
  const { resolved } = useTheme();
  const handle = useRef<CodeViewHandle<AnnotationMeta> | null>(null);
  const hosts = useRef(new Map<string, HTMLElement>());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const scheduleHintSync = useRef<(() => void) | null>(null);

  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const bundle = useAtomValue(fileBundleAtom(bundleKey(journey.id, paths)));
  const contents = Option.getOrNull(AsyncResult.value(bundle));

  const decorations = useMemo(() => {
    const map = new Map<string, DecorationSpec>();
    for (const file of files) {
      map.set(file.path, {
        homedNew: rangesOf(file.homed, "new"),
        homedOld: rangesOf(file.homed, "old"),
        foreignNew: rangesOf(
          file.foreign.map((entry) => entry.hunk),
          "new",
        ),
        foreignOld: rangesOf(
          file.foreign.map((entry) => entry.hunk),
          "old",
        ),
        resurfacedNew: rangesOf(
          file.resurfaced.map((entry) => entry.hunk),
          "new",
        ),
        resurfacedOld: rangesOf(
          file.resurfaced.map((entry) => entry.hunk),
          "old",
        ),
      });
    }
    return map;
  }, [files]);

  /**
   * The one per-item, per-line seam. It runs on every render pass of a visible
   * item, so it stays O(rows on screen).
   */
  const decorate = useCallback(
    (node: HTMLElement, path: string, mode: DisplayMode) => {
      const root = node.shadowRoot;
      const spec = decorations.get(path);
      if (root === null || spec === undefined) return;
      hosts.current.set(path, node);
      // Rows only exist after the item renders, and virtualization re-renders
      // them as the reviewer scrolls — so this is also the moment the guidance
      // rail can know what is actually on screen.
      scheduleHintSync.current?.();

      const classify = (type: string | null, line: number): string | null => {
        // In just-the-code every row is the head revision, so the new-side
        // ranges are the whole answer — which is what makes the changed regions
        // markable there at all: there are no `change-*` line types to read.
        const isNew = mode === "just-the-code" || type === "change-addition";
        const isOld = mode !== "just-the-code" && type === "change-deletion";
        if (!isOld && !isNew) return null;
        const homed = isNew ? spec.homedNew : spec.homedOld;
        const revisit = isNew ? spec.resurfacedNew : spec.resurfacedOld;
        const foreign = isNew ? spec.foreignNew : spec.foreignOld;
        if (inAny(revisit, line)) return "revisit";
        if (inAny(homed, line)) return "home";
        if (inAny(foreign, line)) return mode === "just-the-code" ? "marker" : "dim";
        return null;
      };

      for (const element of root.querySelectorAll<HTMLElement>("[data-line]")) {
        const line = Number(element.getAttribute("data-line"));
        const state = classify(element.getAttribute("data-line-type"), line);
        if (state === null) element.removeAttribute("data-tl");
        else element.setAttribute("data-tl", state);
      }
      for (const element of root.querySelectorAll<HTMLElement>("[data-column-number]")) {
        const line = Number(element.getAttribute("data-column-number"));
        const state = classify(element.getAttribute("data-line-type"), line);
        if (state === null) element.removeAttribute("data-tl");
        else element.setAttribute("data-tl", state);
      }
    },
    [decorations],
  );

  const items = useMemo((): ReadonlyArray<CodeViewItem<AnnotationMeta>> => {
    if (contents === null) return [];
    const built: Array<CodeViewItem<AnnotationMeta>> = [];
    for (const file of files) {
      const content = contents.get(file.path);
      if (content === undefined) continue;

      const annotations = buildAnnotations(file, displayMode);

      if (content.binary || content.omitted) {
        // A change with no text to show is still a change, and still has to be
        // placeable, readable, and markable. Say what it is, plainly.
        built.push({
          id: file.path,
          type: "file",
          file: { name: file.path, contents: placard(file, content.binary) },
          annotations: annotations.map((annotation) => ({
            lineNumber: annotation.lineNumber,
            metadata: annotation.metadata,
          })),
          collapsed: file.markable?.read === true,
          version: annotationVersion(file, displayMode),
        });
        continue;
      }

      if (displayMode === "just-the-code") {
        built.push({
          id: file.path,
          type: "file",
          file: { name: file.path, contents: content.new ?? content.old ?? "" },
          annotations: annotations
            .filter((annotation) => annotation.side === "additions")
            .map((annotation) => ({
              lineNumber: annotation.lineNumber,
              metadata: annotation.metadata,
            })),
          collapsed: file.markable?.read === true,
          version: annotationVersion(file, displayMode),
        });
        continue;
      }

      // Both revisions, so unchanged regions collapse *and expand* natively.
      built.push({
        id: file.path,
        type: "diff",
        fileDiff: parseDiffFromFile(
          { name: file.change?.oldPath ?? file.path, contents: content.old ?? "" },
          { name: file.path, contents: content.new ?? "" },
        ),
        annotations: annotations.map((annotation) => ({
          side: annotation.side,
          lineNumber: annotation.lineNumber,
          metadata: annotation.metadata,
        })),
        // Marking a file read collapses it: the cluster shortens as it is
        // worked, and what remains is what is left to read.
        collapsed: file.markable?.read === true,
        version: annotationVersion(file, displayMode),
      });
    }
    return built;
  }, [contents, displayMode, files]);

  const options = useMemo(
    () => ({
      diffStyle: displayMode === "split" ? ("split" as const) : ("unified" as const),
      // The renderer lives in a shadow root and cannot see the app's `.dark`
      // class, so the effective theme is handed to it explicitly. Without this
      // the code would sit in a light panel inside a dark app.
      themeType: resolved,
      expandUnchanged: false,
      expansionLineCount: 40,
      hunkSeparators: "line-info" as const,
      stickyHeaders: true,
      overflow: "scroll" as const,
      unsafeCSS: SURFACE_CSS,
      onPostRender: (node: HTMLElement, _instance: unknown, phase: string, context?: unknown) => {
        if (phase === "unmount") return;
        const id = (context as { item?: { id?: string } } | undefined)?.item?.id;
        if (typeof id === "string") decorate(node, id, displayMode);
      },
    }),
    [decorate, displayMode, resolved],
  );

  // Scroll requests from evidence links, hint clicks, and the rails.
  useEffect(() => {
    registerScrollHandler((target: ScrollRequest) => {
      const view = handle.current;
      if (view === null) return;
      if (target.kind === "file") {
        view.scrollTo({ type: "item", id: target.path, align: "start" });
        return;
      }
      if (target.kind === "line") {
        view.scrollTo({
          type: "line",
          id: target.path,
          lineNumber: target.line,
          side: target.side === "old" ? "deletions" : "additions",
          align: "center",
        });
        return;
      }
      const hunk = journey.hunks.find(
        (candidate) => candidate.id === target.hunkId || candidate.seedId === target.hunkId,
      );
      if (hunk === undefined) return;
      view.scrollTo({
        type: "line",
        id: hunk.path,
        lineNumber: hunk.newLines > 0 ? hunk.newStart : hunk.oldStart,
        side: hunk.newLines > 0 ? "additions" : "deletions",
        align: "center",
      });
    });
    return () => registerScrollHandler(null);
  }, [journey.hunks, registerScrollHandler]);

  // Guidance follows position: on scroll, read which rows are actually on
  // screen and surface the hints anchored to them. Viewport-driven, so the rail
  // is never operated — it just follows.
  const syncHints = useCallback(() => {
    const container = containerRef.current;
    if (container === null) return;
    const bounds = container.getBoundingClientRect();
    const visible: Array<{ path: string; line: number }> = [];

    for (const [path, node] of hosts.current) {
      if (!node.isConnected) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom < bounds.top || rect.top > bounds.bottom) continue;
      const root = node.shadowRoot;
      if (root === null) continue;
      for (const element of root.querySelectorAll<HTMLElement>("[data-line]")) {
        const elementRect = element.getBoundingClientRect();
        if (elementRect.bottom < bounds.top || elementRect.top > bounds.bottom) continue;
        visible.push({ path, line: Number(element.getAttribute("data-line")) });
      }
    }

    if (visible.length === 0) {
      setVisibleHints([]);
      return;
    }
    const byPath = new Map<string, { min: number; max: number }>();
    for (const entry of visible) {
      const current = byPath.get(entry.path);
      if (current === undefined) byPath.set(entry.path, { min: entry.line, max: entry.line });
      else {
        current.min = Math.min(current.min, entry.line);
        current.max = Math.max(current.max, entry.line);
      }
    }

    const matches = journey.hints.filter((hint) => {
      const window_ = byPath.get(hint.anchor.path);
      if (window_ === undefined) return false;
      return hint.anchor.endLine >= window_.min && hint.anchor.startLine <= window_.max;
    });
    setVisibleHints(matches);
  }, [journey.hints, setVisibleHints]);

  /**
   * Every changed region on this surface, in reading order.
   *
   * A region is a fact about the diff, not about how it is drawn, so this list
   * is identical in all three display modes — which is what lets "region N of
   * M" and next/previous behave the same everywhere.
   */
  const regionList = useMemo(
    () =>
      files.flatMap((file) =>
        [
          ...file.homed,
          ...file.resurfaced.map((entry) => entry.hunk),
          ...file.foreign.map((entry) => entry.hunk),
        ]
          .toSorted(
            (left, right) => (left.newStart || left.oldStart) - (right.newStart || right.oldStart),
          )
          .map((hunk) => ({
            path: file.path,
            side: hunk.newLines > 0 ? ("new" as const) : ("old" as const),
            line: hunk.newLines > 0 ? hunk.newStart : hunk.oldStart,
          })),
      ),
    [files],
  );
  const [regionIndex, setRegionIndex] = useState(0);

  const goRegion = useCallback(
    (direction: 1 | -1) => {
      if (regionList.length === 0) return;
      setRegionIndex((current) => {
        const next = (current + direction + regionList.length) % regionList.length;
        const region = regionList[next];
        if (region !== undefined) {
          handle.current?.scrollTo({
            type: "line",
            id: region.path,
            lineNumber: region.line,
            side: region.side === "old" ? "deletions" : "additions",
            align: "center",
          });
        }
        return next;
      });
    },
    [regionList],
  );

  useEffect(() => {
    setRegionIndex(0);
  }, [regionList]);

  useEffect(() => {
    setRegions({
      total: regionList.length,
      current: regionList.length === 0 ? 0 : regionIndex + 1,
      go: goRegion,
    });
  }, [goRegion, regionIndex, regionList.length, setRegions]);

  // Coalesced: a scroll pass can re-render several items, and the rail only
  // needs the answer once per frame.
  useEffect(() => {
    let frame = 0;
    scheduleHintSync.current = () => {
      if (frame !== 0) return;
      frame = globalThis.requestAnimationFrame(() => {
        frame = 0;
        syncHints();
      });
    };
    scheduleHintSync.current();
    return () => {
      if (frame !== 0) globalThis.cancelAnimationFrame(frame);
      scheduleHintSync.current = null;
    };
  }, [items, syncHints]);

  if (contents === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="tl-pulse h-2 w-2 rounded-full bg-faint" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
        {emptyMessage ?? "Nothing to show here."}
      </div>
    );
  }

  return (
    <CodeView<AnnotationMeta>
      ref={handle}
      containerRef={containerRef}
      items={items}
      options={options}
      onScroll={() => scheduleHintSync.current?.()}
      className="h-full"
      renderCustomHeader={(item) => {
        const file = files.find((candidate) => candidate.path === item.id);
        if (file === undefined) return null;
        return (
          <FileHeader
            file={file}
            displayMode={displayMode}
            onDisplayMode={setDisplayMode}
            onMark={onMark}
          />
        );
      }}
      renderAnnotation={(annotation) => {
        const metadata = annotation.metadata;
        if (metadata === undefined) return null;
        return <HunkBanner meta={metadata} surface={surface} onOpenCluster={onOpenCluster} />;
      }}
    />
  );
}

function annotationVersion(file: FileSpec, mode: DisplayMode): number {
  // Controlled items only re-render when `version` changes, so it has to move
  // whenever anything the item renders from does.
  const read = file.markable?.read === true ? 1 : 0;
  const modeBit = mode === "split" ? 2 : mode === "just-the-code" ? 4 : 0;
  return file.homed.length * 8 + file.foreign.length * 64 + read + modeBit;
}

function buildAnnotations(
  file: FileSpec,
  mode: DisplayMode,
): Array<{
  readonly side: "deletions" | "additions";
  readonly lineNumber: number;
  readonly metadata: AnnotationMeta;
}> {
  const annotations: Array<{
    readonly side: "deletions" | "additions";
    readonly lineNumber: number;
    readonly metadata: AnnotationMeta;
  }> = [];

  for (const entry of file.foreign) {
    const side = entry.hunk.newLines > 0 ? "additions" : "deletions";
    const line = entry.hunk.newLines > 0 ? entry.hunk.newStart : entry.hunk.oldStart;
    if (line <= 0) continue;
    if (mode === "just-the-code" && side === "deletions") continue;
    annotations.push({
      side,
      lineNumber: line,
      metadata: {
        kind: "foreign",
        path: file.path,
        hunkId: entry.hunk.id,
        homeId: entry.home?.id ?? null,
        homeTitle: entry.home?.title ?? "another cluster",
        homePosition: entry.home?.position ?? 0,
        note: null,
      },
    });
  }

  for (const entry of file.resurfaced) {
    const side = entry.hunk.newLines > 0 ? "additions" : "deletions";
    const line = entry.hunk.newLines > 0 ? entry.hunk.newStart : entry.hunk.oldStart;
    if (line <= 0) continue;
    if (mode === "just-the-code" && side === "deletions") continue;
    annotations.push({
      side,
      lineNumber: line,
      metadata: {
        kind: "resurfaced",
        path: file.path,
        hunkId: entry.hunk.id,
        homeId: entry.home?.id ?? null,
        homeTitle: entry.home?.title ?? "another cluster",
        homePosition: entry.home?.position ?? 0,
        note: entry.note.markdown,
      },
    });
  }

  return annotations;
}

function placard(file: FileSpec, binary: boolean): string {
  const kind = file.change?.changeKind ?? "modified";
  if (binary) {
    return kind === "added"
      ? "Binary file added — no text diff."
      : kind === "deleted"
        ? "Binary file deleted — no text diff."
        : "Binary file changed — no text diff.";
  }
  if (kind === "renamed") {
    return `Renamed from ${file.change?.oldPath ?? "elsewhere"} — contents unchanged.`;
  }
  if (
    file.change?.oldMode != null &&
    file.change.newMode != null &&
    file.change.oldMode !== file.change.newMode
  ) {
    return `File mode changed — ${file.change.oldMode} → ${file.change.newMode}.`;
  }
  if (kind === "added") return "Empty file added.";
  return "Changed with no text diff.";
}

function HunkBanner({
  meta,
  surface,
  onOpenCluster,
}: {
  readonly meta: AnnotationMeta;
  readonly surface: "cluster" | "file";
  readonly onOpenCluster: (clusterId: string) => void;
}) {
  if (meta.kind === "resurfaced") {
    return (
      <div className="my-1 flex flex-wrap items-center gap-2 px-3 py-1.5">
        <span className="rounded border border-accent/60 px-1.5 py-[1px] font-mono text-[10px] text-accent">
          ↺ resurfaced · home: {meta.homePosition} · {meta.homeTitle}
        </span>
        {meta.note !== null && <span className="text-[12px] text-muted">{meta.note}</span>}
        <span className="text-[11px] text-faint">doesn’t count here — coverage lives at home</span>
      </div>
    );
  }
  return (
    <div className="my-1 flex flex-wrap items-center gap-2 px-3 py-1.5">
      <button
        type="button"
        disabled={meta.homeId === null}
        onClick={() => meta.homeId !== null && onOpenCluster(meta.homeId)}
        className="cursor-pointer rounded border border-border-strong px-1.5 py-[1px] font-mono text-[10px] text-muted transition-colors hover:border-foreground hover:text-foreground disabled:cursor-default"
      >
        home: {meta.homePosition} · {meta.homeTitle}
      </button>
      <span className="text-[11px] text-faint">
        {surface === "cluster"
          ? "not part of this cluster — one click to its home →"
          : "where this change is read — one click to go there →"}
      </span>
    </div>
  );
}

function FileHeader({
  file,
  displayMode,
  onDisplayMode,
  onMark,
}: {
  readonly file: FileSpec;
  readonly displayMode: DisplayMode;
  readonly onDisplayMode: (mode: DisplayMode) => void;
  readonly onMark?: ((path: string, read: boolean) => void) | undefined;
}) {
  const read = file.markable?.read === true;
  const changeLabel =
    file.change === undefined
      ? null
      : file.change.changeKind === "added"
        ? "new file"
        : file.change.changeKind === "deleted"
          ? "deleted"
          : file.change.changeKind === "renamed"
            ? `renamed from ${file.change.oldPath ?? ""}`
            : null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[12.5px]">{file.path}</span>
        {changeLabel !== null && (
          <span className="shrink-0 rounded border border-border px-1.5 py-[1px] text-[10px] text-muted">
            {changeLabel}
          </span>
        )}
        {file.change !== undefined && !file.change.binary && (
          <span className="shrink-0 font-mono text-[11px]">
            <span className="text-addition">+{file.change.additions}</span>{" "}
            <span className="text-deletion">−{file.change.deletions}</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {displayMode !== "just-the-code" && (
          <div className="inline-flex rounded border border-border text-[11px]">
            <button
              type="button"
              onClick={() => onDisplayMode("inline")}
              aria-pressed={displayMode === "inline"}
              className={`cursor-pointer rounded-l px-2 py-[2px] ${displayMode === "inline" ? "bg-raised text-foreground" : "text-muted"}`}
            >
              Inline
            </button>
            <button
              type="button"
              onClick={() => onDisplayMode("split")}
              aria-pressed={displayMode === "split"}
              className={`cursor-pointer rounded-r px-2 py-[2px] ${displayMode === "split" ? "bg-raised text-foreground" : "text-muted"}`}
            >
              Split
            </button>
          </div>
        )}
        {file.markable !== null && onMark !== undefined && (
          <button
            type="button"
            onClick={() => onMark(file.path, !read)}
            title="Mark read (R)"
            className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12px] transition-colors ${
              read
                ? "border-border-strong bg-raised text-foreground"
                : "border-border text-muted hover:border-border-strong hover:text-foreground"
            }`}
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full border ${read ? "border-foreground bg-foreground" : "border-border-strong"}`}
            />
            {read ? "Read" : "Mark read"}
            <span className="font-mono text-[10px] text-faint">R</span>
          </button>
        )}
      </div>
    </div>
  );
}

export type { AnnotationMeta, Hint };
