import { describe, expect, it } from "vitest";

import type {
  FileChange,
  FileLevelHunkKind,
  IngestionJob,
  Journey,
  ReadState,
  RepositoryPath,
} from "@app/contracts";

import {
  changedRegionsForPath,
  codeModeLineAnchor,
  countHeadLines,
  deriveIngestionStages,
  deriveJourneyViewModel,
  describeFileLevelChange,
  fileHomes,
  findSymbolLine,
  isClusterHomePath,
  journeyWasReplaced,
  parsePrRouteParams,
  resolveClusterRoute,
  resolveEvidenceTarget,
  resolveFileRoute,
} from "../../../src/features/journey/model.ts";

const makeJourney = (): Journey =>
  ({
    formatVersion: 1,
    id: "journey-1",
    pr: { owner: "throughline", repo: "console", number: 418 },
    pinned: {
      headSha: "2".repeat(40),
      baseSha: "1".repeat(40),
      analyzedAt: "2026-07-25T00:00:00.000Z",
    },
    provenance: { harnessKind: "codex" },
    overview: {
      brief: { markdown: "Adds authentication." },
      whereToBegin: { markdown: "Begin with the foundation." },
    },
    clusters: [
      {
        id: "c1",
        position: 1,
        title: "Foundation",
        weight: "core",
        narrative: { markdown: "Builds the foundation." },
        mapEntry: { markdown: "Builds the foundation." },
        buildsOn: [],
        fileOrder: ["src/auth.ts", "deleted.ts"],
        resurfaced: [],
      },
      {
        id: "c2",
        position: 2,
        title: "Binding",
        weight: "supporting",
        narrative: { markdown: "Binds the feature." },
        mapEntry: { markdown: "Binds the feature." },
        buildsOn: ["c1"],
        fileOrder: ["src/auth.ts", "asset.bin"],
        resurfaced: [{ hunkId: "h1", note: { markdown: "Shows the foundation again." } }],
      },
    ],
    hunks: [
      {
        id: "h1",
        path: "src/auth.ts",
        oldStart: 10,
        oldLines: 2,
        newStart: 10,
        newLines: 3,
        seedId: "s1",
        home: "c1",
      },
      {
        id: "h2",
        path: "src/auth.ts",
        oldStart: 20,
        oldLines: 0,
        newStart: 21,
        newLines: 1,
        seedId: "s2",
        home: "c1",
      },
      {
        id: "h3",
        path: "deleted.ts",
        oldStart: 4,
        oldLines: 2,
        newStart: 4,
        newLines: 0,
        seedId: "s3",
        home: "c1",
      },
      {
        id: "h4",
        path: "src/auth.ts",
        oldStart: 30,
        oldLines: 1,
        newStart: 30,
        newLines: 2,
        seedId: "s4",
        home: "c2",
      },
      {
        id: "h5",
        path: "asset.bin",
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        fileKind: "binary",
        seedId: "s5",
        home: "c2",
      },
    ],
    files: [
      {
        path: "src/auth.ts",
        oldPath: null,
        kind: "modified",
        oldMode: "100644",
        newMode: "100644",
        binary: false,
        additions: 6,
        deletions: 3,
      },
      {
        path: "deleted.ts",
        oldPath: null,
        kind: "deleted",
        oldMode: "100644",
        newMode: null,
        binary: false,
        additions: 0,
        deletions: 2,
      },
      {
        path: "asset.bin",
        oldPath: null,
        kind: "added",
        oldMode: null,
        newMode: "100644",
        binary: true,
        additions: 0,
        deletions: 0,
      },
    ],
    hints: [],
  }) as unknown as Journey;

const readState = (readFiles: ReadState["readFiles"], journeyId = "journey-1"): ReadState =>
  ({
    journeyId,
    readFiles,
    displayMode: "inline",
    updatedAt: "2026-07-25T00:00:00.000Z",
  }) as unknown as ReadState;

const ingestionJob = (phase: IngestionJob["phase"], input?: Partial<IngestionJob>): IngestionJob =>
  ({
    id: "job-1",
    pr: { owner: "throughline", repo: "console", number: 418 },
    phase,
    queuePosition: null,
    startedAt: "2026-07-25T00:00:00.000Z",
    updatedAt: "2026-07-25T00:01:00.000Z",
    activity: null,
    journeyId: null,
    failure: null,
    ...input,
  }) as unknown as IngestionJob;

describe("parsePrRouteParams", () => {
  it("accepts only canonical route values that satisfy the PR contract", () => {
    expect(parsePrRouteParams({ owner: "openai", repo: "codex", number: "418" })).toEqual({
      owner: "openai",
      repo: "codex",
      number: 418,
    });

    for (const params of [
      { owner: " openai", repo: "codex", number: "418" },
      { owner: "openai/team", repo: "codex", number: "418" },
      { owner: "openai", repo: "..", number: "418" },
      { owner: "openai", repo: "codex", number: "0418" },
      { owner: "openai", repo: "codex", number: "0" },
      { owner: "openai", repo: "codex", number: "1.5" },
      { owner: "openai", repo: "codex", number: String(Number.MAX_SAFE_INTEGER + 1) },
      { owner: "openai", repo: "codex", number: 418 },
    ]) {
      expect(parsePrRouteParams(params)).toBeNull();
    }
  });
});

