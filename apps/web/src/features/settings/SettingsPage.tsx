import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect } from "react";

import type { DesktopTheme, HarnessStatus } from "@app/contracts";

import {
  ArrowLeftIcon,
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "../../components/Icons.tsx";
import { useTheme } from "../../hooks/useTheme.ts";
import { productAtoms } from "../../state/product.ts";
import {
  automaticHarnessKind,
  harnessReadiness,
  isHarnessSelection,
  type HarnessReadiness,
} from "./model.ts";

const THEMES: ReadonlyArray<{
  readonly value: DesktopTheme;
  readonly label: string;
  readonly description: string;
  readonly icon: typeof SunIcon;
}> = [
  {
    value: "light",
    label: "Light",
    description: "A cool paper surface for bright rooms.",
    icon: SunIcon,
  },
  {
    value: "dark",
    label: "Dark",
    description: "The editor-receded reading surface.",
    icon: MoonIcon,
  },
  {
    value: "system",
    label: "System",
    description: "Follow this device’s appearance.",
    icon: MonitorIcon,
  },
];

export function SettingsPage() {
  const settings = useAtomValue(productAtoms.settings);
  const settingsResult = useAtomValue(productAtoms.settingsSyncResult);
  const harnesses = useAtomValue(productAtoms.harnesses);
  const harnessStatusResult = useAtomValue(productAtoms.harnessStatusResult);
  const refreshHarnessesResult = useAtomValue(productAtoms.refreshHarnesses);
  const setHarnessResult = useAtomValue(productAtoms.setHarness);
  const refreshHarnesses = useAtomSet(productAtoms.refreshHarnesses);
  const setHarness = useAtomSet(productAtoms.setHarness);
  const { setTheme, theme } = useTheme();

  const automatic = automaticHarnessKind(harnesses);
  const orderedHarnesses = harnesses.toSorted((left, right) => {
    const order = (kind: string) => (kind === "codex" ? 0 : kind === "claude" ? 1 : 2);
    return order(left.kind) - order(right.kind) || left.kind.localeCompare(right.kind);
  });

  useEffect(() => {
    const refreshOnFocus = () => {
      if (document.visibilityState === "visible") {
        refreshHarnesses(undefined);
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshHarnesses]);

  return (
    <main className="settings-page">
      <Link className="back-link" to="/">
        <ArrowLeftIcon />
        Back to reviews
      </Link>

      <header className="settings-heading">
        <p className="eyebrow">Settings</p>
        <h1>Keep the machinery quiet.</h1>
        <p>
          Choose which signed-in agent constructs future journeys and how Throughline meets your
          editor.
        </p>
      </header>

      <section className="settings-section" aria-labelledby="harness-heading">
        <div className="settings-section-heading">
          <div>
            <h2 id="harness-heading">Analysis harness</h2>
            <p>
              Throughline runs the selected harness read-only. Changing this affects future
              analyses, not saved journeys.
            </p>
          </div>
          <div className="settings-heading-actions">
            {settings.harness === undefined && automatic !== null ? (
              <span className="selection-note">Using {displayHarnessName(automatic)}</span>
            ) : null}
            <button
              className="button button-secondary button-small"
              type="button"
              disabled={refreshHarnessesResult.waiting}
              onClick={() => refreshHarnesses(undefined)}
            >
              {refreshHarnessesResult.waiting ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>

        <div className="selection-list" role="radiogroup" aria-label="Analysis harness">
          <label
            className="selection-row"
            data-selected={settings.harness === undefined || undefined}
          >
            <input
              className="sr-only"
              type="radio"
              name="analysis-harness"
              checked={settings.harness === undefined}
              onChange={() => setHarness(null)}
            />
            <SelectionMark selected={settings.harness === undefined} />
            <span className="selection-copy">
              <strong>Automatic</strong>
              <span>Use the first authenticated harness: Codex, then Claude.</span>
            </span>
            <span className="selection-status">
              {automatic === null ? "No harness ready" : displayHarnessName(automatic)}
            </span>
          </label>

          {AsyncResult.isFailure(harnessStatusResult) ? (
            <div className="settings-empty" role="alert">
              Harness detection stopped. Check again when the local server is ready.
            </div>
          ) : !AsyncResult.isSuccess(harnessStatusResult) ? (
            <div className="settings-loading" aria-busy="true">
              Detecting local harnesses…
            </div>
          ) : orderedHarnesses.length === 0 ? (
            <div className="settings-empty">
              No harnesses were detected. Install Codex or Claude Code, sign in once, then return
              here.
            </div>
          ) : (
            orderedHarnesses.map((harness) => {
              const selectableKind = isHarnessSelection(harness.kind) ? harness.kind : null;
              const selectable =
                selectableKind !== null && harnessReadiness(harness) === "ready"
                  ? selectableKind
                  : null;
              return (
                <HarnessSelectionRow
                  key={harness.kind}
                  harness={harness}
                  selected={settings.harness === selectableKind}
                  onSelect={selectable === null ? undefined : () => setHarness(selectable)}
                />
              );
            })
          )}
        </div>

        {AsyncResult.isFailure(settingsResult) || AsyncResult.isFailure(setHarnessResult) ? (
          <p className="action-error" role="alert">
            {AsyncResult.isFailure(setHarnessResult)
              ? causeMessage(setHarnessResult.cause)
              : AsyncResult.isFailure(settingsResult)
                ? causeMessage(settingsResult.cause)
                : null}
          </p>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="appearance-heading">
        <div className="settings-section-heading">
          <div>
            <h2 id="appearance-heading">Appearance</h2>
            <p>The code, tree, and journey surfaces follow this choice together.</p>
          </div>
        </div>

        <div className="theme-options" role="radiogroup" aria-label="Appearance">
          {THEMES.map((option) => {
            const ThemeIcon = option.icon;
            const selected = theme === option.value;
            return (
              <label
                key={option.value}
                className="theme-option"
                data-selected={selected || undefined}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name="appearance"
                  checked={selected}
                  onChange={() => setTheme(option.value)}
                />
                <ThemeIcon />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <SelectionMark selected={selected} />
              </label>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function HarnessSelectionRow({
  harness,
  selected,
  onSelect,
}: {
  readonly harness: HarnessStatus;
  readonly selected: boolean;
  readonly onSelect: (() => void) | undefined;
}) {
  const readiness = harnessReadiness(harness);
  const guidance = harnessGuidance(harness.kind, readiness);

  return (
    <label
      className="selection-row harness-row"
      data-selected={selected || undefined}
      data-disabled={onSelect === undefined || undefined}
    >
      <input
        className="sr-only"
        type="radio"
        name="analysis-harness"
        checked={selected}
        disabled={onSelect === undefined}
        onChange={onSelect}
      />
      <SelectionMark selected={selected} />
      <span className="selection-copy">
        <strong>
          {displayHarnessName(harness.kind)}
          {harness.version === null ? null : (
            <span className="version-label">v{harness.version}</span>
          )}
        </strong>
        <span>{guidance}</span>
      </span>
      <HarnessStatusLabel readiness={readiness} />
    </label>
  );
}

function HarnessStatusLabel({ readiness }: { readonly readiness: HarnessReadiness }) {
  const label = {
    ready: "Authenticated",
    "sign-in": "Sign in required",
    "not-installed": "Not installed",
    unknown: "Auth unknown",
  }[readiness];

  return (
    <span className="selection-status" data-readiness={readiness}>
      {label}
    </span>
  );
}

function SelectionMark({ selected }: { readonly selected: boolean }) {
  return (
    <span className="selection-mark" data-selected={selected || undefined} aria-hidden>
      {selected ? <CheckIcon /> : null}
    </span>
  );
}

function displayHarnessName(kind: string): string {
  if (kind === "codex") {
    return "Codex";
  }
  if (kind === "claude") {
    return "Claude Code";
  }
  return kind;
}

function harnessGuidance(kind: string, readiness: HarnessReadiness): string {
  if (readiness === "ready") {
    return "Ready to construct new journeys in a read-only workspace.";
  }
  if (readiness === "not-installed") {
    return `Install ${displayHarnessName(kind)}, then sign in once. Throughline will detect it automatically.`;
  }
  if (readiness === "sign-in") {
    return kind === "claude"
      ? "Sign in with Claude Code or run claude setup-token, then return here."
      : "Run codex login, then return here.";
  }
  return "Installed, but authentication could not be confirmed. Open the harness and verify its login.";
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The setting was not saved. Try again when the local server is ready.";
}
