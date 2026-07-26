/**
 * The transition's honesty is only as good as this parser.
 *
 * Under a read-only sandbox Codex does everything through the shell, so
 * "the agent is reading src/auth/session.ts" is a claim recovered from a
 * command line. These tests pin what may be claimed and what may not.
 *
 * The command lines here are verbatim shapes from real runs: Codex sends one
 * `command_execution` per shell invocation, and that invocation is a whole
 * script — `/bin/zsh -lc "…"` with several commands joined inside it.
 */
import { assert, describe, it } from "@effect/vitest";

import { describeCommand, splitSegments, tokenizeCommand } from "../../src/harness/codex.ts";

/** The single event a one-command line should produce. */
const only = (command: string) => {
  const events = describeCommand(command);
  assert.lengthOf(events, 1);
  return events[0]!;
};

describe("tokenizeCommand", () => {
  it("keeps quoted arguments together", () => {
    assert.deepEqual(tokenizeCommand(`rg -n "class SessionStore" src`), [
      "rg",
      "-n",
      "class SessionStore",
      "src",
    ]);
    assert.deepEqual(tokenizeCommand(`grep -e 'foo bar' .`), ["grep", "-e", "foo bar", "."]);
  });
});

describe("splitSegments", () => {
  it("splits on every shell separator", () => {
    assert.deepEqual(splitSegments("pwd && cat a.ts; ls | wc -l"), [
      "pwd",
      "cat a.ts",
      "ls",
      "wc -l",
    ]);
  });

  it("does not split inside quotes", () => {
    assert.deepEqual(splitSegments(`sed -n '1,20p; 40p' src/db.ts`), [
      `sed -n '1,20p; 40p' src/db.ts`,
    ]);
  });
});

describe("describeCommand", () => {
  it("reads a search pattern past its flags", () => {
    assert.deepEqual(only("rg -n issueToken src"), {
      verb: "search",
      detail: "issueToken",
      path: null,
      pattern: "issueToken",
    });
  });

  it("does not mistake a flag's value for the pattern", () => {
    // `-g '!node_modules'` is a glob filter, not what the agent searched for.
    assert.strictEqual(
      only("rg -g '!node_modules' -n requireSession src").pattern,
      "requireSession",
    );
  });

  it("never reports a bare flag as a search", () => {
    const event = only("rg -g");
    assert.strictEqual(event.verb, "run");
    assert.isNull(event.pattern);
  });

  it("reads a file read out of a pager or cat", () => {
    assert.deepEqual(only("cat src/auth/session.ts"), {
      verb: "read",
      detail: "src/auth/session.ts",
      path: "src/auth/session.ts",
      pattern: null,
    });
    assert.strictEqual(only("sed -n '1,80p' src/db.ts").path, "src/db.ts");
  });

  it("finds the tool through an absolute path and an unquoted shell wrapper", () => {
    assert.strictEqual(only("/bin/zsh -lc /usr/bin/rg -n AuthService").pattern, "AuthService");
  });

  it("unwraps the quoted script a shell was actually handed", () => {
    // The real shape. Before this was unwrapped, every one of these arrived as
    // an uninformative "run" and the counters sat at zero for a whole run.
    const events = describeCommand(
      `/bin/zsh -lc "nl -ba src/auth/session.ts; nl -ba src/pages/auth/LoginPage.ts"`,
    );
    assert.deepEqual(
      events.map((event) => event.path),
      ["src/auth/session.ts", "src/pages/auth/LoginPage.ts"],
    );
  });

  it("unwraps a script that carries quoting of its own", () => {
    // Verbatim from a run. The nested quotes around the glob are why this has
    // to be unwrapped on the raw string rather than on tokens.
    const events = describeCommand(
      `/bin/zsh -lc "rg --files -g '"'!node_modules'"' | sort && sed -n '1,200p' src/db.ts"`,
    );
    assert.deepEqual(
      events.map((event) => event.verb),
      ["run", "run", "read"],
    );
    assert.strictEqual(events.at(-1)!.path, "src/db.ts");
  });

  it("resolves the escaping the shell would have resolved", () => {
    // Verbatim shape. `\"` is how a double-quoted script quotes its own
    // argument; showing the backslashes to a reviewer would be showing them
    // the transport, not the search.
    const event = only(String.raw`/bin/zsh -lc "rg -n \"SessionStore|app\\.session\" src"`);
    assert.strictEqual(event.verb, "search");
    assert.strictEqual(event.pattern, String.raw`SessionStore|app\.session`);
  });

  it("does not call a glob filter a search when there is no pattern", () => {
    // `rg --files` lists the tree; it searched for nothing.
    const event = only(`rg --files -g '!node_modules'`);
    assert.strictEqual(event.verb, "run");
    assert.isNull(event.pattern);
  });

  it("reports every command in a script, not just the informative ones", () => {
    const events = describeCommand(
      `/bin/zsh -lc "pwd && sed -n '1,240p' .throughline/hunks.json && find src -type f"`,
    );
    assert.deepEqual(
      events.map((event) => [event.verb, event.detail]),
      [
        ["run", "pwd"],
        ["read", ".throughline/hunks.json"],
        ["run", "find src -type f"],
      ],
    );
  });

  it("falls back to a plain run rather than guessing", () => {
    const event = only("git status --porcelain");
    assert.strictEqual(event.verb, "run");
    assert.strictEqual(event.detail, "git status --porcelain");
  });

  it("stops at a pipe rather than reading the next command's arguments", () => {
    const events = describeCommand("ls | rg");
    assert.deepEqual(
      events.map((event) => event.verb),
      ["run", "run"],
    );
  });
});
