import { Component, type ReactNode } from 'react';

/** Keeps one broken page from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="content">
        <div className="banner bad" style={{ flexDirection: 'column', gap: 8 }}>
          <strong>This page ran into a problem.</strong>
          <span className="small mono">{this.state.error.message}</span>
          <div>
            <button className="btn sm" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
