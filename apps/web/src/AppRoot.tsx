/**
 * Renderer-wide composition: the router, and nothing else yet.
 *
 * @module AppRoot
 */
import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router.tsx";

export function AppRoot() {
  return <RouterProvider router={router} />;
}
