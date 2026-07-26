import {
  createRootRoute,
  createRoute,
  createRouter,
  ErrorComponent,
  Outlet,
  type ErrorComponentProps,
} from "@tanstack/react-router";

import { ClusterScreen } from "../features/journey/ClusterScreen.tsx";
import { FileScreen } from "../features/journey/FileScreen.tsx";
import { JourneyLayout } from "../features/journey/JourneyLayout.tsx";
import { OverviewScreen } from "../features/journey/OverviewScreen.tsx";
import { SettingsScreen } from "../features/settings/SettingsScreen.tsx";
import { WelcomeScreen } from "../features/welcome/WelcomeScreen.tsx";

/**
 * The route tree, code-based.
 *
 * A handful of routes does not earn the file-based codegen plugin, and migrating
 * to it later is mechanical. What the URL holds is the rule that matters:
 * **state that should survive a reload is in the URL; state that shouldn't
 * (scroll, toggles, which tab is focused) never is.**
 *
 * There are deliberately no loaders. Data arrives through atoms — the same
 * snapshot-then-live streams every other surface reads — so a route's job is
 * purely to name a location.
 *
 * @module app/router
 */
const rootRoute = createRootRoute({
  component: () => <Outlet />,
  errorComponent: (props: ErrorComponentProps) => <ErrorComponent error={props.error} />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WelcomeScreen,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsScreen,
});

/**
 * The journey layout resolves the journey and renders the frame. While an
 * ingestion is running — or when no journey exists yet — it renders the
 * transition instead of its children, which is what makes the wait *leavable*:
 * the URL is already the journey's, so coming back lands in the right place
 * whether the analysis finished or not.
 */
const prRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pr/$owner/$repo/$number",
  component: JourneyLayout,
});

const prIndexRoute = createRoute({
  getParentRoute: () => prRoute,
  path: "/",
  component: OverviewScreen,
});

const clusterRoute = createRoute({
  getParentRoute: () => prRoute,
  path: "cluster/$clusterId",
  component: ClusterScreen,
});

/**
 * Free file reading. A splat because file paths contain slashes — and the splat's
 * value is `decodeURIComponent`'d over the whole remainder, which is exactly
 * right for a repository path.
 */
const fileRoute = createRoute({
  getParentRoute: () => prRoute,
  path: "file/$",
  component: FileScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  settingsRoute,
  prRoute.addChildren([prIndexRoute, clusterRoute, fileRoute]),
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

export const routes = {
  index: indexRoute,
  settings: settingsRoute,
  pr: prRoute,
  prIndex: prIndexRoute,
  cluster: clusterRoute,
  file: fileRoute,
} as const;
