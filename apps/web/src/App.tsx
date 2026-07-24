import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { ConnectionPhase } from "@app/client-runtime/connection";

import { GearIcon } from "./components/Icons.tsx";
import { localApi } from "./localApi.ts";
import { connectionAtoms } from "./state/connection.ts";
import { productAtoms } from "./state/product.ts";

const CONNECTION_LABEL: Record<ConnectionPhase, string> = {
  idle: "Waiting",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  blocked: "Connection parked",
};

export function App() {
  const connection = useAtomValue(connectionAtoms.state);
  const config = useAtomValue(connectionAtoms.serverConfig);
  const viewer = useAtomValue(productAtoms.viewer);
  const navigate = useNavigate();
  const [aboutOpen, setAboutOpen] = useState(false);
  const desktopPlatform = localApi().getAppInfo()?.platform;

  useEffect(
    () =>
      localApi().onMenuAction((action) => {
        if (action === "preferences") {
          void navigate({ to: "/settings" });
        } else if (action === "about") {
          setAboutOpen(true);
        }
      }),
    [navigate],
  );
  useEffect(() => {
    if (!aboutOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAboutOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [aboutOpen]);

  return (
    <div className="app-frame" data-desktop-platform={desktopPlatform}>
      <header className="titlebar">
        <Link className="brand" to="/" aria-label="Throughline home">
          <span className="brand-mark" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span>{config?.appName ?? "Throughline"}</span>
        </Link>

        <div className="titlebar-actions">
          <span
            className="connection-summary"
            title={
              connection.lastError ??
              `${CONNECTION_LABEL[connection.phase]} to the local Throughline server`
            }
          >
            <span className="connection-dot" data-phase={connection.phase} aria-hidden />
            <span className="connection-label">{CONNECTION_LABEL[connection.phase]}</span>
          </span>
          {viewer?.auth === "authenticated" && viewer.login !== null ? (
            <span className="viewer-label">@{viewer.login} · authenticated via gh</span>
          ) : null}
          <Link className="icon-button" to="/settings" aria-label="Open settings" title="Settings">
            <GearIcon />
          </Link>
        </div>
      </header>

      <div className="app-surface">
        <Outlet />
      </div>

      {aboutOpen ? (
        <div className="about-backdrop">
          <button
            className="about-dismiss-layer"
            type="button"
            aria-label="Close About Throughline"
            onClick={() => setAboutOpen(false)}
          />
          <dialog open className="about-dialog" aria-labelledby="about-title" aria-modal="true">
            <span className="brand-mark about-brand-mark" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            <p className="eyebrow">About</p>
            <h1 id="about-title">{config?.appName ?? "Throughline"}</h1>
            <p>
              A local PR comprehension system that turns a large change into an ordered,
              evidence-backed journey.
            </p>
            <small>Version {config?.version ?? "0.0.0"}</small>
            <button
              autoFocus
              className="button button-secondary"
              type="button"
              onClick={() => setAboutOpen(false)}
            >
              Close
            </button>
          </dialog>
        </div>
      ) : null}
    </div>
  );
}
