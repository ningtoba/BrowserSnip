/**
 * The sign pane's own counts, in the order a person meets them.
 *
 * `sign` was recorded as "not reached" by the triage because its action button
 * stays disabled until a mark exists — and the mark *did* exist: it was painted on
 * the page, listed under "Saved signatures", and the button still read "Nothing
 * placed yet — add a signature from the tabs above". The state the pane shares with
 * the overlay is mutated in place, so a snapshot taken by reference and a
 * derivation memoised on the array's identity both describe the past. The result
 * was not a cosmetic one: the tool could not be run at all from its own pane, and
 * the newest mark would have been left out of a run that did go ahead.
 *
 * The byte half — an image painted into the page content at the point the overlay
 * showed, not a `/Sig` field — is measured in the browser by
 * `docs/research/verify-sign-run.mjs` and judged by `docs/research/verify-sign-read.py`;
 * the log lives beside this file as `docs/research/sign-deployed.log`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { SignTool } from '@/components/tools/pdf/security/SignTool';
import * as sign from '@/components/tools/pdf/security/SignMain';
import { useFileStore } from '@/stores/file-store';

/** The pane will not act with no document open, which is a different refusal. */
function openFile(name = 'ruled.pdf') {
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });
  act(() => {
    useFileStore.setState({ file: file as never });
  });
}

/** The overlay's page geometry, which a real pane learns from the open document. */
function openDocument(page: number, total: number) {
  act(() => {
    sign.setSignPage({ page, totalPages: total });
  });
}

function clearMarks() {
  for (const item of [...sign.getSignState().items]) sign.removeSigItem(item.id);
}

const addButton = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((b) => /Add text to PDF/i.test(b.textContent ?? ''));

const runButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('#tool-process-btn');

describe('a placed signature is a signature the pane will act on', () => {
  beforeEach(() => clearMarks());
  afterEach(() => {
    cleanup();
    clearMarks();
    openDocument(1, 1);
    useFileStore.setState({ file: null });
  });

  it('enables the action, and counts the mark, the moment it is added', () => {
    openFile();
    const { container } = render(createElement(SignTool));
    openDocument(1, 3);
    const before = runButton(container)!;
    expect(before.disabled).toBe(true);
    expect(before.textContent).toMatch(/Nothing placed yet|Place signatures/);

    const field = container.querySelector<HTMLInputElement>('#sig-panel-text input[type=text]')!;
    fireEvent.change(field, { target: { value: 'Ada Lovelace' } });
    fireEvent.click(addButton(container)!);

    const after = runButton(container)!;
    expect(after.disabled, 'a mark on the page must not leave the button saying "Nothing placed yet"')
      .toBe(false);
    expect(after.textContent).toBe('Place 1 signature');
  });

  it('counts every mark, including the one added after the first', () => {
    openFile();
    const { container } = render(createElement(SignTool));
    openDocument(1, 3);
    const field = container.querySelector<HTMLInputElement>('#sig-panel-text input[type=text]')!;
    fireEvent.change(field, { target: { value: 'First' } });
    fireEvent.click(addButton(container)!);
    fireEvent.change(field, { target: { value: 'Second' } });
    fireEvent.click(addButton(container)!);

    expect(runButton(container)!.textContent).toBe('Place 2 signatures');
    expect(sign.getSignState().items.map((item) => item.text)).toEqual(['First', 'Second']);
  });

  it('a mark on a page the document does not have is named, not counted', () => {
    openFile();
    const { container } = render(createElement(SignTool));
    openDocument(1, 3);
    act(() => {
      sign.addSigItem({ id: sign.nextSigId(), type: 'text', text: 'Nowhere', imageDataUrl: null, imageBytes: null, w: 120, h: 40, page: 9 } as never);
    });
    // The item is stamped with the pane's current page when none is given, so the
    // off-page mark above is a real placement on a document that shrank.
    const items = sign.getSignState().items;
    expect(items).toHaveLength(1);
    act(() => {
      sign.updateSigItem(items[0].id, { page: 9 });
      sign.setSignPage({ page: 1, totalPages: 2 });
    });

    expect(container.querySelector('[data-sign-offpage]')?.getAttribute('data-sign-offpage')).toBe('1');
    expect(runButton(container)!.disabled).toBe(true);
  });

  it('keeps a resized mark at the size and place the overlay shows', () => {
    openDocument(1, 3);
    act(() => {
      sign.addSigItem({ id: sign.nextSigId(), type: 'text', text: 'Ada', imageDataUrl: null, imageBytes: null, w: 120, h: 40 } as never);
    });
    const item = sign.getSignState().items[0];
    // The centred default, then a drag expressed the way the pointer handler does.
    const centred = item.x;
    expect(centred).toBeCloseTo(0.5 - (item.w / 595) / 2, 6);
    act(() => {
      sign.updateSigItem(item.id, { x: 0.08, y: 0.12, w: 200, h: 60 });
    });
    const moved = sign.getSignState().items[0];
    expect([moved.x, moved.y, moved.w, moved.h]).toEqual([0.08, 0.12, 200, 60]);
    clearMarks();
  });
});
