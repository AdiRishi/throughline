import { assert, describe, it } from "@effect/vitest";

import {
  downgradeUnresolvableLinks,
  extractEvidenceLinks,
  makeEvidenceContext,
  resolveEvidenceLink,
} from "../src/evidence.ts";

const context = makeEvidenceContext({
  hunkIds: ["h1", "h4"],
  treePaths: ["src/auth/token.ts", "src/ui/login.tsx"],
  lineCounts: [["src/auth/token.ts", { old: 10, new: 12 }]],
  containsSymbol: (path, symbol) => path === "src/auth/token.ts" && symbol === "issueToken",
});

describe("extractEvidenceLinks", () => {
  it("reads all three forms out of a Markdown link, an autolink, and bare text", () => {
    const markdown =
      "[the migration](tl:hunk/h1) and <tl:file/src/ui/login.tsx> and tl:symbol/src/auth/token.ts#issueToken";
    assert.deepEqual(
      extractEvidenceLinks(markdown).map((link) => link.kind),
      ["hunk", "file", "symbol"],
    );
  });

  it("does not swallow trailing sentence punctuation", () => {
    const [link] = extractEvidenceLinks("see tl:file/src/ui/login.tsx.");
    assert.deepEqual(link, {
      kind: "file",
      raw: "tl:file/src/ui/login.tsx.",
      path: "src/ui/login.tsx",
    });
  });

  it("stops at a closing paren so a Markdown link target is exact", () => {
    const [link] = extractEvidenceLinks("([a](tl:hunk/h4))");
    assert.deepEqual(link, { kind: "hunk", raw: "tl:hunk/h4", hunkId: "h4" });
  });

  it("keeps a symbol link with no symbol, so the validator can reject it", () => {
    const [link] = extractEvidenceLinks("tl:symbol/src/auth/token.ts");
    assert.deepEqual(link, {
      kind: "symbol",
      raw: "tl:symbol/src/auth/token.ts",
      path: "src/auth/token.ts",
      symbol: "",
    });
    assert.isFalse(resolveEvidenceLink(link!, context));
  });

  it("finds nothing in prose with no evidence", () => {
    assert.deepEqual(extractEvidenceLinks("just words, and a stray tl: colon"), []);
  });
});

describe("resolveEvidenceLink", () => {
  it("resolves a hunk, a file, and a symbol that actually occurs", () => {
    const [hunkLink] = extractEvidenceLinks("tl:hunk/h1");
    const [fileLink] = extractEvidenceLinks("tl:file/src/auth/token.ts");
    const [symbolLink] = extractEvidenceLinks("tl:symbol/src/auth/token.ts#issueToken");
    assert.isTrue(resolveEvidenceLink(hunkLink!, context));
    assert.isTrue(resolveEvidenceLink(fileLink!, context));
    assert.isTrue(resolveEvidenceLink(symbolLink!, context));
  });

  it("refuses a symbol in the wrong file", () => {
    const [link] = extractEvidenceLinks("tl:symbol/src/ui/login.tsx#issueToken");
    assert.isFalse(resolveEvidenceLink(link!, context));
  });
});

describe("downgradeUnresolvableLinks", () => {
  it("keeps resolvable links untouched", () => {
    const markdown = "[the token work](tl:hunk/h1) is first.";
    const result = downgradeUnresolvableLinks(markdown, context);
    assert.strictEqual(result.markdown, markdown);
    assert.deepEqual(result.downgraded, []);
  });

  it("flattens a Markdown link to its label and records the loss", () => {
    const result = downgradeUnresolvableLinks("[the migration](tl:hunk/h99) came first.", context);
    assert.strictEqual(result.markdown, "the migration came first.");
    assert.deepEqual(result.downgraded, ["tl:hunk/h99"]);
  });

  it("flattens an autolink and a bare link to readable text", () => {
    const result = downgradeUnresolvableLinks(
      "see <tl:file/missing.ts> and tl:symbol/src/auth/token.ts#nope",
      context,
    );
    assert.strictEqual(result.markdown, "see missing.ts and nope");
    assert.strictEqual(result.downgraded.length, 2);
  });

  it("downgrades only the failing link in mixed prose", () => {
    const result = downgradeUnresolvableLinks(
      "[good](tl:hunk/h1) then [bad](tl:hunk/h99).",
      context,
    );
    assert.strictEqual(result.markdown, "[good](tl:hunk/h1) then bad.");
  });
});
