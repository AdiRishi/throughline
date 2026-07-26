/**
 * `JourneyReader` — the read side of a journey, served to the reading surfaces.
 *
 * Everything here is immutable per journey, which is what makes it cacheable
 * forever client-side: the artifact is pinned to `baseSha..headSha`, so a patch,
 * a file's contents, and a tree listing cannot drift under a reader.
 *
 * One deliberate design consequence lives in `filePatch`. `@pierre/diffs` can
 * only offer in-place context expansion when a diff was parsed *together with*
 * the full old and new file contents (`isPartial: false`); a bare patch string is
 * always partial and never expandable. So this module serves the patch and the
 * contents as separate calls and the renderer combines them — which is what turns
 * the product's expand-context interaction into native library behaviour.
 *
 * @module journeys/JourneyReader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  JourneyFileNotFoundError,
  JourneyNotFoundError,
  type FileContent,
  type FilePatch,
  type Journey,
  type JourneyEnvelope,
  type JourneyId,
  type JourneyTree,
  type PrRef,
} from "@app/contracts";

import { GitHub } from "../github/GitHub.ts";
import { Workspaces } from "../workspace/Workspaces.ts";
import { JourneyStore } from "./JourneyStore.ts";

/** Images render as images; everything else binary gets a quiet placard. */
const IMAGE_MEDIA_TYPES: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["svg", "image/svg+xml"],
]);

/** Beyond this, a data URL is a liability rather than a preview. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export class JourneyReader extends Context.Service<
  JourneyReader,
  {
    readonly envelope: (ref: PrRef) => Effect.Effect<JourneyEnvelope, JourneyNotFoundError>;
    readonly filePatch: (
      journeyId: JourneyId,
      path: string,
    ) => Effect.Effect<FilePatch, JourneyNotFoundError | JourneyFileNotFoundError>;
    readonly fileContent: (
      journeyId: JourneyId,
      path: string,
    ) => Effect.Effect<FileContent, JourneyNotFoundError | JourneyFileNotFoundError>;
    readonly tree: (journeyId: JourneyId) => Effect.Effect<JourneyTree, JourneyNotFoundError>;
  }
>()("@app/server/journeys/JourneyReader") {}

const make = Effect.gen(function* () {
  const store = yield* JourneyStore;
  const workspaces = yield* Workspaces;
  const github = yield* GitHub;

  const requireJourney = (
    journeyId: JourneyId,
  ): Effect.Effect<{ readonly journey: Journey; readonly ref: PrRef }, JourneyNotFoundError> =>
    store.journeyById(journeyId).pipe(
      Effect.orElseSucceed(() => Option.none<Journey>()),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new JourneyNotFoundError({ journeyId })),
          onSome: (journey) => Effect.succeed({ journey, ref: journey.pr }),
        }),
      ),
    );

  return {
    envelope: (ref) =>
      Effect.gen(function* () {
        const journey = yield* store
          .journey(ref)
          .pipe(Effect.orElseSucceed(() => Option.none<Journey>()));
        if (Option.isNone(journey)) {
          return yield* new JourneyNotFoundError({ pr: ref });
        }
        // The cached view only — a staleness check must never send a request.
        const current = yield* github.cachedPr(ref);
        const currentHeadSha = Option.isSome(current) ? current.value.headSha : null;
        return {
          journey: journey.value,
          stale: currentHeadSha !== null && currentHeadSha !== journey.value.pinned.headSha,
          currentHeadSha,
        };
      }),

    filePatch: Effect.fn("journeyReader.filePatch")(function* (journeyId, path) {
      const { ref } = yield* requireJourney(journeyId);
      const artifacts = yield* workspaces
        .fileArtifacts(ref, journeyId, path)
        .pipe(Effect.mapError(() => new JourneyFileNotFoundError({ journeyId, path })));
      return {
        path: artifacts.entry.path,
        oldPath: artifacts.entry.oldPath,
        patch: artifacts.patch,
        binary: artifacts.entry.binary,
      } satisfies FilePatch;
    }),

    fileContent: Effect.fn("journeyReader.fileContent")(function* (journeyId, path) {
      const { journey, ref } = yield* requireJourney(journeyId);

      const changed = journey.files.some((file) => file.path === path || file.oldPath === path);
      if (!changed) {
        // Free reading of any tree file. This is the one thing journey reading
        // still needs git for, and it re-fetches if the workspace was evicted.
        const text = yield* workspaces
          .treeFile(ref, journey.pinned.headSha, path)
          .pipe(Effect.mapError(() => new JourneyFileNotFoundError({ journeyId, path })));
        return {
          path,
          oldText: null,
          newText: text,
          oldBinaryBytes: null,
          newBinaryBytes: null,
          oldImageDataUrl: null,
          newImageDataUrl: null,
        } satisfies FileContent;
      }

      const artifacts = yield* workspaces
        .fileArtifacts(ref, journeyId, path)
        .pipe(Effect.mapError(() => new JourneyFileNotFoundError({ journeyId, path })));

      const mediaType = imageMediaType(artifacts.entry.path);
      const dataUrl = (bytes: Uint8Array | null): string | null => {
        if (bytes === null || mediaType === null || bytes.length > MAX_INLINE_IMAGE_BYTES) {
          return null;
        }
        return `data:${mediaType};base64,${toBase64(bytes)}`;
      };

      return {
        path: artifacts.entry.path,
        oldText: artifacts.oldText,
        newText: artifacts.newText,
        oldBinaryBytes: artifacts.entry.binary ? artifacts.entry.oldBytes : null,
        newBinaryBytes: artifacts.entry.binary ? artifacts.entry.newBytes : null,
        oldImageDataUrl: dataUrl(artifacts.oldBytes),
        newImageDataUrl: dataUrl(artifacts.newBytes),
      } satisfies FileContent;
    }),

    tree: Effect.fn("journeyReader.tree")(function* (journeyId) {
      const { ref } = yield* requireJourney(journeyId);
      const paths = yield* workspaces
        .treePaths(ref, journeyId)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      return { journeyId, paths } satisfies JourneyTree;
    }),
  } satisfies JourneyReader["Service"];
});

export const layer = Layer.effect(JourneyReader, make);

function imageMediaType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MEDIA_TYPES.get(path.slice(dot + 1).toLowerCase()) ?? null;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked so a large image cannot blow the argument limit of `fromCharCode`.
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
