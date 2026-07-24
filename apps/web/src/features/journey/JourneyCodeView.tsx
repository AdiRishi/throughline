import { processFile } from "@pierre/diffs";
import type {
  CodeViewDiffItem,
  CodeViewFileItem,
  CodeViewItem,
  CodeViewOptions,
  DiffLineAnnotation,
  FileContents,
  LineAnnotation,
} from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  Cluster,
  ClusterId,
  DisplayMode,
  FileChange,
  FileContent,
  Hunk,
  Hint as JourneyHint,
  Journey,
  RepositoryPath,
} from "@app/contracts";

import { useTheme } from "../../hooks/useTheme.ts";
import type { JourneyScrollTarget } from "./JourneyContext.tsx";
import { codeModeLineAnchor, countHeadLines, findSymbolLine, isClusterHomePath } from "./model.ts";
import type { JourneyFileResource } from "./resources.tsx";

type ScopeKind = "home" | "foreign" | "resurfaced";

type JourneyAnnotationValue =
  | {
      readonly kind: "home";
      readonly hunk: Hunk;
      readonly home: Cluster;
      readonly scope: ScopeKind;
      readonly resurfacingNote: string | null;
    }
  | {
      readonly kind: "artifact";
      readonly path: RepositoryPath;
      readonly content: FileContent | null;
      readonly change: FileChange | null;
      readonly fileKind: Hunk["fileKind"] | null;
      readonly error: string | null;
    };

interface JourneyAnnotation {
  readonly value: JourneyAnnotationValue;
}

export interface JourneyCodeViewProps {
  readonly journey: Journey;
  readonly paths: readonly RepositoryPath[];
  readonly resources: ReadonlyMap<RepositoryPath, JourneyFileResource>;
  readonly displayMode: DisplayMode;
  readonly clusterId: ClusterId | null;
  readonly readFiles: ReadonlySet<string>;
  readonly hints: readonly JourneyHint[];
  readonly scrollTarget: JourneyScrollTarget | null;
  readonly readMarkKey: (clusterId: ClusterId, path: RepositoryPath) => string;
  readonly onClearScrollTarget: (key: number) => void;
  readonly onToggleRead: (clusterId: ClusterId, path: RepositoryPath) => void;
  readonly onSetDisplayMode: (mode: DisplayMode) => void;
  readonly onSelectHome: (clusterId: ClusterId) => void;
  readonly onActivePathChange?: (path: RepositoryPath) => void;
  readonly onVisibleHintsChange?: (hintIds: readonly string[], activeHintId: string | null) => void;
  readonly onPreviousCluster?: () => void;
  readonly onNextCluster?: () => void;
}

const DIFF_UNSAFE_CSS = `
  :host {
    --diffs-font-size: 12px;
    --diffs-line-height: 20px;
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-sans);
    --diffs-bg: var(--surface);
  }

  [data-tl-scope="foreign"] {
    opacity: 0.4;
  }

  [data-tl-scope="home"],
  [data-tl-scope="resurfaced"] {
    --diffs-line-bg: color-mix(in srgb, var(--accent) 10%, var(--diffs-bg));
    box-shadow: inset 2px 0 0 var(--accent);
  }

  [data-tl-scope="resurfaced"] {
    --diffs-line-bg: color-mix(in srgb, var(--accent) 6%, var(--diffs-bg));
    box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 68%, transparent);
  }

  [data-tl-hints] {
    box-shadow: inset 2px 0 0 var(--accent);
  }

  [data-diffs-header="custom"] {
    background: var(--raised);
    border-block: 1px solid var(--border);
    min-height: 44px;
  }

  [data-line-annotation] {
    border-block: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  }
`;

