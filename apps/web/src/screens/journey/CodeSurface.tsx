import { parseDiffFromFile, type CodeViewItem, type DiffLineAnnotation } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef } from "react";

import type {
  Cluster,
  ClusterId,
  DisplayMode,
  FileChange,
  FileContent,
  Journey,
  JourneyFiles,
  ReadState,
} from "@app/contracts";

interface ReviewAnnotation {
  readonly type: "home" | "foreign" | "resurfaced" | "hint";
  readonly clusterId?: ClusterId;
  readonly label: string;
}

export interface CodeFocus {
  readonly path: string;
  readonly lineNumber?: number;
  readonly side?: "additions" | "deletions";
}

function annotationsFor(
  journey: Journey,
  cluster: Cluster,
  path: string,
  mode: DisplayMode,
): Array<DiffLineAnnotation<ReviewAnnotation>> {
  const clusterById = new Map(journey.clusters.map((candidate) => [candidate.id, candidate]));
  const resurfaced = new Set(cluster.resurfaced.map((item) => item.hunkId));
  const hunkAnnotations = journey.hunks
    .filter((hunk) => hunk.path === path)
    .map((hunk) => {
      const home = clusterById.get(hunk.home);
      const type =
        hunk.home === cluster.id ? "home" : resurfaced.has(hunk.id) ? "resurfaced" : "foreign";
      return {
        side: "additions" as const,
        lineNumber: Math.max(1, hunk.newStart),
        metadata: {
          type,
          clusterId: hunk.home,
          label:
            type === "home"
              ? `Home · ${cluster.title}`
              : type === "resurfaced"
                ? `Revisit · ${home?.title ?? hunk.home}`
                : `Home · ${home?.title ?? hunk.home}`,
        } satisfies ReviewAnnotation,
      };
    });
  const hintAnnotations = journey.hints
    .filter(
      (hint) =>
        hint.clusterId === cluster.id &&
        hint.anchor.path === path &&
        !(mode === "just-the-code" && hint.anchor.side === "old"),
    )
    .map((hint) => ({
      side: hint.anchor.side === "old" ? ("deletions" as const) : ("additions" as const),
      lineNumber: hint.anchor.startLine,
      metadata: {
        type: "hint" as const,
        label: hint.kind.replace("-", " "),
      },
    }));
  return [...hunkAnnotations, ...hintAnnotations];
}

function fileItem(
  journey: Journey,
  cluster: Cluster,
  files: JourneyFiles,
  path: string,
  mode: DisplayMode,
  readState: ReadState,
): CodeViewItem<ReviewAnnotation> | null {
  const read = readState.readFiles.some(
    (entry) => entry.clusterId === cluster.id && entry.path === path,
  );
  const annotations = annotationsFor(journey, cluster, path, mode);
  const content = files.contents.find((candidate) => candidate.path === path);
  if (
    imageMimeType(path) !== null ||
    content?.oldEncoding === "base64" ||
    content?.newEncoding === "base64"
  ) {
    return null;
  }
  if (mode === "just-the-code") {
    const renderedContent =
      content?.newEncoding === "text"
        ? content.newContent
        : content?.oldEncoding === "text"
          ? content.oldContent
          : null;
    if (renderedContent === null || renderedContent === undefined) return null;
    return {
      id: path,
      type: "file",
      file: {
        name: path,
        contents: renderedContent,
        cacheKey: `${journey.id}:${journey.pinned.headSha}:${path}`,
      },
      annotations: annotations
        .filter((annotation) => annotation.side === "additions")
        .map((annotation) => ({
          lineNumber: annotation.lineNumber,
          metadata: annotation.metadata,
        })),
      collapsed: read,
      version: read ? 1 : 0,
    };
  }

  if (content === undefined) {
    return null;
  }
  if (content.oldContent === null && content.newContent === null) {
    return null;
  }
  const file = journey.files.find((candidate) => candidate.path === path);
  const fileDiff = parseDiffFromFile(
    {
      name: file?.oldPath ?? path,
      contents: content.oldContent ?? "",
      cacheKey: `${journey.id}:${journey.pinned.baseSha}:${file?.oldPath ?? path}`,
    },
    {
      name: path,
      contents: content.newContent ?? "",
      cacheKey: `${journey.id}:${journey.pinned.headSha}:${path}`,
    },
    { context: 3 },
  );
  if (fileDiff.hunks.length === 0) {
    const renderedContent =
      content?.newEncoding === "text"
        ? content.newContent
        : content?.oldEncoding === "text"
          ? content.oldContent
          : null;
    if (renderedContent === null || renderedContent === undefined) return null;
    return {
      id: path,
      type: "file",
      file: {
        name: path,
        contents: renderedContent,
        cacheKey: `${journey.id}:${journey.pinned.headSha}:${path}`,
      },
      annotations: annotations
        .filter((annotation) => annotation.side === "additions")
        .map((annotation) => ({
          lineNumber: annotation.lineNumber,
          metadata: annotation.metadata,
        })),
      collapsed: read,
      version: read ? 1 : 0,
    };
  }
  return {
    id: path,
    type: "diff",
    fileDiff,
    annotations,
    collapsed: read,
    version: read ? 1 : 0,
  };
}

