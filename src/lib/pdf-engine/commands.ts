/**
 * The four operations the registry has no `core` implementation for.
 *
 * This file used to be 1,500 lines: a complete second implementation of every
 * PDF operation, reached through `hooks/usePDFEngine.ts` and its own
 * `executeToolCommand` switch, with no guard pre-flight, no field clamping, no
 * structural `warnings` and no progress. That switch is gone — one dispatch
 * path now, `lib/pdf/tools/**` + `tools/runner.ts` — and this module is only a
 * library of last resorts that the registry's `run` bodies call:
 *
 * | export               | called by                                             |
 * |----------------------|-------------------------------------------------------|
 * | `repairPDF`          | `tools/optimize.ts` (`repair`) — the damaged-file reader and its raw-byte fallback exist nowhere else. |
 * | `scanImagesToPdf`    | `tools/legacy.ts` (`scan-to-pdf`) — kept instead of `core/pack.pdfFromImages` because that path re-encodes every page as PNG; a camera frame is already JPEG and must stay JPEG. |
 * | `drawSignatureMarks` | `tools/legacy.ts` (`sign`) — placing a picture or a typed name at a point the user dragged to. |
 * | `comparePDFs`        | `tools/legacy.ts` (`compare`) — the pixel diff that produces an annotated PDF, and the only compare path the shipped page reaches. `tools/security.ts` computes a diff for its *report*, but collects each page's overlay into a local `images` list it never returns, so that path writes no picture and no file. |
 *
 * What this module is waiting on, so it can shrink to nothing:
 * - `core/pack` gaining "keep the source container" so the scan path can move
 *   onto it (and stop being the only place that knows scan's fit rules).
 * - A `core` home for the two-document pixel diff (probably beside
 *   `core/render`, next to the single-owner pdf.js sessions it should use).
 * - `repairPDF` moving into `core/` and `tools/optimize.ts` dropping its
 *   cross-module import. Requested in `docs/tasks/s3-request.md`.
 *
 * Nothing under `src/components/**` may import this module: a component reaches
 * an operation through `runPdfTool`, never directly. `tests/pdf/one-path.test.ts`
 * keeps that true.
 */
import {
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  newPDF,
  openPDF,
  rgb,
  savePDF,
  StandardFonts,
} from '../pdf/core/doc';
import { embedImageBytes, fitScale } from '../pdf/core/pack';
import { pageContentOps, pageContentStreams } from '../pdf/core/content';
import { pageSize as resolvePageSize } from '../pdf/core/pages';
import { openRender } from '../pdf/core/render';
import { drawTextU } from '../pdf/core/fonts';
import { parseHexColor, throwIfAborted } from '../pdf/tools/helpers';

/** Progress and cancellation, supplied by the runner through the tool context. */
export interface RunHooks {
  progress?: (fraction: number, message?: string) => void;
  signal?: AbortSignal;
}

/* ── OPTIMIZE: repair ─────────────────────────────────────────────────────── */

/** How a damaged file came back into the reader. */
export type RepairPath =
  /** The bytes parsed as they stood; nothing had to be rebuilt. */
  | 'opened'
  /** The file's own index was wrong or gone, so a fresh one was written over its objects. */
  | 'rebuilt-index'
  /** No page tree survived: sheets were built around the content streams in the bytes. */
  | 'content-streams';

export interface RepairFacts {
  bytes: Uint8Array;
  path: RepairPath;
  /** Sheets in the document that was written. */
  pages: number;
  /**
   * Sheets the input claims to hold — its page tree's `/Count` where one could be
   * read, otherwise the number of `/Type /Page` objects still in the bytes. `null`
   * when the file states no count and no page object survives in the plain body
   * (an object stream holds them), which is not a claim that the file is empty.
   */
  claimed: number | null;
  /**
   * Sheets of the output that hold no drawing operator at all.
   *
   * This is the number the campaign exists for: a page count can be exactly right
   * while every sheet is paper, and `docs/TOOL-TRIAGE.md` §2 measured `repair`
   * printing "1 page(s) readable" for precisely such a file.
   */
  blank: number;
}

