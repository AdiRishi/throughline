/**
 * Filesystem-path normalization for values that reach the server from a human:
 * env vars and CLI flags. Shells do not expand `~` inside `FOO=~/bar`, and a
 * relative path means whatever the spawning cwd happened to be — which differs
 * between the desktop shell, the dev runner, and a terminal.
 *
 * @module os-jank
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

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
