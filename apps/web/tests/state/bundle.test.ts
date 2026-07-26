/**
 * A group of atoms must survive a garbage collection.
 *
 * `Atom.family` holds its entries weakly, which is correct for a single atom
 * (the registry keeps live atoms reachable) and wrong for a wrapper object that
 * only a render holds. When the wrapper is collected the family silently builds
 * a second set of atoms, and the screen ends up subscribed to atoms nothing is
 * answering. These tests pin the strong behaviour that replaced it.
 */
import { describe, expect, it } from "vitest";

import { atomBundle } from "../../src/state/bundle.ts";

describe("atomBundle", () => {
  it("returns the same group for the same key", () => {
    const bundleFor = atomBundle((key: string) => ({ key }));
    expect(bundleFor("a/b/1")).toBe(bundleFor("a/b/1"));
  });

  it("builds a distinct group per key", () => {
    const bundleFor = atomBundle((key: string) => ({ key }));
    expect(bundleFor("a/b/1")).not.toBe(bundleFor("a/b/2"));
  });

  it("builds each group exactly once", () => {
    let built = 0;
    const bundleFor = atomBundle((key: string) => {
      built += 1;
      return { key };
    });
    for (let index = 0; index < 100; index += 1) bundleFor("a/b/1");
    expect(built).toBe(1);
  });

  it("holds the group strongly", async () => {
    const bundleFor = atomBundle((key: string) => ({ key }));
    const first = new WeakRef(bundleFor("a/b/1"));

    // Drop every local reference and give the collector a real chance. Under
    // `Atom.family` this is exactly where the entry disappeared.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (typeof globalThis.gc === "function") globalThis.gc();

    expect(bundleFor("a/b/1")).toBe(first.deref());
  });
});