function imageMimeType(path: string): string | null {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (extension) {
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function changeDescription(file: FileChange): string {
  switch (file.kind) {
    case "added":
      return "file added";
    case "deleted":
      return "file deleted";
    case "renamed":
      return file.oldPath === undefined ? "file renamed" : `renamed from ${file.oldPath}`;
    case "mode":
      return "file mode changed";
    case "submodule":
      return "submodule reference changed";
    case "symlink":
      return "symbolic link changed";
    default:
      return "binary file changed";
  }
}

function NonTextChange({
  file,
  content,
  read,
  onMark,
}: {
  readonly file: FileChange;
  readonly content: FileContent | undefined;
  readonly read: boolean;
  readonly onMark: (() => void) | undefined;
}) {
  const mime = imageMimeType(file.path);
  const source = (value: string, encoding: "text" | "base64") =>
    encoding === "base64"
      ? `data:${mime};base64,${value}`
      : `data:${mime};charset=utf-8,${encodeURIComponent(value)}`;
  const images =
    mime === null
      ? []
      : [
          ...(content?.oldContent !== null && content?.oldContent !== undefined
            ? [{ label: "Before", source: source(content.oldContent, content.oldEncoding) }]
            : []),
          ...(content?.newContent !== null && content?.newContent !== undefined
            ? [{ label: "After", source: source(content.newContent, content.newEncoding) }]
            : []),
        ];
  return (
    <article className={`non-text-change ${read ? "read" : ""}`}>
      <header>
        <div>
          <code>{file.path}</code>
          <span>{changeDescription(file)}</span>
        </div>
        {onMark !== undefined && (
          <button onClick={onMark}>{read ? "Mark unread" : "Mark read"}</button>
        )}
      </header>
      {images.length > 0 ? (
        <div className="image-change">
          {images.map((image) => (
            <figure key={image.label}>
              <figcaption>{image.label}</figcaption>
              <img src={image.source} alt={`${image.label} version of ${file.path}`} />
            </figure>
          ))}
        </div>
      ) : (
        <p>No textual diff is available for this change.</p>
      )}
    </article>
  );
}

export function CodeSurface({
  journey,
  cluster,
  files,
  paths,
  mode,
  readState,
  focus,
  onMarkFile,
  onModeChange,
  onOpenCluster,
  onVisiblePath,
}: {
  readonly journey: Journey;
  readonly cluster: Cluster;
  readonly files: JourneyFiles;
  readonly paths: ReadonlyArray<string>;
  readonly mode: DisplayMode;
  readonly readState: ReadState;
  readonly focus: CodeFocus | null;
  readonly onMarkFile: ((path: string) => void) | undefined;
  readonly onModeChange: (mode: DisplayMode) => void;
  readonly onOpenCluster: (clusterId: ClusterId) => void;
  readonly onVisiblePath: (path: string) => void;
}) {
  const viewRef = useRef<CodeViewHandle<ReviewAnnotation>>(null);
  const items = useMemo(
    () =>
      paths.flatMap((path) => {
        const item = fileItem(journey, cluster, files, path, mode, readState);
        return item === null ? [] : [item];
      }),
    [cluster, files, journey, mode, paths, readState],
  );
  const renderedPaths = new Set(items.map((item) => item.id));
  const nonTextFiles = paths.flatMap((path) => {
    if (renderedPaths.has(path)) return [];
    const file = journey.files.find((candidate) => candidate.path === path);
    return file === undefined ? [] : [file];
  });
  const options = useMemo(
    () => ({
      diffStyle: mode === "split" ? ("split" as const) : ("unified" as const),
      theme: { dark: "github-dark-default", light: "github-light-default" },
      themeType: "system" as const,
      overflow: "scroll" as const,
      diffIndicators: "bars" as const,
      expandUnchanged: false,
      expansionLineCount: 20,
      stickyHeaders: true,
    }),
    [mode],
  );

  useEffect(() => {
    if (focus === null || !items.some((item) => item.id === focus.path)) return;
    viewRef.current?.scrollTo(
      focus.lineNumber === undefined
        ? { type: "item", id: focus.path, align: "start", behavior: "smooth" }
        : {
            type: "line",
            id: focus.path,
            lineNumber: focus.lineNumber,
            ...(focus.side === undefined ? {} : { side: focus.side }),
            align: "center",
            behavior: "smooth",
          },
    );
  }, [focus, items]);

  return (
    <>
      {items.length > 0 && (
        <CodeView
          ref={viewRef}
          className="cluster-code-view"
          items={items}
          onScroll={(scrollTop, viewer) => {
            const visible = items.findLast(
              (item) => (viewer.getTopForItem(item.id) ?? Infinity) <= scrollTop + 120,
            );
            if (visible !== undefined) onVisiblePath(visible.id);
          }}
          options={options}
          renderCustomHeader={(item) => {
            const read = readState.readFiles.some(
              (entry) => entry.clusterId === cluster.id && entry.path === item.id,
            );
            return (
              <div className="code-view-header">
                <code>{item.id}</code>
                <div>
                  {mode !== "just-the-code" && (
                    <button onClick={() => onModeChange(mode === "split" ? "inline" : "split")}>
                      {mode === "split" ? "Inline" : "Split"}
                    </button>
                  )}
                  {onMarkFile !== undefined && (
                    <button onClick={() => onMarkFile(item.id)}>
                      {read ? "Mark unread" : "Mark read"}
                    </button>
                  )}
                </div>
              </div>
            );
          }}
          renderAnnotation={(annotation) => {
            const metadata = annotation.metadata;
            if (metadata.type === "hint") {
              return <span className="code-annotation hint">{metadata.label}</span>;
            }
            return (
              <button
                className={`code-annotation ${metadata.type}`}
                onClick={() => {
                  if (metadata.clusterId !== undefined) onOpenCluster(metadata.clusterId);
                }}
              >
                {metadata.label}
              </button>
            );
          }}
        />
      )}
      {nonTextFiles.map((file) => {
        const read = readState.readFiles.some(
          (entry) => entry.clusterId === cluster.id && entry.path === file.path,
        );
        return (
          <NonTextChange
            key={file.path}
            file={file}
            content={files.contents.find((candidate) => candidate.path === file.path)}
            read={read}
            onMark={onMarkFile === undefined ? undefined : () => onMarkFile(file.path)}
          />
        );
      })}
    </>
  );
}
