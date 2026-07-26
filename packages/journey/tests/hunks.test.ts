import { assert, describe, it } from "@effect/vitest";

import { deriveDiff, parseGitPatch, parseRawDiff, unquoteGitPath } from "../src/hunks.ts";
import { RAW_DIFF, ZERO_CONTEXT_PATCH } from "./fixtures/diff.ts";

describe("parseRawDiff", () => {
  it("reads every entry, including the two-path rename", () => {
    const entries = parseRawDiff(RAW_DIFF);
    assert.deepEqual(
      entries.map((entry) => `${entry.status}:${entry.path}`),
      [
        "M:dir with space/odd name.txt",
        "A:empty-added.txt",
        "D:goodbye.txt",
        "M:logo.png",
        "M:script.sh",
        "R:src/auth/renamed.ts",
        "M:src/auth/token.ts",
        "A:src/pages/login.tsx",
      ],
    );
    const rename = entries.find((entry) => entry.status === "R");
    assert.strictEqual(rename?.oldPath, "src/auth/legacy.ts");
    assert.strictEqual(rename?.score, 100);
  });

  it("rejects a stream that does not start with a metadata token", () => {
    assert.throws(() => parseRawDiff("not-a-metadata-token\0"));
  });
});

describe("unquoteGitPath", () => {
  it("leaves unquoted paths alone", () => {
    assert.strictEqual(unquoteGitPath("src/auth/token.ts"), "src/auth/token.ts");
  });

  it("decodes octal escapes back to UTF-8", () => {
    assert.strictEqual(unquoteGitPath('"src/caf\\303\\251.ts"'), "src/café.ts");
  });

  it("decodes the simple escapes", () => {
    assert.strictEqual(unquoteGitPath('"a\\tb\\\\c\\"d"'), 'a\tb\\c"d');
  });
});

describe("parseGitPatch", () => {
  const sections = parseGitPatch(ZERO_CONTEXT_PATCH);

  it("finds one section per changed file", () => {
    assert.strictEqual(sections.length, 8);
  });

  it("recovers a path containing a space from the trailing-tab header lines", () => {
    const section = sections[0];
    assert.strictEqual(section?.newPath, "dir with space/odd name.txt");
    assert.strictEqual(section?.oldPath, "dir with space/odd name.txt");
  });

  it("marks the binary section and gives it no hunks", () => {
    const binary = sections.find((section) => section.headerPath === "logo.png");
    assert.isTrue(binary?.binary);
    assert.strictEqual(binary?.hunks.length, 0);
  });

  it("reads a mode-only change without inventing hunks", () => {
    const mode = sections.find((section) => section.headerPath === "script.sh");
    assert.strictEqual(mode?.oldMode, "100644");
    assert.strictEqual(mode?.newMode, "100755");
    assert.strictEqual(mode?.hunks.length, 0);
  });

  it("reads a pure rename from its rename headers", () => {
    const renamed = sections.find((section) => section.renamed);
    assert.strictEqual(renamed?.oldPath, "src/auth/legacy.ts");
    assert.strictEqual(renamed?.newPath, "src/auth/renamed.ts");
    assert.strictEqual(renamed?.hunks.length, 0);
  });

  it("expands omitted hunk lengths to 1 and keeps zero-length ranges", () => {
    const token = sections.find((section) => section.headerPath === "src/auth/token.ts");
    assert.deepEqual(token?.hunks, [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 4, oldLines: 0, newStart: 5, newLines: 1 },
      { oldStart: 5, oldLines: 0, newStart: 7, newLines: 1 },
    ]);
    assert.strictEqual(token?.additions, 3);
    assert.strictEqual(token?.deletions, 1);
  });

  it("does not mistake a deleted line for a `---` header inside a hunk", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "index 1..2 100644",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,2 +1,2 @@",
      "--- was a horizontal rule",
      "+++ is now three plusses",
      "",
    ].join("\n");
    const [section] = parseGitPatch(patch);
    assert.strictEqual(section?.oldPath, "a.md");
    assert.strictEqual(section?.newPath, "a.md");
    assert.strictEqual(section?.additions, 1);
    assert.strictEqual(section?.deletions, 1);
  });
});

