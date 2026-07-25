import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import type { JourneyScreenLocation } from "./screens/JourneyScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx";
import { connectionAtoms } from "./state/connection.ts";

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
  const connected = connection.phase === "connected";
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="wordmark" aria-label="Throughline home">
          <span className="wordmark-mark">T</span>
          <span>Throughline</span>
        </Link>
        <nav className="topbar-nav" aria-label="Application">
          <Link to="/" activeProps={{ className: "active" }}>
            Pull requests
          </Link>
          <Link to="/settings" activeProps={{ className: "active" }}>
            Settings
          </Link>
          <span className={`connection-pill ${connected ? "connected" : ""}`}>
            <span aria-hidden />
            {connection.phase}
          </span>
        </nav>
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
