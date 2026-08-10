import { errorDetails, errorMessage } from "../errors.ts";
import type { RenderErrorFallbackProps } from "./RenderErrorBoundary.tsx";

/**
 * What a render throw looks like instead of a blank window: the message, the
 * stack behind a disclosure, and two ways out. "Try again" re-renders in place
 * (enough for a transient failure); "Reload app" is the shell's missing URL bar.
 */
export function AppErrorView({ error, reset }: RenderErrorFallbackProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="flex min-h-full items-center justify-center px-6 py-10">
      <section className="w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-lg">
        <h1 className="text-lg font-semibold tracking-tight">Something went wrong.</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-accent-contrast transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium transition-colors hover:border-accent"
          >
            Reload app
          </button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border bg-background">
          <summary className="cursor-pointer list-none px-3 py-2 font-mono text-xs text-muted">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border px-3 py-2 font-mono text-xs">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}
