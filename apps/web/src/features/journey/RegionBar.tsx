/**
 * The reading footer: where you are in the file's changed regions, and the
 * navigation for stepping through them.
 *
 * A region is a fact about the diff, not about how it is drawn, so this behaves
 * identically in inline, split, and just-the-code — and `n`/`p` do the same
 * thing everywhere.
 *
 * @module features/journey/RegionBar
 */
import { useEffect } from "react";

import { useJourney } from "./context.tsx";

export function RegionBar({ children }: { readonly children?: React.ReactNode }) {
  const { regions } = useJourney();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "n") {
        event.preventDefault();
        regions.go(1);
      } else if (event.key === "p") {
        event.preventDefault();
        regions.go(-1);
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [regions]);

  return (
    <footer className="flex h-9 shrink-0 items-center justify-between gap-4 border-t border-border px-4 font-mono text-[11.5px] text-muted">
      {/* `whitespace-nowrap` so a narrow window shortens the neighbour titles
          rather than wrapping them — a wrapped label is taller than the bar and
          spills out of it. */}
      <div className="flex min-w-0 items-center gap-3 overflow-hidden whitespace-nowrap">
        {children}
      </div>
      {regions.total > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-faint">
            region {regions.current} of {regions.total}
          </span>
          <button
            type="button"
            onClick={() => regions.go(-1)}
            title="Previous changed region (p)"
            className="cursor-pointer rounded border border-border px-1.5 transition-colors hover:border-border-strong hover:text-foreground"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => regions.go(1)}
            title="Next changed region (n)"
            className="cursor-pointer rounded border border-border px-1.5 transition-colors hover:border-border-strong hover:text-foreground"
          >
            ↓ next change
          </button>
        </div>
      )}
    </footer>
  );
}
