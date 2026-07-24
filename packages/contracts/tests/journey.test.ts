import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { FileContent, Hunk, Journey, Narrative, RepositoryPath, SeedHunk } from "../src/journey.ts";

const decodeRepositoryPath = Schema.decodeUnknownSync(RepositoryPath);
const decodeSeed = Schema.decodeUnknownSync(SeedHunk);
const decodeHunk = Schema.decodeUnknownSync(Hunk);
const decodeNarrative = Schema.decodeUnknownSync(Narrative);
const decodeFileContent = Schema.decodeUnknownSync(FileContent);
const decodeJourney = Schema.decodeUnknownSync(Schema.toCodecJson(Journey));

describe("RepositoryPath", () => {
  it("accepts relative POSIX paths without normalizing meaningful spaces", () => {
    assert.strictEqual(decodeRepositoryPath("src/space name.ts"), "src/space name.ts");
  });

  it("rejects absolute, traversing, empty-segment, backslash, and NUL paths", () => {
    for (const path of [
      "/etc/passwd",
      "../secret",
      "src/../secret",
      "src//file.ts",
      "src\\file.ts",
      "src/\0file.ts",
    ]) {
      assert.throws(() => decodeRepositoryPath(path));
    }
  });
});

describe("seed and final hunk contracts", () => {
  it("keeps deterministic seeds home-free and requires final assignment metadata", () => {
    const seed = decodeSeed({
      id: "s1",
      path: "src/a.ts",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
    });
    assert.notProperty(seed, "home");
    assert.notProperty(seed, "seedId");

    assert.throws(() =>
      decodeHunk({
        id: "h1",
        path: "src/a.ts",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        seedId: "s1",
      }),
    );
  });
});

describe("Narrative", () => {
  it("preserves Markdown whitespace while rejecting content with no prose", () => {
    assert.strictEqual(
      decodeNarrative({ markdown: "  **evidence**  " }).markdown,
      "  **evidence**  ",
    );
    assert.throws(() => decodeNarrative({ markdown: " \n\t " }));
  });
});

describe("Journey wire contract", () => {
  it("decodes a pinned one-cluster artifact and its ISO timestamp", () => {
    const journey = decodeJourney({
      formatVersion: 1,
      id: "journey-1",
      pr: { owner: "octo", repo: "app", number: 7 },
      pinned: {
        headSha: "2222222222222222222222222222222222222222",
        baseSha: "1111111111111111111111111111111111111111",
        analyzedAt: "2026-07-25T00:00:00.000Z",
      },
      provenance: { harnessKind: "codex" },
      overview: {
        brief: { markdown: "Adds the module." },
        whereToBegin: { markdown: "Begin at cluster one." },
      },
      clusters: [
        {
          id: "c1",
          position: 1,
          title: "Module",
          weight: "core",
          narrative: { markdown: "Adds the module." },
          mapEntry: { markdown: "The foundation." },
          buildsOn: [],
          fileOrder: ["src/a.ts"],
          resurfaced: [],
        },
      ],
      hunks: [
        {
          id: "h1",
          path: "src/a.ts",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          seedId: "s1",
          home: "c1",
        },
      ],
      files: [
        {
          path: "src/a.ts",
          oldPath: null,
          kind: "added",
          oldMode: null,
          newMode: "100644",
          binary: false,
          additions: 1,
          deletions: 0,
        },
      ],
      hints: [],
    });

    assert.isTrue(DateTime.isDateTime(journey.pinned.analyzedAt));
    assert.strictEqual(journey.hunks[0]?.home, "c1");
  });
});

describe("FileContent", () => {
  it("discriminates text, image, and metadata-only binary responses", () => {
    assert.strictEqual(
      decodeFileContent({
        type: "text",
        path: "src/a.ts",
        old: null,
        new: "export const a = 1\n",
      }).type,
      "text",
    );
    assert.strictEqual(
      decodeFileContent({
        type: "image",
        path: "logo.png",
        oldMediaType: null,
        oldBase64: null,
        newMediaType: "image/png",
        newBase64: "iVBORw0KGgo=",
      }).type,
      "image",
    );
    assert.strictEqual(
      decodeFileContent({
        type: "binary",
        path: "asset.bin",
        oldSize: 12,
        newSize: 20,
      }).type,
      "binary",
    );
  });
});
