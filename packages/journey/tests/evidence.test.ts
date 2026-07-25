import { describe, expect, it } from "vitest";

import { downgradeInvalidEvidence, evidenceLinks } from "../src/evidence.ts";

describe("evidence links", () => {
  it("extracts hunk, file, and symbol links from Markdown", () => {
    expect(
      evidenceLinks(
        "See [the change](tl:hunk/h1), [the file](tl:file/src/auth.ts), and [issueToken](tl:symbol/src/auth.ts#issueToken).",
      ),
    ).toEqual([
      { raw: "tl:hunk/h1", kind: "hunk", path: "h1" },
      { raw: "tl:file/src/auth.ts", kind: "file", path: "src/auth.ts" },
      {
        raw: "tl:symbol/src/auth.ts#issueToken",
        kind: "symbol",
        path: "src/auth.ts",
        symbol: "issueToken",
      },
    ]);
  });

  it("downgrades only unresolvable Markdown links to honest plain text", () => {
    expect(
      downgradeInvalidEvidence(
        "Keep [this](tl:hunk/h1), drop [that](tl:hunk/missing).",
        new Set(["tl:hunk/missing"]),
      ),
    ).toBe("Keep [this](tl:hunk/h1), drop that.");
  });
});
