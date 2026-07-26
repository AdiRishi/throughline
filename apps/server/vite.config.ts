import * as NodeModule from "node:module";

import { defineConfig } from "vite";

/**
 * Bundle every non-Node dependency into the single-file CLI so the packaged
 * `dist/bin.mjs` has no runtime dependency on the monorepo layout — with one
 * deliberate exception.
 *
 * **The harness SDKs must stay external.** Both `@openai/codex-sdk` and
 * `@anthropic-ai/claude-agent-sdk` locate and spawn their own bundled platform
 * binaries by resolving their own package from `import.meta.url` — Codex walks
 * `require.resolve('@openai/codex/package.json')` to find
 * `vendor/<triple>/bin/codex`, and Claude spawns a 245 MB single-file binary.
 * Bundling them destroys that resolution (there is no package directory left to
 * walk from), and the failure appears only in a *packaged* app — where the
 * vendored binary is the thing that actually runs the analysis.
 *
 * So they are externalized here and shipped as real packaged dependencies:
 * `scripts/build-desktop-artifact.ts` adds them to the staged manifest and
 * `asarUnpack`s them, because a binary inside an asar archive cannot be exec'd.
 * Per ADR-0006, any change here is verified against a packaged app.
 */
const nodeBuiltinIds = new Set([
  ...NodeModule.builtinModules,
  ...NodeModule.builtinModules.map((moduleName) => `node:${moduleName}`),
]);

/** Kept in sync with the staged dependencies in the desktop packaging script. */
export const EXTERNAL_RUNTIME_PACKAGES: ReadonlyArray<string> = [
  "@openai/codex-sdk",
  "@anthropic-ai/claude-agent-sdk",
];

function isExternalCliDependency(id: string): boolean {
  if (nodeBuiltinIds.has(id)) return true;
  return EXTERNAL_RUNTIME_PACKAGES.some(
    (packageName) => id === packageName || id.startsWith(`${packageName}/`),
  );
}

export default defineConfig({
  ssr: {
    // Everything except the externals above is inlined.
    noExternal: true,
    external: [...EXTERNAL_RUNTIME_PACKAGES],
  },
  build: {
    ssr: "src/bin.ts",
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: true,
    minify: false,
    // The bundle's floor is Electron's bundled Node — the shell spawns
    // dist/bin.mjs via ELECTRON_RUN_AS_NODE — even though dev runs on Node 24+.
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
