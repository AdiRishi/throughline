// Shared Vitest defaults for the workspace, ported from the T3 Code root
// `vite.config.ts` (see `.repos`-style reference at forks/t3code/vite.config.ts:11-22).
//
// Why the values are what they are:
//   • `environment: "node"` — every suite here exercises server, transport, or
//     script code. jsdom is the wrong default and is slower to boot.
//   • 60s hook/test timeouts — the 5s default is a stopwatch, not a budget: it
//     turns a slow CI host into a "failure" for tests that were only waiting on
//     a real port bind, a child process, or a build.
//   • `.repos/**` excluded — that tree is vendored read-only reference material
//     (see .repos/AGENTS.md) and carries thousands of upstream test files.
//
// This file intentionally imports nothing: the repo root is not a workspace
// package and has no `vite` dependency, and a Vite config may default-export a
// plain object (`defineConfig` is only an identity helper). Package configs can
// spread `sharedTestConfig` into their own `test` block.
export const sharedTestConfig = {
  environment: "node",
  exclude: [
    "**/.repos/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/dist-electron/**",
    "**/.{idea,git,cache,output,temp}/**",
  ],
  hookTimeout: 60_000,
  testTimeout: 60_000,
} as const;

export default {
  test: sharedTestConfig,
};
