/**
 * The window frame: a title bar and whatever the route puts under it.
 *
 * The frame is deliberately thin. Reading a cluster should feel like sitting in
 * your own editor, and the way to make that true is to give the code the room
 * — so the only permanent chrome is one line of identity and the gear.
 *
 * @module AppFrame
 */
import { useAtomValue } from "@effect/atom-react";
import { Link, useMatchRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { connectionAtoms } from "./state/connection.ts";
import { welcomeAtoms } from "./state/welcome.ts";

export function AppFrame({ children }: { readonly children: ReactNode }) {
  const matchRoute = useMatchRoute();
  const insideJourney = matchRoute({ to: "/pr/$owner/$repo/$number", fuzzy: true }) !== false;
  const onSettings = matchRoute({ to: "/settings" }) !== false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      {/* The journey's own header lives in its layout, which knows the PR. */}
      {!insideJourney && <TitleBar showBack={onSettings} />}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function TitleBar({ showBack }: { readonly showBack: boolean }) {
  const view = useAtomValue(welcomeAtoms.view);
  const connection = useAtomValue(connectionAtoms.state);

  return (
    <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4 select-none">
      <div className="flex items-center gap-3">
        {showBack ? (
          <Link to="/" className="text-[13px] text-muted transition-colors hover:text-foreground">
            ← Back
          </Link>
        ) : (
          <span className="text-[13px] font-semibold tracking-tight">Throughline</span>
        )}
      </div>
      <div className="flex items-center gap-3 text-[12px] text-muted">
        {connection.phase !== "connected" && (
          <span className="flex items-center gap-1.5">
            <span className="tl-pulse inline-block h-1.5 w-1.5 rounded-full bg-faint" />
            {connection.phase}
          </span>
        )}
        {view.viewer.login !== null && <span>@{view.viewer.login} · authenticated via gh</span>}
        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className="rounded-md p-1 text-faint transition-colors hover:bg-raised hover:text-foreground"
        >
          <GearIcon />
        </Link>
      </div>
    </header>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6.6 1.9h2.8l.35 1.6 1.2.7 1.55-.5 1.4 2.42-1.2 1.1v1.4l1.2 1.1-1.4 2.42-1.55-.5-1.2.7-.35 1.6H6.6l-.35-1.6-1.2-.7-1.55.5L2.1 9.72l1.2-1.1v-1.4L2.1 6.12l1.4-2.42 1.55.5 1.2-.7.35-1.6Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
