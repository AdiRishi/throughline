/**
 * Pull request URL parsing — the pasted-URL door's first check.
 *
 * Pure and total: it either yields a `PrRef` or it does not. Whether that ref
 * is *visible* is a separate door check that costs an API call; this one is
 * free and rejects typos before anything is spent.
 *
 * Lives in `@app/shared` because both sides need the same answer: the server's
 * door checks a pasted URL before spending an API call, and the welcome
 * screen's paste field checks it before navigating. One parser, one set of
 * accepted forms.
 *
 * @module prUrl
 */

/**
 * Structurally the contracts' `PrRef`. Declared here so this package stays
 * dependency-free, per its role as host-agnostic runtime utilities.
 */
export interface ParsedPrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

// `owner/repo#123` — the shorthand people paste out of chat.
const SHORTHAND = /^([\w.-]+)\/([\w.-]+)#(\d+)$/u;
// A path ending in `/pull/123` (or `/pulls/123`), with anything after it.
const PATH = /^\/?([\w.-]+)\/([\w.-]+)\/pulls?\/(\d+)(?:[/?#].*)?$/u;

/**
 * Accepts a full URL (any host — GitHub Enterprise included), a bare
 * `owner/repo/pull/123` path, or the `owner/repo#123` shorthand.
 */
export function parsePrUrl(input: string): ParsedPrRef | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const shorthand = SHORTHAND.exec(trimmed);
  if (shorthand !== null) {
    return refFrom(shorthand[1], shorthand[2], shorthand[3]);
  }

  const pathname = extractPathname(trimmed);
  const path = PATH.exec(pathname);
  if (path !== null) {
    return refFrom(path[1], path[2], path[3]);
  }
  return null;
}

function extractPathname(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(input)) {
    try {
      return new URL(input).pathname;
    } catch {
      return "";
    }
  }
  // Host-less forms: `github.com/owner/repo/pull/1` and `owner/repo/pull/1`
  // both reduce to a path once a leading hostname segment is dropped.
  const withoutHost = input.replace(/^(?:www\.)?[\w.-]+\.[a-z]{2,}\//iu, "/");
  return withoutHost.startsWith("/") ? withoutHost : `/${input}`;
}

function refFrom(
  owner: string | undefined,
  repo: string | undefined,
  numberText: string | undefined,
): ParsedPrRef | null {
  if (owner === undefined || repo === undefined || numberText === undefined) return null;
  const number = Number.parseInt(numberText, 10);
  if (!Number.isInteger(number) || number <= 0) return null;
  // `.git` is a habit from clone URLs; nobody means it as part of the name.
  return { owner, repo: repo.replace(/\.git$/u, ""), number };
}

/** The canonical web URL for a ref on github.com. */
export function prWebUrl(ref: ParsedPrRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
}
