import * as DateTime from "effect/DateTime";

import type { Cluster, ClusterId, Hunk, HunkId, Journey, ReadState } from "@app/contracts";

import type { PinnedTree } from "../src/coverage.ts";

/**
 * Shared fixtures for the journey domain tests. `SAMPLE_DIFF` deliberately
 * contains one of every shape the parser has to survive: a new file, an
 * insertion and a replacement in one file, a binary change, a pure rename, a
 * chmod, a deletion, and a C-quoted path.
 */
export const SAMPLE_DIFF = `diff --git a/src/auth/session.ts b/src/auth/session.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/auth/session.ts
@@ -0,0 +1,3 @@
+export class SessionStore {
+  current() { return null; }
+}
diff --git a/src/app/router.tsx b/src/app/router.tsx
index 2222222..3333333 100644
--- a/src/app/router.tsx
+++ b/src/app/router.tsx
@@ -3,0 +4,1 @@ import { routeTree } from "./routes";
+import { requireSession } from "../routes/guards";
@@ -20,1 +21,1 @@ export const router = createRouter({
-  defaultPreload: "none",
+  defaultPreload: "intent",
diff --git a/docs/logo.png b/docs/logo.png
index 4444444..5555555 100644
Binary files a/docs/logo.png and b/docs/logo.png differ
diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts
diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 6666666..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = true;
-export default gone;
diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
new file mode 100644
index 0000000..7777777
--- /dev/null
+++ "b/src/caf\\303\\251.ts"
@@ -0,0 +1,1 @@
+export const cafe = true;
`;

export const FIXED_INSTANT = DateTime.makeUnsafe("2026-07-25T12:00:00.000Z");

export const hunkId = (value: string): HunkId => value as HunkId;
export const clusterId = (value: string): ClusterId => value as ClusterId;

export function makeCluster(
  overrides: Partial<Cluster> & Pick<Cluster, "id" | "position">,
): Cluster {
  return {
    title: `Cluster ${overrides.position}`,
    weight: "core",
    narrative: { markdown: "What this step does." },
    mapEntry: { markdown: "Compressed account." },
    buildsOn: [],
    fileOrder: [],
    resurfaced: [],
    ...overrides,
  };
}

export function makeHunk(overrides: Partial<Hunk> & Pick<Hunk, "id" | "path" | "home">): Hunk {
  return {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 1,
    seedId: overrides.id,
    ...overrides,
  };
}

export function treeOf(input: {
  readonly paths?: ReadonlyArray<string>;
  readonly lineCounts?: Record<string, { old: number; new: number }>;
  readonly symbols?: Record<string, ReadonlyArray<string>>;
}): PinnedTree {
  const lineCounts = new Map(Object.entries(input.lineCounts ?? {}));
  return {
    paths: new Set(input.paths ?? Object.keys(input.lineCounts ?? {})),
    lineCounts,
    fileContains: (path, symbol) => (input.symbols?.[path] ?? []).includes(symbol),
  };
}

/** A pinned tree that accepts nothing — the strict case for evidence tests. */
export const emptyTree: PinnedTree = treeOf({});

export function makeJourney(
  overrides: Partial<Journey> & Pick<Journey, "clusters" | "hunks">,
): Journey {
  return {
    formatVersion: 1,
    id: "j1" as Journey["id"],
    pr: { owner: "meridian", repo: "console", number: 418 },
    prWords: {
      title: "Add authentication",
      body: "",
      author: "mara",
      url: "https://github.com/meridian/console/pull/418",
      createdAt: FIXED_INSTANT,
    },
    pinned: {
      headSha: "f47c19d",
      baseSha: "a1b2c3f",
      baseRef: "main",
      analyzedAt: FIXED_INSTANT,
    },
    provenance: { harnessKind: "claude", fallbacks: [] },
    overview: {
      brief: { markdown: "The change, in brief." },
      whereToBegin: { markdown: "Start at 1." },
      attention: [],
    },
    files: [],
    hints: [],
    ...overrides,
  };
}

export function makeReadState(
  journeyId: string,
  marks: ReadonlyArray<{ readonly clusterId: string; readonly path: string }>,
): ReadState {
  return {
    journeyId: journeyId as ReadState["journeyId"],
    readFiles: marks.map((mark) => ({
      clusterId: clusterId(mark.clusterId),
      path: mark.path,
    })),
    displayMode: "inline",
    updatedAt: FIXED_INSTANT,
  };
}
