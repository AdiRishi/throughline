// Keep this before the imports: a closed stdout/stderr pipe (the dev runner or
// a shell `| head` going away) must not take the shell down with an unhandled
// EPIPE. Every other write error still throws.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EPIPE") throw err;
  });
}

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import * as Electron from "electron";

import { HostProcessArchitecture, HostProcessPlatform } from "@app/shared/hostProcess";
import * as NetService from "@app/shared/Net";

import * as DesktopApp from "./app/DesktopApp.ts";
import * as DesktopEnvironment from "./app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "./app/DesktopLifecycle.ts";
import * as DesktopObservability from "./app/DesktopObservability.ts";
import * as DesktopShutdown from "./app/DesktopShutdown.ts";
import * as DesktopState from "./app/DesktopState.ts";
import * as DesktopBackendConfiguration from "./backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendManager from "./backend/DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "./backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronApp from "./electron/ElectronApp.ts";
import * as ElectronDialog from "./electron/ElectronDialog.ts";
import * as ElectronMenu from "./electron/ElectronMenu.ts";
import * as ElectronShell from "./electron/ElectronShell.ts";
import * as ElectronTheme from "./electron/ElectronTheme.ts";
import * as ElectronUpdater from "./electron/ElectronUpdater.ts";
import * as ElectronWindow from "./electron/ElectronWindow.ts";
import * as DesktopIpc from "./ipc/DesktopIpc.ts";
import * as DesktopAppSettings from "./settings/DesktopAppSettings.ts";
import * as DesktopUpdater from "./updates/DesktopUpdater.ts";
import * as DesktopApplicationMenu from "./window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "./window/DesktopWindow.ts";

const desktopEnvironmentLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.service(ElectronApp.ElectronApp).pipe(
      Effect.flatMap((app) => app.metadata),
    );
    const platform = yield* HostProcessPlatform;
    const processArch = yield* HostProcessArchitecture;
    return DesktopEnvironment.layer({
      dirname: __dirname,
      homeDirectory: NodeOS.homedir(),
      platform,
      appVersion: metadata.appVersion,
      appPath: metadata.appPath,
      isPackaged: metadata.isPackaged,
      resourcesPath: metadata.resourcesPath,
      processArch,
      runningUnderArm64Translation: metadata.runningUnderArm64Translation,
    });
  }),
).pipe(Layer.provide(ElectronApp.layer));

const electronLayer = Layer.mergeAll(
  ElectronApp.layer,
  ElectronDialog.layer,
  ElectronMenu.layer,
  ElectronShell.layer,
  ElectronTheme.layer,
  ElectronUpdater.layer,
  ElectronWindow.layer,
  DesktopIpc.layer(Electron.ipcMain),
);

const desktopFoundationLayer = Layer.mergeAll(
  DesktopState.layer,
  DesktopShutdown.layer,
  DesktopObservability.layer,
  DesktopAppSettings.layer,
  DesktopBackendConfiguration.layer,
).pipe(Layer.provideMerge(desktopEnvironmentLayer));

const desktopWindowLayer = DesktopWindow.layer.pipe(Layer.provideMerge(desktopFoundationLayer));

const desktopBackendLayer = DesktopBackendManager.layer.pipe(
  Layer.provideMerge(desktopWindowLayer),
);

// The application menu's "Check for Updates…" entry drives the updater, so the
// updater has to be built before it — `Layer.mergeAll` builds in parallel and
// would not satisfy that dependency.
const desktopUpdaterLayer = DesktopUpdater.layer.pipe(Layer.provideMerge(desktopBackendLayer));

const desktopApplicationLayer = Layer.mergeAll(
  DesktopLifecycle.layer,
  DesktopApplicationMenu.layer,
  DesktopLocalEnvironmentAuth.layer,
).pipe(Layer.provideMerge(desktopUpdaterLayer));

// The HttpClient is Electron's global `fetch` rather than the undici-based Node
// client: bundling undici into the CJS main crashes Electron at load
// (`webidl.util.markAsUncloneable is not a function` from undici's CacheStorage).
const desktopRuntimeLayer = desktopApplicationLayer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(electronLayer),
);

DesktopApp.program.pipe(Effect.provide(desktopRuntimeLayer), NodeRuntime.runMain);
