/**
 * Driving a mutation atom with failure reporting on by default.
 *
 * `useAtomSet` fires an atom and returns nothing: the `AsyncResult` is parked
 * in the atom, and unless some component also reads it a failure leaves no
 * trace anywhere. That is the wrong default for a mutation — a failed
 * `notes.delete` should never be indistinguishable from a no-op. This wraps the
 * setter so every settled result is reported unless the caller opts out.
 *
 * @module state/useAtomCommand
 */
import { useAtomSet } from "@effect/atom-react";
import type { Atom, AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import {
  type AtomCommandOptions,
  reportAtomCommandResult,
  settleAsyncResult,
} from "./asyncResult.ts";

export function useAtomCommand<W, A, E>(
  atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, W>,
  options: string | AtomCommandOptions,
): (value: W) => void {
  const set = useAtomSet(atom, { mode: "promiseExit" });
  const resolved: AtomCommandOptions = typeof options === "string" ? { label: options } : options;
  const label = resolved.label;
  const reportFailure = resolved.reportFailure ?? true;
  const reportDefect = resolved.reportDefect ?? true;

  return useCallback(
    (value: W) => {
      void settleAsyncResult(() => set(value)).then((result) => {
        reportAtomCommandResult(result, {
          ...(label === undefined ? {} : { label }),
          reportFailure,
          reportDefect,
        });
      });
    },
    [set, label, reportFailure, reportDefect],
  );
}
