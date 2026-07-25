import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { useTheme } from "../hooks/useTheme.ts";
import { productAtoms } from "../state/product.ts";

export function SettingsScreen() {
  const harnessesResult = useAtomValue(productAtoms.harnesses);
  const settingsResult = useAtomValue(productAtoms.settings);
  const updateSettings = useAtomSet(productAtoms.updateSettings);
  const { theme, setTheme } = useTheme();
  const harnesses = AsyncResult.isSuccess(harnessesResult) ? harnessesResult.value : [];
  const settings = AsyncResult.isSuccess(settingsResult) ? settingsResult.value : {};

  return (
    <main className="settings-page">
      <p className="eyebrow">Preferences</p>
      <h1>Settings</h1>
      <section className="settings-section">
        <div>
          <h2>Appearance</h2>
          <p>Match the system or keep the reading room fixed.</p>
        </div>
        <div className="segmented">
          {(["light", "dark", "system"] as const).map((option) => (
            <button
              key={option}
              className={theme === option ? "active" : ""}
              onClick={() => setTheme(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Analysis harness</h2>
          <p>Throughline runs the selected agent read-only inside the pinned worktree.</p>
        </div>
        <div className="harness-options">
          {harnesses.map((harness) => (
            <button
              key={harness.kind}
              className={settings.harness === harness.kind ? "selected" : ""}
              onClick={() => updateSettings({ harness: harness.kind })}
            >
              <span>{harness.kind === "codex" ? "Codex" : "Claude Code"}</span>
              <small>
                {harness.installed ? harness.auth : "not installed"} ·{" "}
                {harness.kind === "codex" ? "recommended" : "available"}
              </small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div>
          <h2>Privacy</h2>
          <p>
            Journey artifacts, reading progress, and review state remain in Throughline’s local data
            directory.
          </p>
        </div>
        <span className="local-badge">Local only</span>
      </section>
    </main>
  );
}
