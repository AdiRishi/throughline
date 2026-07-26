import type { DisplayMode, Hint, HintKind } from "@app/contracts";

import { Markdown, type EvidenceHandlers } from "../../ui/Markdown.tsx";

/**
 * The right rail: a margin, not a dashboard.
 *
 * Three rules from `docs/product/05-guidance.md` decide every line of this file,
 * and they are all rules about what the rail *refuses* to be.
 *
 * 1. **It follows; it is never operated.** Position in the code drives it, so the
 *    only prop that changes what is prominent is `visiblePaths` — the paths the
 *    reading surface reports on screen. There are no filters, no tabs, no sort,
 *    no kind selector. A collapse toggle is the single control, because a rail
 *    that cannot be closed is not quiet.
 * 2. **Anchored, always.** Every hint is one click from the code it describes, and
 *    the anchor is printed on the card — never a tooltip. A reviewer must be able
 *    to read the anchor without moving the mouse.
 * 3. **Quiet.** Reading with the rail closed has to remain a complete experience,
 *    which is why nothing lives here that lives nowhere else: hints are colour and
 *    connection over the code, and the cluster's narrative — which leads the page —
 *    carries the load-bearing prose.
 *
 * The one subtlety worth stating. Hints bind in every display mode, but a hint
 * anchored to the **old** side has nothing to attach to in just-the-code, where the
 * head revision is on screen and the deleted lines are not. Those hints are
 * omitted there — and said out loud at the foot of the rail, because a hint that
 * silently disappears is worse than one that explains its absence.
 *
 * Prominence is spent on *position*, never on colour: the accent belongs to the
 * current cluster's hunks and to nothing else, so an on-screen hint earns a raised
 * background and full-strength text rather than an accent edge.
 *
 * @module features/journey/GuidanceRail
 */

/** Kind as a small-caps label. Comprehension categories — never severity. */
const KIND_LABEL: Record<HintKind, string> = {
  connection: "connection",
  ripple: "ripple context",
  behavior: "behavioral before / after",
  "pattern-echo": "pattern echo",
  complexity: "complexity",
  resurfacing: "resurfacing note",
};

export interface GuidanceRailProps {
  /** The open cluster's hints, in the order their anchors appear in the code. */
  readonly hints: ReadonlyArray<Hint>;
  /** Paths the reading surface currently has on screen. Drives prominence. */
  readonly visiblePaths: ReadonlyArray<string>;
  readonly displayMode: DisplayMode;
  /**
   * Paths whose *old* side is still rendered in just-the-code — deleted files,
   * which fall back to their deletion diff because there is no head revision to
   * show in silence. Old-side hints on these paths still bind.
   */
  readonly oldSideBindablePaths: ReadonlySet<string>;
  readonly onHintClick: (hint: Hint) => void;
  /** Hint bodies are narrative, so their `tl:` evidence navigates like any other. */
  readonly evidenceHandlers: EvidenceHandlers;
  readonly onCollapse: () => void;
}

