import { useAtomSet } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import type { DisplayMode } from "@app/contracts";

import { setDisplayModeAtom } from "../../state/journeyState.ts";
import { Separator } from "../../ui/primitives.tsx";
import { useJourney } from "./JourneyLayout.tsx";

/**
 * The top bar: which pull request this is, and how its code renders.
 *
 * It holds two things and refuses the rest. **Identity** — `owner/repo · #number`
 * and the pull request's title — because a receded frame still has to answer what
 * the reviewer is inside of. **Display mode**, because the mode is journey-wide and
 * the bar is the one place equally near every file on screen.
 *
 * The subtlety in the toggle: the product has *three* modes but the bar shows *two*
 * segments. `Diff` is not a mode, it is the diff arrangement the reviewer was last
 * in — inline or split — so a split reader who steps into just-the-code and back
 * lands in split, not in someone else's default. The file headers' own inline/split
 * control writes the same journey-wide mode; placement is reach, not scope, so both
 * controls read and write one value and cannot diverge.
 *
 * Everything else a bar like this usually accumulates — approve, comment, open on
 * GitHub, search — is deliberately absent: none of it is in the reading
 * experience's interaction set, and judgement actions live on GitHub.
 *
 * @module features/journey/JourneyTopBar
 */

export function JourneyTopBar() {
  const { journey, displayMode } = useJourney();
  const setDisplayMode = useAtomSet(setDisplayModeAtom);

  /**
   * The arrangement the `Diff` segment returns to. Renderer ephemera by
   * definition — a memory of a preference the reviewer already expressed, not a
   * fact about the journey, so it never travels to the server.
   */
  const lastDiffArrangement = useRef<DisplayMode>("inline");
  useEffect(() => {
    if (displayMode !== "just-the-code") lastDiffArrangement.current = displayMode;
  }, [displayMode]);

  const apply = (next: DisplayMode) => {
    if (next === displayMode) return;
    setDisplayMode({ journeyId: journey.id, displayMode: next });
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-3">
      <Link
        to="/"
        id="back-to-welcome"
        aria-label="back to your pull requests"
        title="back to your pull requests"
        className="shrink-0 rounded-md px-1.5 py-1 text-[13px] leading-none text-faint transition-colors hover:text-foreground"
      >
        &larr;
      </Link>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-mono text-[12px] whitespace-nowrap text-muted">
          {journey.pr.owner}/{journey.pr.repo}
        </span>
        <Separator />
        <span className="shrink-0 font-mono text-[12px] text-muted">#{journey.pr.number}</span>
        {/* The title truncates rather than wraps: the bar's height is part of how
            much room the code gets. */}
        <h1 className="min-w-0 truncate text-[13px] font-medium" title={journey.prWords.title}>
          {journey.prWords.title}
        </h1>
      </div>

      <SegmentedControl
        label="display mode"
        value={displayMode === "just-the-code" ? "code" : "diff"}
        onChange={(value) =>
          apply(value === "code" ? "just-the-code" : lastDiffArrangement.current)
        }
        options={[
          { value: "diff", label: "Diff", id: "display-mode-diff" },
          { value: "code", label: "Code", id: "display-mode-code" },
        ]}
      />
    </header>
  );
}

/**
 * Two segments, one of them current. Used by the bar and by the left rail — the
 * product has exactly one two-state chooser shape, and both places have to look
 * like the same control or the frame stops reading as one thing.
 *
 * The active segment is *lighter* than its track in both themes, which needs the
 * `dark:` variant rather than one token pair: `card` is the brightest surface in
 * light and `raised` is the brightest in dark.
 *
 * It would live in `ui/primitives` if this surface were allowed to add a file
 * there; until then this is its single definition, imported rather than copied.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  fill = false,
}: {
  readonly options: ReadonlyArray<{
    readonly value: T;
    readonly label: string;
    readonly id: string;
  }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  /** Stretch the segments to the container's width, as the rail's does. */
  readonly fill?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex shrink-0 gap-0.5 rounded-md border border-border bg-raised p-[2px] dark:bg-background ${
        fill ? "w-full" : ""
      }`}
    >
      {options.map((option) => {
        const current = option.value === value;
        return (
          <button
            key={option.value}
            id={option.id}
            type="button"
            aria-pressed={current}
            onClick={() => onChange(option.value)}
            className={`cursor-pointer rounded-[5px] px-3 py-1 text-[12px] transition-colors ${
              fill ? "flex-1" : ""
            } ${
              current
                ? "bg-card font-medium text-foreground dark:bg-raised"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
