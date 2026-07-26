/**
 * Settings: harness choice and appearance. One quiet page, off the main surface.
 *
 * Throughline ships no model. Analysis runs on the reviewer's own harnesses,
 * riding their existing logins — so this page's real job is to say plainly what
 * is installed, what is signed in, and which one the next analysis will use.
 *
 * @module features/settings/SettingsPage
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";

import type { DesktopTheme, HarnessKind, HarnessStatus } from "@app/contracts";

import { useTheme } from "../../hooks/useTheme.ts";
import {
  harnessStatusAtom,
  harnessStatusLoadingAtom,
  updateSettingsAtom,
} from "../../state/settings.ts";
import { Segmented } from "../../ui/primitives.tsx";

const THEMES: ReadonlyArray<DesktopTheme> = ["light", "dark", "system"];

export function SettingsPage() {
  const status = useAtomValue(harnessStatusAtom);
  const loading = useAtomValue(harnessStatusLoadingAtom);
  const update = useAtomSet(updateSettingsAtom);
  const { theme, setTheme } = useTheme();

  return (
    <div className="h-full overflow-y-auto">
      <main className="mx-auto w-full max-w-2xl px-8 pt-12 pb-24">
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>

        <section className="mt-9">
          <h2 className="font-mono text-[10.5px] tracking-[0.14em] text-faint uppercase">
            Analysis harness
          </h2>
          <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
            Throughline ships no model. Analyses run on your own agent harness, using the login you
            already have. Nothing leaves your machine except what that harness already sends.
          </p>

          <div className="mt-4 space-y-2">
            <HarnessOption
              kind={null}
              label="Automatic"
              detail={
                status.active === null
                  ? "Nothing usable is installed yet."
                  : `Uses the first signed-in harness — currently ${status.active}.`
              }
              selected={status.selected === null}
              usable
              onSelect={() => update(null)}
            />
            {loading && status.harnesses.length === 0 && (
              <p className="px-1 text-[13px] text-faint">Checking what’s installed…</p>
            )}
            {status.harnesses.map((harness) => (
              <HarnessOption
                key={harness.kind}
                kind={harness.kind}
                label={harness.label}
                detail={describe(harness)}
                selected={status.selected === harness.kind}
                usable={harness.installed && harness.auth !== "unauthenticated"}
                onSelect={() => update(harness.kind)}
              />
            ))}
          </div>

          <p className="mt-3 text-[12px] text-faint">
            Changing this affects future analyses only. To apply it to a journey you already have,
            reanalyze that pull request.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="font-mono text-[10.5px] tracking-[0.14em] text-faint uppercase">
            Appearance
          </h2>
          <div className="mt-3">
            <Segmented
              value={theme}
              options={THEMES.map((option) => ({
                value: option,
                label: option.charAt(0).toUpperCase() + option.slice(1),
              }))}
              onChange={setTheme}
            />
          </div>
        </section>
      </main>
    </div>
  );
}

function describe(harness: HarnessStatus): string {
  if (!harness.installed) return harness.detail;
  const version = harness.version === null ? "" : ` ${harness.version}`;
  switch (harness.auth) {
    case "authenticated":
      return `Installed${version} · signed in`;
    case "unauthenticated":
      return `Installed${version} · not signed in — ${harness.detail}`;
    default:
      return `Installed${version} · sign-in state unknown until it runs`;
  }
}

function HarnessOption({
  label,
  detail,
  selected,
  usable,
  onSelect,
}: {
  readonly kind: HarnessKind | null;
  readonly label: string;
  readonly detail: string;
  readonly selected: boolean;
  readonly usable: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors ${
        selected ? "border-border-strong bg-surface" : "border-border hover:border-border-strong"
      }`}
    >
      <span
        className={`mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-foreground" : "border-border-strong"
        }`}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-medium">
          {label}
          {!usable && <span className="ml-2 text-[12px] font-normal text-faint">unavailable</span>}
        </span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{detail}</span>
      </span>
    </button>
  );
}