/**
 * Repair a damaged or malformed PDF by rebuilding its internal structure.
 *
 * What this does, in the order it tries it:
 * - open the bytes as they stand, ignoring `/Encrypt` (a damaged security
 *   dictionary is not a reason to refuse a file repair exists for);
 * - when that reads less than the file holds, write a fresh cross-reference table
 *   over the objects that are still there and open *that* — the index is what
 *   breaks in a truncated download or a hand-patched file, not the pages;
 * - when no page tree survives at all, build sheets around the content streams the
 *   bytes still carry.
 *
 * The strategy that worked is reported, because the third one changes what the
 * result is: sheets rebuilt around a content stream have no page tree behind them,
 * so their size and order are this rebuild's guess, not the document's.
 *
 * Every candidate is scored on the pages that still hold drawing operators, not on
 * the page count: returning one blank sheet for a file that opens as four inked ones
 * is the defect this function had.
 */
export async function repairPDF(pdfBuffer: ArrayBuffer): Promise<RepairFacts> {
  const bytes = new Uint8Array(pdfBuffer);
  const text = latin1Of(bytes);
  const objects = scanPdfObjects(text);
  const claimed = claimOf(objects);

  const candidates: Array<{ doc: PDFDocument; path: RepairPath }> = [];

  /**
   * A document the loader handed back is only a candidate if its page tree can be
   * walked. With a damaged object stream the fork parses the file and then throws
   * `this.catalog.Pages is not a function` at the first question about it, and that
   * TypeError used to leak into the user's refusal sentence verbatim.
   */
  const usablePages = (doc: PDFDocument): number => {
    try {
      return doc.getPageCount();
    } catch {
      return 0;
    }
  };

  // Strategy 1: open with the shared loader, ignoring `/Encrypt`.
  try {
    const doc = await openPDF(bytes, { ignoreEncryption: true });
    if (usablePages(doc) > 0) candidates.push({ doc, path: 'opened' });
  } catch { /* the index rebuild below reads the same bytes a different way */ }

  // Strategy 2: re-index. Only worth a second parse when the first read fewer
  // sheets than the file claims, but that is exactly the case the tool is for.
  const best = () => Math.max(0, ...candidates.map((item) => usablePages(item.doc)));
  const indexed = rebuiltIndexBytes(bytes, objects);
  if (indexed && (candidates.length === 0 || best() < (claimed ?? Infinity))) {
    try {
      const doc = await openPDF(indexed, { ignoreEncryption: true });
      if (usablePages(doc) > best()) candidates.push({ doc, path: 'rebuilt-index' });
    } catch { /* fall through to the content-stream harvest */ }
  }

  if (candidates.length === 0) {
    const harvested = await recoverPagesFromContentStreams(objects);
    if (harvested) candidates.push({ doc: harvested, path: 'content-streams' });
  }

  const chosen = candidates
    .map((item) => ({ ...item, kept: sheetsWithContent(item.doc) }))
    .sort((a, b) => b.kept - a.kept || usablePages(b.doc) - usablePages(a.doc))[0];

  if (!chosen) {
    throw new Error(
      'This PDF is too damaged to recover. The internal catalog and page tree '
      + 'are corrupted beyond what the browser can repair. Try a desktop PDF editor.',
    );
  }
  const srcDoc = chosen.doc;

  const pageCount = usablePages(srcDoc);
  if (pageCount === 0) {
    throw new Error('No readable pages could be recovered from this PDF.');
  }

  // Rebuild: copy all recovered pages into a brand-new document
  const repaired = await PDFDocument.create();

  const pageIndices = srcDoc.getPageIndices();
  const copied = await repaired.copyPages(srcDoc, pageIndices);
  for (const page of copied) {
    repaired.addPage(page);
  }

  // Copy metadata if readable
  try { const title = srcDoc.getTitle(); if (title) repaired.setTitle(title); } catch { /* metadata is optional */ }
  try { const author = srcDoc.getAuthor(); if (author) repaired.setAuthor(author); } catch { /* metadata is optional */ }

  repaired.setProducer('BrowserSnip PDF');
  repaired.setCreator('BrowserSnip PDF');

  const out = await repaired.save({ useObjectStreams: true });
  // Counted off the bytes, not off `repaired`: `save` rewrites the document it is
  // called on (objects move into the object stream), and a page read after it is a
  // different in-memory shape than the file the user downloads.
  const empty = (await sheetsWithoutContent(out)) ?? 0;
  return {
    bytes: out,
    path: chosen.path,
    pages: repaired.getPageCount(),
    claimed,
    blank: empty,
  };
}

