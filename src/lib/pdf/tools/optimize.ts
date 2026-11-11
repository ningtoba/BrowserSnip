/**
 * Optimize & repair tools.
 *
 * The rule this module is written to: **a run describes the bytes it actually
 * produced.** Every message quotes measured sizes (`describeSize` of the input
 * and of the output), never an intention; a file that came out larger says so
 * instead of reading like a saving; a number the user typed outside the field's
 * bounds is clamped *and announced*; and anything that needed Ghostscript or
 * CoherentPDF and could not reach them says which path produced the file. Where
 * a degraded path would only produce a file that *looks* processed, the tool
 * refuses with a reason instead.
 *
 * Because "it saved" is not evidence "it opens", the tools that rewrite
 * structure re-open their own output with `core/guard` and compare the page
 * count before describing the result.
 */
import type { PDFDocument, PDFImage, PDFPage } from '../core/doc';
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  newPDF,
  openPDF,
  pdfVersion,
  savePDF,
  toArrayBuffer,
} from '../core/doc';
import { COMPRESSION_PRESETS, compressPDF, type CompressionPreset } from '../core/compress';
import {
  appendContentOps,
  makeOp,
  operand,
  pageContentOps,
  prependContentOps,
  streamBytes,
  stripEmbeddedFiles,
} from '../core/content';
import { inspectScript, stripScript } from '../core/sanitize';
import { displayedSize, setMediaAndCrop } from '../core/pages';
import { listLayers, removeHiddenLayerContent } from '../core/layers';
import { canvasToBlob, openRender, type PageRender } from '../core/render';
import { EngineUnavailable } from '../engines/provider';
import { repairPDF, sheetsWithoutContent, type RepairFacts } from '@/lib/pdf-engine/commands';
import {
  ToolInputError,
  clampFields,
  describeSize,
  emptyFileError,
  expandPageRanges,
  inspectPdf,
  looksLikePdf,
  notAPdfError,
  openInputs,
  pagesField,
  parsePageRanges,
  qualityField,
} from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolValues,
} from './types';

const PRESET_OPTIONS = (Object.keys(COMPRESSION_PRESETS) as CompressionPreset[]).map((id) => ({
  value: id,
  label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  hint: COMPRESSION_PRESETS[id].description,
}));

const PRESET_IDS = Object.keys(COMPRESSION_PRESETS) as CompressionPreset[];

/* ── what a run actually did ─────────────────────────────────────────────── */

/**
 * The clause to drop into a tool's own sentence about a failed engine run.
 *
 * `EngineUnavailable` carries a full sentence for the no-fallback case; inside
 * a degrade warning the tool has already named the engine, so only the loader's
 * cause belongs there — one honest sentence, not two.
 */
