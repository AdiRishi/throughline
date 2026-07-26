import { useAtomValue } from "@effect/atom-react";
import { processFile, type CodeViewOptions, type PostRenderPhase } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem } from "@pierre/diffs/react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { DisplayMode, JourneyId } from "@app/contracts";

import { useThemeType } from "../hooks/useTheme.ts";
import { bundleKey, clusterFilesAtom, type FileBundle } from "../state/journeyState.ts";
import {
  applyEmphasis,
  EMPHASIS_CSS,
  EMPTY_EMPHASIS,
  JUST_THE_CODE_CSS,
  type FileEmphasis,
} from "./emphasis.ts";

/**
 * The reading surface: one virtualized `CodeView` for every file on the page.
 *
 * A single stack rather than a component per file, because that is what the
 * library's virtualization is built for — at ninety files and forty thousand
 * lines, mounting a diff per file is the difference between a reading experience
 * and a stall.
 *
 * Three integration facts, each learned by proving it against a real `CodeView`,
 * shape everything here:
 *
 * 1. **A bare patch is never expandable.** `isPartial` is true for any diff parsed
 *    from patch text alone, and the library gates its expand affordances on it. So
 *    every diff is parsed *with* the full old and new blobs, which flips
 *    `isPartial` false and makes the product's expand-context interaction native
 *    library behaviour rather than something we simulate.
 * 2. **Items only re-read when `version` changes.** Mutating an item without
 *    bumping `version` is a silent no-op, so every derived item carries a version
 *    computed from everything that can change it.
 * 3. **Nothing can style a code row from outside.** Each file renders in its own
 *    shadow root; emphasis is written as `data-*` markers in `onPostRender` and
 *    styled by one memoised `unsafeCSS` string (see `./emphasis.ts`).
 *
 * @module journey/CodeSurface
 */

export interface CodeSurfaceAnnotation {
  readonly path: string;
  readonly side: "old" | "new";
  /** 1-based, on `side`. `0` renders above the file's first line. */
  readonly line: number;
  readonly render: () => ReactNode;
}

export interface CodeSurfaceFile {
  readonly path: string;
  readonly emphasis: FileEmphasis;
  /** Collapsed when the reviewer has marked it read. */
  readonly collapsed: boolean;
  readonly header: ReactNode;
}

export interface CodeSurfaceHandle {
  readonly scrollToFile: (path: string) => void;
  readonly scrollToLine: (path: string, side: "old" | "new", line: number) => void;
  /** Which files are currently on screen, newest observation first. */
  readonly visiblePaths: () => ReadonlyArray<string>;
}

/** Item metadata. `CodeView<T>` requires every annotation to carry it. */
interface Meta {
  readonly path: string;
  readonly key: string;
}

