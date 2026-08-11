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

export interface AtomCommandReporter {
  readonly warn: (message: string, cause: Cause.Cause<unknown>) => void;
  readonly error: (message: string, cause: Cause.Cause<unknown>) => void;
}

export interface AtomCommandOptions {
  readonly label?: string;
  readonly reportFailure?: boolean;
  readonly reportDefect?: boolean;
}

/**
 * Reporting a settled command is the DEFAULT, not the call site's job. An atom
 * mutation whose result nothing reads is otherwise completely silent: no
 * console line, no span, no UI — the click just does nothing. A caller that
 * genuinely handles the failure itself opts out with `reportFailure: false`.
 *
 * Interrupts are not failures (a component unmounted mid-request), and a defect
 * is louder than a typed failure because it is a bug rather than an outcome.
 */
export function reportAtomCommandResult(
  result: SettledAsyncResult<unknown, unknown>,
  options: AtomCommandOptions = {},
  reporter: AtomCommandReporter = console,
): void {
  if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) {
    return;
  }

  const label = options.label ?? "atom command";
  if (Cause.hasDies(result.cause)) {
    if (options.reportDefect ?? true) {
      reporter.error(`[atom-command] ${label} defected`, result.cause);
    }
  } else if (options.reportFailure ?? true) {
    reporter.warn(`[atom-command] ${label} failed`, result.cause);
  }
}
