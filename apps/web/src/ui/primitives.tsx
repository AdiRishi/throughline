/**
 * The small set of shared UI pieces.
 *
 * Deliberately small: the product's design principle is that chrome must earn
 * its place, and a component library is chrome that earns it by being used. If
 * something here has one caller, it belongs at that caller.
 *
 * @module ui/primitives
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

import type { Weight } from "@app/contracts";

type ButtonTone = "default" | "primary" | "quiet";

export function Button({
  tone = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: ButtonTone }) {
  const tones: Record<ButtonTone, string> = {
    default:
      "border border-border bg-raised text-foreground hover:border-border-strong hover:bg-surface",
    primary: "border border-transparent bg-foreground text-background hover:opacity-90",
    quiet: "border border-transparent text-muted hover:bg-raised hover:text-foreground",
  };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className ?? ""}`}
    />
  );
}

/** Weight is a quiet text label, never a colour system. */
export function WeightLabel({
  weight,
  className,
}: {
  readonly weight: Weight;
  readonly className?: string;
}) {
  const label = weight === "core" ? "Core" : weight === "supporting" ? "Supporting" : "Mechanical";
  return <span className={`text-[12px] text-faint ${className ?? ""}`}>{label}</span>;
}

/**
 * The journey's progress, one segment per cluster. Segments rather than a
 * single bar because a journey is a sequence, and the shape of what is left
 * should be visible at a glance.
 */
export function SegmentedProgress({
  fractions,
  className,
}: {
  readonly fractions: ReadonlyArray<number>;
  readonly className?: string;
}) {
  if (fractions.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 ${className ?? ""}`} aria-hidden>
      {fractions.map((fraction, index) => (
        <span
          // eslint-disable-next-line react/no-array-index-key -- position is the identity
          key={index}
          className="h-[3px] flex-1 overflow-hidden rounded-full bg-border"
        >
          <span
            className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
          />
        </span>
      ))}
    </div>
  );
}

export function Bar({
  fraction,
  className,
}: {
  readonly fraction: number;
  readonly className?: string;
}) {
  return (
    <span className={`block h-[3px] overflow-hidden rounded-full bg-border ${className ?? ""}`}>
      <span
        className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` }}
      />
    </span>
  );
}

/** A calm, instructive banner. Parked states are states, not errors. */
export function Notice({
  title,
  children,
  action,
}: {
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        {children !== undefined && (
          <div className="mt-1 text-[13px] leading-relaxed text-muted">{children}</div>
        )}
      </div>
      {action}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "default",
}: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
  readonly size?: "default" | "small";
}) {
  const padding = size === "small" ? "px-2 py-[3px] text-[11px]" : "px-3 py-1 text-[12px]";
  return (
    <div className="inline-flex rounded-md border border-border bg-raised p-[2px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={option.value === value}
          className={`rounded-[5px] font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent ${padding} ${
            option.value === value
              ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
              : "text-muted hover:text-foreground"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Relative time, in the register the designs use ("2 days ago", "leaves in 4 days"). */
export function relativeTime(from: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - from.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export function countdown(days: number): string {
  if (days <= 0) return "leaves today";
  if (days === 1) return "leaves tomorrow";
  return `leaves in ${days} days`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