function engineReason(error: unknown): string {
  if (error instanceof EngineUnavailable) return error.detail ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

/** A numeric option, bounded exactly as the rail bounds it (E15). */
interface Bound {
  key: string;
  label: string;
  min: number;
  max: number;
  unit?: string;
  integer?: boolean;
  /** Used when the field is blank or not a number at all. */
  fallback: number;
}

/**
 * Read a number the tool cannot proceed without, clamped into its bounds, with
 * the correction pushed into `warnings` so it reaches the result card.
 *
 * The runner clamps too (`clampFields`), but tools are also called straight from
 * the legacy engine hook and from tests, and a silent clamp is the difference
 * between "200 dpi" and a 30-second rasterise at 0 dpi. The correcting sentence
 * is produced by `core/guard` itself rather than written again here, so the rail
 * and the tool cannot drift into two wordings for one correction (E15).
 */
function readBound(values: ToolValues, bound: Bound, warnings: string[]): number {
  const { values: fixed, changes } = clampFields([fieldFor(bound)], values);
  warnings.push(...changes.map((change) => change.message));
  return numberValue(fixed, bound.key, bound.fallback);
}

/**
 * The same bound, expressed as the field the rail would have shown.
 *
 * Deliberately without `when`: a field the rail hid still has to be clamped when
 * a caller hands the tool a value for it, or `targetEnabled` would let a quality
 * of 200 reach the JPEG encoder unannounced.
 */
function fieldFor(bound: Bound): ToolField {
  return {
    key: bound.key,
    label: bound.label,
    type: 'number',
    min: bound.min,
    max: bound.max,
    ...(bound.integer === true ? { integer: true } : {}),
    ...(bound.unit ? { unit: bound.unit } : {}),
  };
}

/** Byte counts a message is allowed to print — measured, never estimated. */
interface SizeChange {
  before: number;
  after: number;
  /** Positive when the output is the larger of the two (E14). */
  delta: number;
  grew: boolean;
  unchanged: boolean;
  /** Absolute percentage difference, rounded for reading. */
  percent: number;
}

function sizeChange(before: number, after: number): SizeChange {
  const delta = after - before;
  return {
    before,
    after,
    delta,
    grew: delta > 0,
    unchanged: delta === 0,
    percent: before > 0 ? Math.round((Math.abs(delta) / before) * 100) : 0,
  };
}

/** `41.2 KB → 9.8 KB (-76%)`, `… (unchanged)`, or `… (+9%)`. */
function sizeSentence(change: SizeChange): string {
  const arrow = `${describeSize(change.before)} → ${describeSize(change.after)}`;
  if (change.unchanged) return `${arrow} (unchanged)`;
  return `${arrow} (${change.grew ? '+' : '-'}${change.percent}%)`;
}

/**
 * A rebuild that is bigger than the file it started from is not an improvement.
 * Used by the tidy-up tools, which can honestly hand back the input bytes.
 */
function keepSmaller(change: SizeChange, warnings: string[]): boolean {
  if (!change.grew) return false;
  warnings.push(
    `${sizeSentence(change)} — the rebuilt file is larger than the input, so the original bytes are returned.`,
  );
  return true;
}

/**
 * Re-open the bytes a run produced and count its pages (E3, E20).
 *
 * Deleting an object that was still referenced, or writing a linearization
 * dictionary nothing else reads, both produce a file that downloads happily and
 * opens as nothing. The output is therefore parsed before it is described.
 */
async function verifyOutput(
  bytes: Uint8Array,
  name: string,
  expectedPages: number,
): Promise<{ pages: number; problem: string | null }> {
  const check = await inspectPdf(bytes, name);
  if (check.error) return { pages: check.pages, problem: check.message };
  if (expectedPages > 0 && check.pages !== expectedPages) {
    return {
      pages: check.pages,
      problem: `the rebuilt file reads ${check.pages} of ${expectedPages} page(s)`,
    };
  }
  return { pages: check.pages, problem: null };
}

/**
 * True when the page draws glyphs itself (`Tj`, `TJ`, `'`, `"`).
 *
 * This is the cheap, pdf.js-free answer to "is there a text layer here", and it
 * is what lets the flattening and deskewing tools say what a page actually
 * contains instead of reporting "0 characters, done" (E10).
 */
function pageShowsText(page: PDFPage): boolean {
  try {
    return pageContentOps(page).some(
      (op) => op.name === 'Tj' || op.name === 'TJ' || op.name === "'" || op.name === '"',
    );
  } catch {
    // A content stream this parser cannot read simply counts as "no text".
    return false;
  }
}

/** Embedded versus total font resources, which decides PDF/A conformance. */
interface FontAudit {
  total: number;
  embedded: number;
}

/**
 * Count the fonts a document draws with and how many carry a `/FontFile`.
 *
 * Entries are resolved by hand rather than with `lookupMaybe(dict, XClass)`:
 * a font resource may be a dictionary or a reference, and the same is true of
 * the `/Font` map itself — and of what that map holds, which a producer is free
 * to make an array or a name. Asking pdf-lib for a `PDFDict` there throws
 * `UnexpectedObjectTypeError`, which would end a PDF/A run with a parser stack
 * trace instead of a report.
 */
function auditFonts(doc: PDFDocument): FontAudit {
  const audit: FontAudit = { total: 0, embedded: 0 };
  const seen = new Set<string>();
  const dictOf = (value: unknown): PDFDict | undefined => {
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    return resolved instanceof PDFDict ? resolved : undefined;
  };
  for (const page of doc.getPages()) {
    const resources = page.node.Resources();
    const map = dictOf(resources);
    const fontDict = dictOf(map?.get(PDFName.of('Font')));
    if (!fontDict) continue;
    for (const [, value] of fontDict.entries()) {
      const dict = dictOf(value);
      if (!dict) continue;
      const key = `${dict.get(PDFName.of('BaseFont'))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      audit.total += 1;
      const embedded = ['FontFile', 'FontFile2', 'FontFile3'].some(
        (file) => dict.get(PDFName.of(file)) !== undefined,
      );
      if (embedded) audit.embedded += 1;
    }
  }
  return audit;
}

/** The XMP packet a document carries, decoded, or `null` when it has none. */
function xmpPacket(doc: PDFDocument): string | null {
  const raw = doc.catalog.get(PDFName.of('Metadata'));
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const stream = resolved instanceof PDFRawStream ? resolved : undefined;
  if (!stream) return null;
  try {
    return new TextDecoder('latin1').decode(streamBytes(stream));
  } catch {
    return null;
  }
}

/**
 * Register a Flate stream whose `/Length` matches the bytes actually stored.
 *
 * `PDFContext.flateStream` compresses the payload and copies the dictionary it
 * was handed, so a `/Length` written from the uncompressed string is wrong by
 * the compression ratio — which is how the PDF/A metadata and ICC streams used
 * to end up claiming a length no reader could agree with.
 */
function flateStream(
  doc: PDFDocument,
  data: Uint8Array | string,
  dict: Record<string, unknown>,
): PDFRawStream {
  const stream = doc.context.flateStream(data, dict as never);
  stream.dict.set(PDFName.of('Length'), doc.context.obj(stream.contents.byteLength));
  return stream;
}

/** Read a `%PDF-x.y`-shaped fact the tools can state honestly. */
function headerVersionOf(doc: PDFDocument): string {
  const version = pdfVersion(doc);
  return /^[0-9]+\.[0-9]+$/.test(version) ? version : '1.7';
}

/** Object streams are a PDF 1.5 feature; saying so beats a silent 1.4 header. */
function versionWarning(doc: PDFDocument, objectStreams: boolean): string | null {
  if (!objectStreams) return null;
  const version = headerVersionOf(doc);
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  if (major > 1 || (major === 1 && minor >= 5)) return null;
  return `This file declares PDF ${version}, but object streams need 1.5 or newer; a strict reader may ignore them, and the file is still valid.`;
}

/* ── linearization probe ─────────────────────────────────────────────────── */

/**
 * Does the file open with a linearization dictionary?
 *
 * A conforming linearized PDF puts `/Linearized n` in the first page object,
 * within the first few hundred bytes. Checking the bytes is the only way this
 * app can tell a real CoherentPDF result from a rebuild that merely came from
 * the engine.
 */
export function isLinearized(bytes: Uint8Array): boolean {
  const window = new TextDecoder('latin1').decode(
    bytes.subarray(0, Math.min(bytes.length, 65536)),
  );
  return /\/Linearized\s+[\d.]+/.test(window);
}

/* ── deskew geometry ─────────────────────────────────────────────────────── */

export interface SkewCorrection {
  applied: boolean;
  /** Degrees the content was turned by, clockwise as the page is viewed. */
  angle: number;
  /** Page box size after the correction, in points. */
  width: number;
  height: number;
  /** Annotations left in the old coordinate space, which the user must know about. */
  annotations: number;
}

/**
 * Straighten one page by transforming its content, not its `/Rotate`.
 *
 * `/Rotate` only accepts multiples of 90°, so the previous implementation wrote
 * `88` and reported success: viewers that follow the spec rounded it, ignored
 * it, or rejected the file, which is a textbook fake success. The correction
 * therefore goes into the content stream as a `cm` matrix, and the boxes grow to
 * the rotated bounding rectangle so no corner is clipped.
 *
 * `turn` is **degrees of clockwise rotation as the page is viewed**, which is a
 * user-space rotation by `-turn`. That is deliberately the same sign as the
 * bitmap angle `skewFromProjectionProfile` reports a *tilt* in — text running
 * downhill to the right is positive — so a caller holding an estimate has to
 * negate it first (`deskewAngleFor` in `core/measure`), and passing the estimate
 * straight through doubles the lean instead of removing it. `/Rotate` is itself
 * just another rotation, so a turn of N degrees is a visible N degrees whatever
 * multiple of 90 the page carries — what a rotated page costs is the
 * *measurement*, not the matrix: the estimate reads the rendered bitmap, where
 * text under `/Rotate 90` runs vertically and sits outside the searched window
 * (measured: a `/Rotate 90` copy of the 3° fixture is left alone).
 */
export function applySkew(page: PDFPage, turn: number): SkewCorrection {
  const size = page.getSize();
  const box = { width: size.width, height: size.height };
  const annots = page.node.Annots();
  const annotations = annots ? annots.size() : 0;
  if (!Number.isFinite(turn) || Math.abs(turn) < 0.05) {
    return { applied: false, angle: 0, ...box, annotations };
  }
  const radians = (-turn * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x0 = page.getX();
  const y0 = page.getY();
  const corners = [
    [x0, y0],
    [x0 + box.width, y0],
    [x0, y0 + box.height],
    [x0 + box.width, y0 + box.height],
  ].map(([px, py]) => [px * cos - py * sin, px * sin + py * cos]);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const width = maxX - minX;
  const height = maxY - minY;
  prependContentOps(page, [
    makeOp('q'),
    makeOp('cm', [
      operand.number(cos),
      operand.number(sin),
      operand.number(-sin),
      operand.number(cos),
      operand.number(-minX),
      operand.number(-minY),
    ]),
  ]);
  appendContentOps(page, [makeOp('Q')]);
  setMediaAndCrop(page, { x: 0, y: 0, width, height });
  return { applied: true, angle: turn, width, height, annotations };
}

/* ── PDF/A output intent ─────────────────────────────────────────────────── */

/** Tag data plus its signature, ready to be laid out into an ICC profile. */
interface IccTag {
  signature: string;
  data: Uint8Array;
}

function fourCc(value: string): number {
  let out = 0;
  for (let i = 0; i < 4; i++) out = (out << 8) | (value.charCodeAt(i) & 0xff);
  return out >>> 0;
}

function tagText(value: string): Uint8Array {
  const bytes = new Uint8Array(8 + value.length + 1);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('text'));
  const encoder = new TextEncoder();
  bytes.set(encoder.encode(value).subarray(0, value.length), 8);
  bytes[8 + value.length] = 0;
  return bytes;
}

function tagDescription(value: string): Uint8Array {
  const text = `${value}\u0000`;
  const bytes = new Uint8Array(12 + text.length + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('desc'));
  view.setUint32(8, text.length);
  for (let i = 0; i < text.length; i++) bytes[12 + i] = text.charCodeAt(i) & 0xff;
  view.setUint32(12 + text.length, 0, false);
  view.setUint32(16 + text.length, 0, false);
  return bytes;
}

/** An s15Fixed16 number: 16 bits of integer range, 16 of fraction. */
function fixed16(value: number): number {
  return Math.round(value * 65536) | 0;
}

function tagXyz(x: number, y: number, z: number): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('XYZ '));
  view.setUint32(8, fixed16(x));
  view.setUint32(12, fixed16(y));
  view.setUint32(16, fixed16(z));
  return bytes;
}

/** A parametric tone curve of the simplest kind: `Y = X^gamma`. */
function tagCurve(gamma: number): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 2 + 2 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('para'));
  view.setUint16(8, 0);
  view.setUint16(10, 0);
  view.setInt32(12, fixed16(gamma));
  return bytes;
}

/**
 * A minimal but structurally valid sRGB profile for the output intent.
 *
 * The version this file used to hand out was 3144 zero bytes with a header
 * claiming 52 tags: parseable as a blob, meaningless as a colour profile, and
 * exactly the kind of "looks processed" output this pass exists to remove. What
 * is written here declares the tags it really carries, and its size field agrees
 * with its length, so a validator can read the matrix and the tone curves.
 */
export function srgbIccProfile(): Uint8Array {
  const tags: IccTag[] = [
    { signature: 'desc', data: tagDescription('sRGB IEC61966-2.1 (BrowserSnip minimal)') },
    { signature: 'wtpt', data: tagXyz(0.9505, 1.0, 1.089) },
    { signature: 'rXYZ', data: tagXyz(0.4361, 0.2225, 0.0139) },
    { signature: 'gXYZ', data: tagXyz(0.385, 0.7169, 0.1057) },
    { signature: 'bXYZ', data: tagXyz(0.1431, 0.0606, 0.7141) },
    { signature: 'rTRC', data: tagCurve(2.2) },
    { signature: 'gTRC', data: tagCurve(2.2) },
    { signature: 'bTRC', data: tagCurve(2.2) },
    { signature: 'cprt', data: tagText('No copyright, generated by BrowserSnip.') },
  ];
  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed = tags.map((tag) => {
    const at = offset;
    offset += tag.data.byteLength;
    return { ...tag, at };
  });

  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  view.setUint32(4, fourCc('none'));
  view.setUint32(8, 0x0210_0000);
  view.setUint32(12, fourCc('mntr'));
  view.setUint32(16, fourCc('RGB '));
  view.setUint32(20, fourCc('XYZ '));
  view.setUint16(24, 2024);
  view.setUint16(26, 1);
  view.setUint16(28, 1);
  view.setUint32(36, fourCc('acsp'));
  view.setUint32(64, 0);
  view.setInt32(68, fixed16(0.9642));
  view.setInt32(72, fixed16(1));
  view.setInt32(76, fixed16(0.8249));
  view.setUint32(88, fourCc('BrSn'));
  view.setUint32(128, tags.length);
  placed.forEach((tag, index) => {
    const entry = 132 + index * 12;
    view.setUint32(entry, fourCc(tag.signature));
    view.setUint32(entry + 4, tag.at);
    view.setUint32(entry + 8, tag.data.byteLength);
    bytes.set(tag.data, tag.at);
  });
  return bytes;
}

/**
 * Write the PDF/A identification without Ghostscript.
 *
 * What this *can* do locally: name the part and conformance in XMP, add an
 * output intent with a readable sRGB profile, mark the document as tagged, and
 * stamp the info dictionary. What it cannot do is subset and embed fonts, which
 * is why the caller reports both halves.
 */
function bestEffortPdfA(doc: PDFDocument, part: string): { number: number; conformance: string } {
  const number = Number.parseInt(part, 10) || 2;
  const conformance = (part.replace(/\d/g, '').toUpperCase() || 'B').charAt(0);
  doc.setProducer('BrowserSnip');
  doc.setCreationDate(new Date());
  doc.setModificationDate(new Date());

  const xmp = buildPdfAExtension(number, conformance, doc.getTitle() ?? '', doc.getAuthor() ?? '');
  // `/N` on a metadata stream is the component count of the data, and
  // ISO 32000-1 Table 162 says it is 0 there — an integer, not the `[0 0]` this
  // used to write. A validator reads the type, not the intention, and the whole
  // claim of this tool is that the file is readable by one.
  const metadata = flateStream(doc, xmp, {
    Type: 'Metadata',
    Subtype: 'XML',
    N: doc.context.obj(0),
  });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metadata));

  const profile = srgbIccProfile();
  const destProfile = doc.context.flateStream(profile, { N: doc.context.obj(3) });
  destProfile.dict.set(PDFName.of('Length'), doc.context.obj(destProfile.contents.byteLength));
  const outputIntent = doc.context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: doc.context.obj('sRGB IEC61966-2.1'),
    RegistryName: doc.context.obj('http://www.color.org'),
    Info: doc.context.obj('sRGB IEC61966-2.1 (minimal profile written by BrowserSnip)'),
    DestOutputProfile: doc.context.register(destProfile),
  });
  doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([doc.context.register(outputIntent)]));
  doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
  return { number, conformance };
}

function buildPdfAExtension(part: number, conformance: string, title: string, author: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="BrowserSnip"/>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escape(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${escape(author)}</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="${part}" pdfaid:conformance="${conformance}"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/* ── lossless rebuild primitives ─────────────────────────────────────────── */

/** What a pass over the document's streams actually managed. */
export interface DeflateOutcome {
  /** Streams rewritten to Flate. */
  converted: number;
  /** False when this browser has no Flate encoder — which is not "nothing to do". */
  supported: boolean;
}

/**
 * Rewrite every uncompressed stream to Flate.
 *
 * The result separates "there was nothing worth compressing" from "this engine
 * cannot compress", because both used to come back as `0` and the tool then
 * assured the user their file had no large streams.
 */
async function deflateAll(doc: PDFDocument): Promise<DeflateOutcome> {
  const outcome: DeflateOutcome = { converted: 0, supported: true };
  if (typeof CompressionStream === 'undefined') {
    outcome.supported = false;
    return outcome;
  }
  const entries = [...doc.context.enumerateIndirectObjects()];
  for (const [ref, object] of entries) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.has(PDFName.of('Filter'))) continue;
    const contents = object.contents;
    if (contents.byteLength < 512) continue;
    const deflated = await deflateBytes(contents);
    if (deflated === null) {
      outcome.supported = false;
      continue;
    }
    if (deflated.byteLength >= contents.byteLength) continue;
    const updated = object.dict instanceof PDFDict ? object.dict.clone() : (doc.context.obj({}) as PDFDict);
    updated.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    updated.set(PDFName.of('Length'), doc.context.obj(deflated.byteLength));
    doc.context.assign(ref, PDFRawStream.of(updated, deflated));
    outcome.converted += 1;
  }
  return outcome;
}

/**
 * Deflate with the platform encoder, from the bytes directly.
 *
 * `Blob.prototype.stream()` is absent in some engines — including this repo's
 * test environment — so the payload is pushed through a `ReadableStream`
 * instead: one fewer way for a compression to silently do nothing.
 */
async function deflateBytes(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const stream = source.pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Delete indirect objects nothing can reach, and return how many went.
 *
 * The reachability walk has to **resolve** references. Marking only the objects
 * named directly inside the catalog leaves every page, content stream and font
 * looking orphaned — which is what this helper used to do: it deleted the body
 * of the document and the tool reported a wonderful saving on a file with no
 * pages left. Each reference is followed once, so a 500-page tree costs one
 * pass rather than one per object (E7).
 */
function dropOrphanObjects(doc: PDFDocument): number {
  const referenced = new Set<string>();
  const queue: unknown[] = [
    doc.catalog,
    doc.context.trailerInfo.Info,
    doc.context.trailerInfo.Root,
    doc.context.trailerInfo.ID,
  ];
  while (queue.length > 0) {
    const value = queue.shift();
    if (value instanceof PDFRef) {
      const key = value.toString();
      if (referenced.has(key)) continue;
      referenced.add(key);
      queue.push(doc.context.lookup(value));
    } else if (value instanceof PDFArray) {
      value.asArray().forEach((item) => queue.push(item));
    } else if (value instanceof PDFRawStream) {
      for (const [, item] of value.dict.entries()) queue.push(item);
    } else if (value instanceof PDFDict) {
      for (const [, item] of value.entries()) queue.push(item);
    }
  }
  let removed = 0;
  for (const [ref] of [...doc.context.enumerateIndirectObjects()]) {
    if (!referenced.has(ref.toString())) {
      doc.context.delete(ref);
      removed += 1;
    }
  }
  return removed;
}

function removeAllAnnotations(doc: PDFDocument): number {
  let count = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    count += annots.size();
    page.node.set(PDFName.of('Annots'), doc.context.obj([]));
  }
  return count;
}

/** AcroForm field count, or 0 when the document has no interactive form. */
function countFormFields(doc: PDFDocument): number {
  const acroFormRef = doc.catalog.get(PDFName.of('AcroForm'));
  const acroForm = acroFormRef instanceof PDFRef
    ? doc.context.lookupMaybe(acroFormRef, PDFDict)
    : acroFormRef instanceof PDFDict
      ? acroFormRef
      : undefined;
  const fields = acroForm?.get(PDFName.of('Fields'));
  const array = fields instanceof PDFRef
    ? doc.context.lookupMaybe(fields, PDFArray)
    : fields instanceof PDFArray
      ? fields
      : undefined;
  return array ? array.size() : 0;
}

export const optimizeTools: PdfToolDefinition[] = [
  {
    id: 'pdf-compress',
    name: 'Compress PDF',
    description: 'Shrink images and rebuild the file structure — text stays selectable',
    icon: '📦',
    category: 'optimize',
    keywords: ['reduce size', 'smaller', 'shrink', 'email', 'optimise'],
    outputSuffix: '_compressed.pdf',
    actionLabel: 'Compress',
    promise: 'A smaller file with the same pages and selectable text, and an honest before/after size.',
    fields: [
      {
        key: 'preset',
        label: 'Strength',
        type: 'select',
        default: 'balanced',
        options: PRESET_OPTIONS,
        group: 'How hard to squeeze',
      help: 'Each step decodes and re-encodes more of the file. Lossless changes nothing you can see; extreme can make a scan look smeared.',
    },
      {
        key: 'targetEnabled',
        label: 'Aim for a specific file size',
        type: 'toggle',
        default: false,
        group: 'How hard to squeeze',
      help: 'Off squeezes at the strength above. On walks the strengths until the file fits, and stops with the closest attempt when it cannot.',
    },
      {
        key: 'targetMB',
        label: 'Target size',
        type: 'number',
        default: 1,
        min: 0.05,
        max: 200,
        step: 0.05,
        unit: 'MB',
        group: 'How hard to squeeze',
        help: 'The strength ladder is walked until the file fits, or until nothing more can go.',
        when: (v) => v.targetEnabled === true,
      },
      {
        key: 'jpegQuality',
        label: 'JPEG quality override',
        type: 'slider',
        default: 0,
        min: 0,
        max: 0.95,
        step: 0.05,
        group: 'Images',
        help: 'Set to 0 to use the preset’s own quality.',
        when: (v) => v.targetEnabled !== true,
      },
      {
        key: 'maxDpi',
        label: 'Maximum image resolution',
        type: 'number',
        default: 0,
        min: 0,
        max: 600,
        step: 10,
        integer: true,
        unit: 'dpi',
        group: 'Images',
        help: '0 keeps the preset value. Lower this for scans.',
        when: (v) => v.targetEnabled !== true,
      },
      {
        key: 'keepTransparency',
        label: 'Keep transparent logos',
        type: 'toggle',
        default: true,
        group: 'Images',
        help: 'Off throws the transparency mask away as well, so a logo sits on its own box of paper instead of on the page.',
      },
      { key: 'grayscale', label: 'Greyscale', type: 'toggle', default: false, group: 'Images', help: 'Colour images become grey, which usually saves more space than lowering quality. Text and vector colour are left alone.' },
      {
        key: 'stripMetadata',
        label: 'Remove metadata',
        type: 'toggle',
        default: false,
        group: 'Everything else',
        help: 'Drops the info dictionary and XMP, including the title and author.',
      },
    ],
    notes: [
      'Images are decoded and re-encoded in this tab; nothing is uploaded.',
      'If the rebuilt file would be larger than the input, the input bytes are returned and the result says so.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const warnings: string[] = [];
      const values = context.values;

      let preset = stringValue(values, 'preset', 'balanced') as CompressionPreset;
      if (!PRESET_IDS.includes(preset)) {
        warnings.push(`"${preset}" is not a strength this build knows, so "balanced" was used.`);
        preset = 'balanced';
      }
      const targetEnabled = booleanValue(values, 'targetEnabled');
      const targetMB = targetEnabled
        ? readBound(values, { key: 'targetMB', label: 'Target size', min: 0.05, max: 200, unit: 'MB', fallback: 1 }, warnings)
        : 0;
      const targetBytes = targetEnabled ? Math.round(targetMB * 1024 * 1024) : undefined;
      const quality = readBound(
        values,
        { key: 'jpegQuality', label: 'JPEG quality override', min: 0, max: 0.95, fallback: 0 },
        warnings,
      );
      const maxDpi = readBound(
        values,
        { key: 'maxDpi', label: 'Maximum image resolution', min: 0, max: 600, integer: true, unit: 'dpi', fallback: 0 },
        warnings,
      );

      const { bytes, report, pages } = await compressPDF(
        { bytes: input.bytes, password: context.password },
        {
          preset,
          targetBytes,
          jpegQuality: quality > 0 ? quality : undefined,
          maxDpi: maxDpi > 0 ? maxDpi : undefined,
          keepTransparency: booleanValue(values, 'keepTransparency', true),
          grayscale: booleanValue(values, 'grayscale'),
          stripMetadata: booleanValue(values, 'stripMetadata'),
          onProgress: context.progress,
          signal: context.signal,
        },
      );

      // The measured truth: `report.before` is the input size, `bytes` is what
      // is about to be downloaded. Nothing here is estimated from the preset.
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      const images = report.images;
      if (images.total === 0) {
        warnings.push('This PDF contains no images, so only the file structure could be rebuilt.');
      } else if (images.replaced === 0) {
        warnings.push(
          `None of the ${images.total} image(s) could be re-encoded smaller, so they are byte-for-byte the originals.`,
        );
      }
      for (const note of report.notes) warnings.push(note);
      if (targetBytes !== undefined && bytes.byteLength > targetBytes) {
        warnings.push(
          `The ${targetMB} MB target was not reached: ${describeSize(bytes.byteLength)} is the smallest this build gets without rasterising the text.`,
        );
      }

      const headline = change.unchanged
        ? `Nothing to save: ${sizeSentence(change)}.`
        : change.grew
          ? `The rebuild came out larger (${sizeSentence(change)}), so the original ${describeSize(change.before)} file is returned.`
          : `Compressed ${sizeSentence(change)}.`;
      const detail = images.total > 0
        ? `${images.replaced} of ${images.total} image(s) re-encoded, ${images.skipped} left untouched.`
        : 'Text stays selectable: no page was rasterised.';
      const target = targetBytes === undefined
        ? ''
        : ` Target ${targetMB} MB ${bytes.byteLength <= targetBytes ? 'met' : 'not met'}.`;
      // `compressPDF` reports the page count of the document it rebuilt, so the
      // result screen can state the output size in pages and not only in bytes.
      return { kind: 'pdf', bytes, pages, message: `${headline} ${detail}${target}`, warnings };
    },
  },

  {
    id: 'optimize-pdf',
    name: 'Optimize PDF',
    description: 'Lossless tidy-up: compress streams, use object streams, drop dead objects',
    icon: '🧽',
    category: 'optimize',
    keywords: ['lossless', 'clean', 'rebuild', 'linearize-lite'],
    outputSuffix: '_optimized.pdf',
    actionLabel: 'Optimize',
    promise: 'A lossless rebuild that reports the size it actually saved, or admits there was nothing to save.',
    fields: [
      { key: 'compressStreams', label: 'Flate-compress uncompressed streams', type: 'toggle', default: true, group: 'What to tidy', help: 'Re-compresses stream data that was stored raw. Nothing drawn changes.' },
      { key: 'objectStreams', label: 'Pack objects into object streams', type: 'toggle', default: true, group: 'What to tidy', help: 'Packs the object table into streams. A reader older than PDF 1.5 cannot open the result.' },
      { key: 'dropOrphans', label: 'Remove unreferenced objects', type: 'toggle', default: true, group: 'What to tidy', help: 'Removes objects nothing refers to any more. They cost space but cannot be lost in a way the page can show.' },
      {
        key: 'stripMetadata',
        label: 'Remove metadata',
        type: 'toggle',
        default: false,
        group: 'What to tidy',
      help: 'Off is the safe default: title, author and XMP are usually wanted. This is a tidy-up tool, not a privacy tool.',
    },
    ],
    notes: [
      'Lossless: no image is re-encoded and no text is rasterised.',
      'Nothing is deleted unless it is unreachable from the document catalog.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const warnings: string[] = [];
      const values = context.values;
      const compressStreams = booleanValue(values, 'compressStreams', true);
      const objectStreams = booleanValue(values, 'objectStreams', true);
      const dropOrphans = booleanValue(values, 'dropOrphans', true);
      const stripMetadata = booleanValue(values, 'stripMetadata');
      const original = sizeChange(input.bytes.byteLength, input.bytes.byteLength);

      if (!compressStreams && !objectStreams && !dropOrphans && !stripMetadata) {
        return {
          kind: 'pdf',
          bytes: input.bytes,
          pages: input.doc.getPageCount(),
          message: `No tidy-up option was selected, so the file is returned exactly as it came in (${describeSize(input.bytes.byteLength)}).`,
          warnings: ['Nothing was changed: every option on this tool was turned off.'],
        };
      }

      const doc = input.doc;
      const did: string[] = [];
      if (compressStreams) {
        const deflated = await deflateAll(doc);
        if (!deflated.supported) {
          warnings.push(
            'This browser cannot compress streams, so nothing was deflated and any size change comes from the rebuild alone.',
          );
        } else {
          did.push(
            deflated.converted > 0
                              ? `${deflated.converted} stream(s) gained Flate compression`
                              : 'no uncompressed stream was large enough to be worth compressing',
          );
        }
      }
      if (dropOrphans) {
        const removed = dropOrphanObjects(doc);
        did.push(removed > 0 ? `${removed} unreferenced object(s) dropped` : 'no unreferenced objects were found');
      }
      if (stripMetadata) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setCreator('');
        const hadXmp = doc.catalog.get(PDFName.of('Metadata')) !== undefined;
        if (hadXmp) doc.catalog.delete(PDFName.of('Metadata'));
        const infoRef = doc.context.trailerInfo.Info;
        if (infoRef instanceof PDFRef) doc.context.delete(infoRef);
        did.push(`cleared the info dictionary${hadXmp ? ' and the XMP packet' : ''}`);
      }
      const version = versionWarning(doc, objectStreams);
      if (version) warnings.push(version);

      const bytes = await savePDF(doc, { useObjectStreams: objectStreams });
      const rebuilt = sizeChange(original.before, bytes.byteLength);
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      let out = bytes;
      if (check.problem) {
        warnings.push(`The rebuilt file did not reopen cleanly (${check.problem}), so the original was returned.`);
        out = input.bytes;
      } else if (keepSmaller(rebuilt, warnings)) {
        out = input.bytes;
      }
      const delivered = sizeChange(original.before, out.byteLength);
      // Three honest headlines, never a saving that is not there (E14).
      const headline = out === input.bytes
        ? `Already tight: a rebuild would give ${describeSize(bytes.byteLength)} from ${describeSize(rebuilt.before)}, so the original is returned.`
        : delivered.unchanged
          ? `Rebuilt at the same size (${describeSize(delivered.after)}) — there was nothing left to take out.`
          : `Losslessly tidied ${sizeSentence(delivered)}.`;
      context.progress(1, 'Rebuilt');
      return {
        kind: 'pdf',
        bytes: out,
        pages: doc.getPageCount(),
        message: did.length > 0 ? `${headline} ${did.join('; ')}.` : `${headline}`,
        warnings,
      };
    },
  },

  {
    id: 'rasterize-pdf',
    name: 'Rasterize PDF',
    description: 'Flatten every page to an image — layers and selectable text are removed',
    icon: '🖨️',
    category: 'optimize',
    keywords: ['flatten to image', 'print safe', 'outline text', 'bitmap'],
    outputSuffix: '_rasterized.pdf',
    actionLabel: 'Rasterize',
    promise: 'Each page becomes one image, at the resolution you asked for, with the page count and size you expect.',
    fields: [
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 72, max: 600, step: 1, integer: true, unit: 'dpi', group: 'Quality', help: 'Every page becomes a picture at this resolution, so the file grows by roughly the square of it.' },
      {
        key: 'format',
        label: 'File format',
        type: 'segmented',
        default: 'jpeg',
        options: [
          { value: 'jpeg', label: 'JPEG (smaller)' },
          { value: 'png', label: 'PNG (lossless)' },
        ],
        group: 'Quality',
      help: 'JPEG is smaller for photographs; PNG keeps flat colour and text edges exactly, at a much larger size.',
    },
      qualityField('jpeg', { default: 0.85, min: 0.3, max: 1, step: 0.05, group: 'Quality', when: (v) => v.format === 'jpeg' }),
      {
        key: 'keepPageSize',
        label: 'Keep the original page size',
        type: 'toggle',
        default: true,
        group: 'Geometry',
        help: 'On: the page keeps its size in points and the picture is scaled to it. Off: the page is one point per pixel, so a 200 dpi scan of A4 becomes a 29-inch page.',
      },
    ],
    notes: [
      'Pages are rendered by the same pdf.js engine as the preview, in this tab.',
      'A rasterised page cannot be searched, selected, or read by a screen reader.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const warnings: string[] = [];
      const values = context.values;
      const dpi = readBound(values, { key: 'dpi', label: 'Resolution', min: 72, max: 600, integer: true, unit: 'dpi', fallback: 200 }, warnings);
      const format = stringValue(values, 'format', 'jpeg') === 'png' ? 'png' : 'jpeg';
      const quality = readBound(values, { key: 'quality', label: 'JPEG quality', min: 0.3, max: 1, fallback: 0.85 }, warnings);
      const keepPageSize = booleanValue(values, 'keepPageSize', true);
      if (format === 'png') warnings.push('PNG is lossless, so quality is ignored and the file will be larger than the JPEG path.');

      const source = input.doc.getPages();
      const withText = source.filter(pageShowsText).length;
      const session = await openRender(input.bytes, { password: context.password });
      try {
        const target = await newPDF();
        const scale = dpi / 72;
        let encodedAs: 'jpeg' | 'png' = format;
        for (let i = 0; i < source.length; i++) {
          if (context.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
          const size = displayedSize(source[i]);
          const render: PageRender = await session.renderPage(i + 1, scale, {
            background: format === 'jpeg' ? '#ffffff' : undefined,
          });
          // `renderPage` settles when the task is *scheduled*; the ink lands on
          // `finished`. Embedding the canvas before that shipped a picture of
          // nothing: measured on the deployed build, a text sheet at 13.88 % ink
          // came back as one image XObject at 0.00 % non-white, under a line that
          // read "Rasterised 1 page(s) to JPEG at 200 dpi. 7.0 KB → 24.1 KB
          // (+242 %)" (`docs/research/rasterize-fixture.mjs` → `rail-tool-bytes.mjs`
          // → `rail-measure.py`). The same rule `6b9b479` and `694e007` recorded:
          // a canvas is worth only what pdf.js has painted into it by the time it
          // is read, and "turn the pages into images" is the tool that promises it.
          await render.finished;
          const placed = await embedRenderedPage(target, render, format, quality);
          encodedAs = placed.encodedAs;
          const width = keepPageSize ? size.width : render.width;
          const height = keepPageSize ? size.height : render.height;
          const page = target.addPage([width, height]);
          page.drawImage(placed.image, { x: 0, y: 0, width, height });
          render.cancel();
          context.progress(((i + 1) / source.length) * 0.95, `Rasterised page ${i + 1} of ${source.length}`);
        }
        const bytes = await savePDF(target, { useObjectStreams: true });
        const check = await verifyOutput(bytes, input.name, source.length);
        if (check.problem) {
          throw new ToolInputError('CORRUPT', `The rasterised file did not reopen cleanly: ${check.problem}.`, {
            fileName: input.name,
            hint: 'Try a lower resolution — a very large page can exhaust this tab’s memory.',
          });
        }
        const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
        if (encodedAs !== format) {
          warnings.push(
            `This browser would not encode ${format.toUpperCase()}, so each page was written as ${encodedAs.toUpperCase()}: the file is heavier than the setting suggests, and the format named below is the one the bytes are.`,
          );
        }
        warnings.push(
          withText > 0
            ? `${withText} of ${source.length} page(s) carried text and are now pictures: nothing in the output can be selected or searched.`
            : `No page carried a text layer before this run, so nothing searchable was lost.`,
        );
        if (!keepPageSize) {
          warnings.push(
            `Page size follows the pixels at ${dpi} dpi, so a 595 pt page becomes ${Math.round(595 * scale)} pt wide.`,
          );
        }
        return {
          kind: 'pdf',
          bytes,
          pages: target.getPageCount(),
          message: `Rasterised ${source.length} page(s) to ${encodedAs.toUpperCase()} at ${dpi} dpi. ${sizeSentence(change)}.`,
          warnings,
        };
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'repair',
    name: 'Repair PDF',
    description: 'Recover what can be read from a damaged or truncated file',
    icon: '🔧',
    category: 'optimize',
    keywords: ['fix', 'corrupted', 'broken', 'recover'],
    outputSuffix: '_repaired.pdf',
    actionLabel: 'Repair',
    promise: 'A rebuilt file from whatever bytes are still readable, with the pages it could not save named.',
    notes: [
      'This tool opens files the normal reader refuses, which is the point of it.',
      'A file whose page content itself was cut off cannot be recreated; the report names the pages it lost and the sheets that came back blank.',
    ],
    async run(context) {
      const file = context.inputs[0];
      const bytes = await file.bytes();
      // Deliberately not `openInputs`: the gate rejects a file pdf-lib cannot
      // parse, and a file pdf-lib cannot parse is precisely what lands here (E3).
      if (bytes.byteLength === 0) throw emptyFileError(file.name);
      if (!looksLikePdf(bytes)) throw notAPdfError(file.name);
      const before = await inspectPdf(bytes, file.name, { password: context.password });

      context.progress(0.2, 'Rebuilding the cross-reference table');
      let repaired: Uint8Array;
      let engine: 'pdf-lib' | 'ghostscript' = 'pdf-lib';
      // What the local rebuild read: how many sheets the input claims, how many the
      // output holds, and how many of those hold a drawing operator at all. The
      // Ghostscript branch has none of that, so the blank count is taken off the
      // produced bytes instead — the sentence must be measured either way.
      let rebuilt: RepairFacts | null = null;
      try {
        rebuilt = await repairPDF(toArrayBuffer(bytes));
        repaired = rebuilt.bytes;
      } catch (error) {
        const local = error instanceof Error ? error.message : String(error);
        const { rebuildWithGhostscript } = await import('../core/engine-ops');
        context.log('The local parser gave up; asking Ghostscript to rebuild the file.');
        try {
          const outcome = await rebuildWithGhostscript(bytes, { onStatus: context.log });
          repaired = outcome.bytes;
          engine = 'ghostscript';
        } catch (gsError) {
          // A failed download explains itself in full; anything else came out of
          // Ghostscript and has to be attributed to it.
          const said = gsError instanceof EngineUnavailable
            ? gsError.message
            : `Ghostscript said: ${engineReason(gsError)}`;
          throw new ToolInputError(
            'CORRUPT',
            `${file.name} could not be repaired: ${local} ${said}`,
            {
              fileName: file.name,
              hint:
                'If the file was downloaded, download it again — a truncated transfer loses the tail of the '
                + 'document. Running this tool again while online lets Ghostscript rebuild it.',
            },
          );
        }
      }

      const after = await inspectPdf(repaired, file.name);
      const warnings: string[] = [];
      if (after.error || after.pages === 0) {
        throw new ToolInputError(
          'CORRUPT',
          `${file.name} was rewritten but still does not open: ${after.message}`,
          { fileName: file.name, hint: 'The page content itself is gone, not just its index.' },
        );
      }
      if (before.error) warnings.push(`The input would not open (${before.message})${before.truncated ? ' — it has no end-of-file marker' : ''}.`);
      if (engine === 'ghostscript') warnings.push('Ghostscript rebuilt this file; the local parser could not read it at all.');
      if (rebuilt?.path === 'rebuilt-index') {
        warnings.push(
          `The file's own index could not be read: a fresh one was written over the ${rebuilt.pages} page object(s) still in the bytes.`,
        );
      }
      if (rebuilt?.path === 'content-streams') {
        warnings.push(
          'No page tree survived, so each sheet was rebuilt around a content stream: page size and order are a guess here, not the document’s own.',
        );
      }

      // What the input states it holds — its page tree's `/Count` where one could be
      // read, otherwise the page objects still in the file. `repair` may not claim a
      // recovery larger than this without naming the difference (TOOL-TRIAGE §2:
      // "1 page(s) readable" for a file three readers open as four).
      const held = rebuilt?.claimed ?? before.declaredPages ?? before.pages;
      const lost = held > after.pages ? held - after.pages : 0;
      const blank = rebuilt?.blank ?? (await sheetsWithoutContent(repaired)) ?? 0;
      // Only after both counts are read: "without losing pages" used to be
      // printed from the *input*'s health, so a run that lost three pages said it
      // lost none two lines above admitting it did.
      if (!before.error && !before.recovered) {
        warnings.push(lost > 0
          ? `The input already opened with ${held} page(s); the rebuild reads ${after.pages}.`
          : `The input already opened; this run re-wrote its structure without losing pages (${after.pages} in, ${after.pages} out).`);
      }
      if (lost > 0) {
        warnings.push(`${lost} page(s) could not be recovered${before.recovered ? ` (${held} were listed in the page tree)` : ''}.`);
      }
      if (blank > 0) {
        warnings.push(
          `${blank} of the ${after.pages} page(s) in the output ${blank === 1 ? 'is' : 'are'} blank: `
          + `${blank === 1 ? 'its content stream holds' : 'their content streams hold'} no drawing operator, `
          + 'so the sheet opens and nothing appears on it.',
        );
      }
      const change = sizeChange(bytes.byteLength, repaired.byteLength);
      context.progress(1, 'Repaired');
      // One count phrase for both shapes: "N page(s)" when nothing was given up,
      // "N of M page(s)" when the file named more sheets than the rebuild holds.
      const listed = held > after.pages ? `${after.pages} of ${held} page(s)` : `${after.pages} page(s)`;
      const carried = after.pages - blank;
      return {
        kind: 'pdf',
        bytes: repaired,
        // The message below already states this number: `inspectPdf` fully parses
        // the repaired file to prove it opens (E3), so the count is read, not
        // guessed, and printing "out not counted" beside "7 page(s) readable" was
        // the same screen contradicting itself.
        pages: after.pages,
        // "readable" is only printed when every recovered sheet holds a drawing
        // operator. A page count that is right over paper is the failure this
        // campaign keeps meeting, and a bare count is exactly what §2 reported —
        // "1 page(s) readable" for a file three readers still open as four inked
        // sheets. Where something was given up, the sentence says what.
        message: `Repaired ${file.name}: ${
          blank > 0
            ? `${listed} recovered: ${carried} still ${carried === 1 ? 'holds' : 'hold'} content, `
              + `${blank} ${blank === 1 ? 'is' : 'are'} blank`
            : `${listed} readable`
        }. ${sizeSentence(change)}.`,
        warnings,
      };
    },
  },

  {
    id: 'sanitize-pdf',
    name: 'Sanitize PDF',
    description: 'Strip scripts, embedded files, annotations, metadata and hidden layers',
    icon: '🧪',
    category: 'optimize',
    keywords: ['clean', 'privacy', 'remove javascript', 'strip', 'hidden layers', 'cad export'],
    outputSuffix: '_sanitized.pdf',
    actionLabel: 'Sanitize',
    promise: 'Scripts, attachments and optional metadata removed, with a count of everything actually taken out.',
    fields: [
      { key: 'javascript', label: 'Remove JavaScript and automatic actions', type: 'toggle', default: true, group: 'What to remove', help: 'Removes what a document runs by itself: the /OpenAction it runs when it opens, the /A and /AA actions on annotations and form fields, and named scripts. Some forms stop calculating.' },
      { key: 'attachments', label: 'Remove embedded files', type: 'toggle', default: true, group: 'What to remove', help: 'Deletion is final in the output copy; extract them first if the file is the payload.' },
      { key: 'metadata', label: 'Remove XMP metadata', type: 'toggle', default: true, group: 'What to remove', help: 'XMP is what desktop search indexes. Without it the document stops describing itself to those tools.' },
      { key: 'info', label: 'Remove the document info dictionary', type: 'toggle', default: false, group: 'What to remove', help: 'The info dictionary holds title, author and dates — most readers show it as blank afterwards.' },
      { key: 'annotations', label: 'Remove annotations and form fields', type: 'toggle', default: false, group: 'What to remove', help: 'Comments, highlights, form fields and links all go. Anything you filled in goes with them.' },
      {
        key: 'hiddenLayers',
        label: 'Remove hidden layer content',
        type: 'toggle',
        default: false,
        group: 'Hidden layers',
        help: 'Deletes the drawing operators of layers the default view switches off, so a suppressed revision leaves the file. It cannot be undone: a reader that would have shown that layer now has nothing to show.',
      },
    ],
    notes: [
      'Everything runs on the document structure in this tab; no engine download is needed.',
      'This hides and removes optional parts, it does not redact: text under a removed annotation is still in the file.',
      'Script inside an XFA form packet stays where it is — it lives in the packet’s own XML, which this tool does not read — and a run that finds one says so on the card.',
      'Hidden layer content is off by default because it changes what the document can show, not only what it shows: a layer another view or an export intent switches back on is left alone and named.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const doc = input.doc;
      const values = context.values;
      const warnings: string[] = [];
      const actions: string[] = [];
      const removed: string[] = [];
      /** What the file carries that a switch left off this run declined to touch. */
      const leftAlone: string[] = [];

      const script = inspectScript(doc);
      if (booleanValue(values, 'javascript', true)) {
        const stripped = stripScript(doc);
        const left = inspectScript(doc).present;
        // What the bytes actually lost, not what the pass intended: an entry whose
        // removal changed nothing is not something the output is without.
        const gone = Math.min(stripped.removed, script.present - left);
        actions.push(
          gone > 0
            ? `${gone} script reference(s) removed`
            : script.present > 0
              ? 'no script reference this tool could remove'
              : 'no script references were present',
        );
        if (gone > 0) removed.push('scripts');
        if (left > 0) warnings.push(`${left} script reference(s) survived in a place this tool does not look.`);
      } else if (script.present > 0) {
        // The switch was off, so whatever the file runs is still in the output.
        // Saying nothing — or worse, "nothing to remove" — is what read as a clean
        // bill of health for a document that runs code when it opens.
        leftAlone.push(`${script.present} script reference(s) left in place`);
        warnings.push(`${script.places.join(', ')} ${script.present === 1 ? 'runs' : 'run'} in the output too: "Remove JavaScript and automatic actions" is off.`);
      }
      if (script.unreachable) {
        warnings.push(`This tool did not read ${script.unreachable}, so it is still in the file.`);
      }
      if (booleanValue(values, 'attachments', true)) {
        const stripped = stripEmbeddedFiles(doc);
        actions.push(stripped > 0 ? `${stripped} embedded file(s) removed` : 'no embedded files were present');
        if (stripped > 0) removed.push('attachments');
      }
      if (booleanValue(values, 'metadata', true)) {
        const had = xmpPacket(doc) !== null;
        doc.catalog.delete(PDFName.of('Metadata'));
        actions.push(had ? 'XMP metadata removed' : 'there was no XMP packet to remove');
        if (had) removed.push('XMP');
      }
      if (booleanValue(values, 'info')) {
        const infoRef = doc.context.trailerInfo.Info;
        if (infoRef instanceof PDFRef) {
          doc.context.delete(infoRef);
          actions.push('the info dictionary was removed');
          removed.push('the info dictionary');
        } else {
          actions.push('there was no info dictionary');
        }
      }
      if (booleanValue(values, 'annotations')) {
        const fields = countFormFields(doc);
        const annotations = removeAllAnnotations(doc);
        doc.catalog.delete(PDFName.of('AcroForm'));
        doc.catalog.delete(PDFName.of('XFA'));
        actions.push(
          `${annotations} annotation(s)${fields > 0 ? ` including ${fields} form field(s)` : ''} removed`,
        );
        if (annotations > 0 || fields > 0) removed.push('annotations and form fields');
        if (fields > 0) {
          warnings.push(`${fields} form field value(s) were removed with their widgets; filled-in answers typed into a form can live in the page content and stay visible.`);
        }
      }

      // Optional content is neither an annotation nor an attachment, so nothing
      // above touches it — but "sanitized" reads like "nothing hidden is left",
      // and a CAD export with twelve switched-off layers still ships all twelve.
      // Removing that ink is the user's call, not a default: it changes what the
      // document can show, and the output file cannot bring the layers back.
      const removeHidden = booleanValue(values, 'hiddenLayers', false);
      if (removeHidden) {
        const cleanup = removeHiddenLayerContent(doc);
        if (cleanup.refused) {
          warnings.push(`Hidden layer content was not removed: ${cleanup.refused}.`);
          actions.push('no hidden layer content was removed');
        } else {
          // A layer the file switches off but this reader cannot safely empty is
          // an admission, not a result: say so instead of "0 operators removed".
          const emptied = cleanup.removed.filter((layer) => layer.operators > 0 || layer.definitionRemoved);
          if (emptied.length === 0) {
            actions.push(
              cleanup.removed.length > 0 || cleanup.kept.length > 0 || cleanup.unresolved > 0
                ? 'no hidden layer could be emptied without guessing'
                : 'no layer is switched off in the default view',
            );
          } else {
            const names = emptied.map((layer) => `"${layer.name}"`).join(', ');
            actions.push(
              `${cleanup.operators} hidden layer operator(s) of ${names} removed (${describeSize(cleanup.contentBytes)} of content, ${cleanup.definitions} layer definition(s) deleted)`,
            );
            removed.push('the content of hidden layers');
          }
        }
        for (const kept of cleanup.kept) {
          warnings.push(`"${kept.name}" is off in the default view but ${kept.reason}, so its content stays in the file.`);
        }
        if (cleanup.conditional > 0) {
          warnings.push(`${cleanup.conditional} section(s) of content are guarded by a condition over several layers (OCMD) rather than by one layer; they stay.`);
        }
        if (cleanup.unresolved > 0) {
          warnings.push(`${cleanup.unresolved} optional-content reference(s) could not be tied to one layer, so the layer definitions stayed even where their ink went.`);
        }
        if (cleanup.unreadable > 0) {
          warnings.push(`${cleanup.unreadable} part(s) of the content could not be read, so nothing was taken out of them and every layer definition stayed.`);
        }
        if (cleanup.hiddenPages > 0) {
          warnings.push(`${cleanup.hiddenPages} page(s) are themselves optional content; their pages and their content were left alone.`);
        }
      }

      const layers = listLayers(doc);
      if (layers.length > 0 && !removeHidden) {
        const off = layers.filter((layer) => !layer.on).length;
        warnings.push(
          `${layers.length} optional content group(s) (layer${layers.length === 1 ? '' : 's'}) were left in place${
            off > 0 ? `, ${off} of them hidden in the default view` : ''
          }; their content is still in the file.`,
        );
      }

      context.progress(0.9, 'Writing the sanitized file');
      const bytes = await savePDF(doc, { useObjectStreams: true });
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      if (check.problem) {
        throw new ToolInputError('CORRUPT', `The sanitized file did not reopen cleanly: ${check.problem}.`, {
          fileName: input.name,
          hint: 'Turn off "Remove annotations and form fields" and run again.',
        });
      }
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      const clauses = [...actions, ...leftAlone];
      // Three endings, because there are three different things that happened:
      // something was taken out, nothing was taken out but the file still carries
      // what a switch left alone, or the file had nothing any switch asks about.
      const message = removed.length > 0
        ? `Sanitized: ${clauses.join(', ')}. ${sizeSentence(change)}.`
        : leftAlone.length > 0
          ? `Nothing was removed: ${clauses.join(', ')}. ${sizeSentence(change)}.`
          : `Nothing to remove: ${clauses.length > 0 ? clauses.join(', ') : 'no switch was on'}. ${sizeSentence(change)}.`;
      return { kind: 'pdf', bytes, pages: doc.getPageCount(), message, warnings };
    },
  },

  {
    id: 'linearize-pdf',
    name: 'Linearize PDF',
    description: 'Reorder objects so a browser can show page 1 before the file finishes downloading',
    icon: '⚡',
    category: 'optimize',
    keywords: ['fast web view', 'optimize for web', 'progressive'],
    outputSuffix: '_linearized.pdf',
    engines: ['cpdf'],
    actionLabel: 'Linearize',
    promise: 'A file whose first page loads first — or a clear statement that this build only rebuilt it.',
    notes: [
      'True linearization is performed by CoherentPDF (AGPL-3.0, fetched from a CDN the first time this tool runs and cached by your browser). If it cannot be reached, BrowserSnip rebuilds the file with object streams, which helps some viewers but is not a conforming linearized PDF.',
      'The output is checked for a /Linearized dictionary, so the result never claims more than the file contains.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const warnings: string[] = [];
      const { linearizeWithCpdf } = await import('../core/engine-ops');

      try {
        const out = await linearizeWithCpdf(input.bytes, context.password, { onStatus: context.log });
        const check = await verifyOutput(out, input.name, input.pageCount);
        if (check.problem) {
          warnings.push(`CoherentPDF returned a file that does not reopen cleanly (${check.problem}); the local rebuild below is used instead.`);
        } else {
          const linear = isLinearized(out);
          if (!linear) {
            warnings.push('CoherentPDF returned the file without a /Linearized dictionary, so it is a plain rebuild rather than a linearized PDF.');
          }
          const change = sizeChange(input.bytes.byteLength, out.byteLength);
          context.progress(1, 'Linearized with CoherentPDF');
          return {
            kind: 'pdf',
            bytes: out,
            // CoherentPDF gave back a finished file and no document: the honest
            // answer is "out not counted", not a re-derived guess.
            message: linear
              ? `Linearized with CoherentPDF: ${sizeSentence(change)}, page 1 first.`
              : `Rewritten by CoherentPDF: ${sizeSentence(change)}, but not linearized.`,
            warnings,
          };
        }
      } catch (error) {
        warnings.push(
          `CoherentPDF could not be reached (${engineReason(error)}), so this file was rebuilt locally and is not linearized.`,
        );
      }

      const deflated = await deflateAll(input.doc);
      if (!deflated.supported) {
        warnings.push('This browser cannot compress streams, so the rebuild only repacked the objects.');
      }
      const bytes = await savePDF(input.doc, { useObjectStreams: true });
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      if (check.problem) {
        throw new ToolInputError('CORRUPT', `The rebuilt file did not reopen cleanly: ${check.problem}.`, {
          fileName: input.name,
          hint: 'Run again while online: CoherentPDF can linearize this file without a rebuild.',
        });
      }
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      if (isLinearized(bytes)) {
        warnings.push('The local rebuild happened to keep a /Linearized dictionary; it is not verified against the spec.');
      }
      context.progress(1, 'Rebuilt with object streams');
      return {
        kind: 'pdf',
        bytes,
        pages: input.doc.getPageCount(),
        message: `Rebuilt with object streams and ${deflated.converted} newly compressed stream(s): ${sizeSentence(change)}. This is not a conforming linearized PDF.`,
        warnings,
      };
    },
  },

  {
    id: 'pdf-to-pdfa',
    name: 'PDF to PDF/A',
    description: 'Convert for archiving: XMP identification and an output intent; fonts need Ghostscript',
    icon: '🏛️',
    category: 'optimize',
    keywords: ['archive', 'pdfa', 'iso 19005', 'conformance'],
    outputSuffix: '_pdfa.pdf',
    engines: ['ghostscript'],
    actionLabel: 'Convert to PDF/A',
    promise: 'A PDF/A-identised file, and a plain statement of whether Ghostscript could verify it.',
    fields: [
      {
        key: 'part',
        label: 'PDF/A version',
        type: 'select',
        default: '2b',
        options: [
          { value: '1b', label: 'PDF/A-1b (ISO 19005-1, baseline)' },
          { value: '2b', label: 'PDF/A-2b (ISO 19005-2, allows JPEG2000/AES)' },
          { value: '3b', label: 'PDF/A-3b (ISO 19005-3, allows attachments)' },
        ],
        group: 'Conformance level',
      help: 'Level B only asks that the file render the same in ten years. A and U additionally demand tagged, readable content, which needs a font-embedding pass this tool cannot promise offline.',
    },
    ],
    notes: [
      'A conforming conversion runs on Ghostscript (AGPL-3.0, fetched from a CDN the first time this tool runs and cached by your browser). If it cannot be reached, BrowserSnip writes the XMP identification, an sRGB output intent and the tagging flag, which most validators read as a starting point but not as proof of conformance.',
      'Nothing here is uploaded: only the engine binary is fetched.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const warnings: string[] = [];
      const part = stringValue(context.values, 'part', '2b');
      const { convertToPdfA } = await import('../core/engine-ops');

      try {
        const { bytes, log } = await convertToPdfA(input.bytes, part, { onStatus: context.log });
        const check = await verifyOutput(bytes, input.name, input.pageCount);
        if (check.problem) {
          warnings.push(`Ghostscript produced a file that does not reopen cleanly (${check.problem}); the local conversion below is used instead.`);
        } else {
          for (const line of log) warnings.push(`Ghostscript: ${line}`);
          const declared = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
          const fonts = auditFonts(declared);
          if (fonts.total > fonts.embedded) {
            warnings.push(`${fonts.total - fonts.embedded} of ${fonts.total} font(s) in the output are still not embedded, so PDF/A conformance will be rejected by a strict validator.`);
          }
          const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
          context.progress(1, 'Converted with Ghostscript');
          return {
            kind: 'pdf',
            bytes,
            // `declared` is the Ghostscript output re-opened for the font audit,
            // so the count comes off the document itself, not off a guess.
            pages: declared.getPageCount(),
            message: `Converted to PDF/A-${part} with Ghostscript: ${fonts.embedded} of ${fonts.total} font(s) embedded, ${log.length} conformance warning(s) reported. ${sizeSentence(change)}.`,
            warnings,
          };
        }
      } catch (error) {
        warnings.push(`Ghostscript could not be reached (${engineReason(error)}); the file below was produced by the local path.`);
      }

      const written = bestEffortPdfA(input.doc, part);
      const bytes = await savePDF(input.doc, { useObjectStreams: true });
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      if (check.problem) {
        throw new ToolInputError('CORRUPT', `The PDF/A candidate did not reopen cleanly: ${check.problem}.`, {
          fileName: input.name,
          hint: 'Run again while online: a conforming conversion is the one thing Ghostscript can do that this build cannot.',
        });
      }
      const produced = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
      const xmp = xmpPacket(produced) ?? '';
      const identified = /pdfaid:part\s*=\s*"?\d/.test(xmp);
      const intent = produced.catalog.get(PDFName.of('OutputIntents')) !== undefined;
      if (!identified) warnings.push('The XMP identification did not survive the save, so this file is not PDF/A-identified.');
      if (!intent) warnings.push('The output intent did not survive the save.');
      const fonts = auditFonts(produced);
      if (fonts.total > fonts.embedded) {
        warnings.push(
          `${fonts.total - fonts.embedded} of ${fonts.total} font(s) are not embedded. Subsetting and embedding fonts needs Ghostscript, so a validator will reject this file as it stands.`,
        );
      }
      warnings.push(
        'No conformance check was run: the local path writes the identification and the output intent, it does not prove the file passes ISO 19005.',
      );
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      context.progress(1, 'Wrote the PDF/A identification');
      return {
        kind: 'pdf',
        bytes,
        pages: input.doc.getPageCount(),
        message: `Wrote PDF/A-${written.number}${written.conformance} identification (pdfaid:part=${written.number}, conformance=${written.conformance}), an sRGB output intent and the tagging flag. ${sizeSentence(change)}.`,
        warnings,
      };
    },
  },

  {
    id: 'font-to-outline',
    name: 'Font to Outline',
    description: 'Convert all text to vector paths so rendering cannot change',
    icon: '✒️',
    category: 'optimize',
    keywords: ['curves', 'no font dependency', 'rasterize type', 'outline'],
    outputSuffix: '_outlined.pdf',
    engines: ['ghostscript'],
    actionLabel: 'Outline',
    promise: 'Text that cannot reflow or substitute, and a refusal that says whether Ghostscript could not be fetched or refused the file.',
    notes: [
      'Glyphs become vector paths: the text can no longer be selected, searched or edited.',
      'This tool has no degraded path — a rebuild without Ghostscript would leave the fonts in place and only look outlined.',
      'A page that draws no text has nothing to outline: it comes back as Ghostscript rewrote it, and the result says so rather than claiming converted glyphs.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { textToOutlines } = await import('../core/engine-ops');
      // What the pages drew before the run, so "outlined" is a comparison and
      // not an assumption: a file that comes back still drawing its text must
      // not be described as converted.
      const textPages = input.doc.getPages().filter(pageShowsText).length;
      let bytes: Uint8Array;
      let outlineLog: string[] = [];
      try {
        const outcome = await textToOutlines(input.bytes, { onStatus: context.log });
        bytes = outcome.bytes;
        outlineLog = outcome.log;
      } catch (error) {
        // Two different failures, and saying "could not be reached" for the
        // second one sends the user to check a connection that is fine: an
        // `EngineUnavailable` is the download, anything else is Ghostscript
        // itself running and refusing this file.
        const fetched = error instanceof EngineUnavailable;
        throw new ToolInputError(
          'NEEDS_ENGINE',
          fetched
            ? `Ghostscript could not be reached, so nothing was outlined: ${engineReason(error)}`
            : `Ghostscript ran and refused this file, so nothing was outlined: ${engineReason(error)}`,
          {
            fileName: input.name,
            hint: fetched
              ? 'Run again once you are online, or use Rasterize PDF if selectable text does not matter.'
              : 'The file is unchanged. Rasterize PDF draws each page as one image and needs no font at all.',
          },
        );
      }
      const warnings: string[] = [];
      for (const line of outlineLog) warnings.push(`Ghostscript: ${line}`);
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      if (check.problem) {
        throw new ToolInputError('CORRUPT', `The outlined file did not reopen cleanly: ${check.problem}.`, {
          fileName: input.name,
          hint: 'Try Rasterize PDF instead, which draws each page as one image.',
        });
      }
      const produced = await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false });
      const fonts = auditFonts(produced);
      const stillText = produced.getPages().filter(pageShowsText).length;
      if (fonts.total > 0) {
        warnings.push(`${fonts.total} font resource(s) are still referenced, so Ghostscript did not outline every glyph.`);
      }
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      if (change.grew) {
        warnings.push(`${sizeSentence(change)}: outlines are geometry, so the file grows — that is the cost of rendering that cannot change.`);
      }
      const outcome = sizeSentence(change);
      // Three honest answers, chosen by what the bytes now contain.
      let headline: string;
      if (textPages === 0) {
        headline = `Ghostscript rewrote ${input.name}, and no page draws text — there was nothing to outline. ${outcome}.`;
      } else if (stillText === 0 && fonts.total === 0) {
        headline = `Ghostscript drew the type on all ${textPages} page(s) as vector paths: no page shows text through a font and no font resource is left. ${outcome}.`;
      } else {
        headline = `Ghostscript rewrote the file, but ${stillText} of ${textPages} page(s) still draw text and ${fonts.total} font resource(s) remain: that type is not outlined. ${outcome}.`;
      }
      context.progress(1, 'Converted glyphs to paths');
      return {
        kind: 'pdf',
        bytes,
        pages: produced.getPageCount(),
        message: headline,
        warnings,
      };
    },
  },

  {
    id: 'deskew-pdf',
    name: 'Deskew PDF',
    description: 'Straighten scanned pages that were fed in at an angle',
    icon: '📐',
    category: 'optimize',
    keywords: ['straighten', 'scan', 'tilt', 'rotate automatically'],
    outputSuffix: '_deskewed.pdf',
    actionLabel: 'Deskew',
    promise: 'Pages turned straight, with the angle it found for each one and the page size it had to grow.',
    fields: [
      { key: 'maxAngle', label: 'Largest angle to correct', type: 'slider', default: 10, min: 1, max: 30, step: 1, integer: true, unit: '°', group: 'How much to turn', help: 'A page tilted further than this is left alone rather than turned by the wrong amount.' },
      { key: 'threshold', label: 'Confidence needed before turning a page', type: 'slider', default: 0.35, min: 0.05, max: 0.9, step: 0.05, group: 'How much to turn', help: 'A low confidence turns pages that were never tilted.' },
      pagesField({ group: 'Which pages' }),
    ],
    notes: [
      'The tilt is measured by rendering each page with pdf.js, in this tab; the report names the tilt it found and turns the page back by exactly that much.',
      'Correction is written into the page content, not into /Rotate, because /Rotate can only hold multiples of 90°.',
      'Annotations and form fields keep their old coordinates, so a marked-up page is better deskewed before it is annotated.',
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const values = context.values;
      const warnings: string[] = [];
      const { deskewAngleFor, detectSkew } = await import('../core/measure');
      const maxAngle = readBound(values, { key: 'maxAngle', label: 'Largest angle to correct', min: 1, max: 30, integer: true, unit: '°', fallback: 10 }, warnings);
      const confidence = readBound(values, { key: 'threshold', label: 'Confidence needed before turning a page', min: 0.05, max: 0.9, fallback: 0.35 }, warnings);
      const declared = stringValue(values, 'pages', 'all');
      // E6/E15: a page number outside the document is refused with the reason,
      // not quietly dropped, and a repeat is straightened once and said aloud.
      const wanted = expandPageRanges(parsePageRanges(declared, { total: input.pageCount }), input.pageCount);
      const targets = [...new Set(wanted)];
      if (targets.length < wanted.length) {
        warnings.push(`${wanted.length - targets.length} page(s) were listed more than once and are straightened once.`);
      }

      const session = await openRender(input.bytes, { password: context.password });
      const corrected: { page: number; tilt: number; turn: number }[] = [];
      const skipped: string[] = [];
      let movedAnnotations = 0;
      try {
        for (let i = 0; i < targets.length; i++) {
          if (context.signal.aborted) throw new DOMException('Cancelled.', 'AbortError');
          const pageNumber = targets[i];
          const index = pageNumber - 1;
          let estimate: { angle: number; confidence: number };
          try {
            estimate = await detectSkew(session, pageNumber, { maxAngle });
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            skipped.push(`page ${pageNumber} could not be measured (${reason})`);
            continue;
          }
          const angle = estimate.angle;
          if (Math.abs(angle) <= 0.15 || estimate.confidence < confidence) {
            if (Math.abs(angle) > 0.15) {
              skipped.push(`page ${pageNumber} (${angle.toFixed(2)}° below the ${confidence} confidence you asked for)`);
            }
          } else if (Math.abs(angle) > maxAngle) {
            skipped.push(`page ${pageNumber} (${angle.toFixed(2)}° is past the ${maxAngle}° limit)`);
          } else {
            // The estimate is a **bitmap** angle (y runs down, so positive text
            // runs downhill to the right); `applySkew` turns the page clockwise
            // by whatever it is handed. Same magnitude, opposite sign, and
            // `deskewAngleFor` is the tested bridge between them. Handing it the
            // raw estimate — what this call site used to do — turned the page the
            // way it was already leaning: measured on the deployed build, a page
            // at -6° came back at -12° and the line still said "Straightened".
            const result = applySkew(input.doc.getPage(index), deskewAngleFor(estimate, maxAngle));
            if (result.applied) {
              corrected.push({ page: pageNumber, tilt: estimate.angle, turn: result.angle });
              movedAnnotations += result.annotations;
            }
          }
          context.progress((i + 1) / targets.length, `Measured page ${pageNumber}`);
        }
      } finally {
        await session.destroy();
      }

      if (skipped.length > 0) {
        warnings.push(`Not straightened: ${skipped.join('; ')}.`);
      }
      if (movedAnnotations > 0) {
        warnings.push(`${movedAnnotations} annotation(s) kept their old coordinates while the page turned, so they may sit slightly off.`);
      }

      const bytes = await savePDF(input.doc, { useObjectStreams: true });
      const check = await verifyOutput(bytes, input.name, input.pageCount);
      if (check.problem) {
        throw new ToolInputError('CORRUPT', `The deskewed file did not reopen cleanly: ${check.problem}.`, {
          fileName: input.name,
          hint: 'Limit the correction to a smaller angle and run again.',
        });
      }
      const rotations = input.doc
        .getPages()
        .map((page) => page.getRotation().angle)
        .filter((angle) => angle % 90 !== 0);
      if (rotations.length > 0) {
        warnings.push(`${rotations.length} page(s) already carried a /Rotate that is not a multiple of 90°; that value was left alone.`);
      }
      const change = sizeChange(input.bytes.byteLength, bytes.byteLength);
      context.progress(1, 'Done');
      return {
        kind: 'pdf',
        bytes,
        pages: input.doc.getPageCount(),
        message: corrected.length
          ? `Straightened ${corrected.length} page(s): ${corrected
              .map((c) =>
                `${c.page} (tilt ${c.tilt >= 0 ? '+' : '-'}${Math.abs(c.tilt).toFixed(2)}°, turned `
                + `${Math.abs(c.turn).toFixed(2)}° ${c.turn > 0 ? 'clockwise' : 'counterclockwise'})`,
              )
              .join(', ')}. ${sizeSentence(change)}.`
          : `Nothing to do: no page was tilted past ${maxAngle}° at a confidence of ${confidence}. ${sizeSentence(change)}.`,
        warnings,
      };
    },
  },
];

/**
 * Embed one rendered page in the format the user chose.
 *
 * The image goes in as encoded bytes, not a data URL, so a 600 dpi A4 page does
 * not become a 40 MB string in memory (E12).
 */
async function embedRenderedPage(
  doc: PDFDocument,
  render: PageRender,
  format: 'jpeg' | 'png',
  quality: number,
): Promise<{ image: PDFImage; encodedAs: 'jpeg' | 'png' }> {
  const blob = await canvasToBlob(render.canvas, format, quality, {
    background: format === 'jpeg' ? '#ffffff' : undefined,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // The bytes, not the request, choose the embedder. A canvas that cannot
  // encode the asked-for type answers PNG and says nothing about it — that is
  // the HTML spec's fallback — and `embedJpg` on those bytes dies inside
  // pdf-lib with "SOI not found in JPEG". `core/measure` learned this once
  // already; this is the second copy of the helper, given the same lesson.
  const encodedAs = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'jpeg' : 'png';
  const image = encodedAs === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  return { image, encodedAs };
}
