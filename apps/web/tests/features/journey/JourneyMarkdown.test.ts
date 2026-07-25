import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { JourneyMarkdown } from "../../../src/features/journey/JourneyMarkdown.tsx";

describe("journey markdown URLs", () => {
  it("renders internal evidence links with their navigation target intact", () => {
    const html = renderToStaticMarkup(
      createElement(JourneyMarkdown, {
        markdown: "[evidence](tl:hunk/h1)",
        onEvidence: () => undefined,
      }),
    );

    expect(html).toContain('href="tl:hunk/h1"');
    expect(html).toContain("data-evidence-link");
  });

  it("keeps the default URL safety policy for external links and image sources", () => {
    const html = renderToStaticMarkup(
      createElement(JourneyMarkdown, {
        markdown:
          "[safe](https://example.com/review) [unsafe](javascript:alert(1)) ![image](tl:file/asset.png)",
        onEvidence: () => undefined,
      }),
    );

    expect(html).toContain('href="https://example.com/review"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('src="tl:');
  });
});
