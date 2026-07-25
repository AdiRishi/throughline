import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";

import { App } from "./App.tsx";
import {
  JourneyClusterRoute,
  JourneyFileRoute,
  JourneyLayoutRoute,
  JourneyOverviewRoute,
} from "./features/journey/JourneyRouteOutlet.tsx";
import { SettingsPage } from "./features/settings/SettingsPage.tsx";
import { WelcomePage } from "./features/welcome/WelcomePage.tsx";

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: NotFoundPage,
});

export const welcomeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WelcomePage,
});

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

export const pullRequestRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number",
  component: JourneyLayoutRoute,
});

export const pullRequestOverviewRoute = createRoute({
  getParentRoute: () => pullRequestRoute,
  path: "/",
  component: JourneyOverviewRoute,
});

export const pullRequestClusterRoute = createRoute({
  getParentRoute: () => pullRequestRoute,
  path: "/cluster/$clusterId",
  component: JourneyClusterRoute,
});

export const pullRequestFileRoute = createRoute({
  getParentRoute: () => pullRequestRoute,
  path: "/file/$",
  component: JourneyFileRoute,
});

export const routeTree = rootRoute.addChildren([
  welcomeRoute,
  settingsRoute,
  pullRequestRoute.addChildren([
    pullRequestOverviewRoute,
    pullRequestClusterRoute,
    pullRequestFileRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function NotFoundPage() {
  return (
    <main className="empty-page">
      <p className="eyebrow">No route</p>
      <h1>This path doesn’t lead to a journey.</h1>
      <Link className="text-link" to="/">
        Return to your reviews
      </Link>
    </main>
  );
}
