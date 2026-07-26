# Electron Runtime Constraints Pin The Build Shape

Three facts about the Electron runtime dictate build decisions across _multiple_ configs, and each looks like cleanup bait in isolation:

1. **Electron's main and preload entries must be CommonJS, but Effect v4 is ESM-only** — and CJS cannot `require()` ESM. So the desktop build bundles `effect`/`@effect/*` into `main.cjs`/`preload.cjs`. "Why is everything bundled?" — this. Only `electron` (runtime-injected) and `electron-updater` (CJS with dynamic requires) stay external.
2. **The runtime floor is whatever Node the pinned Electron bundles, not the workspace's Node.** The shell spawns the server bundle via `ELECTRON_RUN_AS_NODE`, so the desktop entries and `apps/server/dist/bin.mjs` must target at or below Electron's bundled Node even though development runs on the workspace Node. The targets are set conservatively under the floor (currently `node22` for the desktop entries, `node20` for the server bundle, against Electron 41's bundled Node 24.x) — a target above the floor breaks the packaged app while dev keeps working, so raising one is only done against a packaged app, and bumping Electron is what raises the floor.
3. **The HTTP client is `FetchHttpClient` (global fetch), never the undici-based Node client** — in both the desktop main and the server. Bundling npm undici into the CJS main crashes Electron at load (`webidl.util.markAsUncloneable is not a function`), and the server child running on Electron's Node hits the same class of failure.

Any change to these ("switch to ESM output", "bump the target, we're on Node 24", "use the real Node HttpClient") must be verified against a **packaged** app — dev mode exercises none of the three constraints.

Packaging is architecture-explicit for the same reason: the staged production install declares the artifact OS and CPU before `pnpm install --prod`, and that architecture is passed to `electron-builder`. Unsigned local builds disable signing identity discovery and scrub signing credentials; release signing happens only when the packaging command is invoked with `--signed`.
