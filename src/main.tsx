import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './AppRoot';
import './index.css';

// The router flags and the error boundary that keep a tool from blanking the
// whole app live in AppRoot, so a test can mount this exact tree.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>
);
