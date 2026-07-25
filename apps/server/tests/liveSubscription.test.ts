import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Pull from "effect/Pull";
import * as Stream from "effect/Stream";

import { fromLiveSubscription } from "../src/liveSubscription.ts";

describe("fromLiveSubscription", () => {
  it.effect("preserves an external cancellation as interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<string>();
        const subscription = yield* PubSub.subscribe(pubsub);
        const fiber = yield* fromLiveSubscription(subscription).pipe(
          Stream.runDrain,
          Effect.forkChild,
        );

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        const exit = yield* Fiber.await(fiber);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.isTrue(Cause.hasInterrupts(exit.cause));
          assert.isFalse(exit.cause.reasons.some(Pull.isDoneFailure));
        }
      }),
    ),
  );
});