export function JourneyCodeView({
  journey,
  paths,
  resources,
  displayMode,
  clusterId,
  readFiles,
  hints,
  scrollTarget,
  readMarkKey,
  onClearScrollTarget,
  onToggleRead,
  onSetDisplayMode,
  onSelectHome,
  onActivePathChange,
  onVisibleHintsChange,
  onPreviousCluster,
  onNextCluster,
}: JourneyCodeViewProps) {
  const { theme } = useTheme();
  const codeViewRef = useRef<CodeViewHandle<JourneyAnnotation>>(null);
  const syncPositionRef = useRef<() => void>(() => undefined);
  const [activePath, setActivePath] = useState<RepositoryPath | null>(paths[0] ?? null);
  const activePathRef = useRef(activePath);
  const [regionIndex, setRegionIndex] = useState(0);
  const clusterById = useMemo(
    () => new Map(journey.clusters.map((cluster) => [cluster.id, cluster])),
    [journey.clusters],
  );
  const hunksByPath = useMemo(() => groupHunksByPath(journey.hunks), [journey.hunks]);
  const filesByPath = useMemo(
    () => new Map(journey.files.map((file) => [file.path, file])),
    [journey.files],
  );
  const resurfacedIds = useMemo(() => {
    if (clusterId === null) return new Map<string, string>();
    const cluster = clusterById.get(clusterId);
    return new Map(
      (cluster?.resurfaced ?? []).map((entry) => [entry.hunkId as string, entry.note.markdown]),
    );
  }, [clusterById, clusterId]);

  const items = useMemo(
    () =>
      paths.flatMap((path) => {
        const resource = resources.get(path);
        if (resource === undefined || (!resource.ready && resource.error === null)) return [];
        return [
          buildCodeViewItem({
            journey,
            path,
            resource,
            displayMode,
            clusterId,
            readFiles,
            readMarkKey,
            clusterById,
            hunks: hunksByPath.get(path) ?? [],
            change: filesByPath.get(path) ?? null,
            resurfacedIds,
          }),
        ];
      }),
    [
      clusterById,
      clusterId,
      displayMode,
      filesByPath,
      hunksByPath,
      journey,
      paths,
      readFiles,
      readMarkKey,
      resources,
      resurfacedIds,
    ],
  );

  const onPostRender = useCallback<NonNullable<CodeViewOptions<JourneyAnnotation>["onPostRender"]>>(
    (node, _instance, phase, context) => {
      const path = context.item.id as RepositoryPath;
      markRenderedLines({
        node,
        phase,
        itemType: context.item.type,
        hunks: hunksByPath.get(path) ?? [],
        clusterId,
        resurfacedIds,
        hints: hints.filter((hint) => hint.anchor.path === path),
        headLines: headLineCount(resources.get(path)?.content ?? null),
      });
      if (phase !== "unmount") {
        requestAnimationFrame(() => syncPositionRef.current());
      }
    },
    [clusterId, hints, hunksByPath, resources, resurfacedIds],
  );

  const options = useMemo<CodeViewOptions<JourneyAnnotation>>(
    () => ({
      theme: {
        dark: "github-dark-default",
        light: "github-light-default",
      },
      themeType: theme,
      diffStyle: displayMode === "split" ? "split" : "unified",
      diffIndicators: "classic",
      expandUnchanged: false,
      expansionLineCount: 20,
      collapsedContextThreshold: 8,
      hunkSeparators: "line-info",
      overflow: "scroll",
      stickyHeaders: true,
      unsafeCSS: DIFF_UNSAFE_CSS,
      onPostRender,
    }),
    [displayMode, onPostRender, theme],
  );

  const setCurrentPath = useCallback(
    (path: RepositoryPath) => {
      if (activePathRef.current === path) return;
      activePathRef.current = path;
      setActivePath(path);
      setRegionIndex(0);
      onActivePathChange?.(path);
    },
    [onActivePathChange],
  );

  const syncPosition = useCallback(() => {
    const viewer = codeViewRef.current?.getInstance();
    if (viewer === undefined) return;
    const container = viewer.getContainerElement();
    if (container === undefined) return;
    const rendered = viewer.getRenderedItems();
    let current = rendered[0];
    const containerBounds = container.getBoundingClientRect();
    for (const candidate of rendered) {
      if (candidate.element.getBoundingClientRect().top <= containerBounds.top + 120) {
        current = candidate;
      }
    }
    if (current !== undefined) {
      const path = current.id as RepositoryPath;
      setCurrentPath(path);
      const item = items.find((candidate) => candidate.id === path);
      const root = current.element.shadowRoot;
      if (item !== undefined && root !== null) {
        const regions = regionAnchors(
          hunksByPath.get(path) ?? [],
          displayMode,
          headLineCount(resources.get(path)?.content ?? null),
        );
        const nextRegionIndex = nearestRenderedRegionIndex(
          root,
          item.type,
          regions,
          containerBounds.top + 120,
        );
        if (nextRegionIndex !== null) setRegionIndex(nextRegionIndex);
      }
    }

    let closestHint: { readonly id: string; readonly distance: number } | null = null;
    const visibleHintIds = new Set<string>();
    for (const renderedItem of rendered) {
      const root = renderedItem.element.shadowRoot;
      if (root === null) continue;
      for (const row of root.querySelectorAll<HTMLElement>("[data-tl-hints]")) {
        const ids = row.dataset.tlHints?.split(" ") ?? [];
        const bounds = row.getBoundingClientRect();
        const intersects =
          bounds.bottom >= containerBounds.top && bounds.top <= containerBounds.bottom;
        const distance = Math.abs(bounds.top - containerBounds.top - 120);
        for (const id of ids) {
          if (intersects) visibleHintIds.add(id);
          if (closestHint === null || distance < closestHint.distance) {
            closestHint = { id, distance };
          }
        }
      }
    }
    onVisibleHintsChange?.([...visibleHintIds], closestHint?.id ?? null);
  }, [displayMode, hunksByPath, items, onVisibleHintsChange, resources, setCurrentPath]);
  syncPositionRef.current = syncPosition;

  useEffect(() => {
    if (scrollTarget === null || !paths.includes(scrollTarget.path)) return;
    const handle = codeViewRef.current;
    if (handle === null || !items.some((item) => item.id === scrollTarget.path)) return;
    const resource = resources.get(scrollTarget.path);
    if (scrollTarget.symbol !== undefined && resource === undefined) return;
    if (
      scrollTarget.symbol !== undefined &&
      resource !== undefined &&
      !resource.ready &&
      resource.error === null
    ) {
      return;
    }
    const symbolLine =
      scrollTarget.symbol === undefined ||
      resource?.content?.type !== "text" ||
      resource.content.new === null
        ? null
        : findSymbolLine(resource.content.new, scrollTarget.symbol);
    const requestedLine = scrollTarget.lineNumber ?? symbolLine;
    const deletionHunk =
      displayMode === "just-the-code" &&
      scrollTarget.side === "old" &&
      scrollTarget.lineNumber !== undefined
        ? (hunksByPath
            .get(scrollTarget.path)
            ?.find((hunk) => inHunkRange(hunk, "old", scrollTarget.lineNumber!)) ?? null)
        : null;
    const lineNumber =
      deletionHunk === null
        ? requestedLine
        : codeModeLineAnchor(deletionHunk, headLineCount(resource?.content ?? null));
    handle.scrollTo(
      lineNumber === null || lineNumber === undefined
        ? {
            type: "item",
            id: scrollTarget.path,
            align: "start",
            behavior: "smooth-auto",
          }
        : {
            type: "line",
            id: scrollTarget.path,
            lineNumber,
            ...(displayMode === "just-the-code" || scrollTarget.side === undefined
              ? {}
              : { side: scrollTarget.side === "old" ? "deletions" : "additions" }),
            align: "center",
            behavior: "smooth-auto",
          },
    );
    setCurrentPath(scrollTarget.path);
    onClearScrollTarget(scrollTarget.key);
  }, [
    displayMode,
    hunksByPath,
    items,
    onClearScrollTarget,
    paths,
    resources,
    scrollTarget,
    setCurrentPath,
  ]);

  const scrollFile = useCallback(
    (offset: number) => {
      const currentIndex = Math.max(0, activePath === null ? 0 : paths.indexOf(activePath));
      const next = paths[currentIndex + offset];
      if (next === undefined) return;
      codeViewRef.current?.scrollTo({
        type: "item",
        id: next,
        align: "start",
        behavior: "smooth-auto",
      });
      setCurrentPath(next);
    },
    [activePath, paths, setCurrentPath],
  );

  const scrollRegion = useCallback(
    (offset: number) => {
      if (activePath === null) return;
      const regions = regionAnchors(
        hunksByPath.get(activePath) ?? [],
        displayMode,
        headLineCount(resources.get(activePath)?.content ?? null),
      );
      if (regions.length === 0) return;
      const nextIndex = Math.max(0, Math.min(regions.length - 1, regionIndex + offset));
      setRegionIndex(nextIndex);
      const region = regions[nextIndex]!;
      codeViewRef.current?.scrollTo({
        type: "line",
        id: activePath,
        lineNumber: region.lineNumber,
        ...(displayMode === "just-the-code" ? {} : { side: region.side }),
        align: "center",
        behavior: "smooth-auto",
      });
    },
    [activePath, displayMode, hunksByPath, regionIndex, resources],
  );
  const activeCanMarkRead =
    activePath !== null && clusterId !== null && isClusterHomePath(journey, clusterId, activePath);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }

      if (event.key === "r" && activePath !== null && clusterId !== null && activeCanMarkRead) {
        event.preventDefault();
        onToggleRead(clusterId, activePath);
      } else if (event.key === "j") {
        event.preventDefault();
        scrollFile(1);
      } else if (event.key === "k") {
        event.preventDefault();
        scrollFile(-1);
      } else if (event.key === "n") {
        event.preventDefault();
        scrollRegion(1);
      } else if (event.key === "p") {
        event.preventDefault();
        scrollRegion(-1);
      } else if (event.key === "]" && onNextCluster !== undefined) {
        event.preventDefault();
        onNextCluster();
      } else if (event.key === "[" && onPreviousCluster !== undefined) {
        event.preventDefault();
        onPreviousCluster();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    activePath,
    activeCanMarkRead,
    clusterId,
    onNextCluster,
    onPreviousCluster,
    onToggleRead,
    scrollFile,
    scrollRegion,
  ]);

  const loadedCount = items.length;
  const activeHunks = activePath === null ? [] : (hunksByPath.get(activePath) ?? []);
  const activeRegions = regionAnchors(
    activeHunks,
    displayMode,
    activePath === null ? 0 : headLineCount(resources.get(activePath)?.content ?? null),
  );
  const activeFileIndex = activePath === null ? -1 : paths.indexOf(activePath);

  return (
    <div className="journey-code-shell">
      {loadedCount === 0 ? (
        <div className="journey-code-loading" aria-live="polite">
          <span className="journey-loading-line" />
          <span className="journey-loading-line" />
          <p>Loading pinned file contents…</p>
        </div>
      ) : (
        <CodeView<JourneyAnnotation>
          ref={codeViewRef}
          className="journey-code-view"
          items={items}
          options={options}
          onScroll={syncPosition}
          renderAnnotation={(annotation) => (
            <JourneyAnnotationView
              annotation={annotation.metadata?.value}
              onSelectHome={onSelectHome}
            />
          )}
          renderCustomHeader={(item) => {
            const path = item.id as RepositoryPath;
            const change = filesByPath.get(path) ?? null;
            const currentCluster = clusterId === null ? null : (clusterById.get(clusterId) ?? null);
            const canMarkRead =
              currentCluster !== null && isClusterHomePath(journey, currentCluster.id, path);
            const isRead =
              !canMarkRead || currentCluster === null
                ? false
                : readFiles.has(readMarkKey(currentCluster.id, path));
            return (
              <JourneyFileHeader
                path={path}
                change={change}
                displayMode={displayMode}
                isRead={isRead}
                canMarkRead={canMarkRead}
                onSetDisplayMode={onSetDisplayMode}
                {...(currentCluster === null
                  ? {}
                  : { onToggleRead: () => onToggleRead(currentCluster.id, path) })}
              />
            );
          }}
        />
      )}

      <footer className="journey-code-footer">
        <span className="journey-code-footer-path">{activePath ?? "Pinned files"}</span>
        <span>
          {activeRegions.length === 0
            ? "file-level change"
            : `region ${Math.min(regionIndex + 1, activeRegions.length)} of ${activeRegions.length}`}
        </span>
        <span className="journey-code-navigation" aria-label="Reading navigation">
          <button
            type="button"
            disabled={activeFileIndex <= 0}
            title="Previous file (K)"
            onClick={() => scrollFile(-1)}
          >
            ↑ file
          </button>
          <button
            type="button"
            disabled={activeFileIndex < 0 || activeFileIndex >= paths.length - 1}
            title="Next file (J)"
            onClick={() => scrollFile(1)}
          >
            ↓ file
          </button>
          <button
            type="button"
            disabled={activeRegions.length === 0 || regionIndex <= 0}
            title="Previous changed region (P)"
            onClick={() => scrollRegion(-1)}
          >
            ↑ change
          </button>
          <button
            type="button"
            disabled={activeRegions.length === 0 || regionIndex >= activeRegions.length - 1}
            title="Next changed region (N)"
            onClick={() => scrollRegion(1)}
          >
            ↓ change
          </button>
          {onPreviousCluster === undefined ? null : (
            <button type="button" title="Previous cluster ([)" onClick={onPreviousCluster}>
              ← cluster
            </button>
          )}
          {onNextCluster === undefined ? null : (
            <button type="button" title="Next cluster (])" onClick={onNextCluster}>
              cluster →
            </button>
          )}
        </span>
        <span className="journey-shortcuts" aria-label="Keyboard shortcuts">
          {activeCanMarkRead ? (
            <>
              <kbd>R</kbd> read{" "}
            </>
          ) : null}
          <kbd>J</kbd>/<kbd>K</kbd> file <kbd>N</kbd>/<kbd>P</kbd> region
        </span>
      </footer>
    </div>
  );
}