/** Byte-exact latin-1. `TextDecoder('latin1')` is windows-1252, which rewrites 0x80-0x9F. */
function latin1Of(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

/** Re-encode a latin-1 string. Every code unit here is one byte by construction. */
function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

interface PdfObject {
  number: number;
  generation: number;
  /** Byte offset of the `N G obj` header. */
  start: number;
  /** Byte just past this object's `endobj`. */
  end: number;
  /** The object's own text, header and payload excluded. */
  body: string;
}

/** The `/Length` number in the dictionary above this `stream` keyword. */
function declaredLength(text: string, streamAt: number): number | null {
  const at = text.lastIndexOf('/Length', streamAt);
  if (at < 0 || streamAt - at > 240) return null;
  const value = Number(/\/Length\s+(\d+)/.exec(text.slice(at, streamAt))?.[1]);
  return Number.isFinite(value) ? value : null;
}

/** The `stream` keyword that opens a payload, or -1 when this object has none. */
function streamKeyword(text: string, from: number, limit: number): number {
  for (let at = text.indexOf('stream', from); at >= 0 && at < limit; at = text.indexOf('stream', at + 6)) {
    if (text.slice(at - 3, at) === 'end') continue;
    if (/\r?\n/.test(text[at + 6] ?? '')) return at;
  }
  return -1;
}

/**
 * The byte just past this object's `endobj`, or -1 when the object never closes.
 *
 * The payload is stepped over by its declared `/Length`: binary stream data
 * contains the token `endobj` (and `endstream`) often enough that a scan which
 * trusts the first one finds an object boundary that is not there, and the index
 * written from it points readers into the middle of a compressed stream.
 */
function objectEnd(text: string, bodyStart: number): number {
  let cursor = bodyStart;
  for (;;) {
    const endObj = text.indexOf('endobj', cursor);
    if (endObj < 0) return -1;
    const streamAt = streamKeyword(text, cursor, endObj);
    if (streamAt < 0) return endObj + 'endobj'.length;
    let payload = streamAt + 'stream'.length;
    if (text[payload] === '\r') payload += 1;
    if (text[payload] !== '\n') return -1;
    payload += 1;
    const endStream = text.indexOf('endstream', payload);
    if (endStream < 0) return -1;
    const declared = declaredLength(text, streamAt);
    const pastLength = declared === null ? -1 : payload + declared;
    const lengthIsTruth = pastLength >= 0 && /^\s*endstream/.test(text.slice(pastLength, pastLength + 20));
    cursor = (lengthIsTruth ? pastLength : endStream + 'endstream'.length);
    if (cursor <= endStream) cursor = endStream + 'endstream'.length;
  }
}

/**
 * Every `N G obj` whose `endobj` is still in the file, first occurrence per number.
 *
 * An object that never closes swallows the rest of the file, so the scan stops
 * there rather than inventing boundaries: a truncated tail yields its whole
 * objects, which is what a rebuilt index can honestly point at.
 */
function scanPdfObjects(text: string): PdfObject[] {
  const header = /(?:^|[\r\n\t ])(\d+)\s+(\d+)\s+obj\b/g;
  const found: PdfObject[] = [];
  const taken = new Set<number>();
  let match = header.exec(text);
  while (match !== null) {
    const number = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    if (number === 0 || taken.has(number)) {
      match = header.exec(text);
      continue;
    }
    taken.add(number);
    const end = objectEnd(text, bodyStart);
    if (end < 0) break;
    found.push({
      number,
      generation: Number(match[2]),
      start: match.index + match[0].indexOf(match[1]),
      end,
      body: text.slice(bodyStart, end),
    });
    header.lastIndex = end;
    match = header.exec(text);
  }
  return found;
}

/** What the file says it holds: the page tree's `/Count`, else its page objects. */
function claimOf(objects: PdfObject[]): number | null {
  const trees = objects
    .filter((item) => /\/Type\s*\/Pages\b/.test(item.body))
    .map((item) => Number(/\/Count\s+(\d+)/.exec(item.body)?.[1] ?? NaN))
    .filter((value) => Number.isFinite(value));
  const leaves = objects.filter((item) => /\/Type\s*\/Page\b/.test(item.body)).length;
  const held = Math.max(trees.length ? Math.max(...trees) : 0, leaves);
  return held > 0 ? held : null;
}

/**
 * The same bytes with a correct classic cross-reference table appended.
 *
 * Nothing inside the objects is re-typed — the file's own bytes up to its last
 * complete object, then an index naming where each object starts, then a trailer
 * naming the catalog. That is what keeps a rebuilt sheet's content intact: the
 * earlier shape of this repair copied objects around, and a copied `/Length` that
 * no longer matched its payload turned every page into paper.
 *
 * `null` when no catalog can be named: an index of objects nobody can enter is not
 * a document, and the caller still has the content-stream harvest.
 */
function rebuiltIndexBytes(bytes: Uint8Array, objects: PdfObject[]): Uint8Array | null {
  const version = /^%PDF-(\d\.\d)/.exec(latin1Of(bytes.subarray(0, 16)));
  if (!version || objects.length === 0) return null;
  const present = new Map(objects.map((item) => [item.number, item]));
  const text = latin1Of(bytes);

  let root: PdfObject | null = null;
  for (const trailer of [...text.matchAll(/trailer\s*<<(.*?)>>/gs)].reverse()) {
    const named = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(trailer[1]);
    const found = named ? present.get(Number(named[1])) : undefined;
    if (found) { root = found; break; }
  }
  if (!root) root = objects.find((item) => /\/Type\s*\/Catalog/.test(item.body)) ?? null;
  if (!root) return null;

  const lastEnd = Math.max(...objects.map((item) => item.end));
  const size = Math.max(objects[objects.length - 1].number, root.number) + 1;
  let table = `${text.slice(0, lastEnd)}\n`;
  const xrefAt = table.length;
  table += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number++) {
    const item = present.get(number);
    table += item
      ? `${String(item.start).padStart(10, '0')} ${String(item.generation).padStart(5, '0')} n \n`
      : '0000000000 65535 f \n';
  }
  table += `trailer\n<< /Size ${size} /Root ${root.number} ${root.generation} R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1Bytes(table);
}

/**
 * How many of a produced file's sheets hold no drawing operator.
 *
 * The tool calls this on the bytes it wrote, re-opened from scratch, so the claim
 * is about the download rather than about the document still in memory — the
 * pattern that hid the campaign's blank outputs. `null` means the bytes will not
 * open at all, which is a different sentence and is never reported as "no ink".
 */
export async function sheetsWithoutContent(bytes: Uint8Array): Promise<number | null> {
  let doc: PDFDocument;
  try {
    doc = await openPDF(bytes, { ignoreEncryption: true });
  } catch {
    return null;
  }
  const total = doc.getPageCount();
  return total - sheetsWithContent(doc);
}

/** Operators that put something on the paper: text shown, paths painted, XObjects drawn. */const PAINT_OPERATORS = new Set(['Tj', 'TJ', "'", '"', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'Do', 'BI']);

/**
 * How many of this document's sheets hold a drawing operator.
 *
 * A page whose stream will not decode, or decodes to nothing, or holds only
 * setting operators, prints no ink — this is the count that makes "N page(s)
 * readable" a claim a person can check instead of a number to trust.
 */
function sheetsWithContent(doc: PDFDocument): number {
  let kept = 0;
  for (const page of doc.getPages()) {
    try {
      const streams = pageContentStreams(page);
      if (streams.length === 0) continue;
      const painted = streams.some((stream) => stream.bytes.byteLength > 0)
        && pageContentOps(page).some((op) => PAINT_OPERATORS.has(op.name));
      if (painted) kept += 1;
    } catch { /* an undecodable stream is a sheet with nothing on it */ }
  }
  return kept;
}

/**
 * Last-resort recovery: build one sheet per surviving page content stream.
 *
 * The payload is taken **decoded**, and only from a stream that could be a page's:
 * the first cut at this pushed whatever sat between `stream` and `endstream` into a
 * page with no `/Filter`, which for a `/FlateDecode` producer is ciphertext under a
 * dictionary that claims plaintext — a sheet that opens, counts, and draws nothing.
 */
async function recoverPagesFromContentStreams(objects: PdfObject[]): Promise<PDFDocument | null> {
  // The document exists before the scan does: a payload is decoded by the engine's
  // own stream decoder, which needs the context the dictionary belongs to.
  const doc = await PDFDocument.create();
  for (const object of objects) {
    if (!/\bstream\b/.test(object.body)) continue;
    // A font program, an image, an object stream and the xref stream all carry
    // payloads; none of them is a page's drawing.
    if (/\/FontFile\d?\b|\/Subtype\s*\/Image|\/Type\s*\/(ObjStm|XRef|Metadata)/.test(object.body)) continue;
    const streamAt = streamKeyword(object.body, 0, object.body.length);
    if (streamAt < 0) continue;
    let payload = streamAt + 'stream'.length;
    if (object.body[payload] === '\r') payload += 1;
    if (object.body[payload] !== '\n') continue;
    // Past the line ending: `/Length` counts from the first payload byte, and a
    // slice that starts on the newline is one byte short of a valid zlib stream.
    payload += 1;
    const declared = declaredLength(object.body, streamAt) ?? 0;
    const raw = latin1Bytes(object.body.slice(payload, payload + declared));
    if (raw.byteLength === 0) continue;
    const decoded = decodeStreamPayload(doc.context, object.body, raw);
    if (!decoded || !PAINT_OPERATORS_TEST.test(decodedText(decoded))) continue;
    const box = boxOfPageNaming(object.number, objects) ?? [0, 0, 612, 792];
    const page = doc.addPage([box[2] - box[0], box[3] - box[1]]);
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(decoded)));
  }
  if (doc.getPageCount() === 0) return null;
  doc.setTitle('Recovered PDF');
  doc.setSubject('Partially recovered from corrupted file');
  return doc;
}

/** The `/MediaBox` of the page object that names this content stream, when one does. */
function boxOfPageNaming(number: number, objects: PdfObject[]): [number, number, number, number] | null {
  for (const object of objects) {
    if (!/\/Type\s*\/Page\b/.test(object.body)) continue;
    if (!new RegExp(`\\/Contents\\s+${number}\\s+\\d+\\s+R`).test(object.body)) continue;
    const found = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(object.body);
    if (found) return [Number(found[1]), Number(found[2]), Number(found[3]), Number(found[4])];
  }
  return null;
}

/**
 * A stream payload as its own dictionary says it is encoded.
 *
 * Decoded through the engine rather than `DecompressionStream`: the harvest has to
 * decide in one synchronous step whether a stream is a page's drawing, and a
 * web-stream inflate decodes nothing where `Blob.prototype.stream` is absent —
 * which is the test environment, so the last resort would never be measured where
 * it is written.
 */
function decodeStreamPayload(context: PDFContext, dict: string, raw: Uint8Array): Uint8Array | null {
  if (!/\/FlateDecode/.test(dict)) return raw;
  try {
    const filter = PDFDict.withContext(context);
    filter.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    return decodePDFRawStream(PDFRawStream.of(filter, raw)).decode();
  } catch {
    // A stream that will not decode is not page content: say so by handing back
    // nothing rather than pasting ciphertext where a drawing should be.
    return null;
  }
}

const PAINT_OPERATORS_TEST = /\b(Tj|TJ|f\*?|B\*?|S|s|Do|BI)\b|BT|re\b/;

/** Latin-1 text of a decoded stream, for the operator sniff above. */
function decodedText(bytes: Uint8Array): string {
  return latin1Of(bytes.subarray(0, 4096));
}

/* ── CONVERT TO PDF: scan ─────────────────────────────────────────────────── */

export interface ScanImage {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ScanLayout {
  /** Named sheet (`a4`, `letter`…) or `fit` / `original` to hug the capture. */
  pageSize: string;
  orientation: 'portrait' | 'landscape' | 'auto';
  /** Points on every edge. */
  margin: number;
  fit: 'contain' | 'cover' | 'stretch';
}

export interface ScanResult {
  bytes: Uint8Array;
  pages: number;
  /** Captures that could not be decoded, named, with the reason. */
  skipped: { name: string; reason: string }[];
}

/**
 * Build one page per captured frame.
 *
 * The source container is preserved — a camera frame stays a JPEG — which is
 * why this does not go through `core/pack.pdfFromImages` (that rasterises every
 * image onto a canvas and embeds the result as PNG, roughly doubling a scan).
 * A frame this browser cannot decode is skipped and named rather than killing
 * the run, because losing page 4 of a 20-page scan is better than losing the
 * whole scan.
 */
export async function scanImagesToPdf(
  images: ScanImage[],
  layout: ScanLayout,
  hooks: RunHooks = {},
): Promise<ScanResult> {
  const doc = await newPDF();
  const skipped: ScanResult['skipped'] = [];
  const margin = layout.margin;

  for (let index = 0; index < images.length; index++) {
    throwIfAborted(hooks.signal ?? new AbortController().signal);
    const image = images[index];
    try {
      const embedded = await embedImageBytes(doc, image.bytes, { mime: image.mime });
      const naturalWidth = embedded.width;
      const naturalHeight = embedded.height;
      const hug = layout.pageSize === 'fit' || layout.pageSize === 'original';
      const landscape = layout.orientation === 'landscape'
        || (layout.orientation === 'auto' && naturalWidth > naturalHeight);
      const [sheetWidth, sheetHeight] = hug
        ? [naturalWidth + margin * 2, naturalHeight + margin * 2]
        : resolvePageSize(layout.pageSize, landscape);

      const page = doc.addPage([sheetWidth, sheetHeight]);
      const usableWidth = Math.max(1, sheetWidth - margin * 2);
      const usableHeight = Math.max(1, sheetHeight - margin * 2);
      const scale = hug ? 1 : fitScale(naturalWidth, naturalHeight, usableWidth, usableHeight, layout.fit);
      const drawWidth = Math.min(naturalWidth * scale, usableWidth);
      const drawHeight = Math.min(naturalHeight * scale, usableHeight);
      page.drawImage(embedded, {
        x: margin + (usableWidth - drawWidth) / 2,
        y: margin + (usableHeight - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight,
      });
    } catch (error) {
      skipped.push({
        name: image.name,
        reason: error instanceof Error ? error.message : 'this browser could not decode it',
      });
    }
    hooks.progress?.((index + 1) / images.length, `Placed page ${index + 1} of ${images.length}`);
  }

  const bytes = await savePDF(doc);
  return { bytes, pages: doc.getPageCount(), skipped };
}

/* ── SECURITY: visual signature ───────────────────────────────────────────── */

/**
 * One mark the user placed on the page.
 *
 * `x`/`y` are fractions of the *target* page's own box (`x` from the left, `y`
 * from the bottom, PDF user space) and `width`/`height` are points, so a mark
 * aimed at page 3 of a mixed-size document lands where it was aimed instead of
 * at page 1's geometry.
 */
export interface SignatureMark {
  type: 'text' | 'image';
  text: string;
  image?: Uint8Array | null;
  mime?: string;
  /** 1-based page number. */
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  fontFamily?: string;
}

export interface SignatureResult {
  placed: number;
  /** What had to be given up or moved, in sentences for `result.warnings`. */
  notes: string[];
}

/**
 * Draw the placed marks into the document.
 *
 * Text goes through `core/fonts.drawTextU`, so a signature typed in Chinese,
 * Cyrillic or Arabic embeds a real face instead of throwing the WinAnsi
 * `drawText` error the old path died on.
 */
export async function drawSignatureMarks(
  doc: PDFDocument,
  marks: readonly SignatureMark[],
  hooks: RunHooks = {},
): Promise<SignatureResult> {
  const pages = doc.getPages();
  const notes: string[] = [];
  let placed = 0;
  let missing = 0;
  let moved = 0;

  for (let index = 0; index < marks.length; index++) {
    throwIfAborted(hooks.signal ?? new AbortController().signal);
    const mark = marks[index];
    const page = pages[mark.page - 1];
    if (!page) {
      missing += 1;
      continue;
    }
    const box = page.getMediaBox();
    const width = Math.min(Math.max(1, mark.width), box.width);
    const height = Math.min(Math.max(1, mark.height), box.height);
    const rawX = box.x + Math.min(Math.max(mark.x, 0), 1) * box.width;
    const rawY = box.y + Math.min(Math.max(mark.y, 0), 1) * box.height;
    const x = Math.min(Math.max(rawX, box.x), box.x + box.width - width);
    const y = Math.min(Math.max(rawY, box.y), box.y + box.height - height);
    if (Math.abs(x - rawX) > 0.5 || Math.abs(y - rawY) > 0.5) moved += 1;

    if (mark.type === 'image') {
      if (!mark.image || mark.image.length === 0) {
        missing += 1;
        continue;
      }
      try {
        const embedded = await embedImageBytes(doc, mark.image, { mime: mark.mime, format: 'png' });
        page.drawImage(embedded, { x, y, width, height });
        placed += 1;
      } catch (error) {
        notes.push(`A signature image on page ${mark.page} could not be embedded: ${
          error instanceof Error ? error.message : 'this browser could not decode it'
        }`);
      }
      continue;
    }

    const text = mark.text.trim();
    if (!text) {
      missing += 1;
      continue;
    }
    const size = clampFontSize(height);
    const { r, g, b } = parseHexColor(mark.color ?? '#000000');
    try {
      await drawTextU(page, {
        text,
        x,
        y: y + (height - size) / 2,
        size,
        color: rgb(r, g, b),
        fontFamily: mark.fontFamily,
        maxWidth: box.x + box.width - x,
      });
      placed += 1;
    } catch (error) {
      // `core/fonts` fetches a Unicode face from the CDN for scripts the
      // standard 14 cannot spell; offline, that fetch is what fails.
      notes.push(`The typed signature "${text}" on page ${mark.page} was not written: ${
        error instanceof Error ? error.message : 'its font could not be loaded'
      }. Offline, a signature drawn or uploaded as a picture still works.`);
    }
    hooks.progress?.((index + 1) / marks.length, `Placed signature ${index + 1} of ${marks.length}`);
  }

  if (missing > 0) {
    notes.push(`${count(missing, 'signature')} pointed at a page this document does not have, or had nothing to draw, and was left out.`);
  }
  if (moved > 0) {
    notes.push(`${count(moved, 'signature')} hung past the edge of its page and was pulled back inside it.`);
  }
  return { placed, notes };
}

/** A typed mark keeps the old visual size rule: 65 % of the box, 7–72 pt. */
function clampFontSize(boxHeight: number): number {
  return Math.max(7, Math.min(72, boxHeight * 0.65));
}

function count(value: number, noun: string): string {
  return value === 1 ? `1 ${noun}` : `${value} ${noun}s`;
}

/* ── SECURITY: compare ────────────────────────────────────────────────────── */

export interface CompareOptions {
  /** CSS hex painted over a differing pixel. */
  highlightColor: string;
  /** Sum of the per-channel differences a pixel must exceed to count (5–150). */
  sensitivity: number;
  /** Device pixels per PDF point while rendering. */
  scale?: number;
}

export interface CompareResult {
  bytes: Uint8Array;
  /** Pages that exist in both documents, and so were actually compared. */
  compared: number;
  /** Pages only the first / second document has — reported, never diffed. */
  onlyInFirst: number;
  onlyInSecond: number;
}

/**
 * Render both documents and write document A with the differences painted on.
 *
 * The pixels are compared through `core/render`'s single-owner pdf.js sessions,
 * so the preview and this file agree, and the page-count difference comes back
 * as a number instead of silently truncating the shorter document.
 */
export async function comparePDFs(
  first: Uint8Array,
  second: Uint8Array,
  options: CompareOptions,
  hooks: RunHooks = {},
): Promise<CompareResult> {
  const scale = options.scale ?? 2;
  const out = await newPDF();
  const highlight = parseHexColor(options.highlightColor);
  const labelFont = await out.embedFont(StandardFonts.Helvetica);
  const sessionA = await openRender(first);
  const sessionB = await openRender(second);
  const compared = Math.min(sessionA.numPages, sessionB.numPages);

  try {
    for (let page = 1; page <= compared; page++) {
      throwIfAborted(hooks.signal ?? new AbortController().signal);
      const [renderA, renderB] = await Promise.all([
        sessionA.renderPage(page, scale),
        sessionB.renderPage(page, scale),
      ]);
      // `renderPage` settles when the task is *scheduled*; the pixels arrive on
      // `finished`. Both canvases are read below — once into the page copy, once
      // through the diff — and reading them early is what shipped a comparison
      // where every page measured paper, so nothing could ever be marked
      // (the campaign's unawaited-paint family; `docs/TOOL-CAMPAIGN.md`, the
      // `compare-pdfs` row, carries the deployed numbers).
      await Promise.all([renderA.finished, renderB.finished]);
      const width = Math.max(renderA.width, renderB.width);
      const height = Math.max(renderA.height, renderB.height);
      const sheet = document.createElement('canvas');
      sheet.width = width;
      sheet.height = height;
      const context = sheet.getContext('2d');
      if (!context) throw new Error('This browser cannot render a page to compare it.');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(renderA.canvas, 0, 0);

      const overlay = diffCanvas(renderA, renderB, width, height, options.sensitivity, highlight);
      const pageImage = await embedImageBytes(out, await canvasPng(sheet), { mime: 'image/png' });
      const outPage = out.addPage([width / scale, height / scale]);
      outPage.drawImage(pageImage, { x: 0, y: 0, width: width / scale, height: height / scale });
      if (overlay) {
        const overlayImage = await embedImageBytes(out, await canvasPng(overlay), { mime: 'image/png' });
        outPage.drawImage(overlayImage, {
          x: 0,
          y: 0,
          width: width / scale,
          height: height / scale,
          opacity: 0.7,
        });
      }
      outPage.drawText(`Page ${page} — comparison`, {
        x: 10,
        y: height / scale - 14,
        size: 10,
        font: labelFont,
        color: rgb(0.5, 0.5, 0.5),
      });
      renderA.cancel();
      renderB.cancel();
      hooks.progress?.(page / compared, `Compared page ${page} of ${compared}`);
    }
  } finally {
    await sessionA.destroy();
    await sessionB.destroy();
  }

  return {
    bytes: await savePDF(out),
    compared,
    onlyInFirst: Math.max(0, sessionA.numPages - compared),
    onlyInSecond: Math.max(0, sessionB.numPages - compared),
  };
}

/** Paint every pixel over the threshold in the highlight colour, with alpha. */
function diffCanvas(
  a: { canvas: HTMLCanvasElement; width: number; height: number },
  b: { canvas: HTMLCanvasElement; width: number; height: number },
  width: number,
  height: number,
  sensitivity: number,
  highlight: { r: number; g: number; b: number },
): HTMLCanvasElement | null {
  const grab = (source: HTMLCanvasElement): Uint8ClampedArray => {
    const holder = document.createElement('canvas');
    holder.width = width;
    holder.height = height;
    const context = holder.getContext('2d');
    if (!context) return new Uint8ClampedArray(width * height * 4);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const dataA = grab(a.canvas);
  const dataB = grab(b.canvas);
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  if (!context) return null;
  const paint = context.createImageData(width, height);
  const target = paint.data;
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const distance = Math.abs(dataA[j] - dataB[j])
      + Math.abs(dataA[j + 1] - dataB[j + 1])
      + Math.abs(dataA[j + 2] - dataB[j + 2]);
    if (distance > sensitivity) {
      target[j] = Math.round(highlight.r * 255);
      target[j + 1] = Math.round(highlight.g * 255);
      target[j + 2] = Math.round(highlight.b * 255);
      target[j + 3] = Math.min(255, Math.round(distance * 1.5));
    }
  }
  context.putImageData(paint, 0, 0);
  return out;
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not encode the comparison page.');
  return new Uint8Array(await blob.arrayBuffer());
}