export function CodeSurface({
  journeyId,
  files,
  displayMode,
  annotations,
  onVisibleChange,
  surfaceRef,
  emptyMessage,
}: {
  readonly journeyId: JourneyId;
  readonly files: ReadonlyArray<CodeSurfaceFile>;
  readonly displayMode: DisplayMode;
  readonly annotations: ReadonlyArray<CodeSurfaceAnnotation>;
  readonly onVisibleChange?: (paths: ReadonlyArray<string>) => void;
  readonly surfaceRef?: (handle: CodeSurfaceHandle | null) => void;
  readonly emptyMessage?: string;
}) {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const bundlesResult = useAtomValue(clusterFilesAtom(bundleKey(journeyId, paths)));
  const themeType = useThemeType();
  const handleRef = useRef<CodeViewHandle<Meta> | null>(null);
  const visibleRef = useRef<ReadonlyArray<string>>([]);

  const bundles = AsyncResult.isSuccess(bundlesResult) ? bundlesResult.value : null;

  // Keys are assigned once, here, so the item builder and the renderer agree.
  const keyedAnnotations = useMemo<ReadonlyArray<KeyedAnnotation>>(
    () =>
      annotations.map((annotation, index) => ({
        ...annotation,
        key: `${annotation.path}:${annotation.side}:${annotation.line}:${index}`,
      })),
    [annotations],
  );

  const items = useMemo<ReadonlyArray<CodeViewItem<Meta>>>(() => {
    if (bundles === null) return [];
    return files.flatMap((file) => {
      const bundle = bundles.get(file.path) ?? null;
      const item = buildItem({ file, bundle, displayMode, annotations: keyedAnnotations });
      return item === null ? [] : [item];
    });
  }, [bundles, files, displayMode, keyedAnnotations]);

  /**
   * Emphasis is written per rendered file. It fires on mount *and* on every
   * partial re-render, so rows scrolled into view are marked too — and both
   * branches of every toggle are always written, because a marker left behind
   * leaks onto whatever file the recycled host renders next.
   */
  const onPostRender = useCallback(
    (node: HTMLElement, _instance: unknown, phase: PostRenderPhase, context: unknown) => {
      if (phase === "unmount") return;
      const root = node.shadowRoot;
      if (root === null) return;
      const item = (context as { readonly item?: { readonly id?: string } } | undefined)?.item;
      const path = pathFromItemId(item?.id ?? "");
      const emphasis = files.find((file) => file.path === path)?.emphasis ?? EMPTY_EMPHASIS;
      applyEmphasis(root, emphasis);
    },
    [files],
  );

  const options = useMemo<CodeViewOptions<Meta>>(
    () => ({
      // The library's default is `split`; inline is the product's default.
      diffStyle: displayMode === "split" ? "split" : "unified",
      theme: { light: "pierre-light", dark: "pierre-dark" },
      themeType,
      stickyHeaders: true,
      hunkSeparators: "line-info",
      lineHoverHighlight: "line",
      collapsedContextThreshold: 2,
      expansionLineCount: 40,
      unsafeCSS: displayMode === "just-the-code" ? JUST_THE_CODE_CSS : EMPHASIS_CSS,
      onPostRender: onPostRender as never,
    }),
    [displayMode, themeType, onPostRender],
  );

  useEffect(() => {
    if (surfaceRef === undefined) return;
    const handle: CodeSurfaceHandle = {
      scrollToFile: (path) =>
        handleRef.current?.scrollTo({
          type: "item",
          id: itemId(path, displayMode),
          align: "start",
          offset: -8,
        }),
      scrollToLine: (path, side, line) =>
        handleRef.current?.scrollTo({
          type: "line",
          id: itemId(path, displayMode),
          lineNumber: line,
          side: side === "old" ? "deletions" : "additions",
          align: "center",
          behavior: "smooth",
        }),
      visiblePaths: () => visibleRef.current,
    };
    surfaceRef(handle);
    return () => surfaceRef(null);
  }, [surfaceRef, displayMode]);

  /**
   * The guidance rail follows the reader's position, so the surface reports which
   * files are on screen. The library exposes its rendered items, which is exactly
   * the viewport question — no intersection observers needed.
   */
  const handleScroll = useCallback(() => {
    const instance = handleRef.current?.getInstance();
    if (instance === undefined) return;
    const next = instance
      .getRenderedItems()
      .map((rendered) => pathFromItemId(rendered.id))
      .filter((path): path is string => path !== null);
    const changed =
      next.length !== visibleRef.current.length ||
      next.some((path, index) => visibleRef.current[index] !== path);
    if (!changed) return;
    visibleRef.current = next;
    onVisibleChange?.(next);
  }, [onVisibleChange]);

  if (AsyncResult.isFailure(bundlesResult)) {
    return (
      <Placeholder>
        This journey&rsquo;s materialized diff is no longer on disk. Reanalyze the pull request to
        rebuild it.
      </Placeholder>
    );
  }
  if (bundles === null) {
    return <Placeholder>Loading the code…</Placeholder>;
  }
  if (items.length === 0) {
    return <Placeholder>{emptyMessage ?? "Nothing to read here."}</Placeholder>;
  }

  return (
    <CodeView<Meta>
      // Remounting on a display-mode change is deliberate: the item *kind*
      // changes between diff and just-the-code, and the library refuses to
      // switch an item's type in place.
      key={displayMode}
      ref={handleRef}
      items={items}
      options={options}
      onScroll={handleScroll}
      renderCustomHeader={(item) => {
        const path = pathFromItemId(item.id);
        return files.find((file) => file.path === path)?.header ?? null;
      }}
      renderAnnotation={(annotation) => {
        const key = annotation.metadata.key;
        const match = keyedAnnotations.find((candidate) => candidate.key === key);
        return match?.render() ?? null;
      }}
      style={{ height: "100%", overflow: "auto" }}
    />
  );
}

/**
 * Annotations are matched by a synthetic key carried in the item's metadata rather
 * than by coordinates, so two annotations anchored to the same line stay
 * distinguishable (a foreign-hunk home label and a hint can share a line).
 */
interface KeyedAnnotation extends CodeSurfaceAnnotation {
  readonly key: string;
}

