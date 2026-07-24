import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronTheme from "../../../src/electron/ElectronTheme.ts";
import { getTheme, setTheme } from "../../../src/ipc/methods/window.ts";
import * as DesktopAppSettings from "../../../src/settings/DesktopAppSettings.ts";

describe("window IPC theme methods", () => {
  it.effect("returns the persisted shell theme after a renderer change", () => {
    const sources: Array<string> = [];
    const layer = Layer.mergeAll(
      DesktopAppSettings.layerTest(),
      Layer.succeed(
        ElectronTheme.ElectronTheme,
        ElectronTheme.ElectronTheme.of({
          shouldUseDarkColors: Effect.succeed(false),
          setSource: (source) =>
            Effect.sync(() => {
              sources.push(source);
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      yield* setTheme.handler("dark");

      assert.strictEqual(yield* getTheme.handler(), "dark");
      assert.deepStrictEqual(sources, ["dark"]);
    }).pipe(Effect.provide(layer));
  });
});
