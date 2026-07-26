import { useAtomValue } from "@effect/atom-react";
import type {
  FileTreeRowDecoration,
  FileTreeRowDecorationContext,
  FileTree as FileTreeModel,
  GitStatus,
  GitStatusEntry,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef } from "react";

import type { Cluster, FileChangeKind } from "@app/contracts";

import { useThemeType } from "../../hooks/useTheme.ts";
import { treeAtom } from "../../state/journeyState.ts";
import { useJourney } from "./JourneyLayout.tsx";

/**
 * The project's real file tree — not a synthetic list of changed paths.
 *
 * That distinction is the whole point of this surface. A list of changed files is a
 * report *about* a repository; the head-revision tree with its changed files marked
 * the way an editor marks uncommitted changes *is* the repository. Reading in it
 * feels like being in the project, which is what the receded posture is for. The
 * filter that narrows to changed files is one toggle away, for when the full tree is
 * noise.
 *
 * Above the tree sits a pinned, file-like Overview entry — docs-as-files, the way an
 * editor treats a README. It is what keeps the story one click away while the frame
 * is receded, and while a cluster is open it names that cluster's narrative too.
 *
 * **How this drives `@pierre/trees`.** The library's hook reads its options exactly
 * once, so props can never update the tree: everything after construction goes
 * through model methods (`resetPaths`, `setGitStatus`, `setComposition`), and every
 * callback it captures (`onSelectionChange`, `renderRowDecoration`) is a stable
 * closure over a ref. `resetPaths` builds a new store and therefore drops expansion
 * and selection, so both are re-supplied after every reset.
 *
 * **The one style opinion.** The library's git lane is a colour system (teal added,
 * blue modified, red deleted) and its icon set is colour-coded by file type. This
 * product has one accent colour with one meaning, so both are neutralised: one quiet
 * dot for every kind of change, and no file-type icons. Change kind, coverage, and
 * weight are carried by text in this product, never by hue.
 *
 * @module features/journey/FileTreeRail
 */

/**
 * Expansion, remembered per journey.
 *
 * The rail's two modes are mounted exclusively, so switching to Journey and back
 * unmounts the tree. An editor does not forget which folders you opened, so neither
 * does this. Journey ids are unique per analysis run, so nothing remembered here can
 * be applied to a tree it was not measured on.
 */
const EXPANSION_MEMORY = new Map<string, ReadonlyArray<string>>();

/** Change kinds the artifact distinguishes, mapped onto the tree's status lane. */
const STATUS_BY_KIND: Record<FileChangeKind, GitStatus> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  // A copy and a type change are both "this file is different now" as far as the
  // tree is concerned; the artifact keeps the precise kind for the file header.
  copied: "modified",
  "type-changed": "modified",
};

/** What the library's captured callbacks need, always current. */
interface RailContext {
  readonly filePaths: ReadonlySet<string>;
  readonly activeFile: string | null;
  readonly clusterCounts: ReadonlyMap<string, number>;
  readonly openFile: (path: string) => void;
}