function buildItem(input: {
  readonly file: CodeSurfaceFile;
  readonly bundle: FileBundle | null;
  readonly displayMode: DisplayMode;
  readonly annotations: ReadonlyArray<KeyedAnnotation>;
}): CodeViewItem<Meta> | null {
  const { file, bundle, displayMode } = input;
  if (bundle === null) return null;

  const keyed = input.annotations.filter((annotation) => annotation.path === file.path);

  const version = hash(
    `${displayMode}|${file.collapsed}|${keyed.map((entry) => entry.key).join(",")}|${emphasisSignature(file.emphasis)}`,
  );

  const isBinary = bundle.content.oldBinaryBytes !== null || bundle.content.newBinaryBytes !== null;
  const hasImage =
    bundle.content.oldImageDataUrl !== null || bundle.content.newImageDataUrl !== null;

  /**
   * Non-textual changes render as what they are.
   *
   * `@pierre/diffs` has no binary or image support at all — no item kind, no
   * `binary` flag on a parsed diff. So these become a `file` item whose contents
   * are one honest line, with the real surface (an image pair, or a placard)
   * rendered through a file-level annotation. That keeps them *inside* the one
   * virtualized scroll container and in narrative order, which matters more than
   * rendering them natively would.
   */
  if (isBinary || hasImage) {
    return {
      id: itemId(file.path, displayMode),
      type: "file",
      file: {
        name: file.path,
        contents: describeBinary(bundle),
        cacheKey: `${file.path}:binary`,
      },
      annotations: [{ lineNumber: 0, metadata: { path: file.path, key: `${file.path}:binary` } }],
      collapsed: file.collapsed,
      version,
    };
  }

  if (displayMode === "just-the-code") {
    const text = bundle.content.newText;
    if (text === null) {
      // Deleted files have no head revision to show in silence; they read as
      // their deletion diff instead, which is the honest thing to render.
      return textualDiffItem({ file, bundle, displayMode, keyed, version });
    }
    return {
      id: itemId(file.path, displayMode),
      type: "file",
      file: { name: file.path, contents: text, cacheKey: `${file.path}:new` },
      annotations: keyed.map((annotation) => ({
        lineNumber: annotation.side === "new" ? annotation.line : 0,
        metadata: { path: file.path, key: annotation.key },
      })),
      collapsed: file.collapsed,
      version,
    };
  }

  return textualDiffItem({ file, bundle, displayMode, keyed, version });
}

function textualDiffItem(input: {
  readonly file: CodeSurfaceFile;
  readonly bundle: FileBundle;
  readonly displayMode: DisplayMode;
  readonly keyed: ReadonlyArray<KeyedAnnotation>;
  readonly version: number;
}): CodeViewItem<Meta> | null {
  const { file, bundle } = input;
  const patch = bundle.patch?.patch ?? "";
  if (patch.trim().length === 0) return null;

  const oldPath = bundle.patch?.oldPath ?? file.path;
  // Parsing WITH both blobs is what sets `isPartial: false`, and `isPartial` is
  // the only thing that decides whether expansion affordances exist.
  const fileDiff = processFile(patch, {
    isGitDiff: true,
    cacheKey: `${file.path}:diff`,
    ...(bundle.content.oldText === null
      ? {}
      : { oldFile: { name: oldPath, contents: bundle.content.oldText } }),
    ...(bundle.content.newText === null
      ? {}
      : { newFile: { name: file.path, contents: bundle.content.newText } }),
  });
  if (fileDiff === undefined) return null;

  return {
    id: itemId(file.path, input.displayMode),
    type: "diff",
    fileDiff,
    annotations: input.keyed.map((annotation) => ({
      side: annotation.side === "old" ? "deletions" : "additions",
      lineNumber: annotation.line,
      metadata: { path: file.path, key: annotation.key },
    })),
    collapsed: file.collapsed,
    version: input.version,
  };
}

function describeBinary(bundle: FileBundle): string {
  const before = bundle.content.oldBinaryBytes;
  const after = bundle.content.newBinaryBytes;
  if (before !== null && after !== null)
    return `binary file changed — ${bytes(before)} → ${bytes(after)}`;
  if (after !== null) return `binary file added — ${bytes(after)}`;
  if (before !== null) return `binary file removed — ${bytes(before)}`;
  return "binary file changed";
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The item id encodes the display mode, so switching modes never asks the library
 * to change an existing item's type — which it refuses to do.
 */
function itemId(path: string, displayMode: DisplayMode): string {
  return `${displayMode}::${path}`;
}

function pathFromItemId(id: string): string | null {
  const separator = id.indexOf("::");
  return separator === -1 ? null : id.slice(separator + 2);
}

function emphasisSignature(emphasis: FileEmphasis): string {
  const describe = (ranges: FileEmphasis["focus"]) =>
    ranges.map((range) => `${range.side}${range.start}-${range.end}`).join(",");
  return `${describe(emphasis.focus)}|${describe(emphasis.dim)}|${describe(emphasis.revisit)}`;
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}

function Placeholder({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
      {children}
    </div>
  );
}
