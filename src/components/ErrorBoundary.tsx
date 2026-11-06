import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Change this to clear the error automatically — e.g. the current route. */
  resetKey?: string;
  /** Names the failing region in the console, since one boundary covers many tools. */
  label?: string;
};

type State = { error: Error | null };

/**
 * A tool that throws during render used to take the whole app down: with no
 * boundary anywhere, React unmounts the root and the tab shows a blank page
 * with no clue. This keeps the shell standing and says what happened.
 *
 * The chunk-load case deserves its own copy. After a deploy, an already-open
 * tab holds an `index.html` whose hashed chunks no longer all exist, so the
 * first click on a lazily-loaded tool rejects its dynamic import. That is not a
 * bug in the tool, and "Reload" is the whole fix.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[browsersnip] ${this.props.label ?? 'view'} failed to render${info.componentStack ? `:${info.componentStack}` : ''}`,
      error,
    );
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const text = `${error.name} ${error.message}`;
    const staleChunk = /dynamically imported module|Loading chunk \d+ failed|Importing a module script failed|Failed to fetch/i.test(text);

    return (
      <div className="mx-auto max-w-lg px-6 py-16">
        <div className="rounded-2xl border border-cream-border bg-cream-light p-6 shadow-doodle-card">
          <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted">
            {staleChunk ? 'Stale bundle' : 'Something broke'}
          </p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-[-0.02em] text-ink">
            {staleChunk ? 'This tool needed a file that moved' : 'This view hit an error'}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">
            {staleChunk
              ? 'A new version was published since this tab was opened, so the code for this tool is no longer where the page expected it. Reloading fixes it — no files were lost, since nothing leaves your browser anyway.'
              : 'The rest of the site is still working, and your file never left this tab. Try again, or head back to the tools and use another one.'}
          </p>
          {!staleChunk && (
            <pre className="mt-4 max-h-32 overflow-auto rounded-xl bg-cream border border-cream-border p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
              {error.message || error.name || 'Unknown error'}
            </pre>
          )}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl border border-cream-border bg-cream px-4 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-cream-soft hover:text-ink"
            >
              Reload the page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
