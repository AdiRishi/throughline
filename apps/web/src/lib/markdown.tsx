/**
 * Narrative rendering: Markdown with one extension, `tl:` evidence links.
 *
 * A purpose-built renderer rather than a Markdown library, for one reason that
 * matters: evidence links are the product's central claim, and they have to
 * resolve to *navigation* — scroll to a hunk, open a file — not to an anchor
 * tag. Owning the inline parser is what makes that a first-class case instead
 * of a post-processing hack over someone else's output.
 *
 * The supported subset is what the agent is asked to write: paragraphs, lists,
 * bold, inline code, and links.
 *
 * @module lib/markdown
 */
import type { ReactNode } from "react";

export type EvidenceTarget =
  | { readonly kind: "hunk"; readonly hunkId: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "symbol"; readonly path: string; readonly symbol: string };

export interface NarrativeProps {
  readonly markdown: string;
  /** Called when the reviewer follows an evidence link. */
  readonly onEvidence?: (target: EvidenceTarget) => void;
  /**
   * Turns a bare `tl:hunk/h12` into something a person can read. The journey
   * knows what h12 is; this module deliberately does not.
   */
  readonly labelForHunk?: (hunkId: string) => string | null;
  readonly className?: string;
}

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const BOLD = /\*\*([^*]+)\*\*/;
const CODE = /`([^`]+)`/;
const BARE_EVIDENCE = /tl:(?:hunk|file|symbol)\/[^\s)>\]`"']+/;

export function parseEvidenceHref(href: string): EvidenceTarget | null {
  if (!href.startsWith("tl:")) return null;
  const rest = href.slice(3).replace(/[.,;:!?]+$/u, "");
  if (rest.startsWith("hunk/")) return { kind: "hunk", hunkId: rest.slice(5) };
  if (rest.startsWith("file/")) return { kind: "file", path: rest.slice(5) };
  if (rest.startsWith("symbol/")) {
    const target = rest.slice(7);
    const hash = target.lastIndexOf("#");
    if (hash <= 0) return { kind: "file", path: target };
    return { kind: "symbol", path: target.slice(0, hash), symbol: target.slice(hash + 1) };
  }
  return null;
}

/** Display text for an evidence link written without a label. */
function evidenceLabel(target: EvidenceTarget): string {
  switch (target.kind) {
    case "hunk":
      return target.hunkId;
    case "file":
      return basename(target.path);
    case "symbol":
      return target.symbol;
  }
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function Narrative({ markdown, onEvidence, className }: NarrativeProps) {
  return <div className={`tl-prose ${className ?? ""}`}>{renderBlocks(markdown, onEvidence)}</div>;
}

function renderBlocks(
  markdown: string,
  onEvidence?: NarrativeProps["onEvidence"],
  labelForHunk?: NarrativeProps["labelForHunk"],
): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={`p${blocks.length}`}>{renderInline(paragraph.join(" "), onEvidence)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`u${blocks.length}`}>
        {list.map((item, index) => (
          // eslint-disable-next-line react/no-array-index-key -- list order is the content
          <li key={index}>{renderInline(item, onEvidence, labelForHunk)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
    if (bullet?.[1] !== undefined) {
      flushParagraph();
      list.push(bullet[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * One pass over the inline grammar, longest-match-first at each position. A
 * regex-per-construct approach would mangle nesting; this keeps the text
 * exactly as written and only lifts out what it recognizes.
 */
function renderInline(
  text: string,
  onEvidence?: NarrativeProps["onEvidence"],
  labelForHunk?: NarrativeProps["labelForHunk"],
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const candidates = [
      { kind: "link" as const, match: LINK.exec(rest) },
      { kind: "code" as const, match: CODE.exec(rest) },
      { kind: "bold" as const, match: BOLD.exec(rest) },
      { kind: "bare" as const, match: BARE_EVIDENCE.exec(rest) },
    ].filter((candidate) => candidate.match !== null);

    if (candidates.length === 0) {
      nodes.push(rest);
      break;
    }
    const next = candidates.reduce((best, candidate) =>
      (candidate.match?.index ?? 0) < (best.match?.index ?? 0) ? candidate : best,
    );
    const match = next.match;
    if (match === null) break;

    if (match.index > 0) nodes.push(rest.slice(0, match.index));

    switch (next.kind) {
      case "code":
        nodes.push(<code key={key++}>{match[1]}</code>);
        break;
      case "bold":
        nodes.push(<strong key={key++}>{match[1]}</strong>);
        break;
      case "link": {
        const label = match[1] ?? "";
        const href = match[2] ?? "";
        const target = parseEvidenceHref(href);
        // The label is prose too — `code` and **bold** inside a link should
        // render, not appear as literal markup.
        // A label that is just the identifier is not a label. Prefer something
        // the reviewer can actually read.
        const readable =
          target?.kind === "hunk" && label.trim() === target.hunkId
            ? (labelForHunk?.(target.hunkId) ?? label)
            : label;
        const labelNodes = renderInline(readable, undefined, labelForHunk);
        nodes.push(
          target === null ? (
            <a
              key={key++}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-accent"
            >
              {labelNodes}
            </a>
          ) : (
            <EvidenceLink key={key++} target={target} label={labelNodes} onEvidence={onEvidence} />
          ),
        );
        break;
      }
      case "bare": {
        const target = parseEvidenceHref(match[0]);
        nodes.push(
          target === null ? (
            match[0]
          ) : (
            <EvidenceLink
              key={key++}
              target={target}
              label={
                (target.kind === "hunk" ? labelForHunk?.(target.hunkId) : null) ??
                evidenceLabel(target)
              }
              onEvidence={onEvidence}
            />
          ),
        );
        break;
      }
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return nodes;
}

function EvidenceLink({
  target,
  label,
  onEvidence,
}: {
  readonly target: EvidenceTarget;
  readonly label: ReactNode;
  readonly onEvidence?: NarrativeProps["onEvidence"];
}) {
  const title =
    target.kind === "hunk"
      ? `Go to hunk ${target.hunkId}`
      : target.kind === "file"
        ? `Open ${target.path}`
        : `Open ${target.path} at ${target.symbol}`;

  // A span, not a button: a button is `inline-block` by user-agent default,
  // which turns a link that wraps mid-sentence into a block that shoves the
  // prose around it. Evidence has to read as part of the sentence.
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      onClick={() => onEvidence?.(target)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onEvidence?.(target);
        }
      }}
      className="tl-evidence"
    >
      {label}
    </span>
  );
}
