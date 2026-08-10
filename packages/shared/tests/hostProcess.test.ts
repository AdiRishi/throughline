import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessPlatform, isHostWindows } from "../src/hostProcess.ts";

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
