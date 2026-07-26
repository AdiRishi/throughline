/**
 * The route tree, built in code.
 *
 * A handful of routes does not earn the file-based codegen plugin, and moving
 * to it later is mechanical. The rule of thumb the tree encodes: state that
 * should survive a reload is in the URL (which pull request, which cluster,
 * which file); state that should not (scroll, toggles, collapsed narrative) is
 * never.
 *
 * @module router
 */
import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";

import { AppFrame } from "./AppFrame.tsx";
import { ClusterPage } from "./features/journey/ClusterPage.tsx";
import { FilePage } from "./features/journey/FilePage.tsx";
import { JourneyRoute } from "./features/journey/JourneyRoute.tsx";
import { OverviewPage } from "./features/journey/OverviewPage.tsx";
import { SettingsPage } from "./features/settings/SettingsPage.tsx";
import { WelcomeScreen } from "./features/welcome/WelcomeScreen.tsx";

const rootRoute = createRootRoute({
  component: () => (
    <AppFrame>
      <Outlet />
    </AppFrame>
  ),
});

const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WelcomeScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

/**
 * The journey layout resolves the journey and renders the ingestion transition
 * while one is running or absent — so every child route can assume a journey.
 */
const journeyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number",
  component: JourneyRoute,
});

const overviewRoute = createRoute({
  getParentRoute: () => journeyRoute,
  path: "/",
  component: OverviewPage,
});

const clusterRoute = createRoute({
  getParentRoute: () => journeyRoute,
  path: "/cluster/$clusterId",
  component: ClusterPage,
});

// Splat: file paths contain slashes.
const fileRoute = createRoute({
  getParentRoute: () => journeyRoute,
  path: "/file/$",
  component: FilePage,
});

const routeTree = rootRoute.addChildren([
  welcomeRoute,
  settingsRoute,
  journeyRoute.addChildren([overviewRoute, clusterRoute, fileRoute]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Every surface renders its own empty/parked state; a global pending shell
  // would flash over screens that are already showing something honest.
  defaultPendingMs: 400,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export { clusterRoute, fileRoute, journeyRoute, overviewRoute, settingsRoute, welcomeRoute };
