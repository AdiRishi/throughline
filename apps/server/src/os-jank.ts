/**
 * The environment the server was handed is not the environment the user has.
 *
 * Two shapes of that problem live here:
 *
 *  - **Paths from a human.** Shells do not expand `~` inside `FOO=~/bar`, and a
 *    relative path means whatever the spawning cwd happened to be — which
 *    differs between the desktop shell, the dev runner, and a terminal.
 *  - **`PATH` and `HOME` themselves.** A GUI-launched app inherits neither from
 *    a login shell, so `fixPath` rebuilds them before anything tries to spawn a
 *    subprocess or resolve `~`.
 *
 * @module os-jank
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { HostProcessEnvironment, HostProcessPlatform } from "@app/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathValues,
  readPathFromLaunchctl,
  readPathFromLoginShell,
  resolveWindowsEnvironment,
} from "@app/shared/shell";

// Deliberately not the Effect logger: `fixPath` runs before the logging layer
// is built, so stderr is the only channel that exists.
function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env["SHELL"])) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathValues(shellPath ?? launchctlPath, env["PATH"], platform);
  if (mergedPath) {
    env["PATH"] = mergedPath;
  }
}

/**
 * `HOME` is unset in some service and container launches. Everything that
 * resolves `~` — including this module's own {@link resolveBaseDir} — silently
 * picks a different directory when it is missing.
 */
export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env["HOME"]?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env["HOME"] = homeDir;
  }
}

/**
 * Repairs `PATH` (and on POSIX, `HOME`) in place, once, at startup.
 *
 * Every failure is caught and downgraded to a warning: a user with a broken
 * shell profile still gets a running server, just without the enrichment.
 */
export const fixPath = Effect.fn("fixPath")(function* (): Effect.fn.Return<void> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".throughline");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

/**
 * Same trim/expand/resolve treatment as {@link resolveBaseDir}, for the paths
 * whose default is derived from another resolved path rather than `$HOME`.
 */
export const resolveOverridePath = Effect.fn(function* (
  raw: string | undefined,
  fallback: () => string,
) {
  const { resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return fallback();
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
