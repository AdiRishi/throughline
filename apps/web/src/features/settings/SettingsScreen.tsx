import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState, type ReactNode } from "react";

import type { DesktopTheme, HarnessKind, HarnessReport, HarnessStatus } from "@app/contracts";

import { useTheme } from "../../hooks/useTheme.ts";
import { connectionAtoms } from "../../state/connection.ts";
import { harnessReportAtom, settingsAtom, updateSettingsAtom } from "../../state/journeyState.ts";
import { failureDetail } from "../../ui/failure.ts";
import { CommandText, Fact, Notice, QuietButton, relativeTime } from "../../ui/primitives.tsx";

/**
 * A quiet corner, not a control panel.
 *
 * There are exactly two things a reviewer can decide about Throughline — which
 * harness analyzes, and how the app looks — so this is one page with no tabs, no
 * advanced section, and no flags. Clustering in particular is absent by design:
 * the journey is read-only, so there is nothing to configure about it.
 *
 * Three things shape what is written here:
 *
 * - **The harness list is a report, not a promise.** Throughline ships no model
 *   and holds no secrets; analysis runs on the reviewer's own install, under the
 *   reviewer's own login. So every row states what was actually probed — installed
 *   or not, signed in or not — and when the server wrote setup instruction into
 *   `detail`, that instruction is reproduced verbatim: it contains the exact
 *   command, and paraphrasing it would cost the reviewer the one thing they need.
 * - **A choice here is about the next analysis.** An existing journey pinned the
 *   harness it used into its provenance, so changing the selection cannot reach
 *   backwards. The page says that plainly rather than letting a reviewer conclude
 *   that switching re-decided a journey they already have.
 * - **A selected-but-unusable harness parks, it does not fall back.** The server
 *   refuses to quietly analyze with something the reviewer did not pick, which
 *   makes `active === null` a real state this page has to explain — including when
 *   the reason is the reviewer's own selection.
 *
 * Nothing on this page spends the accent colour: it means emphasis of the current
 * cluster's hunks, and a settings page has no hunks. What is selected here is
 * shown with a filled dot and a raised surface instead. (Weight is a cluster's
 * attention classification and has no meaning on this page either.)
 *
 * @module features/settings/SettingsScreen
 */

export function SettingsScreen() {
  return (
    <div id="settings-screen" className="flex h-full flex-col overflow-hidden">
      {/* The bar holds the way out and nothing else — the app's own chrome never
          sits inside the reviewer's content. */}
      <header className="flex h-11 shrink-0 items-center border-b border-border px-5">
        <Link
          id="settings-back"
          to="/"
          className="flex cursor-pointer items-center gap-2 text-[13px] text-muted transition-colors hover:text-foreground"
        >
          <span aria-hidden>←</span> Throughline
        </Link>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] px-8 pt-12 pb-24">
          <div className="tl-rise">
            <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-muted">
              Which harness analyzes, and how the app looks. Both live on this machine.
            </p>
          </div>
          <HarnessSection />
          <AppearanceSection />
          <AboutSection />
        </div>
      </main>
    </div>
  );
}

