import type { ReactNode } from "react";

import type { Weight } from "@app/contracts";

/**
 * The whole visual vocabulary, in one file.
 *
 * It is small on purpose. "Chrome must earn its place": the reading experience's
 * interaction set is deliberately tiny, so the number of *kinds* of control the
 * product needs is tiny too. Anything that would express severity, risk, or
 * quality is deliberately absent — there is no `Badge` with a colour prop here,
 * because a colour prop is how a calm product becomes a chip farm.
 *
 * @module ui/primitives
 */

/**
 * Weight as a quiet text label, never a colour system. It guides comprehension
 * effort and must never read as risk, severity, or quality.
 */
export function WeightLabel({
  weight,
  className,
}: {
  readonly weight: Weight;
  readonly className?: string;
}) {
  return (
    <span className={`text-[12px] text-muted ${className ?? ""}`}>{WEIGHT_LABEL[weight]}</span>
  );
}

const WEIGHT_LABEL: Record<Weight, string> = {
  core: "Core",
  supporting: "Supporting",
  mechanical: "Mechanical",
};

/**
 * Progress as a segmented meter: one segment per cluster, filled by that
 * cluster's progress. It reads as a journey rather than a percentage, which is
 * the point — the reviewer is walking steps, not filling a bar.
 */
export function JourneyMeter({
  segments,
  className,
}: {
  readonly segments: ReadonlyArray<number>;
  readonly className?: string;
}) {
  return (
    <div className={`flex gap-1 ${className ?? ""}`} aria-hidden>
      {segments.map((fraction, index) => (
        <span
          key={index}
          className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-border"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/** A single thin bar, for the one place a fraction is all there is to say. */
export function Meter({
  fraction,
  className,
}: {
  readonly fraction: number;
  readonly className?: string;
}) {
  return (
    <span
      className={`relative block h-[3px] overflow-hidden rounded-full bg-border ${className ?? ""}`}
      aria-hidden
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${Math.round(fraction * 100)}%` }}
      />
    </span>
  );
}

/** A quiet, low-emphasis action. The default button of this product. */
export function QuietButton({
  children,
  onClick,
  disabled,
  title,
  id,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-border-strong hover:text-foreground disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** The one emphasised action on a surface, and never more than one. */
export function PrimaryButton({
  children,
  onClick,
  disabled,
  id,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-md bg-foreground px-3 py-1.5 text-[12px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * A parked state: `gh` missing, a rate limit, no harness. Calm and instructive —
 * these are states with a remedy, not errors, and the remedy is the content.
 */
export function Notice({
  title,
  children,
  action,
  tone = "calm",
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: "calm" | "attention";
}) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 ${
        tone === "attention" ? "border-accent/40 bg-accent-soft/30" : "border-border bg-card"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[13px] font-medium">{title}</p>
          {children !== undefined && (
            <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>
          )}
        </div>
        {action !== undefined && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/** `+9,914 −2,507`. Diff-native colour, never a judgement. */
export function DiffCounts({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}) {
  return (
    <span className="font-mono text-[12px] whitespace-nowrap">
      <span className="text-added">+{additions.toLocaleString()}</span>{" "}
      <span className="text-removed">−{deletions.toLocaleString()}</span>
    </span>
  );
}

/** A monospace, low-contrast fact. Machinery speaks monospace in this product. */
export function Fact({ children }: { readonly children: ReactNode }) {
  return <span className="font-mono text-[12px] text-muted">{children}</span>;
}

/**
 * Wire text, reproduced character for character, with the backticks the server
 * wrote around a command rendered as monospace.
 *
 * Setup instruction (`detail` on a harness, a viewer, GitHub health) is authored
 * copy that contains the exact command to run, so it is never paraphrased — the
 * only licence this product takes with it is typographic, because machinery speaks
 * monospace here. An unbalanced set of backticks is printed exactly as written
 * rather than guessed at: a mangled command is worse than an unstyled one.
 */
export function CommandText({ text }: { readonly text: string }) {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <code
            key={`${index}:${part}`}
            className="rounded bg-raised px-1 py-[1px] font-mono text-[12px] text-foreground"
          >
            {part}
          </code>
        ) : (
          <span key={`${index}:${part}`}>{part}</span>
        ),
      )}
    </>
  );
}

export function Separator() {
  return (
    <span aria-hidden className="text-border-strong">
      ·
    </span>
  );
}

/** Relative time, in the app's voice: short, human, never a timestamp. */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

/** "leaves in 4 days" / "leaves tomorrow" — the merged section's honest expiry. */
export function leavesIn(mergedAt: Date, retentionDays = 7, now: Date = new Date()): string {
  const elapsed = (now.getTime() - mergedAt.getTime()) / 86_400_000;
  const remaining = Math.max(0, Math.ceil(retentionDays - elapsed));
  if (remaining <= 0) return "leaves today";
  if (remaining === 1) return "leaves tomorrow";
  return `leaves in ${remaining} days`;
}