describe("journey view model", () => {
  it("derives hunk-weighted progress and stable home mappings", () => {
    const journey = makeJourney();
    const state = readState([
      { clusterId: "c1", path: "src/auth.ts" },
      { clusterId: "c2", path: "asset.bin" },
    ] as unknown as ReadState["readFiles"]);

    const view = deriveJourneyViewModel(journey, state);

    expect(view.progress).toMatchObject({
      readHunks: 3,
      totalHunks: 5,
      fraction: 0.6,
      markedFiles: 2,
      clusterFiles: 4,
      complete: false,
    });
    expect(view.clusters[0]).toMatchObject({
      progress: {
        readHunks: 2,
        totalHunks: 3,
        fraction: 2 / 3,
        markedFiles: 1,
        clusterFiles: 2,
      },
      touchedFileCount: 2,
    });
    expect(view.clusters[1]).toMatchObject({
      progress: {
        readHunks: 1,
        totalHunks: 2,
        fraction: 0.5,
        markedFiles: 1,
        clusterFiles: 2,
      },
      touchedFileCount: 2,
    });
    expect(
      view.changedFileByPath
        .get("src/auth.ts" as RepositoryPath)
        ?.homes.map(({ cluster, hunks }) => [cluster.id, hunks.map((hunk) => hunk.id)]),
    ).toEqual([
      ["c1", ["h1", "h2"]],
      ["c2", ["h4"]],
    ]);
    expect(
      fileHomes(journey, "src/auth.ts" as RepositoryPath).map(({ cluster }) => cluster.id),
    ).toEqual(["c1", "c2"]);
    expect(
      isClusterHomePath(journey, journey.clusters[0]!.id, "deleted.ts" as RepositoryPath),
    ).toBe(true);
    expect(
      isClusterHomePath(journey, journey.clusters[1]!.id, "deleted.ts" as RepositoryPath),
    ).toBe(false);
  });

  it("ignores read marks belonging to a replaced journey", () => {
    const view = deriveJourneyViewModel(
      makeJourney(),
      readState(
        [{ clusterId: "c1", path: "src/auth.ts" }] as unknown as ReadState["readFiles"],
        "journey-2",
      ),
    );

    expect(view.progress.readHunks).toBe(0);
    expect(view.progress.fraction).toBe(0);
  });
});

describe("route resolution", () => {
  it("resolves exact clusters, unchanged tree files, and deleted changed files", () => {
    const journey = makeJourney();
    const tree = ["README.md", "src/auth.ts", "asset.bin"] as RepositoryPath[];

    expect(resolveClusterRoute(journey, "c2")?.title).toBe("Binding");
    expect(resolveClusterRoute(journey, "C2")).toBeNull();
    expect(resolveFileRoute(journey, tree, "README.md")).toEqual({
      path: "README.md",
      change: null,
      homes: [],
    });
    expect(resolveFileRoute(journey, tree, "deleted.ts")).toMatchObject({
      path: "deleted.ts",
      change: { kind: "deleted" },
    });
    expect(resolveFileRoute(journey, tree, "../README.md")).toBeNull();
    expect(resolveFileRoute(journey, tree, "missing.ts")).toBeNull();
  });

  it("distinguishes a refreshed document from a replacement journey", () => {
    const firstJourneyId = makeJourney().id;
    const replacementJourneyId = {
      ...makeJourney(),
      id: "journey-2",
    } as unknown as Journey;

    expect(journeyWasReplaced(null, firstJourneyId)).toBe(false);
    expect(journeyWasReplaced(firstJourneyId, firstJourneyId)).toBe(false);
    expect(journeyWasReplaced(firstJourneyId, replacementJourneyId.id)).toBe(true);
  });
});

describe("evidence navigation", () => {
  it("routes hunk links through their home and file and symbol links through free reading", () => {
    const journey = makeJourney();

    expect(resolveEvidenceTarget(journey, "tl:hunk/h3")).toEqual({
      kind: "hunk",
      uri: "tl:hunk/h3",
      hunkId: "h3",
      clusterId: "c1",
      path: "deleted.ts",
      anchor: {
        side: "old",
        startLine: 4,
        endLine: 5,
      },
    });
    expect(resolveEvidenceTarget(journey, "tl:file/src%2Fauth.ts")).toEqual({
      kind: "file",
      uri: "tl:file/src%2Fauth.ts",
      path: "src/auth.ts",
    });
    expect(resolveEvidenceTarget(journey, "tl:symbol/src%2Fauth.ts#authorize")).toEqual({
      kind: "symbol",
      uri: "tl:symbol/src%2Fauth.ts#authorize",
      path: "src/auth.ts",
      symbol: "authorize",
    });
    expect(resolveEvidenceTarget(journey, "tl:hunk/h404")).toBeNull();
    expect(resolveEvidenceTarget(journey, "tl:file/src%2F..%2Fsecret")).toBeNull();
  });
});

