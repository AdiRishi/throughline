import { useParams } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import type { Cluster, ClusterId, DisplayMode, Hint, RepositoryPath } from "@app/contracts";

import { XIcon } from "../../components/Icons.tsx";
import { localApi } from "../../localApi.ts";
import { readMarkKey, useJourneyContext } from "./JourneyContext.tsx";
import { JourneyMarkdown } from "./JourneyMarkdown.tsx";
import { JourneyRouteNotice } from "./JourneyRouteNotice.tsx";
import {
  deriveJourneyViewModel,
  fileHomes,
  resolveClusterRoute,
  resolveFileRoute,
} from "./model.ts";
import { JourneyFileResourceSubscriptions, type JourneyFileResource } from "./resources.tsx";

const JourneyCodeView = lazy(async () => ({
  default: (await import("./JourneyCodeView.tsx")).JourneyCodeView,
}));
const JOURNEY_CODE_VIEW_FALLBACK = <JourneyCodeViewLoading />;

export function JourneyOverviewPage() {
  const context = useJourneyContext();
  const { journey } = context.document;
  const view = useMemo(
    () =>
      deriveJourneyViewModel(journey, {
        journeyId: journey.id,
        readFiles: context.readView.readMarks,
        displayMode: context.readView.displayMode,
        updatedAt: journey.pinned.analyzedAt,
      }),
    [context.readView, journey],
  );

  return (
    <article className="journey-overview">
      <header className="journey-document-heading">
        <p className="eyebrow">Overview</p>
        <h1>{context.document.pullRequest.title}</h1>
        <div className="journey-document-meta">
          <span>
            {view.progress.markedFiles} of {view.progress.clusterFiles} files read
          </span>
          <span aria-hidden>·</span>
          <span>
            {view.progress.readHunks} of {view.progress.totalHunks} hunks covered
          </span>
          {context.stale ? (
            <>
              <span aria-hidden>·</span>
              <strong>Snapshot is stale</strong>
              <button type="button" onClick={context.reanalyze}>
                Reanalyze
              </button>
            </>
          ) : null}
        </div>
      </header>

      <section className="journey-overview-section journey-overview-brief">
        <h2>The change, in brief</h2>
        <JourneyMarkdown
          markdown={journey.overview.brief.markdown}
          onEvidence={context.navigateEvidence}
        />
      </section>

      <section className="journey-overview-section" aria-labelledby="journey-map-heading">
        <div className="journey-overview-section-heading">
          <div>
            <p className="eyebrow">Reading order</p>
            <h2 id="journey-map-heading">The map of the journey</h2>
          </div>
          <span>{journey.clusters.length} clusters</span>
        </div>
        <ol className="journey-map">
          {view.clusters.map(({ cluster, progress, homedHunks, touchedFileCount }) => (
            <li key={cluster.id}>
              <article className="journey-map-entry">
                <span className="journey-map-position">{cluster.position}</span>
                <span className="journey-map-copy">
                  <span className="journey-map-title">
                    <button type="button" onClick={() => context.navigateCluster(cluster.id)}>
                      {cluster.title}
                    </button>
                    <small>{titleCase(cluster.weight)}</small>
                    {progress.complete ? <em>Complete</em> : null}
                  </span>
                  <JourneyMarkdown
                    className="journey-map-narrative"
                    markdown={cluster.mapEntry.markdown}
                    onEvidence={context.navigateEvidence}
                  />
                  {cluster.buildsOn.length > 0 ? (
                    <span className="journey-builds-on">
                      Builds on{" "}
                      {cluster.buildsOn
                        .map((id) => {
                          const dependency = journey.clusters.find((item) => item.id === id);
                          return dependency === undefined
                            ? id
                            : `${dependency.title} (${dependency.position})`;
                        })
                        .join(", ")}
                    </span>
                  ) : null}
                </span>
                <span className="journey-map-scale">
                  <span>{touchedFileCount} files</span>
                  <span>{homedHunks.length} hunks</span>
                  <span>
                    {progress.markedFiles}/{progress.clusterFiles} read
                  </span>
                </span>
              </article>
            </li>
          ))}
        </ol>
      </section>

      <section className="journey-overview-section journey-where-to-begin">
        <h2>Where to begin</h2>
        <JourneyMarkdown
          markdown={journey.overview.whereToBegin.markdown}
          onEvidence={context.navigateEvidence}
        />
        {journey.clusters[0] === undefined ? null : (
          <button
            className="journey-primary-action"
            type="button"
            onClick={() => context.navigateCluster(journey.clusters[0]!.id)}
          >
            Begin with {journey.clusters[0].title}
            <span aria-hidden>→</span>
          </button>
        )}
      </section>

      <details className="journey-pr-words">
        <summary>The PR’s own words</summary>
        <div>
          <p className="eyebrow">
            {context.document.pullRequest.author.login} · {context.document.pullRequest.baseRefName}
          </p>
          <h2>{context.document.pullRequest.title}</h2>
          {context.document.pullRequest.body.length === 0 ? (
            <p>No description was provided.</p>
          ) : (
            <JourneyMarkdown
              markdown={context.document.pullRequest.body}
              onEvidence={context.navigateEvidence}
            />
          )}
          <button
            className="journey-secondary-action"
            type="button"
            onClick={() => void localApi().openExternal(context.document.pullRequest.url)}
          >
            Open on GitHub ↗
          </button>
        </div>
      </details>
    </article>
  );
}

