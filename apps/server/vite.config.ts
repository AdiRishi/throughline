import * as NodeModule from "node:module";

import { defineConfig } from "vite";

// Bundle every non-Node dependency into the single-file CLI so the packaged
// `dist/bin.mjs` has no runtime dependency on the monorepo layout.
const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const externalHarnessSdkIds = ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk"];

function isExternalCliDependency(id: string): boolean {
  return (
    nodeBuiltinIds.has(id) ||
    externalHarnessSdkIds.some(
      (packageName) => id === packageName || id.startsWith(`${packageName}/`),
    )
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
    // Keep the target conservatively below Electron 41's bundled Node 24.x.
    // The shell spawns dist/bin.mjs via ELECTRON_RUN_AS_NODE, so the workspace
    // Node used in development is not the runtime floor.
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
