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
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  degrees,
  decodePDFRawStream,
  newPDF,
  openPDF,
  pageRotation,
  rgb,
  savePDF,
  StandardFonts,
} from '../pdf/core/doc';
import { embedImageBytes, fitScale } from '../pdf/core/pack';
import { pageContentOps, pageContentStreams, parseContentStream } from '../pdf/core/content';
import { pageSize as resolvePageSize } from '../pdf/core/pages';
import { openRender } from '../pdf/core/render';
import { drawTextU } from '../pdf/core/fonts';
import { diffAreasOf, diffAreaWords } from '@/components/tools/pdf/security/CompareMain';
import {
  quarterTurn,
  viewerRectToUserSpace,
  viewerSizeOf,
  type PageFrame,
} from '../pdf/core/tables';
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
  /** Sheets were still page objects in the bytes but the page tree no longer named them. */
  | 'rehooked'
  /** No page tree survived: sheets were built around the content streams in the bytes. */
  | 'content-streams';

/** References a recovered page still names but the cut bytes no longer hold. */
export interface DroppedRefs {
  contents: number;
  annots: number;
  images: number;
}

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
  /**
   * Page objects that were whole in the bytes while nothing in the page tree named
   * them. Counted as recovered sheets, not as lost ones: the object and its
   * `/Contents` were there, only the `/Kids` entry was not.
   */
  rehooked: number;
  /** References on the recovered sheets that point at objects the cut took. */
  dropped: DroppedRefs;
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

  // Sheet objects the page tree stopped naming. They are whole objects with their
  // own `/Contents`; only the `/Kids` entry is gone, so counting them as lost is
  // wrong about a page that is still in the file — MuPDF and poppler both open these
  // bytes at 4 sheets where this tool returned 3 and said one "could not be
  // recovered" (`docs/research/repair-damage-readers.log`, case `orphaned-page-object`).
  const best = (): number => Math.max(0, ...candidates.map((item) => usablePages(item.doc)));
  const openedPages = best();
  const orphans = candidates.length > 0 ? orphanPageObjects(objects) : [];
  const rehookedBytes = orphans.length > 0 ? rehookOrphans(bytes, objects, orphans) : null;

  // Strategy 2: re-index. Only worth a second parse when the first read fewer
  // sheets than the file claims, but that is exactly the case the tool is for.
  const source = rehookedBytes ?? bytes;
  const inSource = rehookedBytes ? scanPdfObjects(latin1Of(rehookedBytes)) : objects;
  const indexed = rebuiltIndexBytes(source, inSource);
  if (indexed && (candidates.length === 0 || best() < (claimed ?? Infinity))) {
    try {
      const doc = await openPDF(indexed, { ignoreEncryption: true });
      if (usablePages(doc) > best()) {
        candidates.push({ doc, path: rehookedBytes ? 'rehooked' : 'rebuilt-index' });
      }
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
  const dropped = dropDanglingReferences(repaired);

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
    rehooked: chosen.path === 'rehooked' ? Math.max(0, repaired.getPageCount() - openedPages) : 0,
    dropped,
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
 * Take out the references a recovered sheet can no longer resolve.
 *
 * A page recovered through a rebuilt index can name a content stream, an annotation
 * or an image XObject that the cut bytes no longer hold, and `copyPages` carries the
 * dangling reference across. The sheet is blank either way, but a file that points
 * at nothing draws warnings from every reader on open (libqpdf `ignoring non-stream
 * item`, MuPDF `cannot find object in xref` / `no XObject subtype specified`), and
 * none of that reaches the user while the sentence says "4 page(s) readable" —
 * measured before this pass covered annots and XObjects: 4 sheets, unchanged dangling
 * references, and eight MuPDF errors under `docs/research/repair-damage-readers.py`
 * case `dangling-image-and-annots`.
 *
 * So the rebuild says "the cut took this" by holding no reference to it. Counted,
 * because what goes is a picture or a link a reader would otherwise have been shown.
 */
function dropDanglingReferences(doc: PDFDocument): DroppedRefs {
  const dropped: DroppedRefs = { contents: 0, annots: 0, images: 0 };
  const { context } = doc;
  const resolves = (value: unknown): boolean => {
    try {
      const found = value instanceof PDFRef ? context.lookup(value) : value;
      return found instanceof PDFStream || found instanceof PDFDict
        || found instanceof PDFArray || found instanceof PDFName;
    } catch {
      // A reference to an object the file does not hold — the truncated tail's
      // case — which is what this pass is looking for.
      return false;
    }
  };
  for (const page of doc.getPages()) {
    const contents = page.node.get(PDFName.of('Contents'));
    if (contents !== undefined) {
      if (contents instanceof PDFArray) {
        const kept = contents.asArray().filter(resolves);
        dropped.contents += contents.size() - kept.length;
        if (kept.length !== contents.size()) {
          if (kept.length === 0) page.node.delete(PDFName.of('Contents'));
          else page.node.set(PDFName.of('Contents'), context.obj(kept));
        }
      } else if (!resolves(contents)) {
        dropped.contents += 1;
        page.node.delete(PDFName.of('Contents'));
      }
    }
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (annots) {
      const kept = annots.asArray().filter(resolves);
      dropped.annots += annots.size() - kept.length;
      if (kept.length !== annots.size()) {
        if (kept.length === 0) page.node.delete(PDFName.of('Annots'));
        else page.node.set(PDFName.of('Annots'), context.obj(kept));
      }
    }
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xobjects) {
      for (const name of xobjects.keys()) {
        if (resolves(xobjects.get(name))) continue;
        // The `/Contents` still says `/<name> Do`; readers report that as a missing
        // resource on the one line they have for it, which is true: it is gone.
        xobjects.delete(name);
        dropped.images += 1;
      }
    }
  }
  return dropped;
}

/**
 * Page objects the file still holds that no page tree names.
 *
 * A `remove-page`-shaped edit that only unhooks the `/Kids` entry leaves the object,
 * its `/Contents` and its `/Resources` in the bytes. MuPDF and poppler open such a
 * file at its full count, so a rebuild that returns the tree's number is returning
 * fewer sheets than the file holds.
 */
function orphanPageObjects(objects: PdfObject[]): PdfObject[] {
  const named = new Set<string>();
  for (const item of objects) {
    if (!/\/Type\s*\/Pages\b/.test(item.body)) continue;
    for (const found of item.body.matchAll(/(\d+)\s+(\d+)\s+R/g)) named.add(`${found[1]} ${found[2]} R`);
  }
  return objects.filter(
    (item) => /\/Type\s*\/Page\b/.test(item.body) && !named.has(`${item.number} ${item.generation} R`),
  );
}

/**
 * The same bytes with every orphaned page object named in the tree again.
 *
 * `/Kids` is an array of references in page order, so an object is put back before
 * the first sibling with a greater object number — the order the file itself is in.
 * That is a guess when numbers do not ascend with the pages, which the report says
 * rather than passing off as the document's own order. `/Count` moves with it, and
 * the index is rebuilt over the result afterwards, so both the offsets and the count
 * are true of the bytes that get written.
 *
 * `null` when the bytes hold no page tree to put them back into.
 */
function rehookOrphans(bytes: Uint8Array, objects: PdfObject[], orphans: PdfObject[]): Uint8Array | null {
  const node = objects.find(
    (item) => /\/Type\s*\/Pages\b/.test(item.body) && /\/Kids\s*\[/.test(item.body) && /\/Count\s+\d+/.test(item.body),
  );
  const kids = node ? /\/Kids\s*\[([^\]]*)\]/.exec(node.body) : null;
  const count = node ? /\/Count\s+(\d+)/.exec(node.body) : null;
  if (!node || !kids || !count) return null;
  const list = kids[1].trim().split(/\s+(?=\d+\s+\d+\s+R)/).filter(Boolean)
    .map((ref) => ({ at: Number(/\d+/.exec(ref)?.[0] ?? 0), ref: ref.trim() }));
  let added = 0;
  for (const orphan of orphans) {
    const ref = `${orphan.number} ${orphan.generation} R`;
    if (list.some((entry) => entry.ref === ref)) continue;
    const at = list.findIndex((entry) => entry.at > orphan.number);
    const entry = { at: orphan.number, ref };
    if (at < 0) list.push(entry);
    else list.splice(at, 0, entry);
    added += 1;
  }
  if (added === 0) return null;
  const body = node.body
    .replace(kids[0], `/Kids [${list.map((entry) => entry.ref).join(' ')}]`)
    .replace(count[0], `/Count ${Number(count[1]) + added}`);
  const bodyStart = node.end - node.body.length;
  const text = latin1Of(bytes);
  return latin1Bytes(`${text.slice(0, bodyStart)}${body}${text.slice(node.end)}`);
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

/**
 * Operators that put something on the paper: text shown, paths painted, XObjects
 * drawn. One spelling of "this stream draws" for both places that ask it — the
 * audit of a produced document and the harvest's decision whether a stream is a
 * page's content at all — because a regex and a set that drift apart would let a
 * sheet count as content in one and not the other.
 */
const PAINT_OPERATORS = new Set(['Tj', 'TJ', "'", '"', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'Do', 'BI']);

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
    if (!decoded || !parseContentStream(decoded).some((op) => PAINT_OPERATORS.has(op.name))) continue;
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
 * `x`/`y` are fractions of the *displayed* sheet the mark sits on — `x` from its
 * left edge, `y` up from its bottom — and `width`/`height` are points measured
 * on that same sheet, because that is what the pane's overlay paints against
 * (the pdf.js viewport carries `/Rotate`). `drawSignatureMarks` maps them into
 * stored user space through `core/tables.viewerRectToUserSpace` and turns the
 * content with the page, so a mark aimed at a quarter-turned sheet lands where
 * it was aimed and reads the way it looked in the preview.
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
/**
 * The families the sign pane offers are standard 14 names, and a standard name is
 * what the overlay paints the mark with (`font-['Helvetica',sans-serif]`).
 *
 * `core/fonts.getFont` reads a present `fontFamily` as "give me an embedded face",
 * so handing it `Helvetica` fetched a Noto subset from the site, embedded that, and
 * failed when nothing was served — while the bytes named a face the pane never
 * showed. A name the standard 14 cannot supply still goes through untouched.
 */
const STANDARD_FOURTEEN = new Set(['helvetica', 'times', 'timesroman', 'courier']);
function embeddedFamily(requested: string | undefined): string | undefined {
  const name = (requested ?? '').trim().toLowerCase();
  return name === '' || STANDARD_FOURTEEN.has(name) ? undefined : requested;
}

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
    const rotation = quarterTurn(pageRotation(page));
    // The pane measures a mark on the DISPLAYED sheet — `SignMain.tsx` paints its
    // overlay on the pdf.js viewport, which carries `/Rotate` — so the fractions
    // and point sizes arrive in the rotated frame. Everything below clamps in
    // that frame and hands the box to the shared viewer table; a `/Rotate 0`
    // page reduces to exactly the stored-box arithmetic this used to do by hand.
    const frame: PageFrame = {
      x0: box.x,
      y0: box.y,
      width: box.width,
      height: box.height,
      rotation,
    };
    const sheet = viewerSizeOf(frame);
    const width = Math.min(Math.max(1, mark.width), sheet.width);
    const height = Math.min(Math.max(1, mark.height), sheet.height);
    const rawX = Math.min(Math.max(mark.x, 0), 1) * sheet.width;
    const rawBottom = Math.min(Math.max(mark.y, 0), 1) * sheet.height;
    const x = Math.min(Math.max(rawX, 0), sheet.width - width);
    const bottom = Math.min(Math.max(rawBottom, 0), sheet.height - height);
    if (Math.abs(x - rawX) > 0.5 || Math.abs(bottom - rawBottom) > 0.5) moved += 1;
    const area = viewerRectToUserSpace(
      { x, y: sheet.height - bottom - height, width, height },
      frame,
    );
    // pdf-lib paints rotated content up-and-right of its anchor, so the anchor
    // is the stored corner the DISPLAYED lower-left lands on, and `up` is the
    // displayed up-axis in stored components — the typed name's baseline lift
    // travels along it, keeping the centring rule in the frame the user saw.
    const [ax, ay] = rotation === 90
      ? [area.x + area.width, area.y]
      : rotation === 180
        ? [area.x + area.width, area.y + area.height]
        : rotation === 270
          ? [area.x, area.y + area.height]
          : [area.x, area.y];
    const [upX, upY] = rotation === 90
      ? [-1, 0]
      : rotation === 180
        ? [0, -1]
        : rotation === 270
          ? [1, 0]
          : [0, 1];

    if (mark.type === 'image') {
      if (!mark.image || mark.image.length === 0) {
        missing += 1;
        continue;
      }
      try {
        const embedded = await embedImageBytes(doc, mark.image, { mime: mark.mime, format: 'png' });
        page.drawImage(embedded, {
          x: ax,
          y: ay,
          width,
          height,
          ...(rotation === 0 ? {} : { rotate: degrees(rotation) }),
        });
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
    const lift = (height - size) / 2;
    const { r, g, b } = parseHexColor(mark.color ?? '#000000');
    try {
      await drawTextU(page, {
        text,
        x: ax + upX * lift,
        y: ay + upY * lift,
        size,
        color: rgb(r, g, b),
        fontFamily: embeddedFamily(mark.fontFamily),
        maxWidth: sheet.width - x,
        ...(rotation === 0 ? {} : { rotation }),
      });
      placed += 1;
    } catch (error) {
      // `core/fonts` embeds a Unicode face for scripts the standard 14 cannot
      // spell; that face is fetched from the site, so this is the one branch a
      // typed signature can take that does not settle with nothing served.
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
      const lines = [`Page ${page} — comparison`];
      if (overlay) {
        const overlayImage = await embedImageBytes(out, await canvasPng(overlay.canvas), { mime: 'image/png' });
        outPage.drawImage(overlayImage, {
          x: 0,
          y: 0,
          width: width / scale,
          height: height / scale,
          opacity: 0.7,
        });
        // The sentence beside the pages names every changed area in the page's own
        // points (`CompareMain.publishDiff` → `diffAreaWords`); the sheet carries
        // the same coordinates through the same region-joining code over the same
        // mask at the same density, or the file quietly drops the half of the
        // verdict a reader can check. Both draw from the frame's top-left, so the
        // points need no re-anchoring.
        const areas = diffAreasOf(overlay.changed, width, height).map((area) => ({
          x0: area.x0 / scale,
          y0: area.y0 / scale,
          x1: area.x1 / scale,
          y1: area.y1 / scale,
        }));
        lines.push(`${count(areas.length, 'changed area')}, from the top-left of the page:`);
        // The pane lists twelve areas and counts the rest; the sheet keeps that
        // cap (its `AREA_LIMIT`) so the two name the same list.
        for (const [index, area] of areas.slice(0, 12).entries()) {
          lines.push(`${index + 1}. ${diffAreaWords(area)}`);
        }
        if (areas.length > 12) {
          lines.push(`${areas.length - 12} more, marked on the copy all the same.`);
        }
      }
      lines.forEach((line, index) => {
        outPage.drawText(line, {
          x: 10,
          y: height / scale - 14 - index * 11,
          size: 10,
          font: labelFont,
          color: rgb(0.5, 0.5, 0.5),
        });
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

/**
 * Paint every pixel over the threshold in the highlight colour, with alpha.
 *
 * `null` when not one pixel cleared the threshold, which is the whole answer for a
 * page the two files share. The caller already guards on it; what it used to get was
 * a full-size canvas of nothing, embedded as a PNG (three device px per point, plus
 * an `/SMask`) on **every** page of every export — measured on an A-against-A pair,
 * 2 image XObjects per page with 0 of 999 600 alpha bytes set on each of the three
 * sheets, 85 247 bytes for three pages of text and no difference at all.
 *
 * The alpha is `distance × 1.5` clamped, the same rule the pane paints with
 * (`CompareMain.publishDiff`), so one change is not two opacities depending on which
 * path reached it.
 *
 * Alongside the canvas it returns the plain changed-pixel mask, so the export can
 * run the pane's own `diffAreasOf` over it and write the same area coordinates the
 * sentence beside the pages names.
 */
function diffCanvas(
  a: { canvas: HTMLCanvasElement; width: number; height: number },
  b: { canvas: HTMLCanvasElement; width: number; height: number },
  width: number,
  height: number,
  sensitivity: number,
  highlight: { r: number; g: number; b: number },
): { canvas: HTMLCanvasElement; changed: Uint8Array } | null {
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
  const changed = new Uint8Array(width * height);
  let marked = 0;
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
      changed[i] = 1;
      marked += 1;
    }
  }
  if (marked === 0) return null;
  context.putImageData(paint, 0, 0);
  return { canvas: out, changed };
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not encode the comparison page.');
  return new Uint8Array(await blob.arrayBuffer());
}
