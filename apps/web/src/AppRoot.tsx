import { RouterProvider } from "@tanstack/react-router";

import { router } from "./router.tsx";

export function AppRoot() {
  return <RouterProvider router={router} />;
}
