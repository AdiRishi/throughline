/**
 * The welcome screen's state: one subscription, folded.
 *
 * The server already enriches the list with journey progress, staleness, and
 * local marks, so the renderer holds nothing it could not be rebuilt from — a
 * reload or a reconnect replays the snapshot and the screen is itself again.
 *
 * @module state/welcome
 */
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { ConnectionSupervisor } from "@app/client-runtime/connection";
import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { PrListView, PrRef } from "@app/contracts";

import { connectionRuntime } from "./connection.ts";

export const INITIAL_PR_LIST: PrListView = {
  viewer: { login: null, ghInstalled: false, authenticated: false, host: null },
  status: { kind: "loading" },
  repos: [],
  merged: [],
  refreshedAt: null,
};

export function createWelcomeAtoms<R, E>(runtime: Atom.AtomRuntime<ConnectionSupervisor | R, E>) {
  // The subscription re-attaches across reconnects by itself, and every fresh
  // session emits a new snapshot — so the screen self-heals with no retry code.
  // Both event kinds carry a whole view, so "folding" is a replace — the
  // server owns sequence ordering, and the renderer just renders the latest.
  const viewResultAtom = runtime.atom(rpcSubscribe("github.subscribePrs", {})).pipe(Atom.keepAlive);

  const viewAtom = Atom.make((get): PrListView => {
    const result = get(viewResultAtom);
    const event = Option.getOrNull(AsyncResult.value(result));
    return event === null ? INITIAL_PR_LIST : event.view;
  }).pipe(Atom.withLabel("pr-list"));

  const loadingAtom = Atom.make((get) => AsyncResult.isInitial(get(viewResultAtom))).pipe(
    Atom.withLabel("pr-list-loading"),
  );

  const refreshAtom = runtime.fn(() => rpcRequest("github.refresh", {}));
  const setReviewedAtom = runtime.fn((input: { readonly pr: PrRef; readonly value: boolean }) =>
    rpcRequest("prState.reviewed", input),
  );
  const setHiddenAtom = runtime.fn((input: { readonly pr: PrRef; readonly value: boolean }) =>
    rpcRequest("prState.hide", input),
  );
  const dismissMergedAtom = runtime.fn((pr: PrRef) => rpcRequest("prState.dismissMerged", { pr }));

  return {
    view: viewAtom,
    loading: loadingAtom,
    refresh: refreshAtom,
    setReviewed: setReviewedAtom,
    setHidden: setHiddenAtom,
    dismissMerged: dismissMergedAtom,
  } as const;
}

export const welcomeAtoms = createWelcomeAtoms(connectionRuntime);