function JourneyFileHeader({
  path,
  change,
  displayMode,
  isRead,
  canMarkRead,
  onToggleRead,
  onSetDisplayMode,
}: {
  readonly path: RepositoryPath;
  readonly change: FileChange | null;
  readonly displayMode: DisplayMode;
  readonly isRead: boolean;
  readonly canMarkRead: boolean;
  readonly onToggleRead?: () => void;
  readonly onSetDisplayMode: (mode: DisplayMode) => void;
}) {
  return (
    <div className="journey-file-header">
      <div className="journey-file-heading">
        <strong>{path}</strong>
        {change === null ? <span>head revision</span> : <span>{change.kind}</span>}
        {change !== null && change.additions > 0 ? (
          <span className="journey-additions">+{change.additions}</span>
        ) : null}
        {change !== null && change.deletions > 0 ? (
          <span className="journey-deletions">−{change.deletions}</span>
        ) : null}
      </div>
      {displayMode === "just-the-code" ? null : (
        <fieldset className="journey-diff-arrangement" aria-label="Diff arrangement">
          <button
            type="button"
            aria-pressed={displayMode === "inline"}
            onClick={() => onSetDisplayMode("inline")}
          >
            Inline
          </button>
          <button
            type="button"
            aria-pressed={displayMode === "split"}
            onClick={() => onSetDisplayMode("split")}
          >
            Split
          </button>
        </fieldset>
      )}
      {canMarkRead ? (
        <button
          className="journey-mark-read"
          type="button"
          aria-pressed={isRead}
          onClick={onToggleRead}
        >
          <span aria-hidden>{isRead ? "✓" : "○"}</span>
          {isRead ? "Read" : "Mark read"}
          <kbd>R</kbd>
        </button>
      ) : null}
    </div>
  );
}

