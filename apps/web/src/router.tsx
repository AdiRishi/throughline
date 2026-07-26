import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { lazy, Suspense } from "react";

import { SettingsGlyph, WindowControls } from "./components/AppChrome.tsx";
import type { JourneyScreenLocation } from "./screens/JourneyScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx";
import { connectionAtoms } from "./state/connection.ts";
import { productAtoms } from "./state/product.ts";

const LazyJourneyScreen = lazy(() =>
  import("./screens/JourneyScreen.tsx").then((module) => ({
    default: module.JourneyScreen,
  })),
);

function JourneyRouteScreen({ location }: { readonly location: JourneyScreenLocation }) {
  return (
    <Suspense fallback={<main className="journey-loading">Opening the reading room…</main>}>
      <LazyJourneyScreen location={location} />
    </Suspense>
  );
}

function Shell() {
  const connection = useAtomValue(connectionAtoms.state);
  const viewerResult = useAtomValue(productAtoms.viewer);
  const viewer = AsyncResult.isSuccess(viewerResult) ? viewerResult.value : null;
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-leading">
          <WindowControls />
          <Link to="/" className="wordmark" aria-label="Throughline home">
            Throughline
          </Link>
        </div>
        <div className="topbar-trailing">
          <span className="auth-status">
            {viewer?.state === "authenticated" && viewer.login
              ? `@${viewer.login} · authenticated via gh`
              : connection.phase}
          </span>
          <Link to="/settings" className="settings-link" aria-label="Settings">
            <SettingsGlyph />
          </Link>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

const rootRoute = createRootRoute({ component: Shell });
const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WelcomeScreen,
});
export const journeyOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number",
  component: () => {
    const params = journeyOverviewRoute.useParams();
    return (
      <JourneyRouteScreen
        location={{
          pr: { owner: params.owner, repo: params.repo, number: Number(params.number) },
          view: { type: "overview" },
        }}
      />
    );
  },
});
export const journeyClusterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number/cluster/$clusterId",
  component: () => {
    const params = journeyClusterRoute.useParams();
    return (
      <JourneyRouteScreen
        location={{
          pr: { owner: params.owner, repo: params.repo, number: Number(params.number) },
          view: { type: "cluster", clusterId: params.clusterId },
        }}
      />
    );
  },
});
export const journeyFileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number/file/$",
  component: () => {
    const params = journeyFileRoute.useParams();
    return (
      <JourneyRouteScreen
        location={{
          pr: { owner: params.owner, repo: params.repo, number: Number(params.number) },
          view: { type: "file", path: params._splat ?? "" },
        }}
      />
    );
  },
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});

const routeTree = rootRoute.addChildren([
  welcomeRoute,
  journeyOverviewRoute,
  journeyClusterRoute,
  journeyFileRoute,
  settingsRoute,
]);
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingMs: 150,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
