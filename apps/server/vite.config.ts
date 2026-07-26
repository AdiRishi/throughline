import * as NodeModule from "node:module";

import { defineConfig } from "vite";

// Bundle every non-Node dependency into the single-file CLI so the packaged
// `dist/bin.mjs` has no runtime dependency on the monorepo layout.
const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);

/**
 * Both harness SDKs ship platform binaries and resolve them relative to their
 * own `import.meta.url`; inlining either one breaks that resolution, and they
 * are hundreds of megabytes besides. They stay external and are loaded through
 * a dynamic import, so a missing one degrades to "harness unavailable" instead
 * of failing the bundle at load. (ADR-0006 territory: verify against a packaged
 * app, never dev.)
 */
const EXTERNAL_PACKAGES = ["@openai/codex-sdk", "@anthropic-ai/claude-agent-sdk"];

function isExternalCliDependency(id: string): boolean {
  return (
    nodeBuiltinIds.has(id) ||
    EXTERNAL_PACKAGES.some((name) => id === name || id.startsWith(`${name}/`))
  );
}

export default defineConfig({
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    // The bundle's floor is Electron's bundled Node (v20.18) — the shell spawns
    // dist/bin.mjs via ELECTRON_RUN_AS_NODE — even though dev runs on Node 22+.
    target: "node20",
    rollupOptions: {
      external: isExternalCliDependency,
      output: {
        banner: "#!/usr/bin/env node\n",
        entryFileNames: "[name].mjs",
      },
    },
  },
});