function JourneyAnnotationView({
  annotation,
  onSelectHome,
}: {
  readonly annotation: JourneyAnnotationValue | undefined;
  readonly onSelectHome: (clusterId: ClusterId) => void;
}) {
  if (annotation === undefined) return null;
  if (annotation.kind === "artifact") {
    return <ArtifactView annotation={annotation} />;
  }

  return (
    <div className="journey-home-label" data-scope={annotation.scope}>
      <button type="button" onClick={() => onSelectHome(annotation.home.id)}>
        {annotation.scope === "resurfaced" ? "Resurfacing" : "Home"} · {annotation.home.position} ·{" "}
        {annotation.home.title}
      </button>
      {annotation.resurfacingNote === null ? null : <span>{annotation.resurfacingNote}</span>}
    </div>
  );
}

function ArtifactView({
  annotation,
}: {
  readonly annotation: Extract<JourneyAnnotationValue, { readonly kind: "artifact" }>;
}) {
  if (annotation.error !== null) {
    return (
      <div className="journey-artifact-card" role="alert">
        <p className="eyebrow">Pinned file unavailable</p>
        <strong>{annotation.path}</strong>
        <p>{annotation.error}</p>
      </div>
    );
  }

  if (annotation.content?.type === "image") {
    return (
      <div className="journey-artifact-card journey-image-card">
        <p className="eyebrow">Image {annotation.change?.kind ?? "file"}</p>
        <div className="journey-image-comparison">
          <ImageSide
            label="Before"
            mediaType={annotation.content.oldMediaType}
            base64={annotation.content.oldBase64}
          />
          <ImageSide
            label="After"
            mediaType={annotation.content.newMediaType}
            base64={annotation.content.newBase64}
          />
        </div>
      </div>
    );
  }

  if (annotation.content?.type === "binary") {
    return (
      <div className="journey-artifact-card">
        <p className="eyebrow">Binary file {annotation.change?.kind ?? "changed"}</p>
        <strong>{annotation.path}</strong>
        <p>
          {formatBytes(annotation.content.oldSize)} → {formatBytes(annotation.content.newSize)}
        </p>
      </div>
    );
  }

  return (
    <div className="journey-artifact-card">
      <p className="eyebrow">{fileLevelLabel(annotation.fileKind, annotation.change)}</p>
      <strong>{annotation.path}</strong>
      <p>{fileLevelDetail(annotation.fileKind, annotation.change)}</p>
    </div>
  );
}

