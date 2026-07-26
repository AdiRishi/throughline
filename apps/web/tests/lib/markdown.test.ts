/**
 * The evidence link is the product's central claim made clickable, so what the
 * parser accepts and refuses is worth pinning precisely.
 */
import { describe, expect, it } from "vitest";

import { parseEvidenceHref } from "../../src/lib/markdown.tsx";

describe("parseEvidenceHref", () => {
  it("reads the three tl: forms", () => {
    expect(parseEvidenceHref("tl:hunk/h12")).toEqual({ kind: "hunk", hunkId: "h12" });
    expect(parseEvidenceHref("tl:file/src/auth/token.ts")).toEqual({
      kind: "file",
      path: "src/auth/token.ts",
    });
    expect(parseEvidenceHref("tl:symbol/src/auth/token.ts#issueToken")).toEqual({
      kind: "symbol",
      path: "src/auth/token.ts",
      symbol: "issueToken",
    });
  });

  it("keeps a split hunk's dotted id intact", () => {
    expect(parseEvidenceHref("tl:hunk/h12.2")).toEqual({ kind: "hunk", hunkId: "h12.2" });
  });

  it("drops sentence punctuation that is not part of the target", () => {
    expect(parseEvidenceHref("tl:file/src/a.ts.")).toEqual({ kind: "file", path: "src/a.ts" });
  });

  it("degrades a symbol link with no symbol to its file", () => {
    expect(parseEvidenceHref("tl:symbol/src/a.ts")).toEqual({ kind: "file", path: "src/a.ts" });
  });

  it("refuses anything that is not a tl: URI", () => {
    expect(parseEvidenceHref("https://github.com/a/b/pull/1")).toBeNull();
    expect(parseEvidenceHref("tl:unknown/thing")).toBeNull();
    expect(parseEvidenceHref("#anchor")).toBeNull();
  });
});