describe("deriveDiff", () => {
  const { files, seeds } = deriveDiff({ raw: RAW_DIFF, patch: ZERO_CONTEXT_PATCH });

  it("orders hunk ids by (path, position) and keeps them dense", () => {
    assert.deepEqual(
      seeds.map((seed) => seed.id),
      ["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10"],
    );
    assert.deepEqual(
      seeds.map((seed) => seed.path),
      [
        "dir with space/odd name.txt",
        "empty-added.txt",
        "goodbye.txt",
        "logo.png",
        "script.sh",
        "src/auth/renamed.ts",
        "src/auth/token.ts",
        "src/auth/token.ts",
        "src/auth/token.ts",
        "src/pages/login.tsx",
      ],
    );
  });

  it("gives every changed file at least one seed hunk", () => {
    const covered = new Set(seeds.map((seed) => seed.path));
    for (const file of files) {
      assert.isTrue(covered.has(file.path), `${file.path} has no seed hunk`);
    }
  });

  it("classifies the file-level hunks by what actually happened", () => {
    const kindOf = (path: string) => seeds.find((seed) => seed.path === path)?.fileKind;
    assert.strictEqual(kindOf("logo.png"), "binary");
    assert.strictEqual(kindOf("script.sh"), "mode");
    assert.strictEqual(kindOf("src/auth/renamed.ts"), "rename");
    assert.strictEqual(kindOf("empty-added.txt"), "empty");
  });

  it("leaves textual hunks without a file kind", () => {
    for (const seed of seeds.filter((entry) => entry.path === "src/auth/token.ts")) {
      assert.isNull(seed.fileKind);
    }
  });

  it("records change kinds, rename provenance, and modes", () => {
    const byPath = new Map(files.map((file) => [file.path, file]));
    assert.strictEqual(byPath.get("src/pages/login.tsx")?.changeKind, "added");
    assert.strictEqual(byPath.get("goodbye.txt")?.changeKind, "deleted");
    assert.strictEqual(byPath.get("goodbye.txt")?.oldPath, "goodbye.txt");
    assert.strictEqual(byPath.get("src/auth/renamed.ts")?.changeKind, "renamed");
    assert.strictEqual(byPath.get("src/auth/renamed.ts")?.oldPath, "src/auth/legacy.ts");
    assert.strictEqual(byPath.get("script.sh")?.oldMode, "100644");
    assert.strictEqual(byPath.get("script.sh")?.newMode, "100755");
    assert.isNull(byPath.get("src/pages/login.tsx")?.oldMode);
    assert.isTrue(byPath.get("logo.png")?.binary);
  });

  it("counts additions and deletions from the patch itself", () => {
    const byPath = new Map(files.map((file) => [file.path, file]));
    assert.strictEqual(byPath.get("src/auth/token.ts")?.additions, 3);
    assert.strictEqual(byPath.get("src/auth/token.ts")?.deletions, 1);
    assert.strictEqual(byPath.get("logo.png")?.additions, 0);
  });

  it("survives a raw list and a patch that disagree in length", () => {
    const truncated = ZERO_CONTEXT_PATCH.slice(
      0,
      ZERO_CONTEXT_PATCH.indexOf("diff --git a/src/pages/login.tsx"),
    );
    const derived = deriveDiff({ raw: RAW_DIFF, patch: truncated });
    assert.strictEqual(derived.files.length, 8);
    // The file with no patch section still gets a file-level hunk rather than
    // vanishing — coverage is about changed files, not about parseable ones.
    const orphan = derived.seeds.filter((seed) => seed.path === "src/pages/login.tsx");
    assert.strictEqual(orphan.length, 1);
    assert.strictEqual(orphan[0]?.fileKind, "empty");
  });

  it("handles an empty diff", () => {
    assert.deepEqual(deriveDiff({ raw: "", patch: "" }), { files: [], seeds: [] });
  });
});
