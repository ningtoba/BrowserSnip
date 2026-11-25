/**
 * Script-face fetch failures: the sentence, and the notice before the wait.
 *
 * A CJK / Arabic / Hebrew rewrite resolves its face from the jsDelivr Noto set
 * (~4 MB each). With the CDN unreachable — offline tab, blocked network — the
 * export used to die mid-run on the raw fetch error (`Failed to fetch`, or a
 * bare "Could not load the <url> font file (HTTP 503)."), which names neither
 * where the bytes were coming from nor what the user can do about it, while
 * Latin text never touches the network at all and must not read as if it did.
 *
 * Pinned here:
 * 1. a rejected fetch surfaces cause + remedy **through the tool's own error
 *    path** — the message names the host, says one internet connection is
 *    needed for this writing system, and that Latin text works offline;
 * 2. an HTTP failure carries the status in the same sentence;
 * 3. a bundled (same-origin) face missing from the app files gets *its* honest
 *    sentence — the CDN remedy must not be claimed for a local file (control);
 * 4. the first fetch of a URL announces itself through the notice sink — the
 *    `engineFetchLine` pattern — and a cached URL does not announce twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { clearFontCache, getFont, setFaceFetchNotice } from '@/lib/pdf/core/fonts';
import { chooseFace } from '@/components/tools/pdf/text-editor/faces';
import { DEFAULT_STYLE } from '@/components/tools/pdf/text-editor/model';

const realFetch = globalThis.fetch;
beforeEach(() => clearFontCache());
afterEach(() => {
  globalThis.fetch = realFetch;
  setFaceFetchNotice(null);
});

const CJK = { text: '分析报表流水线', size: 12, bold: false, italic: false, fontFamily: undefined };
const LATIN_UNICODE = { text: 'café façade', size: 12, bold: false, italic: false, fontFamily: 'noto' };

describe('the script-face download failing well', () => {
  it('names host, remedy, and the offline-Latin fact when the fetch is refused', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const doc = await PDFDocument.create();
    const failure = await getFont(doc, CJK).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(failure).toContain('cdn.jsdelivr.net');
    expect(failure).toContain('NotoSansSC_400Regular.ttf');
    expect(failure).toContain('Failed to fetch');
    expect(failure).toMatch(/one internet connection/i);
    expect(failure).toMatch(/Latin text .*offline/i);
  });

  it('carries the HTTP status in the same sentence', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const doc = await PDFDocument.create();
    await expect(getFont(doc, CJK)).rejects.toThrow(/HTTP 503/);
  });

  it('does not blame the CDN for a bundled face the app itself is missing (control)', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const doc = await PDFDocument.create();
    const failure = await getFont(doc, LATIN_UNICODE).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(failure).toContain('missing from the app files');
    expect(failure).not.toMatch(/one internet connection/i);
  });

  it('the editor’s own tier answers the offline case with the same remedy', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const doc = await PDFDocument.create();
    const failure = await chooseFace(doc, { ...DEFAULT_STYLE, fontFamily: 'script:arabic' }, 'تحليل', []).then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect(failure).toContain('cdn.jsdelivr.net');
    expect(failure).toMatch(/one internet connection/i);
    expect(failure).toMatch(/Latin text .*offline/i);
  });

  it('announces the download before waiting, once per face', async () => {
    const lines: string[] = [];
    setFaceFetchNotice((line) => lines.push(line));
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const doc = await PDFDocument.create();
    await getFont(doc, CJK).catch(() => null);
    // A refused fetch leaves nothing cached, so the retry asks again — the
    // notice fires per attempt that really hits the network, not per call.
    await getFont(doc, CJK).catch(() => null);
    expect(lines.filter((l) => /Downloading the Noto Sans SC face from cdn\.jsdelivr\.net/.test(l))).toHaveLength(2);
    expect(lines.every((l) => /Your PDF stays on this device/.test(l))).toBe(true);
  });
});