export function FileTreeRail() {
  const { journey, changedOnly } = useJourney();
  const params = useParams({ from: "/pr/$owner/$repo/$number" });
  const fileRoute = useParams({ from: "/pr/$owner/$repo/$number/file/$", shouldThrow: false });
  const clusterRoute = useParams({
    from: "/pr/$owner/$repo/$number/cluster/$clusterId",
    shouldThrow: false,
  });
  const navigate = useNavigate();
  const themeType = useThemeType();

  const activeFile = fileRoute?._splat ?? null;
  const activeCluster = useMemo<Cluster | null>(() => {
    const clusterId = clusterRoute?.clusterId;
    if (clusterId === undefined) return null;
    return journey.clusters.find((cluster) => cluster.id === clusterId) ?? null;
  }, [clusterRoute?.clusterId, journey.clusters]);

  const treeResult = useAtomValue(treeAtom(journey.id));
  const changedPaths = useMemo(() => journey.files.map((file) => file.path), [journey.files]);

  const gitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () => journey.files.map((file) => ({ path: file.path, status: STATUS_BY_KIND[file.kind] })),
    [journey.files],
  );

  /**
   * How many clusters home hunks in a file. Shown only above one, because "1
   * cluster" is the unremarkable case and a lane full of it is noise. Above one is
   * the fact worth surfacing: this file is read from two places in the journey.
   */
  const clusterCounts = useMemo<ReadonlyMap<string, number>>(() => {
    const homes = new Map<string, Set<string>>();
    for (const hunk of journey.hunks) {
      const existing = homes.get(hunk.path);
      if (existing === undefined) homes.set(hunk.path, new Set([hunk.home]));
      else existing.add(hunk.home);
    }
    return new Map([...homes].map(([path, ids]) => [path, ids.size] as const));
  }, [journey.hunks]);

  const treeFailed = AsyncResult.isFailure(treeResult);
  const headPaths = AsyncResult.isSuccess(treeResult) ? treeResult.value.paths : null;

  /**
   * The tree's contents. The full head revision is the default posture; the filter
   * swaps in the changed set. A head revision that never arrived falls back to the
   * changed set rather than to nothing — the artifact always carries it, and a rail
   * with paths in it is more use than an empty one.
   */
  const paths = useMemo<ReadonlyArray<string>>(
    () => (changedOnly || headPaths === null ? changedPaths : headPaths),
    [changedOnly, headPaths, changedPaths],
  );
  const filePaths = useMemo(() => new Set(paths), [paths]);

  /**
   * The expansion a fresh tree opens with, and the fallback for a reset that happens
   * before the tree has ever rendered a row to read expansion from.
   */
  const seedExpansion = useMemo(
    () => EXPANSION_MEMORY.get(journey.id) ?? changedAncestors(changedPaths),
    [journey.id, changedPaths],
  );

  const contextRef = useRef<RailContext>({
    filePaths,
    activeFile,
    clusterCounts,
    openFile: () => {},
  });

  const { model } = useFileTree({
    // Read exactly once, which is why every value the tree needs later reaches it
    // through `contextRef` or a model method instead.
    paths,
    // An editor never hides `src` because it holds a single child; nor does this.
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    initialExpandedPaths: expansionOf(seedExpansion, activeFile),
    initialSelectedPaths: activeFile === null ? [] : [activeFile],
    gitStatus,
    icons: { set: "none" },
    itemHeight: 28,
    unsafeCSS: TREE_CSS,
    onSelectionChange: (selected) => {
      const context = contextRef.current;
      const path = selected.at(-1);
      if (path === undefined || path === context.activeFile) return;
      // Directories are selectable too; only a file is a place to navigate to.
      if (!context.filePaths.has(path)) return;
      context.openFile(path);
    },
    renderRowDecoration: (row) => decorate(row, contextRef.current.clusterCounts),
  });

  // Declared before every effect that reads it, so effect order keeps it current.
  useEffect(() => {
    contextRef.current = {
      filePaths,
      activeFile,
      clusterCounts,
      openFile: (path) =>
        void navigate({
          to: "/pr/$owner/$repo/$number/file/$",
          params: { ...params, _splat: path },
        }),
    };
  });

  const appliedPaths = useRef(paths);

  useEffect(() => {
    if (appliedPaths.current !== paths) {
      // Content, not identity: a re-fetch of the same head revision must not throw
      // the reviewer's expansion away, and on a real tree this comparison is the
      // cheap half of the work `resetPaths` would otherwise do.
      const differs = !sameOrder(appliedPaths.current, paths);
      appliedPaths.current = paths;
      if (differs) {
        // A rebuilt store drops expansion, so what is open right now is re-supplied.
        const open = expandedDirectories(model);
        model.resetPaths(paths, {
          initialExpandedPaths: expansionOf(
            open.length === 0 ? seedExpansion : open,
            contextRef.current.activeFile,
          ),
        });
      }
    }
    // Cheap when unchanged, and the one call that must follow a reset: a rebuilt
    // store carries no status markers.
    model.setGitStatus(gitStatus);
    // Forces the row lanes to re-read `renderRowDecoration` — the only route by
    // which decoration data that changed outside the model reaches a row.
    model.setComposition(model.getComposition());
  }, [model, paths, gitStatus, seedExpansion]);

  // One selection, following the URL: the tree shows where the reviewer is, and the
  // ancestor chain has to be open for `scrollToPath` to have a row to reach.
  useEffect(() => {
    if (activeFile === null) return;
    for (const directory of ancestorDirectories(activeFile)) {
      const item = model.getItem(directory);
      // `isDirectory()` is a method rather than a discriminant, so the handle union
      // narrows on the capability itself.
      if (item !== null && "expand" in item) item.expand();
    }
    for (const selected of model.getSelectedPaths()) {
      if (selected !== activeFile) model.getItem(selected)?.deselect();
    }
    const item = model.getItem(activeFile);
    if (item === null) return;
    item.select();
    model.scrollToPath(activeFile, { offset: "center" });
  }, [model, activeFile, paths]);

  useEffect(
    () => () => {
      EXPANSION_MEMORY.set(journey.id, expandedDirectories(model));
    },
    [model, journey.id],
  );

  const note = statusNote({
    changedOnly,
    treeFailed,
    treeLoading: headPaths === null && !treeFailed,
    empty: paths.length === 0,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {note !== null && <p className="px-3 pb-2 text-[11px] text-muted">{note}</p>}
      <div className="min-h-0 flex-1">
        <FileTree
          id="project-tree"
          model={model}
          header={
            <div className="px-1.5 pb-1.5">
              <button
                type="button"
                id="rail-overview-entry"
                onClick={() => void navigate({ to: "/pr/$owner/$repo/$number", params })}
                className="flex w-full cursor-pointer items-start gap-2 rounded-md border border-border bg-raised px-2 py-2 text-left font-sans text-[13px] leading-snug text-foreground transition-colors hover:border-border-strong"
              >
                <span aria-hidden className="shrink-0 text-[12px] text-faint">
                  §
                </span>
                <span className="min-w-0">
                  Overview
                  {activeCluster === null
                    ? ""
                    : ` — ${activeCluster.position} · ${activeCluster.title}`}
                </span>
              </button>
            </div>
          }
          // `light-dark()` survives in a few of the library's own values; the host's
          // colour scheme is what makes those follow the app's theme, not the OS.
          style={{ height: "100%", colorScheme: themeType }}
        />
      </div>
    </div>
  );
}

