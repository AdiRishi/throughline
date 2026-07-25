import { assert, describe, it } from "vitest";

import {
  safeDiagnosticErrorType,
  sanitizeDiagnosticJsonLine,
  sanitizeDiagnosticText,
  sanitizeDiagnosticUrl,
} from "../src/safeLog.ts";

describe("safeLog", () => {
  it("removes credentials and query fragments while retaining useful locations", () => {
    const diagnostic = sanitizeDiagnosticText(
      [
        "Authorization: Bearer bearer-secret-sentinel",
        "access_token=query-secret-sentinel",
        '"bootstrapToken":"bootstrap-secret-sentinel"',
        "github_pat_1234567890abcdefghijkl",
        "at https://user:password@example.com/src/app.ts?access_token=url-secret#fragment",
      ].join("\n"),
    );

    assert.notInclude(diagnostic, "bearer-secret-sentinel");
    assert.notInclude(diagnostic, "query-secret-sentinel");
    assert.notInclude(diagnostic, "bootstrap-secret-sentinel");
    assert.notInclude(diagnostic, "github_pat_");
    assert.notInclude(diagnostic, "user:password");
    assert.notInclude(diagnostic, "url-secret");
    assert.include(diagnostic, "https://example.com/src/app.ts");
  });

  it("does not treat a route ending in bearer as an authorization header", () => {
    assert.equal(
      sanitizeDiagnosticText("http.url: /api/auth/bootstrap/bearer\nhttp.status: 200"),
      "http.url: /api/auth/bootstrap/bearer\nhttp.status: 200",
    );
  });

  it("redacts Basic authorization values and credential fields completely", () => {
    const diagnostic = sanitizeDiagnosticText(
      [
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
        '"credential":"bootstrap-secret-sentinel"',
        '"token":"bearer-secret-sentinel"',
      ].join("\n"),
    );

    assert.include(diagnostic, "Authorization: Basic [redacted]");
    assert.notInclude(diagnostic, "dXNlcjpwYXNzd29yZA==");
    assert.notInclude(diagnostic, "bootstrap-secret-sentinel");
    assert.notInclude(diagnostic, "bearer-secret-sentinel");
  });

  it("consumes complete quoted assignment values", () => {
    const diagnostic = sanitizeDiagnosticText(
      String.raw`credential="alpha beta \"gamma\"" token='delta epsilon \'zeta\''`,
    );

    assert.equal(diagnostic, "credential=[redacted] token=[redacted]");
    assert.notInclude(diagnostic, "beta");
    assert.notInclude(diagnostic, "epsilon");
  });

  it("keeps transformed structured log lines valid JSON", () => {
    const input = JSON.stringify({
      message: "request failed",
      annotations: {
        access_token: "query-secret-sentinel",
        source: "wss://localhost/ws?access_token=url-secret-sentinel",
      },
    });
    const parsed = JSON.parse(sanitizeDiagnosticText(input)) as {
      readonly annotations: Record<string, string>;
    };

    assert.equal(parsed.annotations.access_token, "[redacted]");
    assert.equal(parsed.annotations.source, "wss://localhost/ws");
  });

  it("bounds structured values without truncating the serialized NDJSON record", () => {
    const parsed = JSON.parse(
      sanitizeDiagnosticJsonLine(
        JSON.stringify({
          message: "x".repeat(16 * 1024),
          annotations: {
            credential: "bootstrap-secret-sentinel",
            nested: { token: "bearer-secret-sentinel" },
          },
        }),
      ),
    ) as {
      readonly message: string;
      readonly annotations: {
        readonly credential: string;
        readonly nested: { readonly token: string };
      };
    };

    assert.match(parsed.message, /…\[truncated\]$/u);
    assert.equal(parsed.annotations.credential, "[redacted]");
    assert.equal(parsed.annotations.nested.token, "[redacted]");
  });

  it("bounds untrusted renderer and child-process messages", () => {
    const diagnostic = sanitizeDiagnosticText("x".repeat(100), 32);

    assert.lengthOf(diagnostic, 32);
    assert.match(diagnostic, /…\[truncated\]$/u);
  });

  it("rejects malformed source URLs instead of retaining their contents", () => {
    assert.equal(sanitizeDiagnosticUrl("not a url?access_token=secret"), "[invalid-url]");
  });

  it("rejects opaque source URLs instead of retaining embedded content", () => {
    assert.equal(
      sanitizeDiagnosticUrl("data:text/javascript,private-diff-prompt-sentinel"),
      "[unsupported-url]",
    );
    assert.equal(
      sanitizeDiagnosticUrl("javascript:private-diff-prompt-sentinel"),
      "[unsupported-url]",
    );
  });

  it("retains only stable structural error labels", () => {
    assert.equal(safeDiagnosticErrorType({ _tag: "GitHubReadError" }), "GitHubReadError");
    assert.equal(safeDiagnosticErrorType(new TypeError("secret message")), "TypeError");
    assert.equal(
      safeDiagnosticErrorType({ _tag: "unsafe tag with secret data", message: "secret" }),
      "UnknownError",
    );
  });

  it("does not let a hostile error proxy replace the original failure", () => {
    const error = new Proxy(
      {},
      {
        has: () => {
          throw new Error("proxy trap");
        },
      },
    );

    assert.equal(safeDiagnosticErrorType(error), "UnknownError");
  });
});
