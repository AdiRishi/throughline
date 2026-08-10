import { assert, describe, it } from "@effect/vitest";

import { DEV_PROXIED_PATH_PREFIXES, isDevProxiedPath } from "../src/devProxy.ts";

describe("isDevProxiedPath", () => {
  it("matches every prefix exactly", () => {
    for (const prefix of DEV_PROXIED_PATH_PREFIXES) {
      assert.isTrue(isDevProxiedPath(prefix));
    }
  });

  it("matches sub-paths of a prefix", () => {
    assert.isTrue(isDevProxiedPath("/api/notes"));
    assert.isTrue(isDevProxiedPath("/ws/rpc"));
    assert.isTrue(isDevProxiedPath("/.well-known/app"));
  });

  it("does not match a longer path segment that merely starts with a prefix", () => {
    // The bug a bare `startsWith` check has: `/apifoo` is an app route, not a
    // proxied backend path.
    assert.isFalse(isDevProxiedPath("/apifoo"));
    assert.isFalse(isDevProxiedPath("/wsx"));
    assert.isFalse(isDevProxiedPath("/.well-knownish"));
  });

  it("does not match unrelated app routes", () => {
    assert.isFalse(isDevProxiedPath("/"));
    assert.isFalse(isDevProxiedPath("/notes"));
    assert.isFalse(isDevProxiedPath("/index.html"));
  });
});
