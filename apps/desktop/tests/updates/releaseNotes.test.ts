import { assert, describe, it } from "@effect/vitest";

import { normalizeDesktopUpdateReleaseNotes } from "../../src/updates/releaseNotes.ts";

describe("normalizeDesktopUpdateReleaseNotes", () => {
  it("turns GitHub markdown and HTML into bounded plain-text items", () => {
    assert.deepEqual(
      normalizeDesktopUpdateReleaseNotes(
        [
          {
            version: "1.2.0",
            note: `
              ## What's changed
              - Improve journey loading &amp; recovery
              <li>Keep <strong>native menus</strong> responsive</li>
              [Full changelog](https://example.test/compare/1.1.0...1.2.0)
            `,
          },
        ],
        "1.2.0",
      ),
      [
        {
          version: "1.2.0",
          items: ["Improve journey loading & recovery", "Keep native menus responsive"],
        },
      ],
    );
  });

  it("ignores malformed release notes instead of blocking an update", () => {
    assert.deepEqual(
      normalizeDesktopUpdateReleaseNotes([{ version: 1, note: Symbol("invalid") }], "1.2.0"),
      [],
    );
  });
});
