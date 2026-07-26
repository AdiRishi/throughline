import { describe, expect, it } from "vitest";

import { deriveSeedHunks } from "../src/hunks.ts";

describe("deriveSeedHunks", () => {
  it("derives a dense ordered partition across additions, deletions, and modifications", () => {
    const patch = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
index 2222222..0000000
--- a/src/deleted.ts
+++ /dev/null
@@ -4,2 +0,0 @@
-old
-lines
diff --git a/src/changed.ts b/src/changed.ts
index 3333333..4444444 100644
--- a/src/changed.ts
+++ b/src/changed.ts
@@ -8 +8,2 @@
-before
+after
+again`;

    expect(deriveSeedHunks(patch)).toEqual({
      files: [
        {
          path: "src/added.ts",
          kind: "added",
          additions: 2,
          deletions: 0,
        },
        {
          path: "src/deleted.ts",
          kind: "deleted",
          additions: 0,
          deletions: 2,
        },
        {
          path: "src/changed.ts",
          kind: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
      hunks: [
        {
          id: "h1",
          path: "src/added.ts",
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
        },
        {
          id: "h2",
          path: "src/deleted.ts",
          oldStart: 4,
          oldLines: 2,
          newStart: 0,
          newLines: 0,
        },
        {
          id: "h3",
          path: "src/changed.ts",
          oldStart: 8,
          oldLines: 1,
          newStart: 8,
          newLines: 2,
        },
      ],
    });
  });

  it("covers non-textual changes with one file-level hunk", () => {
    const patch = `diff --git a/assets/logo.png b/assets/logo.png
index 1111111..2222222 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts`;

    expect(deriveSeedHunks(patch)).toEqual({
      files: [
        {
          path: "assets/logo.png",
          kind: "binary",
          additions: 0,
          deletions: 0,
        },
        {
          path: "new-name.ts",
          oldPath: "old-name.ts",
          kind: "renamed",
          additions: 0,
          deletions: 0,
        },
      ],
      hunks: [
        {
          id: "h1",
          path: "assets/logo.png",
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          fileKind: "binary",
        },
        {
          id: "h2",
          path: "new-name.ts",
          oldStart: 0,
          oldLines: 0,
          newStart: 0,
          newLines: 0,
          fileKind: "rename",
        },
      ],
    });
  });
});
