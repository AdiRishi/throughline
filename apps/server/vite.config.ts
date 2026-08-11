import * as NodeModule from "node:module";

import { defineConfig } from "vite";

// Bundle every non-Node dependency into the single-file CLI so the packaged
// `dist/bin.mjs` has no runtime dependency on the monorepo layout.
const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);
const appVersion =
  process.env.APP_VERSION?.trim() ||
  (NodeModule.createRequire(import.meta.url)("./package.json") as { version: string }).version;

function isExternalCliDependency(id: string): boolean {
  return nodeBuiltinIds.has(id);
}

export default defineConfig({
  define: {
    "process.env.APP_VERSION": JSON.stringify(appVersion),
  },
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    // The bundle's floor is Electron's bundled Node — the shell spawns dist/bin.mjs
    // via ELECTRON_RUN_AS_NODE — even though development may run on a newer Node.
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
