import { useAtomSet } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import { useState } from "react";

import { resolveUrlAtom, startIngestionAtom } from "../../state/journeyState.ts";
import { Notice, QuietButton } from "../../ui/primitives.tsx";
import { doorDetail } from "./welcomeCopy.ts";

/**
 * The quieter of the two doors.
 *
 * The list is the primary path; this exists for the pull request that is not in
 * it — a public repository the reviewer wants to try Throughline on, a one-off
 * review. The docs call it "visually subordinate", so it is: a dashed outline
 * instead of a card, a placeholder instead of a heading, and a quiet button where
 * every row above has an emphasised one. Same pipeline, different door.
 *
 * It resolves *before* it navigates. Rejection happens at the door by design —
 * a bad URL or a repository `gh` cannot see is the one place in the product where
 * "no" is an allowed answer — and the rejection's `detail` is authored copy, so it
 * is shown verbatim rather than wrapped in a diagnosis of our own. Landing the
 * reviewer on a transition that can never start would be the alternative.
 *
 * @module features/welcome/UrlDoor
 */

export function UrlDoor() {
  const navigate = useNavigate();
  const resolveUrl = useAtomSet(resolveUrlAtom, { mode: "promiseExit" });
  const startIngestion = useAtomSet(startIngestionAtom, { mode: "promiseExit" });

  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);

  const open = async (): Promise<void> => {
    const trimmed = url.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setRejection(null);

    const resolved = await resolveUrl(trimmed);
    if (Exit.isFailure(resolved)) {
      setRejection(doorDetail(resolved.cause));
      setBusy(false);
      return;
    }

    // Starting is idempotent and joins a job already running for this PR, so the
    // same call serves "analyze this" and "reopen this".
    const ref = resolved.value;
    const started = await startIngestion({ ref, reanalyze: false });
    if (Exit.isFailure(started)) {
      setRejection(doorDetail(started.cause));
      setBusy(false);
      return;
    }

    setBusy(false);
    void navigate({
      to: "/pr/$owner/$repo/$number",
      params: { owner: ref.owner, repo: ref.repo, number: String(ref.number) },
    });
  };

  return (
    <section className="mt-10 max-w-[560px]">
      <form
        onSubmit={(event) => {
          // The quiet button is a plain button, so Enter reaches the journey
          // through implicit submission and both paths run the same code.
          event.preventDefault();
          void open();
        }}
        className="flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3"
      >
        <LinkGlyph />
        <label htmlFor="pr-url-input" className="sr-only">
          Pull request URL
        </label>
        <input
          id="pr-url-input"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Review a PR that isn’t in your list — paste its URL"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-faint"
        />
        <QuietButton id="open-pr-url" onClick={() => void open()} disabled={busy}>
          {busy ? "Opening…" : "Open"}
        </QuietButton>
      </form>

      {rejection !== null && (
        <div className="mt-3">
          <Notice
            title="That pull request cannot be opened"
            action={
              <QuietButton id="dismiss-url-rejection" onClick={() => setRejection(null)}>
                Dismiss
              </QuietButton>
            }
          >
            {rejection}
          </Notice>
        </div>
      )}
    </section>
  );
}

function LinkGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden
      className="shrink-0 text-faint"
    >
      <path d="M6.4 9.6 9.6 6.4" />
      <path d="M7.4 5 8.9 3.5a2.5 2.5 0 0 1 3.6 3.6L11 8.6" />
      <path d="M8.6 11 7.1 12.5a2.5 2.5 0 0 1-3.6-3.6L5 7.4" />
    </svg>
  );
}
