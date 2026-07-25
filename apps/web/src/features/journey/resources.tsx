import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo } from "react";

import type { FileContent, JourneyFilePatch, JourneyId, RepositoryPath } from "@app/contracts";

import { productAtoms } from "../../state/product.ts";

export interface JourneyFileResource {
  readonly patch: JourneyFilePatch | null;
  readonly content: FileContent | null;
  readonly error: string | null;
  readonly ready: boolean;
}

export function JourneyFileResourceSubscriptions({
  journeyId,
  paths,
  onResource,
}: {
  readonly journeyId: JourneyId;
  readonly paths: readonly RepositoryPath[];
  readonly onResource: (path: RepositoryPath, resource: JourneyFileResource) => void;
}) {
  return paths.map((path) => (
    <JourneyFileResourceSubscription
      journeyId={journeyId}
      key={path}
      path={path}
      onResource={onResource}
    />
  ));
}

function JourneyFileResourceSubscription({
  journeyId,
  path,
  onResource,
}: {
  readonly journeyId: JourneyId;
  readonly path: RepositoryPath;
  readonly onResource: (path: RepositoryPath, resource: JourneyFileResource) => void;
}) {
  const atoms = useMemo(
    () => ({
      patch: productAtoms.filePatch({ journeyId, path }),
      content: productAtoms.fileContent({ journeyId, path }),
    }),
    [journeyId, path],
  );
  const patchResult = useAtomValue(atoms.patch);
  const contentResult = useAtomValue(atoms.content);
  const patch = Option.getOrNull(AsyncResult.value(patchResult));
  const content = Option.getOrNull(AsyncResult.value(contentResult));
  const error = resultError(patchResult) ?? resultError(contentResult);

  useEffect(() => {
    onResource(path, {
      patch,
      content,
      error,
      ready: patch !== null && content !== null,
    });
  }, [content, error, onResource, patch, path]);

  return null;
}

function resultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (!AsyncResult.isFailure(result)) return null;
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "This file could not be loaded from the pinned journey.";
}
