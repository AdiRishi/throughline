import { App } from "./App.tsx";
import { AppErrorView } from "./components/AppErrorView.tsx";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary.tsx";

/**
 * Owns renderer-wide composition. A starter has no router or global providers,
 * so this just wraps the single demo page in the renderer-wide error boundary
 * — but it's the natural seam to add context providers (theme, a router) as the
 * app grows.
 */
export function AppRoot() {
  return (
    <RenderErrorBoundary fallback={AppErrorView}>
      <App />
    </RenderErrorBoundary>
  );
}
