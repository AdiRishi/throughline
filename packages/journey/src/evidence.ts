/**
 * Evidence links: markdown's one Throughline extension.
 *
 * Narrative is plain Markdown except that a link target may be a `tl:` URI —
 * `tl:hunk/h12`, `tl:file/src/auth/token.ts`, `tl:symbol/src/auth/token.ts#issueToken`.
 * Evidence lives *in* the prose rather than in a parallel refs array, so there
 * is nothing to drift. The renderer resolves these to navigation; the validator
 * resolves them against the artifact and the pinned tree.
 *
 * @module evidence
 */

export interface HunkEvidence {
  readonly kind: "hunk";
  readonly hunkId: string;
  readonly raw: string;
}

export interface FileEvidence {
  readonly kind: "file";
  readonly path: string;
  readonly raw: string;
}

export interface SymbolEvidence {
  readonly kind: "symbol";
  readonly path: string;
  readonly symbol: string;
  readonly raw: string;
}

export type EvidenceLink = HunkEvidence | FileEvidence | SymbolEvidence;

/**
 * Matches a `tl:` URI wherever it appears — inside a markdown link target or
 * bare in prose. Stops at whitespace and at the delimiters that would end a
 * markdown link, so `[the guard](tl:file/src/guards.ts)` yields the path only.
 */
const EVIDENCE_URI = /tl:(hunk|file|symbol)\/([^\s)\]<>"'`]+)/g;

/**
 * A bare link at the end of a sentence — "…is added in tl:hunk/h1." — must not
 * swallow the punctuation that follows it. Trailing sentence marks and slashes
 * are never part of a hunk id, a path, or a symbol name, so they are trimmed
 * back off the match. Internal dots (`tl:file/src/a.ts`) are untouched.
 */
const TRAILING_PUNCTUATION = /[.,;:!?/]+$/;

/** Parse one `tl:` URI. Returns null for anything that is not one. */
export function parseEvidenceUri(uri: string): EvidenceLink | null {
  const match = /^tl:(hunk|file|symbol)\/([^\s]+)$/.exec(uri.trim());
  if (match === null) return null;
  const [, kind, rest] = match;
  if (kind === undefined || rest === undefined || rest.length === 0) return null;

  if (kind === "hunk") {
    return { kind: "hunk", hunkId: rest, raw: uri.trim() };
  }
  if (kind === "file") {
    return { kind: "file", path: rest, raw: uri.trim() };
  }
  // A symbol URI is `path#symbol`; the last `#` separates them so paths
  // containing `#` still resolve.
  const separator = rest.lastIndexOf("#");
  if (separator <= 0 || separator === rest.length - 1) return null;
  return {
    kind: "symbol",
    path: rest.slice(0, separator),
    symbol: rest.slice(separator + 1),
    raw: uri.trim(),
  };
}

/** Every resolvable-shaped `tl:` link in a markdown string, in order. */
export function extractEvidenceLinks(markdown: string): ReadonlyArray<EvidenceLink> {
  const links: EvidenceLink[] = [];
  for (const match of markdown.matchAll(EVIDENCE_URI)) {
    const trimmed = match[0].replace(TRAILING_PUNCTUATION, "");
    const parsed = parseEvidenceUri(trimmed);
    if (parsed !== null) links.push(parsed);
  }
  return links;
}

/**
 * The absolute floor of the evidence ladder: turn an unresolvable link into
 * plain text rather than shipping prose that points nowhere. `[text](tl:x)`
 * becomes `text`; a bare `tl:x` becomes its readable tail. The loss is always
 * logged by the caller — the floor exists so the pipeline terminates, not
 * because standing on it is acceptable.
 */
export function downgradeEvidenceLink(markdown: string, raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const asMarkdownLink = new RegExp(`\\[([^\\]]*)\\]\\(\\s*${escaped}\\s*\\)`, "g");
  const withoutLinks = markdown.replace(asMarkdownLink, (_match, text: string) =>
    text.length > 0 ? text : readableTail(raw),
  );
  return withoutLinks.split(raw).join(readableTail(raw));
}

/** `tl:symbol/src/a.ts#issueToken` → `issueToken`; `tl:file/src/a.ts` → `src/a.ts`. */
function readableTail(raw: string): string {
  const parsed = parseEvidenceUri(raw);
  if (parsed === null) return raw;
  switch (parsed.kind) {
    case "hunk":
      return parsed.hunkId;
    case "file":
      return parsed.path;
    case "symbol":
      return parsed.symbol;
  }
}

/**
 * Rewrite every link in `markdown` that a resolver rejects. Returns the cleaned
 * prose plus the list of links that were downgraded, so the caller can record
 * each loss in the run's provenance.
 */
export function downgradeUnresolvableLinks(
  markdown: string,
  resolves: (link: EvidenceLink) => boolean,
): { readonly markdown: string; readonly downgraded: ReadonlyArray<EvidenceLink> } {
  const downgraded: EvidenceLink[] = [];
  let result = markdown;
  const seen = new Set<string>();
  for (const link of extractEvidenceLinks(markdown)) {
    if (seen.has(link.raw)) continue;
    seen.add(link.raw);
    if (resolves(link)) continue;
    downgraded.push(link);
    result = downgradeEvidenceLink(result, link.raw);
  }
  return { markdown: result, downgraded };
}
