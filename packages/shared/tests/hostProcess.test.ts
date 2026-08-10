import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  HostProcessArchitecture,
  HostProcessArguments,
  HostProcessExecutablePath,
  HostProcessHostname,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
  isHostWindows,
} from "../src/hostProcess.ts";

describe("host process references", () => {
  it.effect("read real process values by default", () =>
    Effect.gen(function* () {
      assert.isNotEmpty(yield* HostProcessArchitecture);
      assert.strictEqual(yield* HostProcessWorkingDirectory, process.cwd());
      assert.strictEqual(yield* HostProcessExecutablePath, process.execPath);
      assert.deepStrictEqual(yield* HostProcessArguments, process.argv);
      assert.isString(yield* HostProcessHostname);
    }),
  );

  it.effect("are overridable without touching the process global", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* HostProcessArchitecture, "arm64");
      assert.strictEqual(yield* HostProcessHostname, "test-host");
      assert.strictEqual(yield* HostProcessWorkingDirectory, "/tmp/workdir");
      assert.strictEqual(yield* HostProcessExecutablePath, "/tmp/bin/app");
      assert.deepStrictEqual(yield* HostProcessArguments, ["/tmp/bin/app", "--flag"]);
    }).pipe(
      Effect.provideService(HostProcessArchitecture, "arm64"),
      Effect.provideService(HostProcessHostname, "test-host"),
      Effect.provideService(HostProcessWorkingDirectory, "/tmp/workdir"),
      Effect.provideService(HostProcessExecutablePath, "/tmp/bin/app"),
      Effect.provideService(HostProcessArguments, ["/tmp/bin/app", "--flag"]),
    ),
  );
});

describe("isHostWindows", () => {
  it.effect("is true only on win32", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "win32")));
      assert.isFalse(
        yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "linux")),
      );
      assert.isFalse(
        yield* isHostWindows.pipe(Effect.provideService(HostProcessPlatform, "darwin")),
      );
    }),
  );
});
