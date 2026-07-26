import { RouterProvider } from "@tanstack/react-router";

import { router } from "./app/router.tsx";

/**
 * Owns renderer-wide composition. The router is the only provider Throughline
 * needs: atoms read from a module-level runtime, and theme is a class on the
 * document root set before React mounts.
 */
export function AppRoot() {
  return <RouterProvider router={router} />;
}
