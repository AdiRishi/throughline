import { assert, describe, it } from "@effect/vitest";

import {
  downgradeEvidenceLink,
  downgradeUnresolvableLinks,
  extractEvidenceLinks,
  parseEvidenceUri,
} from "../src/evidence.ts";

describe("parseEvidenceUri", () => {
  it("parses a hunk link", () => {
    assert.deepEqual(parseEvidenceUri("tl:hunk/h12"), {
      kind: "hunk",
      hunkId: "h12",
      raw: "tl:hunk/h12",
    });
  });

  it("parses a file link with a nested path", () => {
    assert.deepEqual(parseEvidenceUri("tl:file/src/auth/token.ts"), {
      kind: "file",
      path: "src/auth/token.ts",
      raw: "tl:file/src/auth/token.ts",
    });
  });

  it("parses a symbol link, splitting on the last hash", () => {
    assert.deepEqual(parseEvidenceUri("tl:symbol/src/a#b.ts#issueToken"), {
      kind: "symbol",
      path: "src/a#b.ts",
      symbol: "issueToken",
      raw: "tl:symbol/src/a#b.ts#issueToken",
    });
  });

  it("rejects a symbol link with no symbol", () => {
    assert.isNull(parseEvidenceUri("tl:symbol/src/a.ts"));
    assert.isNull(parseEvidenceUri("tl:symbol/src/a.ts#"));
  });

  it("rejects unknown schemes and kinds", () => {
    assert.isNull(parseEvidenceUri("https://example.com"));
    assert.isNull(parseEvidenceUri("tl:cluster/c1"));
    assert.isNull(parseEvidenceUri("tl:hunk/"));
  });
});

describe("extractEvidenceLinks", () => {
  it("finds links inside markdown link targets", () => {
    const links = extractEvidenceLinks("The [guard](tl:file/src/guards.ts) runs first.");
    assert.deepEqual(
      links.map((link) => link.raw),
      ["tl:file/src/guards.ts"],
    );
  });

  it("finds bare links in prose", () => {
    const links = extractEvidenceLinks("Added in tl:hunk/h3 and tl:hunk/h4 together.");
    assert.deepEqual(
      links.map((link) => link.raw),
      ["tl:hunk/h3", "tl:hunk/h4"],
    );
  });

  it("does not swallow sentence-final punctuation", () => {
    const links = extractEvidenceLinks("It lands in tl:hunk/h1.");
    assert.deepEqual(links, [{ kind: "hunk", hunkId: "h1", raw: "tl:hunk/h1" }]);
  });

  it("keeps a file extension that ends the link", () => {
    const links = extractEvidenceLinks("See tl:file/src/a.ts, then read on.");
    assert.deepEqual(
      links.map((link) => link.raw),
      ["tl:file/src/a.ts"],
    );
  });

  it("stops at a closing paren and a closing bracket", () => {
    const links = extractEvidenceLinks("(tl:hunk/h9) and [tl:hunk/h10]");
    assert.deepEqual(
      links.map((link) => link.raw),
      ["tl:hunk/h9", "tl:hunk/h10"],
    );
  });

  it("finds nothing in prose with no links", () => {
    assert.deepEqual(extractEvidenceLinks("Plain narrative with no evidence."), []);
  });
});

describe("downgradeEvidenceLink", () => {
  it("keeps the link text when downgrading a markdown link", () => {
    assert.equal(
      downgradeEvidenceLink("The [session store](tl:file/src/s.ts) is new.", "tl:file/src/s.ts"),
      "The session store is new.",
    );
  });

  it("falls back to the readable tail when the link text is empty", () => {
    assert.equal(
      downgradeEvidenceLink("See [](tl:symbol/src/s.ts#current).", "tl:symbol/src/s.ts#current"),
      "See current.",
    );
  });

  it("replaces a bare link with its readable tail", () => {
    assert.equal(downgradeEvidenceLink("Added in tl:hunk/h7.", "tl:hunk/h7"), "Added in h7.");
  });

  it("leaves other links alone", () => {
    const markdown = "Both [a](tl:hunk/h1) and [b](tl:hunk/h2).";
    assert.equal(downgradeEvidenceLink(markdown, "tl:hunk/h1"), "Both a and [b](tl:hunk/h2).");
  });
});

describe("downgradeUnresolvableLinks", () => {
  it("downgrades only what the resolver rejects and reports the loss", () => {
    const markdown = "Read [good](tl:hunk/h1) then [bad](tl:hunk/h404).";
    const result = downgradeUnresolvableLinks(
      markdown,
      (link) => link.kind === "hunk" && link.hunkId === "h1",
    );
    assert.equal(result.markdown, "Read [good](tl:hunk/h1) then bad.");
    assert.deepEqual(
      result.downgraded.map((link) => link.raw),
      ["tl:hunk/h404"],
    );
  });

  it("is a no-op when everything resolves", () => {
    const markdown = "All [fine](tl:hunk/h1).";
    const result = downgradeUnresolvableLinks(markdown, () => true);
    assert.equal(result.markdown, markdown);
    assert.deepEqual(result.downgraded, []);
  });

  it("handles the same unresolvable link appearing twice", () => {
    const result = downgradeUnresolvableLinks("tl:hunk/h9 and tl:hunk/h9", () => false);
    assert.equal(result.markdown, "h9 and h9");
    assert.equal(result.downgraded.length, 1);
  });
});
