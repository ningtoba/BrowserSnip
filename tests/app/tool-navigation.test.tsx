/**
 * Regression test for the production white screen.
 *
 * Clicking a tool card navigates inside a click handler. Several tools mount a
 * `React.lazy` panel, so that navigation suspends during synchronous input and
 * React throws minified error #426; with no error boundary the result was an
 * empty `#root`. Direct URL loads never hit it, which is why the bug survived
 * every earlier check.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { AppRoot } from '@/AppRoot';
import { ErrorBoundary } from '@/components/ErrorBoundary';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.location.hash = '';
});

/**
 * Render a throwing element inside a boundary.
 *
 * In development React re-throws boundary-caught errors at the caller so that
 * devtools and `window.onerror` still see them, after the fallback has already
 * been committed. The throw is expected, so swallow it and assert on the DOM.
 */
function renderInsideBoundary(child: ReactNode): void {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(<ErrorBoundary label="test" resetKey="a">{child}</ErrorBoundary>);
  } catch {
    // React's development re-throw of the error the boundary already handled.
  }
  spy.mockRestore();
}

/** The console text React emits when sync input suspends a lazy component. */
const SUSPENSE_ON_SYNC_INPUT = /suspended while responding to synchronous input|Minified React error #426/;

async function clickCard(toolId: string) {
  window.location.hash = '#/pdf';
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // Mirror index.html: the app owns a #root element, and "the screen went white"
  // means that element lost its children.
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  render(<AppRoot />, { container: root });

  const card = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>(`button[data-tool="${toolId}"]`);
    if (!found) throw new Error(`dashboard never rendered a card for ${toolId}`);
    return found;
  });

  fireEvent.click(card);

  await waitFor(() => {
    expect(window.location.hash).toBe(`#/tool/${toolId}`);
  });
  // Let the suspended chunk settle and any render throw surface.
  await new Promise((r) => setTimeout(r, 50));

  const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
  spy.mockRestore();
  return { root, logged };
}

describe('tool-card navigation', () => {
  it('keeps the router configured to navigate inside a transition', () => {
    // jsdom cannot reproduce React #426: the sync-input check depends on real
    // discrete-event scheduling, so the click tests above pass with the flag
    // removed. This tripwire stops the fix from being "cleaned up" by someone
    // who reads the click test as unrelated ceremony. `scripts/browser-smoke.mjs`
    // is the end-to-end version of this assertion.
    const source = readFileSync(resolve(process.cwd(), 'src/AppRoot.tsx'), 'utf8');
    expect(source).toMatch(/v7_startTransition:\s*true/);
    expect(source).toMatch(/<ErrorBoundary/);
  });

  it('keeps the app mounted when a lazily-loaded tool suspends on click', async () => {
    const { root, logged } = await clickCard('edit-pdf');

    expect(SUSPENSE_ON_SYNC_INPUT.test(logged), `React suspended on sync input:\n${logged.slice(0, 400)}`).toBe(false);
    expect(root.childElementCount, 'the app unmounted to a blank page').toBeGreaterThan(0);
    expect(root.textContent ?? '', 'the app unmounted to a blank page').not.toBe('');
  });

  it('keeps the app mounted for the in-place text editor too', async () => {
    const { root, logged } = await clickCard('edit-pdf-text');

    expect(SUSPENSE_ON_SYNC_INPUT.test(logged)).toBe(false);
    expect(root.childElementCount).toBeGreaterThan(0);
  });

  it('shows a recoverable panel instead of a blank page when a view throws', async () => {
    // A boundary that swallows the error but renders nothing is still a white
    // screen to the user, so the fallback has to carry words and buttons.
    // Must be capitalised: JSX treats a lowercase tag as a DOM element, so a
    // `const boom = ...` would never render as a component.
    function Boom(): never {
      throw new Error('boom while rendering');
    }
    renderInsideBoundary(<Boom />);

    const text = document.body.textContent ?? '';
    expect(text).toContain('This view hit an error');
    expect(text).toContain('Try again');
    expect(text).toContain('Reload the page');
  });

  it('names a stale deploy as the cause when a chunk fails to load', async () => {
    function StaleChunk(): never {
      throw new Error('Failed to fetch dynamically imported module: /assets/editor-abc123.js');
    }
    renderInsideBoundary(<StaleChunk />);

    const text = document.body.textContent ?? '';
    expect(text).toContain('This tool needed a file that moved');
    expect(text).not.toContain('Failed to fetch dynamically imported module');
  });
});
