/**
 * Invoking `gh`, and reading what its failures mean.
 *
 * Classification is the load-bearing part: the rate discipline in
 * `GitHub.ts` can only be structural if "this was a rate limit" and "this was a
 * 404" are decided in one place, from the process outcome, and never guessed at
 * the call site.
 *
 * @module github/gh
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type { CommandOutcome, Runner, RunOptions } from "../process/Subprocess.ts";

/** What a non-zero `gh` exit actually was. */
export type GhFailure =
  | { readonly kind: "not-installed"; readonly detail: string }
  | { readonly kind: "not-authenticated"; readonly detail: string }
  | { readonly kind: "rate-limit"; readonly secondary: boolean; readonly detail: string }
  | { readonly kind: "client"; readonly status: number; readonly detail: string }
  | { readonly kind: "transport"; readonly status?: number; readonly detail: string };

const HTTP_STATUS = /\(HTTP (\d{3})\)/u;

/**
 * `gh` reports API errors on stderr in a stable shape:
 * `gh: Not Found (HTTP 404)`. That, plus a few well-known phrases, is enough to
 * decide retry-or-not without a second request.
 */
export function classifyGhFailure(outcome: CommandOutcome): GhFailure {
  const text = `${outcome.stderr}\n${outcome.stdout}`;
  const detail = firstMeaningfulLine(text) || `gh exited with code ${outcome.exitCode}`;
  const status = Number.parseInt(HTTP_STATUS.exec(text)?.[1] ?? "", 10);

  if (/exceeded a secondary rate limit/iu.test(text)) {
    return { kind: "rate-limit", secondary: true, detail };
  }
  if (status === 429 || (status === 403 && /rate limit/iu.test(text))) {
    return { kind: "rate-limit", secondary: false, detail };
  }
  if (
    status === 401 ||
    /gh auth login/iu.test(text) ||
    /authentication token|not logged (in)?to|no accounts? are logged/iu.test(text)
  ) {
    return { kind: "not-authenticated", detail };
  }
  if (Number.isInteger(status)) {
    return status >= 500
      ? { kind: "transport", status, detail }
      : { kind: "client", status, detail };
  }
  // No HTTP status at all: a DNS failure, a dropped connection, a proxy. Those
  // are the only things worth retrying.
  if (
    /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection refused|dial tcp|TLS handshake/iu.test(
      text,
    )
  ) {
    return { kind: "transport", detail };
  }
  return { kind: "client", status: 0, detail };
}

function firstMeaningfulLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("{")) {
      return trimmed.replace(/^gh:\s*/u, "");
    }
  }
  return "";
}

export interface GhOptions {
  readonly args: ReadonlyArray<string>;
  readonly timeout?: Duration.Input | undefined;
  readonly cwd?: string | undefined;
}

/**
 * Run `gh` with the environment neutralised: no pager, no prompts, no colour.
 * A prompt would hang the server on a terminal nobody is watching, and colour
 * codes would corrupt the JSON we parse.
 *
 * A missing binary is reported as exit 127 rather than a spawn failure, so the
 * caller has one shape to classify instead of two.
 */
export type Gh = (options: GhOptions) => Effect.Effect<CommandOutcome>;

export const makeGh = (runner: Runner): Gh =>
  Effect.fn("github.gh")(function* (options: GhOptions) {
    const runOptions: RunOptions = {
      command: "gh",
      args: options.args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: {
        GH_PAGER: "cat",
        PAGER: "cat",
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
        CLICOLOR: "0",
      },
      timeout: options.timeout ?? Duration.seconds(45),
    };
    return yield* runner(runOptions).pipe(
      Effect.catch((cause) =>
        Effect.succeed<CommandOutcome>({
          command: `gh ${options.args.join(" ")}`,
          exitCode: 127,
          stdout: "",
          stderr: cause.message,
        }),
      ),
    );
  });
