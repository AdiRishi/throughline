import * as NodeModule from "node:module";

import { defineConfig } from "vite";

// The harness SDKs carry platform executables and must retain their package
// layout. Everything else is bundled into the single-file server CLI.
const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const externalPackages = ["@openai/codex-sdk", "@anthropic-ai/claude-agent-sdk"] as const;

function isExternalCliDependency(id: string): boolean {
  return (
    nodeBuiltinIds.has(id) ||
    externalPackages.some((packageName) => id === packageName || id.startsWith(`${packageName}/`))
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
