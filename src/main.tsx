import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './AppRoot';
import './index.css';
import { leaveCachedShell, watchForNewBuild } from './lib/version';

// The router flags and the error boundary that keep a tool from blanking the
// whole app live in AppRoot, so a test can mount this exact tree.
// A shell that came out of a cache is a shell whose tool chunks may already be
// gone; step off it before anything lazily imports.
leaveCachedShell();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>
);

// A deploy made while this tab is open replaces the page rather than waiting for
// the reader to notice the old build.
watchForNewBuild();