/** One quiet band of the page: a small-caps label, an optional fact, content. */
function Section({
  id,
  title,
  meta,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly meta?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} className="mt-12">
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2">
        <h2 className="font-mono text-[11px] tracking-[0.14em] text-faint uppercase">{title}</h2>
        {meta}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ── The harness ─────────────────────────────────────────────────────────────

function HarnessSection() {
  const result = useAtomValue(harnessReportAtom);
  const settingsResult = useAtomValue(settingsAtom);
  const update = useAtomSet(updateSettingsAtom, { mode: "promiseExit" });
  const refreshReport = useAtomRefresh(harnessReportAtom);
  const refreshSettings = useAtomRefresh(settingsAtom);

  /**
   * The last choice this page wrote *and the server confirmed*. It outranks the
   * fetched settings on purpose: re-probing two CLIs takes seconds, and a radio
   * that snapped back to the old answer while that ran would read as a rejected
   * click. `undefined` means this page has written nothing yet.
   */
  const [confirmed, setConfirmed] = useState<HarnessKind | null | undefined>(undefined);
  const [writeFailure, setWriteFailure] = useState<string | null>(null);

  const report = AsyncResult.isSuccess(result) ? result.value : null;
  // The report carries the same `selected` the store holds, so a settings fetch
  // that has not landed (or failed) still leaves the radio group truthful.
  const stored = AsyncResult.isSuccess(settingsResult)
    ? settingsResult.value.harness
    : (report?.selected ?? null);
  const chosen = confirmed === undefined ? stored : confirmed;

  /**
   * Re-probe. The only control on this page beyond the two documented choices,
   * and it appears only inside a parked or failed notice — those are the states
   * where the remedy happens *outside* the app (a `login` run in a terminal) and
   * detection is cached, so without it the page cannot notice the fix.
   */
  const recheck = (
    <QuietButton id="recheck-harnesses" onClick={refreshReport}>
      Check again
    </QuietButton>
  );

  const choose = async (harness: HarnessKind | null): Promise<void> => {
    setWriteFailure(null);
    const exit = await update({ harness });
    if (Exit.isFailure(exit)) {
      // A selection that did not persist must not look like one that did.
      setWriteFailure(failureDetail(exit.cause));
      return;
    }
    setConfirmed(exit.value.harness);
    // `active` is the server's computation over this choice, and the server drops
    // its detection cache on every write — so the answer to "what runs next" has
    // to be asked for again rather than inferred here.
    refreshSettings();
    refreshReport();
  };

  return (
    <Section
      id="analysis-harness"
      title="Analysis harness"
      meta={<ProbeMeta probedAt={report?.probedAt ?? null} waiting={result.waiting} />}
    >
      <p className="text-[13px] leading-relaxed text-muted">
        Throughline analyzes with your own agent harness, riding your own login. It ships no model
        and holds no secrets of its own.
      </p>

      {report === null ? (
        AsyncResult.isFailure(result) ? (
          <div className="mt-4">
            <Notice title="Throughline could not read your harnesses" action={recheck}>
              {failureDetail(result.cause)}
            </Notice>
          </div>
        ) : (
          // Probing shells out to two CLIs and opens a zero-token session, so this
          // line is on screen for a moment on every visit. It says what is happening.
          <p className="tl-fade mt-4 text-[13px] text-muted">
            Looking for the harnesses installed on this machine…
          </p>
        )
      ) : report.harnesses.length === 0 ? (
        // Nothing to list is a designed state, not a blank fieldset: with no rows
        // there is no selection to make, and the page says what it looked for.
        <div id="harness-options" className="mt-5">
          <Notice title="No harness was found on this machine" action={recheck}>
            Throughline looks for the Codex CLI and Claude Code. Install one and sign in to it, then
            check again — until then, analysis cannot run.
          </Notice>
        </div>
      ) : (
        <>
          <fieldset id="harness-options" className="mt-5 space-y-2">
            <legend className="sr-only">Which harness analyzes a pull request</legend>
            <HarnessOption
              id="harness-auto"
              name="Auto-select"
              checked={chosen === null}
              onSelect={() => void choose(null)}
              detail="Use the first signed-in harness, in the order listed here."
            />
            {report.harnesses.map((status) => (
              <HarnessOption
                key={status.kind}
                id={`harness-${status.kind}`}
                name={status.label}
                version={status.version}
                checked={chosen === status.kind}
                onSelect={() => void choose(status.kind)}
                detail={<HarnessState status={status} />}
                marker={report.active === status.kind ? "runs the next analysis" : undefined}
              />
            ))}
          </fieldset>

          {/* The fact most easily assumed away, so it is said outright — and it
              points at Reanalyze, which is the control that actually applies it. */}
          <p className="mt-4 text-[13px] leading-relaxed text-muted">
            Changing this affects future analyses only. A journey records the harness that built it,
            so to apply a new choice to a journey you already have, reanalyze that pull request.
          </p>

          {report.active === null && (
            <div className="mt-4">
              <ParkedNotice report={report} chosen={chosen} action={recheck} />
            </div>
          )}

          {writeFailure !== null && (
            <div className="mt-4">
              <Notice
                title="That choice was not saved"
                action={
                  <QuietButton id="dismiss-settings-failure" onClick={() => setWriteFailure(null)}>
                    Dismiss
                  </QuietButton>
                }
              >
                {writeFailure}
              </Notice>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * One choice. A real radio input, sr-only, so the group keeps native keyboard
 * behaviour and the visible row is free to be a row: name, version, state, and —
 * for the one that would actually run — a plain-language marker rather than a
 * badge.
 */
function HarnessOption({
  id,
  name,
  version,
  checked,
  onSelect,
  detail,
  marker,
}: {
  readonly id: string;
  readonly name: string;
  readonly version?: string | null | undefined;
  readonly checked: boolean;
  readonly onSelect: () => void;
  readonly detail: ReactNode;
  readonly marker?: string | undefined;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
        checked
          ? "border-border-strong bg-raised"
          : "border-border bg-card hover:border-border-strong"
      }`}
    >
      <input
        type="radio"
        id={id}
        name="harness-selection"
        className="sr-only"
        checked={checked}
        onChange={onSelect}
      />
      <span
        aria-hidden
        className={`mt-[3px] h-[13px] w-[13px] shrink-0 rounded-full border transition-colors ${
          checked ? "border-foreground bg-foreground" : "border-border-strong"
        }`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 text-[13px] font-medium">
            {name}
            {version !== null && version !== undefined && (
              <>
                {" "}
                <Fact>{version}</Fact>
              </>
            )}
          </span>
          {marker !== undefined && (
            <span className="shrink-0 text-[12px] text-muted">{marker}</span>
          )}
        </span>
        <span className="mt-1 block text-[13px] leading-relaxed text-muted">{detail}</span>
      </span>
    </label>
  );
}

/**
 * What was probed, in the order a reviewer asks it: is it here, and can it run.
 * `detail` wins whenever the server wrote one, because it is authored instruction
 * — the exact command — and this page has nothing truer to say than that.
 */
function HarnessState({ status }: { readonly status: HarnessStatus }) {
  // The server's `detail` already names the state it is instructing about ("Codex
  // is installed but not signed in. Run `codex login`."), so it replaces the
  // sentence below rather than joining it — restating it would be noise.
  if (status.detail !== null && status.detail.trim().length > 0) {
    return <CommandText text={status.detail} />;
  }
  if (!status.installed || status.auth === "missing") return <>Not installed.</>;
  switch (status.auth) {
    case "authenticated":
      return <>Installed and signed in.</>;
    case "unauthenticated":
      return <>Installed, not signed in.</>;
    default:
      return <>Installed. Throughline could not tell whether it is signed in.</>;
  }
}

/**
 * Nothing can analyze. A parked state with a remedy, so the remedy is the
 * content — and the ways to get here need different sentences, because one of them
 * is the reviewer's own selection rather than a missing install.
 *
 * The "check again" is here and only here: this is the one state where the page
 * has to notice something the reviewer changed outside it (a `login` they just
 * ran in a terminal).
 */
function ParkedNotice({
  report,
  chosen,
  action,
}: {
  readonly report: HarnessReport;
  readonly chosen: HarnessKind | null;
  readonly action: ReactNode;
}) {
  const selected =
    chosen === null ? null : (report.harnesses.find((status) => status.kind === chosen) ?? null);
  return (
    <Notice title="Analysis cannot run yet" action={action}>
      {selected !== null ? (
        <p>
          {selected.label} is chosen here but is not ready, and Throughline never quietly analyzes
          with something you did not choose. Sign in to it, or select another harness above.
        </p>
      ) : chosen === null ? (
        <p>
          No harness on this machine is signed in, so there is nothing for an analysis to run on.
          Each row above carries the exact command; run one, then check again.
        </p>
      ) : (
        // A choice the probe cannot account for: still the reviewer's selection,
        // so it parks rather than falling back, and saying so beats a wrong reason.
        <p>
          The harness chosen here is not one Throughline found on this machine. Select another
          harness above.
        </p>
      )}
    </Notice>
  );
}

/** When these states were read. Detection is cached, so freshness is a fact. */
function ProbeMeta({
  probedAt,
  waiting,
}: {
  readonly probedAt: DateTime.Utc | null;
  readonly waiting: boolean;
}) {
  if (waiting) return <Fact>checking…</Fact>;
  if (probedAt === null) return null;
  return <Fact>checked {relativeTime(DateTime.toDate(probedAt))}</Fact>;
}

// ── Appearance ──────────────────────────────────────────────────────────────

const THEMES: ReadonlyArray<{ readonly value: DesktopTheme; readonly label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/**
 * Appearance is a host setting, not a server one: it is written to local storage
 * (where the pre-mount guard reads it) and forwarded to the shell, so it applies
 * before the next window ever paints.
 */
function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  return (
    <Section id="appearance" title="Appearance">
      <fieldset className="flex w-fit gap-1 rounded-lg border border-border bg-card p-1">
        <legend className="sr-only">Appearance</legend>
        {THEMES.map((option) => {
          const active = theme === option.value;
          return (
            <label
              key={option.value}
              htmlFor={`theme-${option.value}`}
              className={`cursor-pointer rounded-md px-3 py-1 text-[12px] transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
                active
                  ? "bg-raised font-medium text-foreground"
                  : "text-muted hover:text-foreground"
              }`}
            >
              <input
                type="radio"
                id={`theme-${option.value}`}
                name="theme"
                className="sr-only"
                checked={active}
                onChange={() => setTheme(option.value)}
              />
              {option.label}
            </label>
          );
        })}
      </fieldset>
      <p className="mt-3 text-[13px] text-muted">System follows this computer’s appearance.</p>
    </Section>
  );
}

// ── About ───────────────────────────────────────────────────────────────────

/**
 * The version comes from the local server rather than the bundle, because the
 * server is the process that actually does the work — and it is null until the
 * first round trip, which this says instead of guessing a number.
 */
function AboutSection() {
  const config = useAtomValue(connectionAtoms.serverConfig);
  return (
    <Section id="about" title="About">
      <p className="text-[13px] font-medium">{config?.appName ?? "Throughline"}</p>
      <p className="mt-1">
        {config === null ? (
          <Fact>version arrives with the local server</Fact>
        ) : (
          <Fact>version {config.version}</Fact>
        )}
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-muted">
        Everything is local-first: there is no Throughline cloud and no telemetry. GitHub access
        rides your own gh login, analysis rides your own harness login, and your read state never
        leaves this machine.
      </p>
    </Section>
  );
}