export function GuidanceRail({
  hints,
  visiblePaths,
  displayMode,
  oldSideBindablePaths,
  onHintClick,
  evidenceHandlers,
  onCollapse,
}: GuidanceRailProps) {
  const bound = hints.filter((hint) => canBind({ hint, displayMode, oldSideBindablePaths }));
  const omitted = hints.length - bound.length;

  // The rail follows the reader: hints anchored to a file on screen float to the
  // top and read at full strength, the rest stay in anchor order underneath.
  const onScreen = new Set(visiblePaths);
  const ordered = [
    ...bound.filter((hint) => onScreen.has(hint.anchor.path)),
    ...bound.filter((hint) => !onScreen.has(hint.anchor.path)),
  ];

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-[11px] tracking-[0.12em] text-faint uppercase">guidance</span>
        {ordered.length > 0 && (
          <span className="truncate text-[11px] text-faint">· following your position</span>
        )}
        <button
          type="button"
          id="collapse-guidance"
          onClick={onCollapse}
          title="collapse guidance"
          aria-label="collapse guidance"
          className="ml-auto cursor-pointer rounded-sm px-1 text-[13px] text-faint transition-colors hover:text-foreground"
        >
          <span aria-hidden>⇥</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {ordered.length === 0 ? (
          <p className="px-1 text-[12px] leading-relaxed text-muted">
            {hints.length === 0
              ? "no hints for this cluster. the narrative leads it, and the code carries the rest."
              : "every hint here points at removed lines. switch to the diff to read them alongside the code."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {ordered.map((hint) => (
              <li key={hint.id}>
                <HintCard
                  hint={hint}
                  prominent={onScreen.has(hint.anchor.path)}
                  onActivate={onHintClick}
                  evidenceHandlers={evidenceHandlers}
                />
              </li>
            ))}
          </ul>
        )}

        {omitted > 0 && ordered.length > 0 && (
          <p className="mt-4 border-t border-border px-1 pt-3 text-[11px] leading-relaxed text-faint">
            {omitted === 1 ? "1 hint waits" : `${omitted} hints wait`} on the diff —{" "}
            {omitted === 1 ? "it points" : "they point"} at removed lines, and just-the-code shows
            the head revision only.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * One hint.
 *
 * The anchor line is the real control, and the whole card is a convenience target
 * over it. That split is forced by the content: a hint body is narrative, so it may
 * hold `tl:` evidence links, and those are buttons — which a `<button>` element may
 * not contain. So the anchor carries the semantics ("scroll to guards.ts · L10")
 * where it is also printed as text, and a click anywhere else on the card lands on
 * the same action. Clicks that start on a nested control are left alone rather than
 * fought over.
 */
function HintCard({
  hint,
  prominent,
  onActivate,
  evidenceHandlers,
}: {
  readonly hint: Hint;
  readonly prominent: boolean;
  readonly onActivate: (hint: Hint) => void;
  readonly evidenceHandlers: EvidenceHandlers;
}) {
  const label = anchorLabel(hint);

  return (
    <div
      id={`hint-${hint.id}`}
      onClick={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest("button, a") !== null) {
          return;
        }
        onActivate(hint);
      }}
      className={`cursor-pointer rounded-md px-3 py-2.5 transition-colors ${
        prominent
          ? "border border-l-2 border-border border-l-border-strong bg-raised"
          : "border border-transparent hover:bg-raised/60"
      }`}
    >
      <p
        className={`text-[10px] tracking-[0.12em] uppercase ${
          prominent ? "text-muted" : "text-faint"
        }`}
      >
        {KIND_LABEL[hint.kind]}
      </p>
      <div
        className={`mt-1.5 text-[12px] leading-relaxed ${
          prominent ? "text-foreground" : "text-muted"
        }`}
      >
        <Markdown markdown={hint.body.markdown} handlers={evidenceHandlers} />
      </div>
      <button
        type="button"
        onClick={() => onActivate(hint)}
        title={`scroll to ${label}`}
        className="mt-2 cursor-pointer font-mono text-[11px] text-faint transition-colors hover:text-muted"
      >
        {label} <span aria-hidden>⇕</span>
      </button>
    </div>
  );
}

/** `guards.ts · L10` — the file's own name, because the rail sits beside the code. */
function anchorLabel(hint: Hint): string {
  const { path, side, startLine, endLine } = hint.anchor;
  const slash = path.lastIndexOf("/");
  const name = slash === -1 ? path : path.slice(slash + 1);
  const lines = endLine > startLine ? `L${startLine}–${endLine}` : `L${startLine}`;
  // The side is named only when it is the old one: in a diff, "old L41" is the
  // difference between the line that went away and the line that took its place.
  return side === "old" ? `${name} · old ${lines}` : `${name} · ${lines}`;
}

function canBind(input: {
  readonly hint: Hint;
  readonly displayMode: DisplayMode;
  readonly oldSideBindablePaths: ReadonlySet<string>;
}): boolean {
  if (input.hint.anchor.side === "new") return true;
  if (input.displayMode !== "just-the-code") return true;
  return input.oldSideBindablePaths.has(input.hint.anchor.path);
}
