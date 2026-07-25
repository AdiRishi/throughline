import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx";
import { connectionAtoms } from "./state/connection.ts";

const LazyJourneyScreen = lazy(() =>
  import("./screens/JourneyScreen.tsx").then((module) => ({
    default: module.JourneyScreen,
  })),
);

function JourneyRouteScreen() {
  return (
    <Suspense fallback={<main className="journey-loading">Opening the reading room…</main>}>
      <LazyJourneyScreen />
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
export const journeyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/journey/$owner/$repo/$number",
  component: JourneyRouteScreen,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});

const routeTree = rootRoute.addChildren([welcomeRoute, journeyRoute, settingsRoute]);
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
