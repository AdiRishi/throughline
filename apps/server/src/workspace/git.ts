/**
 * The git runner.
 *
 * Repository bytes move through git, never through the API — which is why this
 * file exists beside the `GitHub` module rather than inside it. Clones and fetches
 * therefore cost API quota nothing, and the rate discipline `GitHub` enforces has
 * nothing to say about them.
 *
 * Authentication rides `gh auth git-credential`, the same credential helper
 * `gh auth setup-git` installs. That is deliberate: a token never appears in
 * argv (readable by other local processes), never in the environment, and never
 * in `.git/config`. `gh` holds it and hands it over one request at a time.
 *
 * @module workspace/git
 */
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { firstLine, runProcess, runProcessBytes } from "../process/run.ts";

export class GitFailedError extends Data.TaggedError("GitFailedError")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly stderr: string;
}> {
  override get message(): string {
    return `git ${this.args.slice(0, 3).join(" ")} failed (${this.exitCode}): ${firstLine(this.stderr)}`;
  }
}

export class GitUnavailableError extends Data.TaggedError("GitUnavailableError")<{
  readonly detail: string;
}> {}

export type GitError = GitFailedError | GitUnavailableError;

/** A clone of a large repository is slow, and that is not a fault. */
const DEFAULT_TIMEOUT: Duration.Input = "10 minutes";

/**
 * Config flags applied to every invocation. `credential.helper=` (empty) first
 * *clears* whatever the reviewer has configured, then the `gh` helper is
 * appended — so behaviour is identical on a machine with a keychain helper, a
 * store helper, or none at all.
 */
const CREDENTIAL_ARGS: ReadonlyArray<string> = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
  // Never stop at a password prompt: a missing credential must fail, not hang.
  "-c",
  "core.askPass=",
];

const BASE_ARGS: ReadonlyArray<string> = [
  "-c",
  "advice.detachedHead=false",
  // A reviewer's global gitattributes or clean/smudge filters must not rewrite
  // the bytes we analyse — the journey's line numbers are claims about the real
  // blobs, not about a locally transformed copy.
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
];

const NON_INTERACTIVE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
};

function buildArgs(
  args: ReadonlyArray<string>,
  options?: { readonly authenticated?: boolean },
): ReadonlyArray<string> {
  return [...BASE_ARGS, ...(options?.authenticated === false ? [] : CREDENTIAL_ARGS), ...args];
}

function classify(exitCode: number, stderr: string, args: ReadonlyArray<string>): GitError {
  const lower = stderr.toLowerCase();
  if (lower.includes("command not found") || lower.includes("enoent")) {
    return new GitUnavailableError({ detail: "git is not installed or is not on PATH." });
  }
  return new GitFailedError({ args, exitCode, stderr });
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run git, capturing stdout as text. A non-zero exit is a fault here (unlike
 * `gh`, where a 4xx is an answer) unless the caller says otherwise — `allowFailure`
 * exists for the handful of best-effort calls like `worktree prune`.
 */
export const git = Effect.fn("workspace.git")(function* (
  args: ReadonlyArray<string>,
  options?: {
    readonly timeout?: Duration.Input;
    readonly authenticated?: boolean;
    readonly allowFailure?: boolean;
  },
): Effect.fn.Return<GitResult, GitError, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runProcess("git", buildArgs(args, options), {
    env: NON_INTERACTIVE_ENV,
    timeout: options?.timeout ?? DEFAULT_TIMEOUT,
  }).pipe(Effect.mapError((cause) => classify(-1, cause.detail, args)));

  if (result.exitCode !== 0 && options?.allowFailure !== true) {
    return yield* classify(result.exitCode, result.stderr, args);
  }
  return result;
});

/**
 * Run git, capturing stdout as raw bytes. Needed for `git show <rev>:<path>` on a
 * binary blob, where decoding as text would corrupt the content — and the product
 * renders images as images, so the bytes have to survive.
 */
export const gitBytes = Effect.fn("workspace.gitBytes")(function* (
  args: ReadonlyArray<string>,
  options?: { readonly timeout?: Duration.Input },
): Effect.fn.Return<Uint8Array, GitError, ChildProcessSpawner.ChildProcessSpawner> {
  const result = yield* runProcessBytes("git", buildArgs(args), {
    env: NON_INTERACTIVE_ENV,
    timeout: options?.timeout ?? "2 minutes",
  }).pipe(Effect.mapError((cause) => classify(-1, cause.detail, args)));

  if (result.exitCode !== 0) {
    return yield* classify(result.exitCode, result.stderr, args);
  }
  return result.stdout;
});
