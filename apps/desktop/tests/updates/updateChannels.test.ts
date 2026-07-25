import { assert, describe, it } from "@effect/vitest";

import {
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "../../src/updates/updateChannels.ts";

describe("updateChannels", () => {
  it("recognizes only the release pipeline's complete nightly version format", () => {
    assert.isTrue(isNightlyDesktopVersion("0.0.17-nightly.20260415.1"));
    assert.isFalse(isNightlyDesktopVersion("0.0.17-nightly.20260415"));
    assert.isFalse(isNightlyDesktopVersion("0.0.17-nightly.2026-04-15.1"));
    assert.isFalse(isNightlyDesktopVersion("0.0.17"));
  });

  it("derives the default channel from the running app version", () => {
    assert.equal(resolveDefaultDesktopUpdateChannel("0.0.17"), "latest");
    assert.equal(resolveDefaultDesktopUpdateChannel("0.0.17-nightly.20260415.1"), "nightly");
  });
});