describe("changed region anchors", () => {
  it("keeps both sides while preferring the head side for navigation", () => {
    const regions = changedRegionsForPath(makeJourney(), "src/auth.ts" as RepositoryPath);

    expect(regions).toMatchObject([
      {
        hunkId: "h1",
        oldRange: { side: "old", startLine: 10, endLine: 11 },
        newRange: { side: "new", startLine: 10, endLine: 12 },
        navigation: { side: "new", startLine: 10, endLine: 12 },
      },
      {
        hunkId: "h2",
        oldRange: null,
        newRange: { side: "new", startLine: 21, endLine: 21 },
      },
      {
        hunkId: "h4",
        oldRange: { side: "old", startLine: 30, endLine: 30 },
        newRange: { side: "new", startLine: 30, endLine: 31 },
      },
    ]);
    expect(changedRegionsForPath(makeJourney(), "asset.bin" as RepositoryPath)[0]).toMatchObject({
      fileKind: "binary",
      oldRange: null,
      newRange: null,
      navigation: null,
    });
  });

  it("anchors deletion-only regions to the nearest surviving head line", () => {
    const deletion = makeJourney().hunks[2]!;

    expect(codeModeLineAnchor(deletion, 20)).toBe(4);
    expect(codeModeLineAnchor({ ...deletion, newStart: 30 } as typeof deletion, 12)).toBe(12);
    expect(codeModeLineAnchor({ ...deletion, newStart: 0 } as typeof deletion, 12)).toBe(1);
    expect(codeModeLineAnchor(deletion, 0)).toBeNull();
    expect(countHeadLines("first\nsecond\n")).toBe(2);
    expect(countHeadLines("")).toBe(0);
    expect(countHeadLines(null)).toBe(0);
    expect(findSymbolLine("const first = 1;\nfunction authorize() {}\n", "authorize")).toBe(2);
    expect(findSymbolLine("const first = 1;\n", "authorize")).toBeNull();
  });
});

describe("ingestion stage derivation", () => {
  it("groups only observed pipeline phases and carries live activity through unchanged", () => {
    const activity = {
      stage: "narrating",
      currentAction: "Writing the binding narrative",
      currentFile: "src/auth.ts",
      recentActions: ["Read the foundation"],
      counters: { filesWalked: 8, symbolsTraced: 5, callSitesFollowed: 3 },
    } as unknown as IngestionJob["activity"];

    expect(
      deriveIngestionStages(ingestionJob("queued", { startedAt: null, queuePosition: 2 })),
    ).toMatchObject({
      outcome: "queued",
      queuePosition: 2,
      stages: [{ state: "queued" }, { state: "pending" }, { state: "pending" }],
    });
    expect(deriveIngestionStages(ingestionJob("diffing"))).toMatchObject({
      outcome: "running",
      stages: [{ state: "complete" }, { state: "active" }, { state: "pending" }],
    });
    expect(deriveIngestionStages(ingestionJob("analyzing", { activity }))).toMatchObject({
      outcome: "running",
      activity,
      stages: [{ state: "complete" }, { state: "complete" }, { state: "active" }],
    });
    expect(deriveIngestionStages(ingestionJob("complete"))).toMatchObject({
      outcome: "complete",
      stages: [{ state: "complete" }, { state: "complete" }, { state: "complete" }],
    });
  });

  it("does not invent the stage at which a terminal operational outcome happened", () => {
    const failed = deriveIngestionStages(
      ingestionJob("failed", {
        failure: { code: "clone", message: "The repository could not be cloned." },
      }),
    );
    const cancelledBeforeStart = deriveIngestionStages(
      ingestionJob("cancelled", { startedAt: null }),
    );

    expect(failed.outcome).toBe("failed");
    expect(failed.stages.map(({ state }) => state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(cancelledBeforeStart.stages.map(({ state }) => state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
  });
});

describe("file-level presentation", () => {
  const change = (kind: FileChange["kind"], input?: Partial<FileChange>): FileChange =>
    ({
      path: "new.bin",
      oldPath: null,
      kind,
      oldMode: "100644",
      newMode: "100644",
      binary: false,
      additions: 0,
      deletions: 0,
      ...input,
    }) as FileChange;

  it("names non-textual changes without implying textual content", () => {
    const cases: ReadonlyArray<readonly [FileLevelHunkKind, FileChange, string]> = [
      ["binary", change("added"), "Binary file added"],
      [
        "rename",
        change("renamed", { oldPath: "old.bin" as RepositoryPath }),
        "File renamed from old.bin to new.bin",
      ],
      [
        "mode",
        change("modified", { oldMode: "100644", newMode: "100755" }),
        "File mode changed from 100644 to 100755",
      ],
      ["symlink", change("modified"), "Symbolic link changed"],
      ["submodule", change("modified"), "Submodule updated"],
      ["empty", change("deleted"), "Empty file deleted"],
    ];

    for (const [fileKind, file, label] of cases) {
      expect(describeFileLevelChange(fileKind, file)).toBe(label);
    }
  });
});
