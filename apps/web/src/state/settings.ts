/**
 * Settings: harness detection and the reviewer's choice.
 *
 * @module state/settings
 */
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { request as rpcRequest } from "@app/client-runtime/rpc";
import type { HarnessKind, HarnessStatusView } from "@app/contracts";

import { connectionRuntime } from "./connection.ts";
import { requestWhenConnected } from "./rpc.ts";

const EMPTY: HarnessStatusView = { harnesses: [], selected: null, active: null };

const statusResultAtom = connectionRuntime
  .atom(requestWhenConnected("harness.status", {}))
  .pipe(Atom.keepAlive);

export const harnessStatusAtom = Atom.make(
  (get): HarnessStatusView =>
    Option.getOrElse(AsyncResult.value(get(statusResultAtom)), () => EMPTY),
).pipe(Atom.withLabel("harness-status"));

export const harnessStatusLoadingAtom = Atom.make((get) =>
  AsyncResult.isInitial(get(statusResultAtom)),
).pipe(Atom.withLabel("harness-status-loading"));

export const updateSettingsAtom = connectionRuntime.fn((harness: HarnessKind | null) =>
  rpcRequest("settings.update", { harness }),
);
