import { assert, describe, it } from "@effect/vitest";

import { parsePrUrl, prWebUrl } from "../src/prUrl.ts";

describe("parsePrUrl", () => {
  it("accepts the canonical web URL and everything hanging off it", () => {
    const expected = { owner: "meridian", repo: "console", number: 418 };
    assert.deepEqual(parsePrUrl("https://github.com/meridian/console/pull/418"), expected);
    assert.deepEqual(parsePrUrl("https://github.com/meridian/console/pull/418/files"), expected);
    assert.deepEqual(
      parsePrUrl("https://github.com/meridian/console/pull/418#discussion_r1"),
      expected,
    );
    assert.deepEqual(parsePrUrl("https://github.com/meridian/console/pull/418?w=1"), expected);
  });

  it("accepts host-less and shorthand forms people actually paste", () => {
    const expected = { owner: "meridian", repo: "console", number: 418 };
    assert.deepEqual(parsePrUrl("github.com/meridian/console/pull/418"), expected);
    assert.deepEqual(parsePrUrl("meridian/console/pull/418"), expected);
    assert.deepEqual(parsePrUrl("meridian/console#418"), expected);
    assert.deepEqual(parsePrUrl("  meridian/console#418  "), expected);
  });

  it("accepts a GitHub Enterprise host", () => {
    assert.deepEqual(parsePrUrl("https://ghe.example.com/team/app/pull/7"), {
      owner: "team",
      repo: "app",
      number: 7,
    });
  });

  it("tolerates a .git suffix on the repository name", () => {
    assert.deepEqual(parsePrUrl("https://github.com/team/app.git/pull/7"), {
      owner: "team",
      repo: "app",
      number: 7,
    });
  });

  it("rejects anything that is not a pull request", () => {
    assert.isNull(parsePrUrl(""));
    assert.isNull(parsePrUrl("   "));
    assert.isNull(parsePrUrl("https://github.com/meridian/console"));
    assert.isNull(parsePrUrl("https://github.com/meridian/console/issues/418"));
    assert.isNull(parsePrUrl("https://github.com/meridian/console/pull/abc"));
    assert.isNull(parsePrUrl("https://github.com/meridian/console/pull/0"));
    assert.isNull(parsePrUrl("not a url at all"));
    assert.isNull(parsePrUrl("https://"));
  });
});

describe("prWebUrl", () => {
  it("round-trips through the parser", () => {
    const ref = { owner: "meridian", repo: "console", number: 418 };
    assert.deepEqual(parsePrUrl(prWebUrl(ref)), ref);
  });
});
