import { assert, describe, it } from "@effect/vitest";

import { derivePatchFacts } from "../src/hunks.ts";

const COMPOSITE_PATCH = String.raw`diff --git a/binary/asset.bin b/binary/asset.bin
index 01c0d965bf8379b4a41360f65e1c6e270ba9b048..bfe172bfa930462039055d8ca6297bff6d7219f1 100644
GIT binary patch
literal 20
bcmZQzWMa-sE!R!T%u6h))J;h&N&E)@HDw0K

literal 15
WcmZQzWMa<GNzqNp%u6h){0{&cSp@e0

diff --git a/empty/added.txt b/empty/added.txt
new file mode 100644
index 0000000..e69de29
diff --git a/mode/script.sh b/mode/script.sh
old mode 100644
new mode 100755
diff --git a/rename/from.txt b/rename/to.txt
similarity index 100%
rename from rename/from.txt
rename to rename/to.txt
diff --git a/symlink/current b/symlink/current
index 8c6ff43..0a1584e 120000
--- a/symlink/current
+++ b/symlink/current
@@ -1 +1 @@
-targets/old
\ No newline at end of file
+targets/new
\ No newline at end of file
diff --git a/text/added.txt b/text/added.txt
new file mode 100644
index 0000000..85b870e
--- /dev/null
+++ b/text/added.txt
@@ -0,0 +1,2 @@
+added alpha
+added beta
diff --git a/text/deleted.txt b/text/deleted.txt
deleted file mode 100644
index d02fea3..0000000
--- a/text/deleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
diff --git a/text/modified.txt b/text/modified.txt
index 564b0bc..0ca2a11 100644
--- a/text/modified.txt
+++ b/text/modified.txt
@@ -2 +2,2 @@ header
-one
+ONE
+TWO
@@ -4 +5 @@ keep
-four
+FOUR
diff --git a/vendor/module b/vendor/module
index e3d0c4f..5722407 160000
--- a/vendor/module
+++ b/vendor/module
@@ -1 +1 @@
-Subproject commit e3d0c4fd804d2b7d0d7172c75223952c6f5d2dab
+Subproject commit 5722407a43ae07675628d6e53ed24d9a4c52d6a8
`;

describe("derivePatchFacts", () => {
  it("derives textual and semantic file-level seeds from a real zero-context Git patch", () => {
    const facts = derivePatchFacts(COMPOSITE_PATCH);

    assert.deepEqual(facts.files as unknown, [
      {
        path: "binary/asset.bin",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: true,
        additions: 0,
        deletions: 0,
      },
      {
        path: "empty/added.txt",
        oldPath: null,
        kind: "added",
        oldMode: null,
        newMode: "100644",
        binary: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "mode/script.sh",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100755",
        binary: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "rename/to.txt",
        oldPath: "rename/from.txt",
        kind: "renamed",
        oldMode: null,
        newMode: null,
        binary: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "symlink/current",
        oldPath: null,
        kind: "modified",
        oldMode: "120000",
        newMode: "120000",
        binary: false,
        additions: 0,
        deletions: 0,
      },
      {
        path: "text/added.txt",
        oldPath: null,
        kind: "added",
        oldMode: null,
        newMode: "100644",
        binary: false,
        additions: 2,
        deletions: 0,
      },
      {
        path: "text/deleted.txt",
        oldPath: null,
        kind: "deleted",
        oldMode: "100644",
        newMode: null,
        binary: false,
        additions: 0,
        deletions: 2,
      },
      {
        path: "text/modified.txt",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: false,
        additions: 3,
        deletions: 2,
      },
      {
        path: "vendor/module",
        oldPath: null,
        kind: "modified",
        oldMode: "160000",
        newMode: "160000",
        binary: false,
        additions: 0,
        deletions: 0,
      },
    ]);
    assert.deepEqual(facts.hunks as unknown, [
      {
        id: "s1",
        path: "binary/asset.bin",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "binary",
      },
      {
        id: "s2",
        path: "empty/added.txt",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "empty",
      },
      {
        id: "s3",
        path: "mode/script.sh",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "mode",
      },
      {
        id: "s4",
        path: "rename/to.txt",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "rename",
      },
      {
        id: "s5",
        path: "symlink/current",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "symlink",
      },
      {
        id: "s6",
        path: "text/added.txt",
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
      },
      {
        id: "s7",
        path: "text/deleted.txt",
        oldStart: 1,
        oldLines: 2,
        newStart: 0,
        newLines: 0,
      },
      {
        id: "s8",
        path: "text/modified.txt",
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 2,
      },
      {
        id: "s9",
        path: "text/modified.txt",
        oldStart: 4,
        oldLines: 1,
        newStart: 5,
        newLines: 1,
      },
      {
        id: "s10",
        path: "vendor/module",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "submodule",
      },
    ]);
  });

  it("handles ordinary spaces, quoted escapes, and marker-looking changed lines", () => {
    const patch = String.raw`diff --git a/empty add b/empty add
new file mode 100644
index 0000000..e69de29
diff --git "a/dir/name\twith-tab.txt" "b/dir/name\twith-tab.txt"
index 3367afd..3e75765 100644
--- "a/dir/name\twith-tab.txt"
+++ "b/dir/name\twith-tab.txt"
@@ -1 +1 @@
-old
+new
diff --git a/marker-like.txt b/marker-like.txt
index c8fa780..2ab3bb0 100644
--- a/marker-like.txt
+++ b/marker-like.txt
@@ -2 +2 @@ stable
--- old header-like
+++ new header-like
`;

    const facts = derivePatchFacts(patch);

    assert.deepEqual(
      facts.files.map((file) => file.path),
      ["dir/name\twith-tab.txt", "empty add", "marker-like.txt"],
    );
    assert.deepEqual(
      facts.hunks.map((hunk) => ({
        path: hunk.path,
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
      })),
      [
        { path: "dir/name\twith-tab.txt", oldStart: 1, newStart: 1 },
        { path: "empty add", oldStart: 0, newStart: 0 },
        { path: "marker-like.txt", oldStart: 2, newStart: 2 },
      ],
    );
  });

  it("keeps zero-length anchors correct when ambient Git config adds inter-hunk context", () => {
    const patch = String.raw`diff --git a/context.txt b/context.txt
index 1111111..2222222 100644
--- a/context.txt
+++ b/context.txt
@@ -1,3 +1,4 @@
 keep one
-old
+new
 keep two
+added
`;

    assert.deepEqual(
      derivePatchFacts(patch).hunks.map((hunk) => ({
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
      })),
      [
        { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
        { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 },
      ],
    );
  });

  it("rejects a decoded path that cannot safely address a run artifact", () => {
    const patch = String.raw`diff --git a/../evil.txt b/../evil.txt
index 3367afd..3e75765 100644
--- a/../evil.txt
+++ b/../evil.txt
@@ -1 +1 @@
-old
+new
`;

    assert.throws(() => derivePatchFacts(patch), "Unsafe repository path");
  });
});