export function JourneyClusterPage() {
  const context = useJourneyContext();
  const params = useParams({ strict: false }) as { readonly clusterId?: string };
  const cluster =
    params.clusterId === undefined
      ? null
      : resolveClusterRoute(context.document.journey, params.clusterId);

  if (cluster === null) {
    return (
      <JourneyRouteNotice
        eyebrow="Unknown cluster"
        title="This step isn’t part of the pinned journey."
        action="Return to the overview"
        onAction={context.navigateOverview}
      />
    );
  }

  return <ClusterReadingSurface key={cluster.id} cluster={cluster} />;
}

function ClusterReadingSurface({ cluster }: { readonly cluster: Cluster }) {
  const context = useJourneyContext();
  const { journey } = context.document;
  const [narrativeOpen, setNarrativeOpen] = useState(true);
  const [resources, setResources] = useState<ReadonlyMap<RepositoryPath, JourneyFileResource>>(
    new Map(),
  );
  const [guidanceViewport, updateGuidanceViewport] = useGuidanceViewport();
  const onResource = useCallback((path: RepositoryPath, resource: JourneyFileResource) => {
    setResources((current) => {
      const next = new Map(current);
      next.set(path, resource);
      return next;
    });
  }, []);
  const hints = useMemo(
    () => journey.hints.filter((hint) => hint.clusterId === cluster.id),
    [cluster.id, journey.hints],
  );
  const guidance = useGuidanceRailState(hints, guidanceViewport, context.readView.displayMode);
  const clusterIndex = journey.clusters.findIndex((item) => item.id === cluster.id);
  const previousCluster = journey.clusters[clusterIndex - 1];
  const nextCluster = journey.clusters[clusterIndex + 1];

  return (
    <div className="journey-reading-page" data-guidance-state={guidance.state}>
      <JourneyFileResourceSubscriptions
        journeyId={journey.id}
        paths={cluster.fileOrder}
        onResource={onResource}
      />
      <main className="journey-reading-main">
        <section className="journey-cluster-narrative" data-open={narrativeOpen || undefined}>
          <button
            className="journey-narrative-toggle"
            type="button"
            aria-expanded={narrativeOpen}
            onClick={() => setNarrativeOpen((open) => !open)}
          >
            <span className="journey-cluster-number">{cluster.position}</span>
            <span>
              <small>{titleCase(cluster.weight)} cluster</small>
              <strong>{cluster.title}</strong>
            </span>
            <span aria-hidden>{narrativeOpen ? "−" : "+"}</span>
          </button>
          {narrativeOpen ? (
            <JourneyMarkdown
              className="journey-narrative-copy"
              markdown={cluster.narrative.markdown}
              onEvidence={context.navigateEvidence}
            />
          ) : null}
        </section>

        {context.actionError === null ? null : (
          <p className="journey-inline-error" role="alert">
            {context.actionError}
          </p>
        )}

        {cluster.fileOrder.length === 0 ? (
          <JourneyRouteNotice
            eyebrow="No file surface"
            title="This cluster has no ordered files in the saved journey."
            action="Return to the overview"
            onAction={context.navigateOverview}
          />
        ) : (
          <Suspense fallback={JOURNEY_CODE_VIEW_FALLBACK}>
            <JourneyCodeView
              journey={journey}
              paths={cluster.fileOrder}
              resources={resources}
              displayMode={context.readView.displayMode}
              clusterId={cluster.id}
              readFiles={context.readView.readFiles}
              hints={hints}
              scrollTarget={context.scrollTarget}
              readMarkKey={readMarkKey}
              onClearScrollTarget={context.clearScrollTarget}
              onToggleRead={context.toggleRead}
              onSetDisplayMode={context.setDisplayMode}
              onSelectHome={context.navigateCluster}
              onVisibleHintsChange={updateGuidanceViewport}
              {...(previousCluster === undefined
                ? {}
                : { onPreviousCluster: () => context.navigateCluster(previousCluster.id) })}
              {...(nextCluster === undefined
                ? {}
                : { onNextCluster: () => context.navigateCluster(nextCluster.id) })}
            />
          </Suspense>
        )}
      </main>
      <GuidanceRail
        hints={guidance.hints}
        activeHintId={guidanceViewport.activeHintId}
        collapsed={guidance.collapsed}
        onCollapsedChange={guidance.setCollapsed}
      />
    </div>
  );
}

