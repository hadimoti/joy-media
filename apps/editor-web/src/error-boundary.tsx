import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
interface State {
  readonly error?: Error;
}
export class EditorErrorBoundary extends Component<{ readonly children: ReactNode }, State> {
  override state: State = {};
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}
  override render(): ReactNode {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <main role="alert">
        <h1>Editor recovered safely</h1>
        <p>{this.state.error.message}</p>
        <button onClick={() => this.setState({})}>Try again</button>
      </main>
    );
  }
}
