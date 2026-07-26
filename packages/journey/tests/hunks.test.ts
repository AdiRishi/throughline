import { assert, describe, it } from "@effect/vitest";

import { deriveDiffIndex, parseUnifiedDiff, unquoteGitPath } from "../src/hunks.ts";
import { SAMPLE_DIFF } from "./fixtures.ts";

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);

  it("finds every changed file in the patch", () => {
    assert.deepEqual(
      files.map((file) => file.path).toSorted(),
      [
        "docs/logo.png",
        "scripts/run.sh",
        "src/app/router.tsx",
        "src/auth/session.ts",
        "src/café.ts",
        "src/gone.ts",
        "src/new.ts",
      ].toSorted(),
    );
  });

  it("reads a new file as an addition with no old-side lines", () => {
    const file = files.find((entry) => entry.path === "src/auth/session.ts");
    assert.isDefined(file);
    assert.equal(file.kind, "added");
    assert.deepEqual(file.ranges, [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }]);
    assert.equal(file.additions, 3);
    assert.equal(file.deletions, 0);
  });

  it("keeps two changed regions in one file as two separate ranges", () => {
    const file = files.find((entry) => entry.path === "src/app/router.tsx");
    assert.isDefined(file);
    assert.deepEqual(file.ranges, [
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 },
      { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1 },
    ]);
  });

  it("reads a deletion as an old-side-only range on the old path", () => {
    const file = files.find((entry) => entry.path === "src/gone.ts");
    assert.isDefined(file);
    assert.equal(file.kind, "deleted");
    assert.deepEqual(file.ranges, [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }]);
  });

  it("marks a binary change as binary with no ranges", () => {
    const file = files.find((entry) => entry.path === "docs/logo.png");
    assert.isDefined(file);
    assert.isTrue(file.binary);
    assert.deepEqual(file.ranges, []);
  });

  it("reads a pure rename with its old path and no ranges", () => {
    const file = files.find((entry) => entry.path === "src/new.ts");
    assert.isDefined(file);
    assert.equal(file.kind, "renamed");
    assert.equal(file.oldPath, "src/old.ts");
    assert.deepEqual(file.ranges, []);
  });

  it("treats a chmod as a modification, not a type change", () => {
    const file = files.find((entry) => entry.path === "scripts/run.sh");
    assert.isDefined(file);
    assert.equal(file.kind, "modified");
    assert.equal(file.oldMode, "100644");
    assert.equal(file.newMode, "100755");
  });

  it("decodes C-quoted paths", () => {
    assert.isDefined(files.find((entry) => entry.path === "src/café.ts"));
  });

  it("ignores the no-newline marker rather than counting it as a line", () => {
    const patch = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-one
\\ No newline at end of file
+two
\\ No newline at end of file
`;
    const [file] = parseUnifiedDiff(patch);
    assert.isDefined(file);
    assert.deepEqual(file.ranges, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]);
  });

  it("reads an omitted line count as 1", () => {
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -5 +5,2 @@
-one
+one
+two
`;
    const [file] = parseUnifiedDiff(patch);
    assert.isDefined(file);
    assert.deepEqual(file.ranges, [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 2 }]);
  });

  it("returns nothing for an empty patch", () => {
    assert.deepEqual(parseUnifiedDiff(""), []);
    assert.deepEqual(parseUnifiedDiff("\n\n"), []);
  });
});

describe("unquoteGitPath", () => {
  it("passes unquoted paths through", () => {
    assert.equal(unquoteGitPath("src/a.ts"), "src/a.ts");
  });

  it("decodes octal escapes as UTF-8 bytes", () => {
    assert.equal(unquoteGitPath('"src/caf\\303\\251.ts"'), "src/café.ts");
  });

  it("decodes simple escapes", () => {
    assert.equal(unquoteGitPath('"a\\tb"'), "a\tb");
  });
});

describe("deriveDiffIndex", () => {
  const index = deriveDiffIndex(SAMPLE_DIFF);

  it("assigns dense ids ordered by path then position", () => {
    assert.deepEqual(
      index.seeds.map((seed) => [seed.id, seed.path]),
      [
        ["h1", "docs/logo.png"],
        ["h2", "scripts/run.sh"],
        ["h3", "src/app/router.tsx"],
        ["h4", "src/app/router.tsx"],
        ["h5", "src/auth/session.ts"],
        ["h6", "src/café.ts"],
        ["h7", "src/gone.ts"],
        ["h8", "src/new.ts"],
      ],
    );
  });

  it("gives every changed file with no changed lines exactly one file-level hunk", () => {
    const fileLevel = index.seeds.filter((seed) => seed.fileKind !== undefined);
    assert.deepEqual(
      fileLevel.map((seed) => [seed.path, seed.fileKind]),
      [
        ["docs/logo.png", "binary"],
        ["scripts/run.sh", "mode"],
        ["src/new.ts", "rename"],
      ],
    );
  });

  it("is deterministic: the same patch always yields the same ids", () => {
    const again = deriveDiffIndex(SAMPLE_DIFF);
    assert.deepEqual(again.seeds, index.seeds);
  });

  it("reports one file change per changed file", () => {
    assert.equal(index.files.length, 7);
    assert.deepEqual(
      index.files.map((file) => file.path),
      [
        "docs/logo.png",
        "scripts/run.sh",
        "src/app/router.tsx",
        "src/auth/session.ts",
        "src/café.ts",
        "src/gone.ts",
        "src/new.ts",
      ],
    );
  });

  it("classifies a symlink flip as a symlink file-level hunk", () => {
    const patch = `diff --git a/link b/link
old mode 100644
new mode 120000
index 1..2
`;
    const { seeds } = deriveDiffIndex(patch);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0]?.fileKind, "symlink");
  });

  it("classifies an empty new file as an empty file-level hunk", () => {
    const patch = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`;
    const { seeds } = deriveDiffIndex(patch);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0]?.fileKind, "empty");
  });
});
