/**
 * The guidance rail: scroll-bound help beside the code.
 *
 * It follows; it is never operated. Position in the code drives it — there are
 * no filters, no tabs, no controls. Clicking a hint scrolls the code to its
 * anchor; scrolling the code brings its hints alongside.
 *
 * Reading with it closed must remain a complete experience, which is why the
 * cluster's narrative leads the page rather than living here.
 *
 * @module features/journey/GuidanceRail
 */
import type { Hint, HintKind } from "@app/contracts";

import { Narrative, type EvidenceTarget } from "../../lib/markdown.tsx";
import { useJourney } from "./context.tsx";

const KIND_LABEL: Record<HintKind, string> = {
  connection: "Connection",
  complexity: "Complexity companion",
  ripple: "Ripple context",
  "pattern-echo": "Pattern echo",
  behavior: "Behavioral before / after",
  resurfacing: "Resurfacing note",
};

export function GuidanceRail() {
  const { visibleHints, setGuidanceOpen, requestScroll, journey, labelForHunk } = useJourney();

  const onEvidence = (target: EvidenceTarget) => {
    if (target.kind === "hunk") {
      requestScroll({ kind: "hunk", hunkId: target.hunkId });
      return;
    }
    requestScroll({ kind: "file", path: target.path });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-4">
        <span className="font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
          Guidance
          {visibleHints.length > 0 && (
            <span className="ml-2 tracking-normal normal-case">· following your position</span>
          )}
        </span>
        <button
          type="button"
          onClick={() => setGuidanceOpen(false)}
          title="Collapse guidance"
          className="cursor-pointer rounded px-1 text-[12px] text-faint transition-colors hover:text-foreground"
        >
          collapse →|
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-8">
        {visibleHints.length === 0 ? (
          <p className="px-1 pt-2 text-[12px] leading-relaxed text-faint">
            {journey.hints.length === 0
              ? "This journey carries no hints. The cluster’s narrative leads the page; the code is the rest."
              : "Nothing anchored to what’s on screen. Keep reading — hints arrive alongside the code they describe."}
          </p>
        ) : (
          visibleHints.map((hint, index) => (
            <HintCard
              key={hint.id}
              hint={hint}
              active={index === 0}
              labelForHunk={labelForHunk}
              onEvidence={onEvidence}
              onOpen={() =>
                requestScroll({
                  kind: "line",
                  path: hint.anchor.path,
                  side: hint.anchor.side,
                  line: hint.anchor.startLine,
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function HintCard({
  hint,
  active,
  onOpen,
  onEvidence,
  labelForHunk,
}: {
  readonly hint: Hint;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onEvidence: (target: EvidenceTarget) => void;
  readonly labelForHunk: (hunkId: string) => string | null;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`block w-full cursor-pointer rounded-lg border-l-2 px-3 py-3 text-left transition-all ${
        active
          ? "border-l-accent bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.14)]"
          : "border-l-transparent opacity-55 hover:opacity-90"
      }`}
    >
      <p className="font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
        {KIND_LABEL[hint.kind]}
      </p>
      <div className="mt-1.5 text-[13px] leading-relaxed text-foreground">
        <Narrative
          labelForHunk={labelForHunk}
          markdown={hint.body.markdown}
          onEvidence={onEvidence}
        />
      </div>
      <p className="mt-2 font-mono text-[11px] text-faint">
        {basename(hint.anchor.path)} · L{hint.anchor.startLine}
        {hint.anchor.endLine !== hint.anchor.startLine && `–${hint.anchor.endLine}`}
        <span className="ml-1">↕</span>
      </p>
    </button>
  );
}

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}