export function JourneyFilePage() {
  const context = useJourneyContext();
  const params = useParams({ strict: false }) as { readonly _splat?: string };
  const resolved = resolveFileRoute(context.document.journey, context.treePaths, params._splat);

  if (resolved === null) {
    if (!context.treeReady) {
      return (
        <JourneyRouteNotice
          eyebrow="Opening file"
          title="Reading the pinned repository tree…"
          action="Return to the overview"
          onAction={context.navigateOverview}
        />
      );
    }
    return (
      <JourneyRouteNotice
        eyebrow="Unknown file"
        title="That path isn’t present in this pinned journey."
        action="Return to the overview"
        onAction={context.navigateOverview}
      />
    );
  }

  return <FreeFileReadingSurface key={resolved.path} path={resolved.path} />;
}

function FreeFileReadingSurface({ path }: { readonly path: RepositoryPath }) {
  const context = useJourneyContext();
  const { journey } = context.document;
  const homes = useMemo(() => fileHomes(journey, path), [journey, path]);
  const clusterId =
    homes.find((home) => home.cluster.id === context.currentClusterId)?.cluster.id ??
    homes[0]?.cluster.id ??
    null;
  const [resources, setResources] = useState<ReadonlyMap<RepositoryPath, JourneyFileResource>>(
    new Map(),
  );
  const paths = useMemo(() => [path], [path]);
  const [guidanceViewport, updateGuidanceViewport] = useGuidanceViewport();
  const onResource = useCallback((resourcePath: RepositoryPath, resource: JourneyFileResource) => {
    setResources(new Map([[resourcePath, resource]]));
  }, []);
  const hints = useMemo(
    () =>
      clusterId === null
        ? []
        : journey.hints.filter((hint) => hint.clusterId === clusterId && hint.anchor.path === path),
    [clusterId, journey.hints, path],
  );
  const guidance = useGuidanceRailState(hints, guidanceViewport, context.readView.displayMode);

  useEffect(() => {
    if (clusterId !== null && clusterId !== context.currentClusterId) {
      context.setCurrentCluster(clusterId);
    }
  }, [clusterId, context]);

  return (
    <div
      className="journey-reading-page journey-free-file-page"
      data-guidance-state={guidance.state}
    >
      <JourneyFileResourceSubscriptions
        journeyId={journey.id}
        paths={paths}
        onResource={onResource}
      />
      <main className="journey-reading-main">
        <FileTabs activePath={path} />
        <section className="journey-file-context">
          <div>
            <p className="eyebrow">Free file reading</p>
            <strong>{path}</strong>
          </div>
          {homes.length === 0 ? (
            <span className="journey-file-no-home">Unchanged at the pinned head</span>
          ) : (
            <label>
              Current cluster
              <select
                value={clusterId ?? ""}
                onChange={(event) =>
                  context.setCurrentCluster(event.currentTarget.value as ClusterId)
                }
              >
                {homes.map((home) => (
                  <option key={home.cluster.id} value={home.cluster.id}>
                    {home.cluster.position} · {home.cluster.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        {context.actionError === null ? null : (
          <p className="journey-inline-error" role="alert">
            {context.actionError}
          </p>
        )}

        <Suspense fallback={JOURNEY_CODE_VIEW_FALLBACK}>
          <JourneyCodeView
            journey={journey}
            paths={paths}
            resources={resources}
            displayMode={context.readView.displayMode}
            clusterId={clusterId}
            readFiles={context.readView.readFiles}
            hints={hints}
            scrollTarget={context.scrollTarget}
            readMarkKey={readMarkKey}
            onClearScrollTarget={context.clearScrollTarget}
            onToggleRead={context.toggleRead}
            onSetDisplayMode={context.setDisplayMode}
            onSelectHome={context.setCurrentCluster}
            onVisibleHintsChange={updateGuidanceViewport}
          />
        </Suspense>
      </main>
      <GuidanceRail
        hints={guidance.hints}
        activeHintId={guidanceViewport.activeHintId}
        collapsed={guidance.collapsed}
        onCollapsedChange={guidance.setCollapsed}
      />
    </div>
  );
}

function JourneyCodeViewLoading() {
  return (
    <div className="journey-code-shell">
      <div className="journey-code-loading" aria-live="polite">
        <span className="journey-loading-line" />
        <span className="journey-loading-line" />
        <p>Preparing the pinned code view…</p>
      </div>
    </div>
  );
}

function FileTabs({ activePath }: { readonly activePath: RepositoryPath }) {
  const context = useJourneyContext();
  return (
    <nav className="journey-file-tabs" aria-label="Open files">
      {context.openFiles.map((path) => (
        <div key={path} data-active={path === activePath || undefined}>
          <button type="button" onClick={() => context.navigateFile(path)}>
            {fileName(path)}
          </button>
          <button
            type="button"
            aria-label={`Close ${path}`}
            onClick={() => context.closeFile(path)}
          >
            <XIcon />
          </button>
        </div>
      ))}
    </nav>
  );
}

function useGuidanceViewport() {
  const [viewport, setViewport] = useState<{
    readonly visibleHintIds: readonly string[];
    readonly activeHintId: string | null;
  }>({ visibleHintIds: [], activeHintId: null });
  const update = useCallback((visibleHintIds: readonly string[], activeHintId: string | null) => {
    setViewport((current) =>
      current.activeHintId === activeHintId &&
      current.visibleHintIds.length === visibleHintIds.length &&
      current.visibleHintIds.every((id, index) => id === visibleHintIds[index])
        ? current
        : { visibleHintIds, activeHintId },
    );
  }, []);
  return [viewport, update] as const;
}

function useGuidanceRailState(
  hints: readonly Hint[],
  viewport: {
    readonly visibleHintIds: readonly string[];
    readonly activeHintId: string | null;
  },
  displayMode: DisplayMode,
) {
  const [collapsed, setCollapsed] = useState(false);
  const boundHints = useMemo(() => {
    const permittedHints =
      displayMode === "just-the-code" ? hints.filter((hint) => hint.anchor.side === "new") : hints;
    const visible = new Set(viewport.visibleHintIds);
    const intersecting = permittedHints.filter((hint) => visible.has(hint.id));
    if (intersecting.length > 0 || viewport.activeHintId === null) return intersecting;
    const nearest = permittedHints.find((hint) => hint.id === viewport.activeHintId);
    return nearest === undefined ? [] : [nearest];
  }, [displayMode, hints, viewport.activeHintId, viewport.visibleHintIds]);
  return {
    hints: boundHints,
    collapsed,
    setCollapsed,
    state: boundHints.length === 0 ? "empty" : collapsed ? "collapsed" : "open",
  } as const;
}

function GuidanceRail({
  hints,
  activeHintId,
  collapsed,
  onCollapsedChange,
}: {
  readonly hints: readonly Hint[];
  readonly activeHintId: string | null;
  readonly collapsed: boolean;
  readonly onCollapsedChange: (collapsed: boolean) => void;
}) {
  const context = useJourneyContext();
  if (hints.length === 0) return null;

  if (collapsed) {
    return (
      <aside className="journey-guidance journey-guidance-collapsed">
        <button
          type="button"
          aria-label="Show guidance"
          title="Show guidance"
          onClick={() => onCollapsedChange(false)}
        >
          ‹
        </button>
      </aside>
    );
  }

  return (
    <aside className="journey-guidance" aria-label="Guidance">
      <header>
        <div>
          <p className="eyebrow">Guidance</p>
          <span>Bound to the code</span>
        </div>
        <button
          type="button"
          aria-label="Hide guidance"
          title="Hide guidance"
          onClick={() => onCollapsedChange(true)}
        >
          ›
        </button>
      </header>
      <div className="journey-hints">
        {hints.map((hint) => (
          <article
            key={hint.id}
            className="journey-hint"
            data-active={hint.id === activeHintId || undefined}
          >
            <button
              type="button"
              onClick={() =>
                context.requestScroll(hint.anchor.path, hint.anchor.startLine, hint.anchor.side)
              }
            >
              <span>{hintKindLabel(hint.kind)}</span>
              <code>
                {fileName(hint.anchor.path)}:{hint.anchor.startLine}
              </code>
            </button>
            <JourneyMarkdown markdown={hint.body.markdown} onEvidence={context.navigateEvidence} />
          </article>
        ))}
      </div>
    </aside>
  );
}

const titleCase = (value: string): string => value[0]!.toUpperCase() + value.slice(1);

const fileName = (path: RepositoryPath): string => path.split("/").at(-1) ?? path;

const hintKindLabel = (kind: Hint["kind"]): string => {
  switch (kind) {
    case "connection":
      return "Connection";
    case "complexity":
      return "Complexity companion";
    case "ripple":
      return "Ripple context";
    case "pattern-echo":
      return "Pattern echo";
    case "behavior":
      return "Behavioral change";
    case "resurfacing":
      return "Resurfacing";
  }
};
