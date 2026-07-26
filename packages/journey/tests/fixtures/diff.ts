/**
 * A real git diff, captured from a scratch repository built to exercise every
 * change kind Throughline must place: a line edit, a pure insertion, an added
 * file, a deleted file, a pure rename, a mode-only change, a binary change, an
 * empty added file, and a path containing a space (which git disambiguates
 * with a trailing tab on the `---`/`+++` lines).
 *
 * Captured with:
 *   git -c core.quotePath=false diff --raw -z -M base..head
 *   git -c core.quotePath=false diff -U0 -M base..head
 */

export const RAW_DIFF = [
  ":100644 100644 422c2b7 55dce13 M\0dir with space/odd name.txt\0",
  ":000000 100644 0000000 e69de29 A\0empty-added.txt\0",
  ":100644 000000 4202011 0000000 D\0goodbye.txt\0",
  ":100644 100644 9a96c02 0e624e9 M\0logo.png\0",
  ":100644 100755 4163036 4163036 M\0script.sh\0",
  ":100644 100644 33194a0 33194a0 R100\0src/auth/legacy.ts\0src/auth/renamed.ts\0",
  ":100644 100644 b3c5a95 1a2eac8 M\0src/auth/token.ts\0",
  ":000000 100644 0000000 4e2cfed A\0src/pages/login.tsx\0",
].join("");

export const ZERO_CONTEXT_PATCH = `diff --git a/dir with space/odd name.txt b/dir with space/odd name.txt
index 422c2b7..55dce13 100644
--- a/dir with space/odd name.txt\t
+++ b/dir with space/odd name.txt\t
@@ -2 +2 @@ a
-b
+B
diff --git a/empty-added.txt b/empty-added.txt
new file mode 100644
index 0000000..e69de29
diff --git a/goodbye.txt b/goodbye.txt
deleted file mode 100644
index 4202011..0000000
--- a/goodbye.txt
+++ /dev/null
@@ -1 +0,0 @@
-to be deleted
diff --git a/logo.png b/logo.png
index 9a96c02..0e624e9 100644
Binary files a/logo.png and b/logo.png differ
diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/src/auth/legacy.ts b/src/auth/renamed.ts
similarity index 100%
rename from src/auth/legacy.ts
rename to src/auth/renamed.ts
diff --git a/src/auth/token.ts b/src/auth/token.ts
index b3c5a95..1a2eac8 100644
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -2 +2 @@ line1
-line2
+CHANGED2
@@ -4,0 +5 @@ line4
+NEW4.5
@@ -5,0 +7 @@ line5
+line6
diff --git a/src/pages/login.tsx b/src/pages/login.tsx
new file mode 100644
index 0000000..4e2cfed
--- /dev/null
+++ b/src/pages/login.tsx
@@ -0,0 +1,2 @@
+new file
+contents
`;
