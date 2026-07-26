/**
 * Ingestion state: a direct rendering of the job stream.
 *
 * There is no invented progress here because there is no other data source —
 * the transition shows what the pipeline published, and nothing else. Reconnect
 * replays the snapshot and the transition resumes where reality is.
 *
 * @module state/ingestion
 */
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { request as rpcRequest, subscribe as rpcSubscribe } from "@app/client-runtime/rpc";
import type { IngestionJob, IngestionStartInput, JobId } from "@app/contracts";

import { atomBundle } from "./bundle.ts";
import { connectionRuntime } from "./connection.ts";
import { parsePrKey } from "./prKey.ts";

/** One bundle per pull request — `atomBundle`, not `Atom.family`; see that module. */
export const ingestionAtomsFor = atomBundle((key: string) => {
  const pr = parsePrKey(key);

  // keepAlive for the same reason as the journey atoms: a remount must not
  // race the disposal of a subscription the transition depends on.
  const eventResultAtom = connectionRuntime
    .atom(rpcSubscribe("ingestion.subscribe", { pr }))
    .pipe(Atom.keepAlive);

  const jobAtom = Atom.make((get): IngestionJob | null => {
    const event = Option.getOrNull(AsyncResult.value(get(eventResultAtom)));
    return event?.job ?? null;
  }).pipe(Atom.withLabel(`ingestion:${key}`));

  /** False until the first event lands, so the UI can wait rather than guess. */
  const readyAtom = Atom.make((get) => !AsyncResult.isInitial(get(eventResultAtom))).pipe(
    Atom.withLabel(`ingestion-ready:${key}`),
  );

  return { pr, job: jobAtom, ready: readyAtom } as const;
});

export const ingestionActions = {
  start: connectionRuntime.fn((input: IngestionStartInput) => rpcRequest("ingestion.start", input)),
  cancel: connectionRuntime.fn((jobId: JobId) => rpcRequest("ingestion.cancel", { jobId })),
} as const;
