import { assert, describe, it } from "@effect/vitest";

import type { Journey } from "@app/contracts";

import { validateJourneyReferences } from "../src/coverage.ts";
import { findEvidenceLinks, parseEvidenceLink, validateEvidenceLinks } from "../src/evidence.ts";
import { makeJourney, pinnedFile } from "./fixtures.ts";

describe("evidence link parsing", () => {
  it("finds inline, autolink, and reference-definition destinations but ignores prose and code", () => {
    const markdown = [
      "[hunk](tl:hunk/h1)",
      '[file](<tl:file/src%2Fa.ts> "source")',
      "<tl:symbol/src%2Fa.ts#alpha>",
      "[reference]: tl:file/src%2Fb.ts",
      "Plain tl:hunk/missing is not a Markdown link.",
      "`[code](tl:hunk/missing)`",
    ].join("\n");

    const links = findEvidenceLinks(markdown);

    assert.deepEqual(
      links.map((located) => (located.result.ok ? located.result.link.uri : located.result.uri)),
      ["tl:hunk/h1", "tl:file/src%2Fa.ts", "tl:symbol/src%2Fa.ts#alpha", "tl:file/src%2Fb.ts"],
    );
  });

  it("percent-decodes valid paths and rejects malformed or unsafe encoded paths", () => {
    const parsed = parseEvidenceLink("tl:file/src%2Fspace%20name.ts");
    assert.isTrue(parsed.ok);
    if (parsed.ok) {
      assert.strictEqual(parsed.link.kind, "file");
      if (parsed.link.kind === "file") {
        assert.strictEqual(parsed.link.path, "src/space name.ts");
      }
    }
    assert.deepEqual(parseEvidenceLink("tl:file/src%2F..%2Fsecret"), {
      ok: false,
      uri: "tl:file/src%2F..%2Fsecret",
      message: "Invalid file evidence URI: tl:file/src%2F..%2Fsecret",
    });
    assert.deepEqual(parseEvidenceLink("tl:file/src%2Fbad%E0%A4"), {
      ok: false,
      uri: "tl:file/src%2Fbad%E0%A4",
      message: "Invalid file evidence URI: tl:file/src%2Fbad%E0%A4",
    });
  });
});

describe("evidence resolution", () => {
  it("resolves hunk, head-file, and exact case-sensitive head-symbol links", () => {
    const markdown = [
      "[hunk](tl:hunk/h1)",
      "[file](tl:file/src%2Fa.ts)",
      "[symbol](tl:symbol/src%2Fa.ts#alpha)",
    ].join(" ");

    assert.deepEqual(
      validateEvidenceLinks(markdown, {
        hunkIds: new Set(["h1"]),
        pinnedFile,
      }),
      [],
    );
  });

  it("reports unknown hunks, deleted head files, and absent symbols independently", () => {
    const deletedHead = (path: string) =>
      path === "deleted.ts" ? { old: "export const old = 1", new: null } : pinnedFile(path);
    const markdown = [
      "[hunk](tl:hunk/h404)",
      "[file](tl:file/deleted.ts)",
      "[symbol](tl:symbol/src%2Fa.ts#Alpha)",
      "[malformed](tl:symbol/src%2Fa.ts)",
    ].join(" ");

    assert.deepEqual(
      validateEvidenceLinks(markdown, {
        hunkIds: new Set(["h1"]),
        pinnedFile: deletedHead,
      }).map((violation) => violation.code),
      [
        "evidence-hunk-missing",
        "evidence-file-missing",
        "evidence-symbol-missing",
        "evidence-invalid-uri",
      ],
    );
  });
});

describe("hint reference validation", () => {
  it("rejects an out-of-range anchor in an otherwise valid pinned text file", () => {
    const base = makeJourney();
    const journey = {
      ...base,
      hints: [
        {
          ...base.hints[0]!,
          anchor: {
            ...base.hints[0]!.anchor,
            path: "src/a.ts",
            startLine: 21,
            endLine: 22,
          },
        },
      ],
    } as unknown as Journey;

    assert.deepEqual(
      validateJourneyReferences(journey, pinnedFile).map((violation) => violation.code),
      ["hint-anchor-out-of-range"],
    );
  });
});
