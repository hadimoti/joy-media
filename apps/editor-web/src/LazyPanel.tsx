import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';

interface LazyPanelBoundaryState {
  readonly error?: Error;
}

class LazyPanelBoundary extends Component<
  { readonly children: ReactNode; readonly label: string },
  LazyPanelBoundaryState
> {
  override state: LazyPanelBoundaryState = {};

  static getDerivedStateFromError(error: Error): LazyPanelBoundaryState {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <section className="panel-load-error" role="alert">
          <strong>{this.props.label} unavailable</strong>
          <p>That panel could not be loaded. Reload the editor and try again.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload editor
          </button>
        </section>
      );
    }
    return this.props.children;
  }
}

export function LazyPanel({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <LazyPanelBoundary label={label}>
      <Suspense
        fallback={
          <section className="panel-loading" role="status" aria-label={`Loading ${label}`}>
            Loading {label}…
          </section>
        }
      >
        {children}
      </Suspense>
    </LazyPanelBoundary>
  );
}
