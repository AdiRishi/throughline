import { Component, type ReactNode } from "react";

/**
 * The only thing React gives you for a render throw: a class component with
 * `getDerivedStateFromError`. Without one, a single bad render blanks the
 * window — in the shell there is not even a URL bar to reload from.
 *
 * `fallback` may be a node (a local, inline replacement) or a function of the
 * captured error plus a `reset` that clears the failure and re-renders the
 * children — which is what the root boundary needs to offer "Try again".
 */
export interface RenderErrorFallbackProps {
  readonly error: unknown;
  readonly reset: () => void;
}

export class RenderErrorBoundary extends Component<
  {
    readonly children: ReactNode;
    readonly fallback: ReactNode | ((props: RenderErrorFallbackProps) => ReactNode);
  },
  { readonly failed: boolean; readonly error: unknown }
> {
  override state = { failed: false, error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  private readonly reset = () => {
    this.setState({ failed: false, error: undefined });
  };

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return typeof this.props.fallback === "function"
      ? this.props.fallback({ error: this.state.error, reset: this.reset })
      : this.props.fallback;
  }
}
