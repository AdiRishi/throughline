import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessEnvironment, HostProcessPlatform } from "@app/shared/hostProcess";
import { WindowsShellEnvironment } from "@app/shared/shell";

import { fixPath, hydratePosixHome } from "../src/os-jank.ts";

describe("hydratePosixHome", () => {
  it("fills in a missing HOME from the user account", () => {
    const env: NodeJS.ProcessEnv = {};
    hydratePosixHome(env, () => "/home/user");
    assert.equal(env["HOME"], "/home/user");
  });

  it("leaves an existing HOME alone", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/home/existing" };
    hydratePosixHome(env, () => "/home/other");
    assert.equal(env["HOME"], "/home/existing");
  });

  it("treats a blank HOME as missing", () => {
    const env: NodeJS.ProcessEnv = { HOME: "   " };
    hydratePosixHome(env, () => "/home/user");
    assert.equal(env["HOME"], "/home/user");
  });
});

describe("fixPath", () => {
  it.effect("is a no-op on platforms with no login-shell convention", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcessPlatform, "freebsd"),
        Effect.provideService(HostProcessEnvironment, env),
      );
      assert.deepEqual(env, { PATH: "/usr/bin" });
    }),
  );

  it.effect("merges the shell PATH ahead of the inherited one on win32", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, env),
        Effect.provideService(WindowsShellEnvironment, () => ({ PATH: "C:\\Node" })),
      );
      assert.equal(env["PATH"], "C:\\Node;C:\\Windows");
    }),
  );

  // The enrichment is best-effort by design: a user whose shell profile throws
  // must still get a running server, just without the extra PATH entries.
  it.effect("survives a shell probe that throws on win32", () =>
    Effect.gen(function* () {
      const env: NodeJS.ProcessEnv = { PATH: "C:\\Windows" };
      yield* fixPath().pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(HostProcessEnvironment, env),
        Effect.provideService(WindowsShellEnvironment, () => {
          throw new Error("execution policy");
        }),
      );
      assert.equal(env["PATH"], "C:\\Windows");
    }),
  );
});
