/**
 * The rail announces a CDN face fetch while it waits (c3 blocker 3).
 *
 * `setFaceFetchNotice` was wired only into the text editor's export
 * (`TextEditor.buildOutput`), so every rail tool that had to download a script
 * face went silent through a multi-megabyte wait: measured live on this branch,
 * a `日本語` watermark run made one request to `cdn.jsdelivr.net` and the card
 * printed nothing about it — a hung-looking tab with no explanation. The hook
 * now installs the sink around `runPdfTool` (cleared when the newest run ends,
 * mirroring the editor and `engineFetchLine`'s convention), so the line
 * `Downloading the <face> face from <host> — once, then your browser caches
 * it. Your PDF stays on this device.` lands in the rail's log before the run
 * completes.
 *
 * Pins: the CJK watermark run logs the notice BEFORE its bytes are even asked
 * for (the fetch stub samples the log at call time); a Latin watermark run
 * fetches nothing and logs no notice — that control passes in both builds by
 * design, the two CJK assertions are the red-without-fix half.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { usePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { clearFontCache } from '@/lib/pdf/core/fonts';

/** A CID-keyed CFF script face; any face bytes will do — the notice is about the fetch. */
const FACE = new Uint8Array(readFileSync(join(process.cwd(), 'tests/fixtures/cjk-cid-cff.otf')));

const realFetch = globalThis.fetch;
/** For every stubbed face request: was the notice already in the rail log at that moment? */
const noticedAtFetch: boolean[] = [];

beforeAll(() => {
  globalThis.fetch = (async () => {
    noticedAtFetch.push(
      useProcessStore.getState().logs.some((line) => /Downloading the .* face from /.test(line)),
    );
    return new Response(FACE as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  clearFontCache();
});

async function onePagePdf(): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return new File([await doc.save() as unknown as BlobPart], 'sheet.pdf', { type: 'application/pdf' });
}

async function driveWatermark(text: string) {
  clearFontCache();
  noticedAtFetch.length = 0;
  useProcessStore.setState({ logs: [] });
  const file = await onePagePdf();
  useFileStore.setState({ file, files: [file], metadata: null });
  const { result } = renderHook(() => usePdfTool('watermark'));
  await waitFor(() => expect(result.current.tool).toBeTruthy());
  let pending: Promise<unknown> = Promise.resolve(null);
  act(() => {
    pending = result.current.run({ text });
  });
  await act(async () => {
    await pending;
  });
  return useProcessStore.getState();
}

describe('the rail announces the face fetch (usePdfTool)', () => {
  it('logs the CDN notice for a CJK watermark, before the bytes are fetched', async () => {
    const state = await driveWatermark('日本語');
    const notice = state.logs.find((line) => /Downloading the .* face from /.test(line));
    expect(notice, 'the run log carries the fetch notice').toBeTruthy();
    expect(notice).toMatch(/once, then your browser caches it/);
    expect(notice).toMatch(/stays on this device/);
    expect(noticedAtFetch.length, 'the run really fetched a face').toBeGreaterThan(0);
    // The notice precedes the wait it announces — every fetch saw it already logged.
    expect(noticedAtFetch.every((seen) => seen), 'the notice was logged before the fetch').toBe(true);
  });

  it('control: a Latin watermark fetches nothing and announces nothing', async () => {
    const state = await driveWatermark('Status report');
    expect(noticedAtFetch.length).toBe(0);
    expect(state.logs.some((line) => /Downloading the/.test(line))).toBe(false);
  });
});
