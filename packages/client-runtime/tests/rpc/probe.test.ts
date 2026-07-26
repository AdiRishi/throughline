import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const sessionChanges = (ref: SubscriptionRef.SubscriptionRef<Option.Option<string>>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const live = yield* PubSub.subscribe(ref.pubsub);
      const current = ref.value;
      return Stream.make(current).pipe(
        Stream.concat(Stream.fromSubscription(live)),
        Stream.changes,
      );
    }),
  );

describe("probe", () => {
  it.live("emits current then live", () =>
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<Option.Option<string>>(Option.none());
      const seen = yield* Ref.make<string[]>([]);
      const fiber = yield* Effect.forkChild(
        sessionChanges(ref).pipe(
          Stream.runForEach((v) =>
            Ref.update(seen, (s) => [...s, Option.getOrElse(v, () => "none")]),
          ),
        ),
      );
      yield* Effect.sleep("50 millis");
      yield* SubscriptionRef.set(ref, Option.some("a"));
      yield* Effect.sleep("50 millis");
      yield* SubscriptionRef.set(ref, Option.none());
      yield* SubscriptionRef.set(ref, Option.some("b"));
      yield* Effect.sleep("100 millis");
      const out = yield* Ref.get(seen);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(out, ["none", "a", "none", "b"]);
    }).pipe(Effect.scoped),
  );
});
