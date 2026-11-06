import { HashRouter } from 'react-router-dom';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';

/**
 * The tree mounted at `#root`, split out of `main.tsx` so a test can render the
 * exact production configuration instead of a copy of it.
 *
 * Both wrappers here are load-bearing and were absent when the site shipped a
 * white screen on every tool-card click:
 *
 * 1. `v7_startTransition` — tool panels are `React.lazy`. Navigating from the
 *    dashboard is synchronous input, so without a transition the panel suspends
 *    while React is flushing a sync update and throws minified error #426.
 *    React then unmounts the tree: blank page, one console line.
 * 2. `ErrorBoundary` — with nothing catching that throw, the whole app
 *    disappeared instead of one panel. It also turns a stale-chunk 404 (an open
 *    tab after a deploy) into a "reload" prompt rather than a white page.
 */
export function AppRoot() {
  return (
    <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ErrorBoundary label="app" resetKey="app">
        <App />
      </ErrorBoundary>
    </HashRouter>
  );
}

export default AppRoot;
