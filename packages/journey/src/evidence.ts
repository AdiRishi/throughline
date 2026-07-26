/**
 * Evidence links: `tl:` URIs embedded in narrative Markdown.
 *
 * Per the vision, prose that can't be checked against code is not allowed to
 * exist in the product. Evidence lives *in* the text rather than in a parallel
 * refs array, so there is nothing to drift; this module is how the text is
 * read, resolved, and — at the pipeline's absolute floor — honestly downgraded.
 *
 * Three forms:
 *   tl:hunk/h12
 *   tl:file/src/auth/token.ts
 *   tl:symbol/src/auth/token.ts#issueToken
 *
 * A `tl:symbol` link resolves iff the symbol string occurs textually in the
 * referenced file at the pinned head — deliberately no language tooling, so
 * the check stays cheap and unambiguous.
 *
 * @module evidence
 */

export type EvidenceLink =
  | { readonly kind: "hunk"; readonly raw: string; readonly hunkId: string }
  | { readonly kind: "file"; readonly raw: string; readonly path: string }
  | {
      readonly kind: "symbol";
      readonly raw: string;
      readonly path: string;
      readonly symbol: string;
    };

/** What the resolver needs to know about the pinned revision. */
export interface EvidenceContext {
  /** Hunk ids *and* seed ids: a link written against a seed survives its split. */
  readonly hunkIds: ReadonlySet<string>;
  /** Every path at the pinned head, plus deleted paths the journey still names. */
  readonly treePaths: ReadonlySet<string>;
  readonly lineCounts: ReadonlyMap<string, { readonly old: number; readonly new: number }>;
  readonly containsSymbol: (path: string, symbol: string) => boolean;
}

// Stops at whitespace and at the delimiters that end a Markdown link or
// autolink, so `[x](tl:file/a.ts)` and `<tl:file/a.ts>` both yield `a.ts`.
const LINK_PATTERN = /tl:(hunk|file|symbol)\/([^\s)>\]`"']+)/gu;

/** Every `tl:` link in a Markdown string, in source order, duplicates included. */
export function extractEvidenceLinks(markdown: string): ReadonlyArray<EvidenceLink> {
  const links: EvidenceLink[] = [];
  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const kind = match[1];
    const target = match[2];
    if (kind === undefined || target === undefined) continue;
    const raw = match[0];
    if (kind === "hunk") {
      links.push({ kind: "hunk", raw, hunkId: stripTrailingPunctuation(target) });
      continue;
    }
    if (kind === "file") {
      links.push({ kind: "file", raw, path: stripTrailingPunctuation(target) });
      continue;
    }
    const hash = target.lastIndexOf("#");
    if (hash <= 0 || hash === target.length - 1) {
      // A symbol link with no symbol can never resolve; represent it honestly
      // so the validator reports it rather than silently ignoring it.
      links.push({ kind: "symbol", raw, path: stripTrailingPunctuation(target), symbol: "" });
      continue;
    }
    links.push({
      kind: "symbol",
      raw,
      path: target.slice(0, hash),
      symbol: stripTrailingPunctuation(target.slice(hash + 1)),
    });
  }
  return links;
}

/**
 * Sentence punctuation is not part of a path. `see tl:file/a.ts.` should
 * resolve; a trailing `.` in a real filename is preserved because the strip
 * only runs when the character is unambiguously terminal.
 */
function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/u, "");
}

export function resolveEvidenceLink(link: EvidenceLink, context: EvidenceContext): boolean {
  switch (link.kind) {
    case "hunk":
      return context.hunkIds.has(link.hunkId);
    case "file":
      return context.treePaths.has(link.path);
    case "symbol":
      return (
        link.symbol.length > 0 &&
        context.treePaths.has(link.path) &&
        context.containsSymbol(link.path, link.symbol)
      );
  }
}

/** Human-facing text for a link that could not survive as a link. */
function displayText(link: EvidenceLink): string {
  switch (link.kind) {
    case "hunk":
      return link.hunkId;
    case "file":
      return link.path;
    case "symbol":
      return link.symbol.length > 0 ? link.symbol : link.path;
  }
}

export interface DowngradeResult {
  readonly markdown: string;
  /** The links that were flattened, for the run directory's honesty trail. */
  readonly downgraded: ReadonlyArray<string>;
}

/**
 * The floor: rewrite unresolvable links as plain text so the pipeline always
 * terminates with a valid artifact. The ladder above it (repair, then
 * regenerate the narration) exists so this is almost never stood on — and every
 * use is logged, because a silent downgrade would be exactly the kind of
 * unfalsifiable prose the product refuses to ship.
 */
export function downgradeUnresolvableLinks(
  markdown: string,
  context: EvidenceContext,
): DowngradeResult {
  const downgraded: string[] = [];
  const shouldDowngrade = (raw: string): boolean => {
    const [link] = extractEvidenceLinks(raw);
    if (link === undefined) return false;
    if (resolveEvidenceLink(link, context)) return false;
    downgraded.push(raw);
    return true;
  };

  // `[text](tl:…)` keeps its label; the link is what fails, not the sentence.
  let result = markdown.replace(
    /\[([^\]]*)\]\((tl:(?:hunk|file|symbol)\/[^)\s]+)\)/gu,
    (whole, label: string, target: string) => (shouldDowngrade(target) ? label : whole),
  );
  result = result.replace(/<(tl:(?:hunk|file|symbol)\/[^>\s]+)>/gu, (whole, target: string) => {
    if (!shouldDowngrade(target)) return whole;
    const [link] = extractEvidenceLinks(target);
    return link === undefined ? whole : displayText(link);
  });
  result = result.replace(LINK_PATTERN, (whole) => {
    if (!shouldDowngrade(whole)) return whole;
    const [link] = extractEvidenceLinks(whole);
    return link === undefined ? whole : displayText(link);
  });

  return { markdown: result, downgraded };
}

/**
 * Build the resolver context from a journey's own parts plus the pinned tree.
 * Kept here so the server and the renderer construct it the same way.
 */
export function makeEvidenceContext(input: {
  readonly hunkIds: Iterable<string>;
  readonly treePaths: Iterable<string>;
  readonly lineCounts: Iterable<readonly [string, { readonly old: number; readonly new: number }]>;
  readonly containsSymbol: (path: string, symbol: string) => boolean;
}): EvidenceContext {
  return {
    hunkIds: new Set(input.hunkIds),
    treePaths: new Set(input.treePaths),
    lineCounts: new Map(input.lineCounts),
    containsSymbol: input.containsSymbol,
  };
}