function decorate(
  context: FileTreeRowDecorationContext,
  counts: ReadonlyMap<string, number>,
): FileTreeRowDecoration | null {
  if (context.row.kind !== "file") return null;
  const count = counts.get(context.row.path);
  if (count === undefined || count < 2) return null;
  return { text: `${count} clusters`, title: `homed in ${count} clusters of this journey` };
}

/** Every state of the tree that is not simply "here it is", each one designed. */
function statusNote(input: {
  readonly changedOnly: boolean;
  readonly treeFailed: boolean;
  readonly treeLoading: boolean;
  readonly empty: boolean;
}): string | null {
  if (input.treeFailed && !input.changedOnly) {
    return "the project tree isn't available for this journey — showing the changed files";
  }
  if (input.treeLoading && !input.changedOnly) return "reading the project tree…";
  if (input.empty) return input.changedOnly ? "no changed files" : "this tree has no files";
  return null;
}

/** A base expansion plus the open file's own chain, which must always be visible. */
function expansionOf(
  base: ReadonlyArray<string>,
  activeFile: string | null,
): ReadonlyArray<string> {
  const directories = new Set(base);
  if (activeFile !== null) {
    for (const directory of ancestorDirectories(activeFile)) directories.add(directory);
  }
  return [...directories];
}

