/**
 * Settling an Effect promise into a value.
 *
 * `runPromiseExit` resolves with an `Exit`, but a caller that chains the
 * returned promise (`.finally`, a shared "pending" promise) still has to
 * survive the case where the promise rejects instead — a rejection there poisons
 * the chain permanently. `settleAsyncResult` turns both outcomes into an
 * `AsyncResult`, so the call site has exactly one shape to branch on.
 *
 * @module state/asyncResult
 */
import * as Cause from "effect/Cause";
import type * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";

export type SettledAsyncResult<A, E> = AsyncResult.Success<A, E> | AsyncResult.Failure<A, E>;

export function squashAtomCommandFailure(result: {
  readonly cause: Cause.Cause<unknown>;
}): unknown {
  return Cause.squash(result.cause);
}

export async function settleAsyncResult<A, E>(
  execute: () => Promise<Exit.Exit<A, E>>,
): Promise<SettledAsyncResult<A, E>> {
  try {
    return AsyncResult.fromExit(await execute());
  } catch (defect) {
    return AsyncResult.failure(Cause.die(defect));
  }
}
