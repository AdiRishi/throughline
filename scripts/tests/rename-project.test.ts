import { describe, expect, it } from "vitest";

import {
  isKebabCase,
  isProbablyBinary,
  isReverseDns,
  isSweepableFile,
  parseCliOptions,
  type RenameTargets,
  renameContent,
  renamePath,
  toTitle,
} from "../rename-project.ts";

const TARGETS: RenameTargets = {
  kebab: "my-app",
  title: "My App",
  appId: "com.mycompany.my-app",
};

describe("toTitle", () => {
  it("title-cases a kebab name", () => {
    expect(toTitle("my-cool-app")).toBe("My Cool App");
  });

  it("handles a single word", () => {
    expect(toTitle("notes")).toBe("Notes");
  });

  it("keeps digits inside words", () => {
    expect(toTitle("app-2go")).toBe("App 2go");
  });
});

describe("isReverseDns", () => {
  it("accepts dot-separated lowercase segments", () => {
    expect(isReverseDns("com.mycompany")).toBe(true);
    expect(isReverseDns("io.github.arishi")).toBe(true);
  });

  it("rejects single segments, uppercase, and stray dots", () => {
    expect(isReverseDns("com")).toBe(false);
    expect(isReverseDns("Com.MyCompany")).toBe(false);
    expect(isReverseDns(".com.foo")).toBe(false);
    expect(isReverseDns("com.")).toBe(false);
    expect(isReverseDns("com..foo")).toBe(false);
    expect(isReverseDns("")).toBe(false);
  });
});

describe("isKebabCase", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(isKebabCase("my-cool-app")).toBe(true);
    expect(isKebabCase("notes")).toBe(true);
    expect(isKebabCase("app2")).toBe(true);
  });

  it("rejects uppercase, leading digits, and stray hyphens", () => {
    expect(isKebabCase("MyApp")).toBe(false);
    expect(isKebabCase("2fast")).toBe(false);
    expect(isKebabCase("-app")).toBe(false);
    expect(isKebabCase("app-")).toBe(false);
    expect(isKebabCase("a--b")).toBe(false);
    expect(isKebabCase("")).toBe(false);
  });
});

describe("isSweepableFile", () => {
  it("excludes the vendored reference subtree", () => {
    // `.repos/` is read-only reference material (see .repos/AGENTS.md) and is
    // the overwhelming majority of `git ls-files` output.
    expect(isSweepableFile(".repos/effect/packages/effect/src/Effect.ts")).toBe(false);
    expect(isSweepableFile(".repos/AGENTS.md")).toBe(false);
  });

  it("excludes the lockfile and empty lines", () => {
    expect(isSweepableFile("pnpm-lock.yaml")).toBe(false);
    expect(isSweepableFile("")).toBe(false);
  });

  it("includes ordinary tracked files", () => {
    expect(isSweepableFile("package.json")).toBe(true);
    expect(isSweepableFile("apps/desktop/src/main.ts")).toBe(true);
    expect(isSweepableFile("docs/brand/favicon/throughline-icon-64.png")).toBe(true);
  });

  it("does not exclude a real path that merely starts like the vendored one", () => {
    expect(isSweepableFile(".reposition/notes.md")).toBe(true);
  });
});

describe("renameContent", () => {
  it("replaces the app id before the kebab name it contains", () => {
    expect(renameContent("com.arsoftware.throughline", TARGETS)).toBe("com.mycompany.my-app");
  });

  it("replaces the kebab name and the title", () => {
    expect(renameContent("throughline is Throughline", TARGETS)).toBe("my-app is My App");
  });

  it("leaves unrelated text alone", () => {
    expect(renameContent("nothing to see", TARGETS)).toBe("nothing to see");
  });
});

describe("renamePath", () => {
  it("renames the tracked brand assets that embed the project name", () => {
    expect(renamePath("docs/brand/favicon/throughline-icon-64.png", TARGETS)).toBe(
      "docs/brand/favicon/my-app-icon-64.png",
    );
    expect(renamePath("docs/brand/throughline-logo-dark.png", TARGETS)).toBe(
      "docs/brand/my-app-logo-dark.png",
    );
  });

  it("renames directory segments too", () => {
    expect(renamePath("packages/throughline/src/index.ts", TARGETS)).toBe(
      "packages/my-app/src/index.ts",
    );
  });

  it("returns undefined when the path does not embed the name", () => {
    expect(renamePath("package.json", TARGETS)).toBeUndefined();
  });

  it("keeps t3.json's icon pointer resolvable by using the same replacements as the content sweep", () => {
    const pointer = "docs/brand/favicon/throughline-icon-64.png";
    expect(renameContent(pointer, TARGETS)).toBe(renamePath(pointer, TARGETS));
  });
});

describe("isProbablyBinary", () => {
  it("detects a NUL byte", () => {
    expect(isProbablyBinary(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))).toBe(true);
  });

  it("treats text as text", () => {
    expect(isProbablyBinary(new TextEncoder().encode("export const a = 1;\n"))).toBe(false);
  });

  it("treats an empty file as text", () => {
    expect(isProbablyBinary(new Uint8Array())).toBe(false);
  });
});

describe("parseCliOptions", () => {
  it("reads the two positional arguments", () => {
    expect(parseCliOptions(["my-app", "com.mycompany"])).toEqual({
      kebab: "my-app",
      appIdPrefix: "com.mycompany",
      dryRun: false,
    });
  });

  it("recognises --dry-run in any position", () => {
    expect(parseCliOptions(["--dry-run", "my-app", "com.mycompany"]).dryRun).toBe(true);
    expect(parseCliOptions(["my-app", "com.mycompany", "--dry-run"]).dryRun).toBe(true);
  });

  it("does not mistake a flag for a positional argument", () => {
    expect(parseCliOptions(["--dry-run"]).kebab).toBeUndefined();
  });
});