/**
 * Every directory holding a change. A fresh tree opens showing where the change is,
 * which is the tree's own quiet answer to "where do I begin".
 */
function changedAncestors(changedPaths: ReadonlyArray<string>): ReadonlyArray<string> {
  const directories = new Set<string>();
  for (const path of changedPaths) {
    for (const directory of ancestorDirectories(path)) directories.add(directory);
  }
  return [...directories];
}

/** `src/app/router.tsx` → `["src", "src/app"]`. */
function ancestorDirectories(path: string): ReadonlyArray<string> {
  const directories: string[] = [];
  let prefix = "";
  for (const segment of path.split("/").slice(0, -1)) {
    if (segment.length === 0) continue;
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    directories.push(prefix);
  }
  return directories;
}

/**
 * The currently expanded directories. `getVisibleRows`' end index is inclusive, and
 * only rows under expanded ancestors are visible at all — which is exactly right
 * here, since expansion hidden inside a collapsed folder is not expansion the
 * reviewer can see.
 */
function expandedDirectories(model: FileTreeModel): ReadonlyArray<string> {
  const count = model.getVisibleCount();
  if (count === 0) return [];
  return model
    .getVisibleRows(0, count - 1)
    .filter((row) => row.kind === "directory" && row.isExpanded)
    .map((row) => row.path);
}

function sameOrder(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

/**
 * The tree's styling, injected into its shadow root — the library's only seam that
 * reaches a row, and the reason none of this is Tailwind. It lands in the `unsafe`
 * cascade layer, so it wins over the library's own `base` layer without specificity
 * games. Every colour resolves to an app token through inherited custom properties,
 * so the tree follows the app's theme with no second theme definition to keep in
 * sync.
 */
const TREE_CSS = `
  :host {
    --trees-font-family-override: var(--font-mono);
    --trees-font-size-override: 12px;
    --trees-padding-inline-override: 8px;
    --trees-bg-override: var(--color-card);
    --trees-fg-override: var(--color-muted);
    --trees-fg-muted-override: var(--color-faint);
    --trees-border-color-override: var(--color-border);
    --trees-selected-bg-override: var(--color-raised);
    --trees-selected-fg-override: var(--color-foreground);
    --trees-selected-focused-border-color-override: var(--color-border-strong);
    /* Focus is always the accent in this product; emphasis is what it means. */
    --trees-focus-ring-color-override: var(--color-accent);
    /* Drives the hover tint. Neutral, so hover never borrows the accent's meaning. */
    --trees-accent-override: var(--color-foreground);
    --trees-git-added-color-override: var(--color-faint);
    --trees-git-modified-color-override: var(--color-faint);
    --trees-git-deleted-color-override: var(--color-faint);
    --trees-git-renamed-color-override: var(--color-faint);
    --trees-git-untracked-color-override: var(--color-faint);
    --trees-git-ignored-color-override: var(--color-faint);
  }

  /*
   * One quiet dot for every kind of change, in place of the library's A/M/D/R
   * letters. Which kind it is is not what this rail is for; that it changed, and
   * which clusters read it, is.
   */
  [data-item-git-status] > [data-item-section="git"] > span {
    font-size: 0;
  }
  [data-item-git-status] > [data-item-section="git"] > span::before {
    content: "";
    display: block;
    width: 5px;
    height: 5px;
    border-radius: 999px;
    background-color: currentColor;
  }

  /* A deleted file is gone at head: present in the filtered tree, visibly past. */
  [data-item-git-status="deleted"] {
    opacity: 0.55;
  }

  /* Selection outranks the status colour, so the open file reads as open. */
  [data-item-selected="true"] > [data-item-section="content"] {
    color: var(--trees-selected-fg);
  }

  /* Paths speak monospace; the cluster count beside them is prose. */
  [data-item-section="decoration"] {
    font-family: var(--font-sans);
    font-size: 11px;
  }
`;
