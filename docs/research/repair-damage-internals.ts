/**
 * Why `repair` answers what it answers — one file's internals, no judgement.
 *
 * Bundled by `repair-damage-measure.mjs` beside `repair-damage-entry.ts`. The
 * point is to separate three numbers a report line can collapse into one:
 *
 *  · `lenient`  — pages the shared loader parses out of the file as it stands;
 *  * `raw`      — what a byte scan of the same bytes says the file holds: how
 *                   many `/Type /Page` objects and what `/Count` the page tree
 *                   claims;
 *  · `pdfjs`    — what the app's own renderer sees, which is the number a user
 *                   sees when the damaged file opens in the viewer.
 *
 * When `pdfjs` and `lenient` disagree, the tool is reading less than the file
 * holds and the message is describing its own parser, not the document.
 */
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { openPDF } from '../../src/lib/pdf/core/doc';

// The same worker the app ships, resolved from this repo: pdf.js parses nothing
// without it, and a probe that cannot start one would report "unreadable" for
// files the viewer opens.
GlobalWorkerOptions.workerSrc = `file://${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`;

// Byte-exact: `TextDecoder('latin1')` is windows-1252, which rewrites 0x80-0x9F.
const latin1 = { decode: (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1') };

export interface Internals {
  file: string;
  lenient: number | null;
  lenientError: string | null;
  rawPageObjects: number;
  rawPageCount: number | null;
  rawStreams: number;
  pdfjs: number | null;
  pdfjsError: string | null;
  pdfjsChars: number[];
}

export async function internals(name: string, bytes: Uint8Array): Promise<Internals> {
  const text = latin1.decode(bytes);

  let lenient: number | null = null;
  let lenientError: string | null = null;
  try {
    const doc = await openPDF(bytes, { ignoreEncryption: true });
    lenient = doc.getPageCount();
  } catch (error) {
    lenientError = error instanceof Error ? error.message.slice(0, 90) : String(error);
    try {
      const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      lenient = doc.getPageCount();
      lenientError = `${lenientError} (raw fork load ok)`;
    } catch (inner) {
      lenientError = `${lenientError} / fork: ${inner instanceof Error ? inner.message.slice(0, 70) : inner}`;
    }
  }

  const pageObjects = (text.match(/\/Type\s*\/Page[^sA-Za-z]/g) ?? []).length;
  const counts: number[] = [];
  for (const found of text.matchAll(/\/Type\s*\/Pages[\s\S]{0,200}?\/Count\s+(\d+)/g)) counts.push(Number(found[1]));
  const streams = (text.match(/[^d]stream\r?\n/g) ?? []).length;

  let pdfjs: number | null = null;
  let pdfjsError: string | null = null;
  const pdfjsChars: number[] = [];
  try {
    const doc = await getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      disableFontFace: true,
      standardFontDataUrl: `file://${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
    }).promise;
    pdfjs = doc.numPages;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pdfjsChars.push(content.items.reduce((sum: number, item) => sum + String('str' in item ? item.str : '').length, 0));
      page.cleanup();
    }
    await doc.destroy();
  } catch (error) {
    pdfjsError = error instanceof Error ? error.message.slice(0, 90) : String(error);
  }

  return {
    file: name,
    lenient,
    lenientError,
    rawPageObjects: pageObjects,
    rawPageCount: counts.length ? Math.max(...counts) : null,
    rawStreams: streams,
    pdfjs,
    pdfjsError,
    pdfjsChars,
  };
}