function ImageSide({
  label,
  mediaType,
  base64,
}: {
  readonly label: string;
  readonly mediaType: string | null;
  readonly base64: string | null;
}) {
  return (
    <figure>
      <figcaption>{label}</figcaption>
      {mediaType === null || base64 === null ? (
        <div className="journey-image-missing">No image</div>
      ) : (
        <img alt={`${label} revision`} src={`data:${mediaType};base64,${base64}`} />
      )}
    </figure>
  );
}

function buildCodeViewItem(input: {
  readonly journey: Journey;
  readonly path: RepositoryPath;
  readonly resource: JourneyFileResource;
  readonly displayMode: DisplayMode;
  readonly clusterId: ClusterId | null;
  readonly readFiles: ReadonlySet<string>;
  readonly readMarkKey: (clusterId: ClusterId, path: RepositoryPath) => string;
  readonly clusterById: ReadonlyMap<ClusterId, Cluster>;
  readonly hunks: readonly Hunk[];
  readonly change: FileChange | null;
  readonly resurfacedIds: ReadonlyMap<string, string>;
}): CodeViewItem<JourneyAnnotation> {
  const {
    journey,
    path,
    resource,
    displayMode,
    clusterId,
    readFiles,
    readMarkKey,
    clusterById,
    hunks,
    change,
    resurfacedIds,
  } = input;
  const collapsed =
    clusterId !== null &&
    isClusterHomePath(journey, clusterId, path) &&
    readFiles.has(readMarkKey(clusterId, path));
  const fileKind = hunks.find((hunk) => hunk.fileKind !== undefined)?.fileKind ?? null;
  const annotationSignature = hunks
    .map((hunk) => `${hunk.id}:${hunk.home}:${resurfacedIds.has(hunk.id) ? "r" : ""}`)
    .join("|");
  const version = stableHash(
    `${journey.id}:${displayMode}:${clusterId ?? ""}:${collapsed}:${annotationSignature}:${resource.ready}:${resource.error ?? ""}`,
  );

  if (
    resource.error !== null ||
    resource.content === null ||
    resource.content.type !== "text" ||
    fileKind !== null ||
    (displayMode === "just-the-code" && resource.content.new === null)
  ) {
    return {
      id: path,
      type: "file",
      file: emptyFile(path, journey.id),
      annotations: [
        {
          lineNumber: 0,
          metadata: {
            value: {
              kind: "artifact",
              path,
              content: resource.content,
              change,
              fileKind,
              error: resource.error,
            },
          },
        },
        ...homeAnnotationsForFile(hunks, clusterId, clusterById, resurfacedIds, null),
      ],
      version,
      collapsed,
    } satisfies CodeViewFileItem<JourneyAnnotation>;
  }

  if (displayMode === "just-the-code" || resource.patch?.patch === null) {
    return {
      id: path,
      type: "file",
      file: {
        name: path,
        contents: resource.content.new ?? "",
        cacheKey: `${journey.id}:${path}:head`,
      },
      annotations: homeAnnotationsForFile(
        hunks,
        clusterId,
        clusterById,
        resurfacedIds,
        headLineCount(resource.content),
      ),
      version,
      collapsed,
    } satisfies CodeViewFileItem<JourneyAnnotation>;
  }

  const patch = resource.patch?.patch;
  if (patch === undefined) {
    return artifactErrorItem(path, version, collapsed, change, fileKind, "The patch is loading.");
  }

  try {
    const oldFile: FileContents = {
      name: change?.oldPath ?? path,
      contents: resource.content.old ?? "",
      cacheKey: `${journey.id}:${path}:old`,
    };
    const newFile: FileContents = {
      name: path,
      contents: resource.content.new ?? "",
      cacheKey: `${journey.id}:${path}:new`,
    };
    const fileDiff = processFile(patch, {
      cacheKey: `${journey.id}:${path}:diff`,
      isGitDiff: true,
      oldFile,
      newFile,
      throwOnError: true,
    });
    if (fileDiff === undefined) {
      return artifactErrorItem(
        path,
        version,
        collapsed,
        change,
        fileKind,
        "The pinned patch did not contain a renderable file.",
      );
    }
    return {
      id: path,
      type: "diff",
      fileDiff,
      annotations: homeAnnotationsForDiff(hunks, clusterId, clusterById, resurfacedIds),
      version,
      collapsed,
    } satisfies CodeViewDiffItem<JourneyAnnotation>;
  } catch (error) {
    return artifactErrorItem(
      path,
      version,
      collapsed,
      change,
      fileKind,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function artifactErrorItem(
  path: RepositoryPath,
  version: number,
  collapsed: boolean,
  change: FileChange | null,
  fileKind: Hunk["fileKind"] | null,
  error: string,
): CodeViewFileItem<JourneyAnnotation> {
  return {
    id: path,
    type: "file",
    file: emptyFile(path, "error"),
    annotations: [
      {
        lineNumber: 0,
        metadata: {
          value: {
            kind: "artifact",
            path,
            content: null,
            change,
            fileKind,
            error,
          },
        },
      },
    ],
    version,
    collapsed,
  };
}

function emptyFile(path: RepositoryPath, cacheKey: string): FileContents {
  return { name: path, contents: "", cacheKey: `${cacheKey}:${path}:empty` };
}

function homeAnnotationsForDiff(
  hunks: readonly Hunk[],
  clusterId: ClusterId | null,
  clusterById: ReadonlyMap<ClusterId, Cluster>,
  resurfacedIds: ReadonlyMap<string, string>,
): DiffLineAnnotation<JourneyAnnotation>[] {
  return hunks.map((hunk) => ({
    side: hunk.newLines > 0 ? "additions" : "deletions",
    lineNumber: hunk.newLines > 0 ? hunk.newStart : hunk.oldStart,
    metadata: { value: homeAnnotation(hunk, clusterId, clusterById, resurfacedIds) },
  }));
}

function homeAnnotationsForFile(
  hunks: readonly Hunk[],
  clusterId: ClusterId | null,
  clusterById: ReadonlyMap<ClusterId, Cluster>,
  resurfacedIds: ReadonlyMap<string, string>,
  lineCount: number | null,
): LineAnnotation<JourneyAnnotation>[] {
  return hunks.map((hunk) => ({
    lineNumber: lineCount === null ? 0 : (codeModeLineAnchor(hunk, lineCount) ?? 0),
    metadata: {
      value: homeAnnotation(hunk, clusterId, clusterById, resurfacedIds),
    },
  }));
}

function homeAnnotation(
  hunk: Hunk,
  clusterId: ClusterId | null,
  clusterById: ReadonlyMap<ClusterId, Cluster>,
  resurfacedIds: ReadonlyMap<string, string>,
): JourneyAnnotationValue {
  const home = clusterById.get(hunk.home);
  if (home === undefined) {
    throw new Error(`Journey hunk ${hunk.id} has no home cluster.`);
  }
  const resurfacingNote = resurfacedIds.get(hunk.id) ?? null;
  return {
    kind: "home",
    hunk,
    home,
    scope: resurfacingNote !== null ? "resurfaced" : hunk.home === clusterId ? "home" : "foreign",
    resurfacingNote,
  };
}

function markRenderedLines(input: {
  readonly node: HTMLElement;
  readonly phase: "mount" | "update" | "unmount";
  readonly itemType: "file" | "diff";
  readonly hunks: readonly Hunk[];
  readonly clusterId: ClusterId | null;
  readonly resurfacedIds: ReadonlyMap<string, string>;
  readonly hints: readonly JourneyHint[];
  readonly headLines: number;
}) {
  const root = input.node.shadowRoot;
  if (root === null) return;
  const rows = root.querySelectorAll<HTMLElement>("[data-line], [data-column-number]");
  for (const row of rows) {
    delete row.dataset.tlScope;
    delete row.dataset.tlHints;
    if (input.phase === "unmount") continue;

    const line = Number(row.dataset.line ?? row.dataset.columnNumber);
    if (!Number.isInteger(line)) continue;
    const lineType = row.dataset.lineType ?? "";
    const side =
      input.itemType === "file"
        ? "new"
        : lineType.includes("deletion")
          ? "old"
          : lineType.includes("addition")
            ? "new"
            : null;
    if (side === null) continue;

    const hunk = input.hunks.find((candidate) =>
      input.itemType === "file" && candidate.newLines === 0
        ? line === codeModeLineAnchor(candidate, input.headLines)
        : inHunkRange(candidate, side, line),
    );
    if (hunk !== undefined) {
      row.dataset.tlScope = input.resurfacedIds.has(hunk.id)
        ? "resurfaced"
        : hunk.home === input.clusterId
          ? "home"
          : "foreign";
    }

    const hintIds = input.hints
      .filter(
        (hint) =>
          hint.anchor.side === side && line >= hint.anchor.startLine && line <= hint.anchor.endLine,
      )
      .map((hint) => hint.id);
    if (hintIds.length > 0) row.dataset.tlHints = hintIds.join(" ");
  }
}

function inHunkRange(hunk: Hunk, side: "old" | "new", line: number): boolean {
  const start = side === "old" ? hunk.oldStart : hunk.newStart;
  const lines = side === "old" ? hunk.oldLines : hunk.newLines;
  return lines > 0 && line >= start && line < start + lines;
}

function regionAnchors(
  hunks: readonly Hunk[],
  displayMode: DisplayMode,
  headLines: number,
): ReadonlyArray<{ readonly lineNumber: number; readonly side: "additions" | "deletions" }> {
  return hunks
    .flatMap((hunk) => {
      if (displayMode === "just-the-code") {
        const lineNumber = codeModeLineAnchor(hunk, headLines);
        return lineNumber === null ? [] : [{ lineNumber, side: "additions" as const }];
      }
      return [
        hunk.newLines > 0
          ? { lineNumber: hunk.newStart, side: "additions" as const }
          : { lineNumber: hunk.oldStart, side: "deletions" as const },
      ];
    })
    .toSorted((left, right) => left.lineNumber - right.lineNumber);
}

function nearestRenderedRegionIndex(
  root: ShadowRoot,
  itemType: CodeViewItem<JourneyAnnotation>["type"],
  regions: ReadonlyArray<{
    readonly lineNumber: number;
    readonly side: "additions" | "deletions";
  }>,
  viewportAnchor: number,
): number | null {
  let nearest: { readonly index: number; readonly distance: number } | null = null;
  for (const row of root.querySelectorAll<HTMLElement>("[data-line], [data-column-number]")) {
    const lineNumber = Number(row.dataset.line ?? row.dataset.columnNumber);
    if (!Number.isInteger(lineNumber)) continue;
    const side = renderedRowSide(itemType, row);
    if (side === null) continue;
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index]!;
      if (region.lineNumber !== lineNumber || region.side !== side) continue;
      const distance = Math.abs(row.getBoundingClientRect().top - viewportAnchor);
      if (nearest === null || distance < nearest.distance) {
        nearest = { index, distance };
      }
    }
  }
  return nearest?.index ?? null;
}

function renderedRowSide(
  itemType: CodeViewItem<JourneyAnnotation>["type"],
  row: HTMLElement,
): "additions" | "deletions" | null {
  if (itemType === "file") return "additions";
  const lineType = row.dataset.lineType ?? "";
  if (lineType.includes("deletion")) return "deletions";
  if (lineType.includes("addition")) return "additions";
  return null;
}

function headLineCount(content: FileContent | null): number {
  return content?.type === "text" ? countHeadLines(content.new) : 0;
}

function groupHunksByPath(hunks: readonly Hunk[]): ReadonlyMap<RepositoryPath, readonly Hunk[]> {
  const grouped = new Map<RepositoryPath, Hunk[]>();
  for (const hunk of hunks) {
    const current = grouped.get(hunk.path) ?? [];
    current.push(hunk);
    grouped.set(hunk.path, current);
  }
  return grouped;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function formatBytes(size: number | null): string {
  if (size === null) return "size unavailable";
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function fileLevelLabel(kind: Hunk["fileKind"] | null, change: FileChange | null): string {
  if (kind === "rename") return "Pure rename";
  if (kind === "mode") return "File mode changed";
  if (kind === "symlink") return "Symbolic link changed";
  if (kind === "submodule") return "Submodule pointer changed";
  if (kind === "empty") return `Empty file ${change?.kind ?? "changed"}`;
  if (kind === "binary") return `Binary file ${change?.kind ?? "changed"}`;
  return `File ${change?.kind ?? "changed"}`;
}

function fileLevelDetail(kind: Hunk["fileKind"] | null, change: FileChange | null): string {
  if (kind === "rename" && change?.oldPath !== null && change?.oldPath !== undefined) {
    return `Moved from ${change.oldPath}; the contents are unchanged.`;
  }
  if (kind === "mode") {
    return `${change?.oldMode ?? "unknown mode"} → ${change?.newMode ?? "unknown mode"}`;
  }
  if (kind === "submodule") return "The pinned commit reference changed.";
  if (kind === "symlink") return "The link target changed.";
  if (kind === "empty") return "There are no text lines to display.";
  return "This change has no textual diff to render.";
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
