import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, defineProject, type TestProjectInlineConfiguration } from "vitest/config";

import { DEV_PROXIED_PATH_PREFIXES } from "@app/shared/devProxy";

const port = Number(process.env.PORT ?? 5733);
const explicitHost = process.env.HOST?.trim();
const host = explicitHost || "localhost";
// Deliberately has no loopback default. Baking one pins every build to
// 127.0.0.1: the server then serves that bundle to a LAN/tailnet visitor whose
// browser dials its OWN loopback, silently. Unset means "use the page origin"
// (src/env.ts), which is the only address that is right for every visitor; an
// explicit value stays what it should be — a dev/override affordance.
const configuredWsUrl = process.env.VITE_WS_URL?.trim();
const bootstrapToken = process.env.VITE_BOOTSTRAP_TOKEN?.trim() || "";
const sourcemapEnv = process.env.APP_WEB_SOURCEMAP?.trim().toLowerCase();

// Renderer failures are forwarded to the server as OTLP spans and land in the
// same trace file as the server's own (docs/technical/06-observability.md).
// Without sourcemaps every frame in them is minified garbage, so default them
// on: "hidden" emits the maps without the bundle referencing them, "0"/"false"
// opts out entirely.
const buildSourcemap: boolean | "hidden" =
  sourcemapEnv === "0" || sourcemapEnv === "false"
    ? false
    : sourcemapEnv === "hidden"
      ? "hidden"
      : true;

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    // Tests mirror the source tree from `tests/`, never colocated under `src`
    // (AGENTS.md). Component tests opt into a DOM with a per-file
    // `// @vitest-environment jsdom` docblock; the default stays node so the
    // transport/atom suites keep running without a DOM.
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    // The suites here exercise connection supervision and websocket
    // subscription lifecycles. Under the full monorepo test run, those async
    // tests can exceed Vitest's default 5s budget.
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

// Browser dev proxies the backend through this server so the app works from any
// origin.

function resolveDevProxyTarget(wsUrl: string | undefined): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  try {
    const url = new URL(wsUrl);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

const devProxyTarget = resolveDevProxyTarget(configuredWsUrl);

export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // Pre-bundled up front instead of discovered one import-level at a time.
    // The workspace packages (@app/*) are crawled as source, so the effect
    // entrypoints they pull in are otherwise found late — and a late discovery
    // costs a full-page reload mid-session.
    include: [
      "@effect/atom-react",
      "effect/Effect",
      "effect/Layer",
      "effect/Option",
      "effect/Schema",
      "effect/Stream",
      "effect/unstable/http",
      "effect/unstable/observability",
      "effect/unstable/reactivity",
      "effect/unstable/rpc",
      "effect/unstable/socket/Socket",
      "react-dom/client",
    ],
  },
  define: {
    // Pinned explicitly rather than left to Vite's automatic VITE_ exposure, so
    // an unset value bakes as "" (the client then falls back to the page
    // origin) instead of leaking a stray shell variable into the bundle.
    "import.meta.env.VITE_WS_URL": JSON.stringify(configuredWsUrl ?? ""),
    "import.meta.env.VITE_BOOTSTRAP_TOKEN": JSON.stringify(bootstrapToken),
  },
  resolve: {
    // One React, always: the first workspace package to take a React peer dep
    // would otherwise get its own copy, and two copies break hooks.
    dedupe: ["react", "react-dom"],
  },
  server: {
    host,
    port,
    strictPort: true,
    // Transform the whole module graph at server start instead of on the first
    // request. Without this, a cold worktree discovers and transforms modules
    // one import-level at a time while the browser waits.
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
    ...(devProxyTarget
      ? {
          proxy: Object.fromEntries(
            DEV_PROXIED_PATH_PREFIXES.map((prefix) => [
              prefix,
              {
                target: devProxyTarget,
                changeOrigin: true,
                ...(prefix === "/ws" ? { ws: true } : {}),
              },
            ]),
          ),
        }
      : {}),
    // Electron's BrowserWindow needs the HMR socket pinned to an explicit host
    // to connect reliably; the dev runner sets HOST for the web child. Without
    // HOST, leaving this unset lets the client derive it from the page origin,
    // which is what makes HMR work over Tailscale/LAN instead of failing an
    // attempt against the wrong machine's localhost first.
    ...(explicitHost
      ? {
          hmr: {
            protocol: "ws",
            host: explicitHost,
            clientPort: port,
          },
        }
      : {}),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
  },
  test: {
    projects: [defineProject(unitTestProject)],
  },
}));
