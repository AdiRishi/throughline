import { createContext, useContext } from "react";
import type { Components, UrlTransform } from "react-markdown";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { localApi } from "../../localApi.ts";

const EvidenceNavigationContext = createContext<(uri: string) => void>(() => undefined);
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
  a: JourneyMarkdownAnchor,
};

const transformJourneyMarkdownUrl: UrlTransform = (url, key) =>
  key === "href" && url.startsWith("tl:") ? url : defaultUrlTransform(url);

export function JourneyMarkdown({
  markdown,
  onEvidence,
  className,
}: {
  readonly markdown: string;
  readonly onEvidence: (uri: string) => void;
  readonly className?: string;
}) {
  return (
    <EvidenceNavigationContext value={onEvidence}>
      <div className={className}>
        <ReactMarkdown
          components={MARKDOWN_COMPONENTS}
          remarkPlugins={REMARK_PLUGINS}
          urlTransform={transformJourneyMarkdownUrl}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </EvidenceNavigationContext>
  );
}

function JourneyMarkdownAnchor({ href, children, ...props }: React.ComponentProps<"a">) {
  const onEvidence = useContext(EvidenceNavigationContext);

  if (href?.startsWith("tl:")) {
    return (
      <a
        {...props}
        href={href}
        data-evidence-link
        onClick={(event) => {
          event.preventDefault();
          onEvidence(href);
        }}
      >
        {children}
      </a>
    );
  }

  if (href?.startsWith("https://") || href?.startsWith("http://")) {
    return (
      <a
        {...props}
        href={href}
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void localApi().openExternal(href);
        }}
      >
        {children}
      </a>
    );
  }

  return (
    <a {...props} href={href}>
      {children}
    </a>
  );
}
