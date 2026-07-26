import { marked, type Token, type Tokens } from "marked";
import { Fragment, type ReactNode } from "react";

import { parseEvidenceUri, type EvidenceLink } from "@app/journey/evidence";

/**
 * The narrative renderer.
 *
 * Narrative is Markdown with one extension: a link target may be a `tl:` URI, and
 * the renderer resolves those to *navigation* rather than to an href. That is what
 * makes the vision's "every claim is evidence-backed" a live property of the UI —
 * clicking a claim takes the reviewer to the code that proves it.
 *
 * Rendering walks `marked`'s token tree rather than emitting HTML, for two
 * reasons: it keeps the supported set deliberately small (this is prose beside
 * code, not a document — no headings, no images), and it means no
 * `dangerouslySetInnerHTML` anywhere in the product, so agent-written prose can
 * never inject markup.
 *
 * @module ui/Markdown
 */

export interface EvidenceHandlers {
  /** Scroll to a hunk, wherever it is currently rendered. */
  readonly onHunk?: (hunkId: string) => void;
  /** Open a file. */
  readonly onFile?: (path: string) => void;
  /** Open a file and frame the symbol. */
  readonly onSymbol?: (path: string, symbol: string) => void;
}

export function Markdown({
  markdown,
  handlers,
  className,
}: {
  readonly markdown: string;
  readonly handlers?: EvidenceHandlers;
  readonly className?: string;
}) {
  const tokens = marked.lexer(markdown.trim());
  return (
    <div className={`tl-prose ${className ?? ""}`}>
      <Tokens tokens={tokens} handlers={handlers} />
    </div>
  );
}

function Tokens({
  tokens,
  handlers,
}: {
  readonly tokens: ReadonlyArray<Token>;
  readonly handlers: EvidenceHandlers | undefined;
}) {
  return (
    <>
      {tokens.map((token, index) => (
        <Fragment key={index}>{renderToken(token, handlers)}</Fragment>
      ))}
    </>
  );
}

function renderToken(token: Token, handlers: EvidenceHandlers | undefined): ReactNode {
  switch (token.type) {
    case "paragraph":
      return <p>{renderInline((token as Tokens.Paragraph).tokens ?? [], handlers)}</p>;
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens === undefined ? text.text : renderInline(text.tokens, handlers);
    }
    case "space":
      return null;
    case "list": {
      const list = token as Tokens.List;
      const items = list.items.map((item, index) => (
        <li key={index}>{renderInline(item.tokens ?? [], handlers)}</li>
      ));
      return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case "list_item":
      return <li>{renderInline((token as Tokens.ListItem).tokens ?? [], handlers)}</li>;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-border bg-raised p-3 text-[12px]">
          <code>{(token as Tokens.Code).text}</code>
        </pre>
      );
    case "blockquote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-muted">
          <Tokens tokens={(token as Tokens.Blockquote).tokens ?? []} handlers={handlers} />
        </blockquote>
      );
    case "hr":
      return <hr className="border-border" />;
    // Headings would make a narrative into a document. Render the text, drop the
    // hierarchy — the page owns the hierarchy, the prose does not.
    case "heading":
      return (
        <p className="font-semibold">
          {renderInline((token as Tokens.Heading).tokens ?? [], handlers)}
        </p>
      );
    default:
      return "text" in token ? (token.text as string) : null;
  }
}

function renderInline(
  tokens: ReadonlyArray<Token>,
  handlers: EvidenceHandlers | undefined,
): ReactNode {
  return tokens.map((token, index) => (
    <Fragment key={index}>{renderInlineToken(token, handlers)}</Fragment>
  ));
}

function renderInlineToken(token: Token, handlers: EvidenceHandlers | undefined): ReactNode {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      // A bare `tl:` URI in prose is still a link, so plain text is scanned too.
      return text.tokens === undefined
        ? withBareEvidence(text.text, handlers)
        : renderInline(text.tokens, handlers);
    }
    case "strong":
      return <strong>{renderInline((token as Tokens.Strong).tokens ?? [], handlers)}</strong>;
    case "em":
      return <em>{renderInline((token as Tokens.Em).tokens ?? [], handlers)}</em>;
    case "codespan":
      return <code>{(token as Tokens.Codespan).text}</code>;
    case "br":
      return <br />;
    case "del":
      return <del>{renderInline((token as Tokens.Del).tokens ?? [], handlers)}</del>;
    case "link": {
      const link = token as Tokens.Link;
      const evidence = parseEvidenceUri(link.href);
      const label = renderInline(link.tokens ?? [], handlers);
      if (evidence !== null) {
        return (
          <EvidenceLinkButton evidence={evidence} handlers={handlers}>
            {label}
          </EvidenceLinkButton>
        );
      }
      // An ordinary link opens outside the app; Throughline is not a browser.
      return (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline decoration-accent/40 underline-offset-2"
        >
          {label}
        </a>
      );
    }
    default:
      return "text" in token ? (token.text as string) : null;
  }
}

const BARE_EVIDENCE = /tl:(?:hunk|file|symbol)\/[^\s)\]<>"'`]+/g;

/** Split plain text on bare `tl:` URIs so they render as evidence too. */
function withBareEvidence(text: string, handlers: EvidenceHandlers | undefined): ReactNode {
  if (!text.includes("tl:")) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(BARE_EVIDENCE)) {
    const start = match.index;
    const raw = match[0].replace(/[.,;:!?/]+$/, "");
    const evidence = parseEvidenceUri(raw);
    if (evidence === null) continue;
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <EvidenceLinkButton key={`${start}`} evidence={evidence} handlers={handlers}>
        {readableLabel(evidence)}
      </EvidenceLinkButton>,
    );
    cursor = start + raw.length;
  }
  if (cursor === 0) return text;
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function readableLabel(evidence: EvidenceLink): string {
  switch (evidence.kind) {
    case "hunk":
      return evidence.hunkId;
    case "file":
      return evidence.path;
    case "symbol":
      return evidence.symbol;
  }
}

function EvidenceLinkButton({
  evidence,
  handlers,
  children,
}: {
  readonly evidence: EvidenceLink;
  readonly handlers: EvidenceHandlers | undefined;
  readonly children: ReactNode;
}) {
  const activate = () => {
    switch (evidence.kind) {
      case "hunk":
        handlers?.onHunk?.(evidence.hunkId);
        break;
      case "file":
        handlers?.onFile?.(evidence.path);
        break;
      case "symbol":
        handlers?.onSymbol?.(evidence.path, evidence.symbol);
        break;
    }
  };
  const title =
    evidence.kind === "symbol"
      ? `${evidence.symbol} in ${evidence.path}`
      : evidence.kind === "file"
        ? evidence.path
        : `hunk ${evidence.hunkId}`;

  return (
    <button
      type="button"
      onClick={activate}
      title={title}
      className="cursor-pointer rounded-sm text-accent underline decoration-accent/40 underline-offset-2 transition-colors hover:decoration-accent"
    >
      {children}
    </button>
  );
}
