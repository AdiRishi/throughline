/**
 * `GhRunner` — one command in, a typed answer out.
 *
 * This seam exists for a reason the specification states as a test: *"simulated
 * 403-with-reset must produce exactly zero further requests until reset; a
 * stampede of `openPrs()` calls must produce exactly one."* Both are **counting**
 * assertions about requests, and they are only writable if the thing that issues
 * a request can be substituted. So `GitHub`'s dependency is "run a `gh` command",
 * not "spawn a process" — a smaller interface, and the one the guarantees can be
 * checked through.
 *
 * Classification lives here too, because deciding what a failure *means* is the
 * same knowledge as knowing how to invoke the tool: `gh` reports everything as
 * exit 1 with prose on stderr, so the signatures below are the only way to tell a
 * rate limit from a 404 from a dead network.
 *
 * @module github/GhRunner
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { firstLine, runProcess } from "../process/run.ts";

/** `gh` is not installed, or is installed but not authenticated. */
export class GhUnavailableError extends Data.TaggedError("GhUnavailableError")<{
  readonly reason: "missing" | "unauthenticated";
  readonly detail: string;
}> {}

/**
 * A rate limit was reported. Carries the reset instant when GitHub told us one;
 * the caller parks the whole module until then and refuses every call in the
 * meantime — including a user-initiated refresh.
 */
export class GhRateLimitedError extends Data.TaggedError("GhRateLimitedError")<{
  readonly detail: string;
  readonly resetAtMillis: number | null;
  readonly secondary: boolean;
}> {}

/** A 4xx that is an answer, not an obstacle. Never retried. */
export class GhClientError extends Data.TaggedError("GhClientError")<{
  readonly status: number;
  readonly detail: string;
}> {}

/** A transport failure or 5xx — the only class that may be retried. */
export class GhTransientError extends Data.TaggedError("GhTransientError")<{
  readonly detail: string;
}> {}

export type GhError = GhUnavailableError | GhRateLimitedError | GhClientError | GhTransientError;

export class GhRunner extends Context.Service<
  GhRunner,
  {
    /** Run `gh` with these arguments. Failure is already classified. */
    readonly run: (
      args: ReadonlyArray<string>,
      options?: { readonly timeout?: Duration.Input },
    ) => Effect.Effect<string, GhError>;
  }
>()("@app/server/github/GhRunner") {}

/**
 * `gh` colourizes and paginates when it thinks it has a terminal, and both would
 * corrupt the JSON we parse — so the environment is pinned rather than inherited.
 */
const GH_ENV: Record<string, string> = {
  GH_PAGER: "cat",
  NO_COLOR: "1",
  CLICOLOR: "0",
};

export const layer: Layer.Layer<GhRunner, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    GhRunner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return {
        run: (args, options) =>
          runProcess("gh", args, { env: GH_ENV, ...options }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((cause) => new GhTransientError({ detail: cause.detail }) as GhError),
            Effect.flatMap((result) =>
              result.exitCode === 0
                ? Effect.succeed(result.stdout)
                : Effect.fail(classify(result.exitCode, result.stderr, result.stdout)),
            ),
          ),
      } satisfies GhRunner["Service"];
    }),
  );

/**
 * `gh` prints its diagnostics to stderr as prose, so classification is signature
 * matching. Ordering matters: a secondary-rate-limit message also contains the
 * words "rate limit", and an unauthenticated `gh` reports a 401 that must read as
 * "sign in", not as a transient blip worth retrying.
 */
export function classify(exitCode: number, stderr: string, stdout: string): GhError {
  const text = `${stderr}\n${stdout}`.trim();
  const lower = text.toLowerCase();

  if (
    lower.includes("command not found") ||
    lower.includes("enoent") ||
    lower.includes("is not recognized as an internal or external command")
  ) {
    return new GhUnavailableError({
      reason: "missing",
      detail: "The GitHub CLI (gh) is not installed or is not on PATH.",
    });
  }
  if (
    lower.includes("gh auth login") ||
    lower.includes("not logged in") ||
    lower.includes("no credentials found") ||
    lower.includes("authentication required") ||
    lower.includes("bad credentials")
  ) {
    return new GhUnavailableError({
      reason: "unauthenticated",
      detail: "The GitHub CLI is not authenticated. Run `gh auth login`, then refresh.",
    });
  }

  if (lower.includes("secondary rate limit") || lower.includes("abuse detection")) {
    return new GhRateLimitedError({
      detail: "GitHub applied a secondary rate limit.",
      resetAtMillis: parseRetryAfter(text),
      secondary: true,
    });
  }
  if (lower.includes("rate limit")) {
    return new GhRateLimitedError({
      detail: "GitHub's API rate limit is exhausted for this login.",
      resetAtMillis: parseResetHeader(text),
      secondary: false,
    });
  }

  const status = parseStatus(text);
  if (status !== null && status >= 400 && status < 500) {
    return new GhClientError({ status, detail: firstLine(text) });
  }
  if (status !== null && status >= 500) {
    return new GhTransientError({ detail: `GitHub returned ${status}. ${firstLine(text)}` });
  }
  if (
    lower.includes("connection refused") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("dial tcp") ||
    lower.includes("network is unreachable") ||
    lower.includes("temporary failure in name resolution")
  ) {
    return new GhTransientError({ detail: firstLine(text) });
  }

  // A GraphQL error arrives as exit 1 with a JSON body; treat it as an answer.
  if (lower.includes('"errors"') || lower.includes("graphql:")) {
    return new GhClientError({ status: 422, detail: firstLine(text) });
  }

  return new GhTransientError({
    detail: text.length === 0 ? `gh exited with code ${exitCode}.` : firstLine(text),
  });
}

function parseStatus(text: string): number | null {
  const match = /HTTP\s+(\d{3})|status[:\s]+(\d{3})|\((\d{3})\)/i.exec(text);
  if (match === null) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined ? null : Number.parseInt(value, 10);
}

function parseRetryAfter(text: string): number | null {
  const match = /retry[- ]after[:\s]+(\d+)/i.exec(text);
  if (match?.[1] === undefined) return null;
  return Date.now() + Number.parseInt(match[1], 10) * 1000;
}

function parseResetHeader(text: string): number | null {
  const match = /x-ratelimit-reset[:\s]+(\d+)/i.exec(text);
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10) * 1000;
}
