import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const fromLiveSubscription = <A>(subscription: PubSub.Subscription<A>): Stream.Stream<A> =>
  // Stream.fromSubscription converts an external interrupt into Cause.Done,
  // which an RPC stream can mistake for a schema-encoded domain failure.
  Stream.fromPull(Effect.succeed(PubSub.takeAll(subscription)));

export const fromLivePubSub = <A>(pubsub: PubSub.PubSub<A>): Stream.Stream<A> =>
  Stream.unwrap(Effect.map(PubSub.subscribe(pubsub), fromLiveSubscription));
