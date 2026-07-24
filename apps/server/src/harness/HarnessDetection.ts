import * as Effect from "effect/Effect";

import type { HarnessAuthState, HarnessStatus } from "@app/contracts";

import type { HarnessProcess, HarnessProcessResult } from "./HarnessProcess.ts";

const VERSION_PATTERN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u;

export const versionFromOutput = (output: string): string | null =>
  output.match(VERSION_PATTERN)?.[0] ?? null;

export const detectHarness = (
  kind: string,
  binary: string | undefined,
  process: HarnessProcess["Service"],
  authArgs: ReadonlyArray<string>,
  parseAuth: (result: HarnessProcessResult) => HarnessAuthState,
): Effect.Effect<HarnessStatus> => {
  if (binary === undefined) {
    return Effect.succeed({
      kind,
      installed: false,
      version: null,
      auth: "unknown",
    });
  }

  return Effect.all(
    [
      process.run(binary, ["--version"]).pipe(Effect.option),
      process.run(binary, authArgs).pipe(Effect.option),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(
      ([versionResult, authResult]): HarnessStatus => ({
        kind,
        installed: true,
        version:
          versionResult._tag === "Some" && versionResult.value.exitCode === 0
            ? versionFromOutput(`${versionResult.value.stdout}\n${versionResult.value.stderr}`)
            : null,
        auth: authResult._tag === "Some" ? parseAuth(authResult.value) : "unknown",
      }),
    ),
  );
};
