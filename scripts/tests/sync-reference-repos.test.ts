import { describe, expect, it } from "vitest";

import { REFERENCE_REPOS } from "../lib/reference-repos.ts";
import {
  parseCliOptions,
  planReferenceRepoSync,
  resolveReferenceRepoRef,
  selectRepos,
} from "../sync-reference-repos.ts";

const effectRepo = REFERENCE_REPOS[0];
if (effectRepo === undefined) {
  throw new Error("REFERENCE_REPOS must not be empty for these tests to mean anything.");
}

const readInstalledVersion = () => "4.0.0-beta.106";

describe("parseCliOptions", () => {
  it("reads the repo id, latest and dry-run flags", () => {
    expect(parseCliOptions(["--repo", "effect", "--latest", "--dry-run"])).toEqual({
      repoId: "effect",
      latest: true,
      dryRun: true,
    });
  });

  it("defaults to every repo at the pinned ref", () => {
    expect(parseCliOptions([])).toEqual({ repoId: undefined, latest: false, dryRun: false });
  });
});

describe("selectRepos", () => {
  it("names the valid ids when asked for one that does not exist", () => {
    expect(() => selectRepos("nope")).toThrow(/Unknown reference repo "nope"/);
  });

  it("returns every configured repo when no id is given", () => {
    expect(selectRepos(undefined)).toBe(REFERENCE_REPOS);
  });
});

describe("resolveReferenceRepoRef", () => {
  // The pin is the point: a vendored copy that drifts from the installed
  // dependency is worse than no vendored copy, because it reads as authoritative.
  it("pins to the installed dependency version by default", () => {
    expect(resolveReferenceRepoRef(effectRepo, false, readInstalledVersion)).toBe(
      `${effectRepo.versionTagPrefix}4.0.0-beta.106`,
    );
  });

  it("tracks the default branch with --latest", () => {
    expect(resolveReferenceRepoRef(effectRepo, true, readInstalledVersion)).toBe(
      effectRepo.latestRef,
    );
  });
});

describe("planReferenceRepoSync", () => {
  it("adds a subtree that is not present yet", () => {
    const [plan] = planReferenceRepoSync({
      options: { repoId: effectRepo.id, latest: false, dryRun: true },
      subtreeExists: () => false,
      readInstalledVersion,
    });

    expect(plan?.action).toBe("add");
    expect(plan?.args).toEqual([
      "subtree",
      "add",
      `--prefix=${effectRepo.prefix}`,
      effectRepo.repository,
      `${effectRepo.versionTagPrefix}4.0.0-beta.106`,
      "--squash",
    ]);
  });

  it("pulls a subtree that already exists", () => {
    const [plan] = planReferenceRepoSync({
      options: { repoId: effectRepo.id, latest: false, dryRun: true },
      subtreeExists: () => true,
      readInstalledVersion,
    });

    expect(plan?.action).toBe("pull");
    expect(plan?.args[1]).toBe("pull");
  });

  it("plans one entry per configured repo when no id is given", () => {
    const plans = planReferenceRepoSync({
      options: { repoId: undefined, latest: false, dryRun: true },
      subtreeExists: () => true,
      readInstalledVersion,
    });

    expect(plans).toHaveLength(REFERENCE_REPOS.length);
  });
});
