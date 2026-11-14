/**
 * The page picker must not claim a selection the run refuses.
 *
 * `validate` on `extract-pages` (and the shared `selection`) treats a cleared
 * field as "nothing chosen" — blank is deliberately not "all" — but the picker
 * resolved the empty string through `tryResolvePages`, which reads it as *every*
 * page. Pressing the strip's own `none` chip therefore left "ALL 4 PAGES PICKED",
 * four highlighted thumbnails and "4 OF 4 SELECTED" on screen beside a disabled
 * Extract button that said *Choose which pages to extract.* Measured in Chromium:
 * `docs/research/extract-pages-round.mjs` case `12-empty`.
 *
 * The strip is the half of the control that shows state, so its `aria-pressed`
 * tiles are what is asserted — with `all` as the control, because a strip that
 * marks nothing in both states would pass a one-sided test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { FieldControl } from '@/components/tools/pdf/shared/FieldControls';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { useFileStore } from '@/stores/file-store';

vi.mock('@/lib/pdf/core/render', () => ({
  openRender: async () => ({
    numPages: 4,
    fingerprint: 'picker-empty-session',
    page: async () => ({ getViewport: () => ({ width: 595, height: 842, rotation: 0 }) }),
    destroy: async () => {},
  }),
  // jsdom has no 2-D context: every tile lands in its "no image" state, which is
  // exactly the state that still draws the picker, the caption and `aria-pressed`.
  thumbnails: async () => [],
}));

const pages = getPdfTool('extract-pages')!.fields!.find((field) => field.key === 'pages')!;

function renderWith(value: string) {
  return render(createElement(FieldControl, {
    field: pages,
    values: { pages: value },
    onChange: () => {},
  }));
}

/** The tiles the strip marks as picked, by their own accessible names. */
function pressed(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[aria-pressed="true"][aria-label^="Page "]')]
    .map((tile) => tile.getAttribute('aria-label')!);
}

beforeEach(() => {
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'picker.pdf', {
    type: 'application/pdf',
  });
  useFileStore.setState({ file, files: [file] });
});

describe('a cleared page field', () => {
  it('marks no page, so the strip agrees with the refusal', async () => {
    const { container, findByText } = renderWith('');
    // The session mounts a beat later than the first render, so wait on the tick
    // that only the pics strip prints.
    await findByText(/0 of 4 pages picked/i);
    expect(pressed(container)).toEqual([]);
    expect(container.textContent).not.toMatch(/all 4 pages picked/i);
    // And the caption under the strip says what to do, rather than "4 of 4".
    expect(container.textContent).toMatch(/4 pages · pick pages/i);
  });

  it('still marks every page for `all` (the control)', async () => {
    const { container, findByText } = renderWith('all');
    await findByText(/all 4 pages picked/i);
    expect(pressed(container)).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4']);
    expect(container.textContent).toMatch(/4 of 4 selected/i);
  });

  it('marks only the pages named when some are picked (the second control)', async () => {
    const { container, findByText } = renderWith('2');
    await findByText(/1 of 4 pages picked/i);
    expect(pressed(container)).toEqual(['Page 2']);
  });
});
