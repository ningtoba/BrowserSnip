/**
 * Convert to PDF.
 *
 * Every text-ish format goes through the same two steps: parse into the
 * `Block` model in `core/layout`, then render with real, selectable PDF text.
 * That replaces the old `html-to-pdf`, which screenshotted markup into a
 * fixed-width A4 image (no selectable text, no pagination control) and injected
 * author HTML into the live document.
 *
 * Fidelity rules for this file, because "it produced a PDF" was the complaint:
 *
 * - `promise` says what the run gives you, `notes` says what it cannot keep.
 *   A browser converter loses things a server-grade engine keeps; the user
 *   learns that before the run, not after the download.
 * - Anything actually lost on *this* run (skipped images, a page with no text,
 *   a truncated JSON branch) goes in `result.warnings` so the result card shows
 *   it, rather than in a log pane nobody opens.
 * - Inputs are refused by name and by format before any parsing: a 0-byte file
 *   and a PDF dropped on a DOCX tool are different sentences (E1, E2).
 * - All drawn text is laid out by `core/layout`, which routes through
 *   `core/fonts`, so CJK, Cyrillic and accented Latin survive (E11) instead of
 *   raising the old `WinAnsi cannot encode` error.
 */
import { drawPageInto, newPDF, openPDF, savePDF } from '../core/doc';
import { decodeImage, decodeImagePages, sniffImageMime, webpFrameCount, type DecodedImage } from '../core/images';
import { pdfFromImages } from '../core/pack';
import { ocrSilentPageOf, type OcrPageResult, type OcrSilentPage } from '../core/ocr';
import { pageSize } from '../core/pages';
import {
  ToolInputError,
  clampNumber,
  marginField,
  orientationField,
  pageSizeField,
  describeSize,
  emptyFileError,
  looksLikePdf,
  pdfResult,
  throwIfAborted,
} from './helpers';
import {
  booleanValue,
  numberValue,
  fileValues,
  stringValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolResult,
  type ToolRunContext,
  type ToolValues,
} from './types';

type Block = import('../core/layout').Block;
type Inline = import('../core/layout').Inline;
type LayoutOptions = import('../core/layout').LayoutOptions;

const PAGE_FIELD = pageSizeField();

/** The named sheets, so a tool that adds its own first choice does not re-spell them. */
const SHEET_OPTIONS = PAGE_FIELD.options ?? [];

/**
 * CBZ's `Page size`, which includes the hug this tool has always produced.
 *
 * The field used to offer six sheets while `run` hardcoded `pageSize: 'original'`,
 * so A4, Letter and A5 wrote byte-identical page boxes
 * (`docs/TOOL-TRIAGE.md` CONTROL INERT 1). Hugging each panel is what a comic
 * archive wants and what the promise says, so it is now a named choice — the
 * first one, and the default — rather than an invisible answer behind the select.
 */
const CBZ_PAGE_FIELD = pageSizeField({
  default: 'fit',
  help: 'Match each image leaves every page the size of its own artwork. A named sheet puts every page on that paper and scales the artwork into it.',
  options: [{ value: 'fit', label: 'Match each image' }, ...SHEET_OPTIONS],
});

/** What a CBZ page is, by the extension the entry names. Same list the hint quotes. */
const CBZ_PAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'];

/** The word the result card uses for a chosen sheet, taken from the field itself. */
function sheetLabel(value: string): string {
  return SHEET_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

const MARGIN_FIELD = marginField();

const ORIENTATION_FIELD = orientationField();

/**
 * The raster routes' sheet, which is the picture unless a sheet is asked for.
 *
 * "JPG to PDF" (and its six siblings) takes one format and nothing else; the page
 * *is* the picture there, one PDF point per pixel at 72 dpi, so a named sheet is
 * the exception. The route used to open on A4 with no hug in the list at all:
 * measured on the dev build, a 420 x 300 JPEG landed 483 x 345 pt inside a
 * 595.28 x 841.89 sheet — 161 596 ink px of 501 832, the picture floating in white
 * on a page 2.4 times its height. Hugging is the first choice and the default.
 */
const IMAGE_PAGE_FIELD = pageSizeField({
  default: 'fit',
  options: [{ value: 'fit', label: 'Match each image' }, ...SHEET_OPTIONS],
  help: 'Each page is the size of its own picture, one point per pixel at 72 dpi, plus the margin. A named sheet puts every page on that paper and scales the picture into it.',
});

/**
 * Orientation, hidden where it cannot act.
 *
 * A page sized from its own pixels has no width and height to swap, and
 * `placeImage` never reads the orientation on that branch, so the control was
 * live-looking and inert there. Where a sheet *is* chosen it still swaps the
 * sheet (A4 + Landscape → 841.89 x 595.28).
 */
const IMAGE_ORIENTATION_FIELD: ToolField = {
  ...ORIENTATION_FIELD,
  when: (values: ToolValues) => values.pageSize !== 'fit',
  help: 'Swaps the sheet’s width and height. A page that matches its picture has nothing to swap, so this is hidden until you pick a sheet.',
};

/** Zero margin by default: the shared 56 pt would pad every page the picture sits on. */
const IMAGE_MARGIN_FIELD: ToolField = { ...MARGIN_FIELD, default: 0 };

/**
 * Layout settings for the shared renderer.
 *
 * Every number is clamped here as well as in the rail: a value arriving from a
 * restored session, a pasted URL query or a field another surface wrote can
 * otherwise reach `pageSize`/`drawText` as `NaN` or `-40` (E15).
 */
export function layoutOptionsFor(
  values: ToolValues,
  overrides: Partial<LayoutOptions> = {},
): LayoutOptions {
  const size = stringValue(values, 'pageSize', 'a4');
  const landscape = stringValue(values, 'orientation', 'portrait') === 'landscape';
  const [width, height] = pageSize(size, landscape);
  const columns = numberValue(values, 'columns', 1);
  return {
    pageSize: [width, height],
    margin: clampNumber(numberValue(values, 'margin', 56), 0, Math.min(width, height) / 3),
    baseFontSize: clampNumber(numberValue(values, 'fontSize', 11), 4, 96),
    lineHeight: clampNumber(numberValue(values, 'lineHeight', 1.45), 0.8, 4),
    fontFamily: stringValue(values, 'fontFamily', 'auto'),
    header: stringValue(values, 'header') || undefined,
    footer: stringValue(values, 'footer') || undefined,
    pageNumbers: booleanValue(values, 'pageNumbers'),
    columns: columns === 2 ? 2 : 1,
    ...overrides,
  };
}

function layoutOptions(context: ToolRunContext, overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  return layoutOptionsFor(context.values, overrides);
}

/* ----------------------------------------------------------------─ honesty */

/** Which sniffed MIME types each format-specific tool will accept. */
const FORMAT_MIMES: Record<string, string[]> = {
  jpg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  heic: ['image/heic', 'image/heif'],
  bmp: ['image/bmp'],
  tiff: ['image/tiff'],
  psd: ['image/vnd.adobe.photoshop'],
};

/** What a rasterised page gives up; used by every image route (E10, E12). */
const RASTER_LOSS =
  'Each page is one flat image: there is no text layer to select or search, and colour profile, EXIF and GPS metadata are dropped.';

/**
 * Where the page box comes from, measured rather than assumed.
 *
 * `placeImage` sizes a hugged page from the pixel count, one point per pixel,
 * and never reads a density: a 300 x 150 PNG carrying `pHYs` at 300 dpi came out
 * of the dev build as a 300 x 150 pt sheet (4.17 x 2.08 in), not the 1 x 0.5 in
 * its own resolution claims. That is the scanner convention and is kept — but a
 * 300 dpi scan prints four times the size its density asks for, so say so.
 */
const RASTER_DENSITY =
  'The page is sized from the pixel count at 72 dpi — one point per pixel — never from a density the file records (EXIF resolution, or a PNG `pHYs` chunk): a 300 dpi scan prints about four times the size it asks for.';

/**
 * Transparency in a PNG: kept in the file, flattened by the page.
 *
 * On the dev build the alpha survived as an image soft mask (`/SMask` present,
 * mask 0 outside the disc, 255 inside) and `pdfFromImages` painted a white
 * rectangle under the image, so the see-through part *shows* the page's own white
 * paper (measured there: 255, 255, 255; the disc 220, 30, 40 exact) rather than a
 * black or a checkerboard. The mask is the file's, the white is the page's, and
 * a user choosing a cut-out logo deserves both facts before the run.
 */
const PNG_ALPHA =
  'A transparent PNG keeps its transparency in the file as a soft mask, but the page paints its white paper under it, so see-through parts come out white on the page and when printed — not transparent.';

/**
 * WebP carries alpha the same way; the sentence travels under its own format's
 * name. Measured on the rail (:5296): the WEBP card opened "A transparent PNG
 * keeps its transparency…" — the PNG line borrowed wholesale, in front of a
 * user holding a `.webp` whose mask and paper behaved exactly as described.
 */
const WEBP_ALPHA =
  'A transparent WebP keeps its transparency in the file as a soft mask, but the page paints its white paper under it, so see-through parts come out white on the page and when printed — not transparent.';

/**
 * A BMP header carries its own byte count, and Chrome ignores it.
 *
 * Handed a short file the decoder paints the rows that are there and fills the
 * rest with white; nothing distinguishes that from a picture of a white band.
 * The reader compares the header against the file length and refuses by name.
 */
const BMP_TRUNCATED =
  'A BMP header states exactly how many pixel bytes the file must hold, and the file is checked against it: one cut short — an interrupted copy or save — is refused by name instead of converting with the missing rows painted white.';

/**
 * The one BMP coding this browser answers with nothing.
 *
 * Measured at :5296: both RLE4 encodings the SDK documents came back as a fully
 * transparent bitmap — a blank page under a card that said
 * `1 BMP image(s) → 1 page(s)` — while 8-bit run-length decoded pixel-exact
 * against the same source (`c2-rle8` maxdiff 0, `c2-rle4`/`c2-rle4sdk` blank).
 */
const BMP_RLE4 =
  'A 4-bit run-length BMP (RLE4) is refused by name: this browser decodes it to an empty picture — measured on Chrome for Testing 151 on Linux, which painted none of its pixels — and an empty picture would ship as a blank page carrying a success count. 8-bit run-length BMPs convert exactly.';

/**
 * The flattened picture a PSD carries, in the coding the file itself names.
 *
 * Measured at :5296 (convert-psd-svg-spec.json, runs8): JPEG-coded composites
 * (compression 5) and appended PNG previews convert pixel-exact — 16-bit and
 * CMYK documents among them, since those previews carry 8-bit RGB — while raw,
 * RLE and ZIP-coded composites (what Photoshop itself writes for layered
 * documents) are answered by the shared reader with "no flattened preview
 * embedded", a sentence the file contradicts: the preview IS embedded, only
 * unreadable here. Walking the three length-prefixed sections and reading the
 * first compression code costs what the lie is worth; anything that cannot be
 * parsed cleanly defers to the reader, so the refusal only ever rests on the
 * file's own header words.
 */
function psdCompositeProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length < 30) return null;
  if (!(bytes[0] === 0x38 && bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x53)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, false) !== 1) return null; // PSD v1 only; v2 defers
  const channels = view.getUint16(12, false);
  const depth = view.getUint16(22, false);
  const mode = view.getUint16(24, false);
  let at = 26;
  for (let section = 0; section < 3; section += 1) {
    // colour-mode data, image resources, layer & mask info — skip by length.
    if (at + 4 > bytes.length) return null;
    at += 4 + view.getUint32(at, false);
  }
  if (at + 4 > bytes.length || channels < 1 || channels > 56) return null;
  const coding = view.getUint16(at + 2, false);
  const codingName: Record<number, string> = {
    0: 'uncompressed', 1: 'run-length encoded', 2: 'ZIP', 3: 'ZIP with prediction',
  };
  const words = codingName[coding];
  if (!words) return null; // 5/7 store JPEG — that one opens; unknown codes try anyway
  const kind = mode === 4 ? ' CMYK' : mode === 9 ? ' Lab' : mode === 1 ? ' greyscale' : '';
  const bitness = depth > 8 ? ` ${depth}-bit` : '';
  return `"${name}" keeps its flattened picture as ${words}${kind}${bitness} channel data, which this page’s PSD reader cannot open — it converts only previews stored as JPEG or PNG.`;
}

const PSD_PREVIEW_HINT = 'Export a flattened PNG or JPEG, or re-save the PSD with a JPEG-compatibility preview, then try again; this page never re-composes PSD layers.';

/**
 * What the PSD route actually converts — measured, not assumed.
 *
 * The family's generic line ("pixels are embedded as they decode") was true of
 * the previews this page can open and silent about the ones it cannot: the
 * layered Photoshop file format keeps its composite raw/RLE/ZIP-coded, and
 * before the gate above those files were refused with a sentence ("no flattened
 * preview embedded") that the file itself disproves.
 */
const PSD_COMPOSITE =
  'A PSD converts through the flattened preview the file itself carries — layers, masks and blend modes are never re-composed here, so what you see is what the last save baked in. A preview stored uncompressed, run-length or ZIP-coded (the shape Photoshop writes for a layered document) is refused by name with its coding named; JPEG-coded previews convert — 16-bit and CMYK documents among them, because their previews carry 8-bit RGB — and so does an appended PNG.';

/**
 * The two TIFF codings the bundled reader gets wrong, and the honest split.
 *
 * Measured at :5296 against Pillow/libjpeg decodes of the same files:
 * JPEG-compressed TIFF came back with every pixel wrong (`c2-jpegtif`, maxdiff
 * 255 on all 153), planar-2 TIFF with the colour planes misplaced
 * (`c2-planar2`, same) — both as *successful* pages. None, LZW, Deflate,
 * palette, Group 4 and 16-bit (exact high byte) all matched pixel for pixel
 * (`c2-lzw`, `c2-deflate`, `c2-pal8`, `c2-g4`, `c2-tif16`), so those convert
 * and the two liars are refused before the decoder is asked.
 */
const TIFF_VARIANTS =
  'A TIFF stores its pixels in one of many codings. Plain, LZW, Deflate, palette, 1-bit Group 4 and 16-bit all convert — a 16-bit TIFF keeps its 8-bit high byte, pixel-exact. A TIFF that carries its picture as JPEG, or in separate colour planes (planar configuration 2), is named and refused: this app’s TIFF reader colours those two wrongly (measured against the same files opened by other decoders), and a wrong page is worse than a missing one.';

/**
 * A WebP states its own length too, and its decoder is even quieter than BMP's.
 *
 * A WebP cut at 40 % of its bytes decoded into a *complete* 400 x 240 bitmap of
 * white and shipped as a page: the card said `2 WEBP image(s) -> 2 page(s)` with
 * nothing else (measured, and Pillow refuses the same file). The RIFF length and
 * each chunk's own size are read and a short file is refused by name.
 */
const WEBP_TRUNCATED =
  'A WebP header states the file’s own length and every chunk repeats its size, and the file is checked against both: one cut short — an interrupted download or save — is refused by name instead of becoming a blank page.';

/** PDF has no animation, and a WebP may be one. */
const WEBP_FIRST_FRAME =
  'An animated WebP gives one page — its first frame — and the rest of the frames and their timing are dropped: a PDF page cannot play. The result card names every file that was animated.';

/** Shared admissions for the text routes — true of the bundled layout engine. */
const TEXT_NOTES = [
  'Text is drawn as real, selectable PDF text through embedded fonts, so it stays searchable and copyable.',
  'Author styling is structural, not pixel-exact: no CSS box model, no widow/orphan control, no kerning or hyphenation, and the standard 14 faces plus Noto Sans are used instead of the document’s own fonts.',
  'Chinese, Japanese, Korean, Arabic, Hebrew, Thai and Indic faces are fetched from the CDN the first time they are needed. Offline, the run is refused with the script named rather than printed as empty boxes.',
  'A single word longer than the column has no space to break at: it starts at the left margin and whatever does not fit falls past the right edge of the sheet. Break up minified code, base64 blobs and unspaced URLs into lines yourself.',
  'A block taller than one sheet — a paragraph, a heading, a list item, a single table row — is continued on the next sheet, never left below the bottom edge. A table repeats its header on every sheet its rows spill onto.',
];

/* ------------------------------------------------------------ input guard */

/**
 * What a byte string actually is, whatever its file name claims.
 *
 * The converters used to trust extensions, so a PDF renamed `.docx` reached the
 * mammoth reader and failed as "cannot read properties of undefined". Magic
 * bytes decide, and the refusal quotes them (E2).
 */
export type SourceKind =
  | 'pdf'
  | 'zip'
  | 'ole'
  | 'palm'
  | 'psd'
  | 'image'
  | 'svg'
  | 'text'
  | 'binary'
  | 'empty';

export interface SniffedSource {
  kind: SourceKind;
  /** Reads as `a PNG image` / `a PDF` — the format is always named (E2). */
  label: string;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const IMAGE_LABELS: Record<string, string> = {
  'image/png': 'a PNG image',
  'image/jpeg': 'a JPEG image',
  'image/gif': 'a GIF image',
  'image/webp': 'a WebP image',
  'image/avif': 'an AVIF image',
  'image/bmp': 'a BMP image',
  'image/tiff': 'a TIFF image',
  'image/heic': 'a HEIC/HEIF image',
  'image/heif': 'a HEIF image',
  'image/vnd.adobe.photoshop': 'a Photoshop (PSD) file',
  'image/svg+xml': 'an SVG drawing',
};

function startsWith(bytes: Uint8Array, magic: number[], offset = 0): boolean {
  for (let i = 0; i < magic.length; i++) {
    if (bytes[offset + i] !== magic[i]) return false;
  }
  return true;
}

/** Fraction of NUL bytes that means "this is not a text file". */
function looksBinary(bytes: Uint8Array): boolean {
  const window = Math.min(bytes.length, 4096);
  let nul = 0;
  for (let i = 0; i < window; i++) if (bytes[i] === 0x00) nul++;
  return window > 0 && nul / window > 0.01;
}

export function sniffSource(bytes: Uint8Array, name = ''): SniffedSource {
  if (bytes.length === 0) return { kind: 'empty', label: 'an empty file' };
  if (looksLikePdf(bytes)) return { kind: 'pdf', label: 'a PDF' };
  const image = sniffImageMime(bytes);
  if (image === 'image/svg+xml') return { kind: 'svg', label: 'an SVG drawing' };
  if (image === 'image/vnd.adobe.photoshop') return { kind: 'psd', label: IMAGE_LABELS[image] };
  if (image) return { kind: 'image', label: IMAGE_LABELS[image] ?? `an ${image} image` };
  if (startsWith(bytes, [0x50, 0x4b])) {
    return { kind: 'zip', label: 'a ZIP package (the container used by DOCX, XLSX, PPTX, ODT, EPUB and CBZ)' };
  }
  if (startsWith(bytes, OLE_MAGIC)) {
    return { kind: 'ole', label: 'a legacy compound Office file (DOC, XLS, PPT or MSG)' };
  }
  // PalmDB books carry their type at offset 60 and the name says it too.
  if (/\.(mobi|azw3?|prc)$/i.test(name) || (bytes.length > 68 && String.fromCharCode(bytes[60], bytes[61], bytes[62], bytes[63]) === 'BOOK')) {
    return { kind: 'palm', label: 'a PalmDB ebook (MOBI or AZW)' };
  }
  if (startsWith(bytes, [0xef, 0xbb, 0xbf]) || startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) {
    return { kind: 'text', label: 'a text file' };
  }
  if (looksBinary(bytes)) return { kind: 'binary', label: 'binary data this converter cannot read' };
  return { kind: 'text', label: 'a text file' };
}

/** The tool the user should have reached for, named in the refusal. */
function alternativeFor(sniffed: SniffedSource): string {
  switch (sniffed.kind) {
    case 'pdf':
      return 'It is already a PDF — use a Convert from PDF tool to change its format, or a page tool to edit it.';
    case 'zip':
      return 'If it is an Office or ebook document, use Word to PDF, Excel to PDF, PowerPoint to PDF or EPUB to PDF instead.';
    case 'ole':
      return 'Legacy binary Office needs the LibreOffice converter, which is not bundled: re-save it as DOCX, XLSX or PPTX first.';
    case 'palm':
      return 'Re-save the book as EPUB (Calibre does it in one click), which is converted in this tab.';
    case 'image':
    case 'psd':
      return 'Use Images to PDF, or Digitize Document if the page has text to recognise.';
    case 'svg':
      return 'Use SVG to PDF for a drawing, or Images to PDF to place it on a page.';
    case 'binary':
      return 'The bytes do not match any format this tool reads. A text file saved as UTF-16 without its byte-order mark looks exactly like this from the outside: re-save it as UTF-8, or save it with the mark.';
    default:
      return 'Remove it from the list, or choose the tool that matches its real format.';
  }
}

/**
 * Refuse an input whose content is not what the tool advertises (E1, E2).
 *
 * `expected.kinds` is about *content*, not the file name: a JPEG renamed
 * `.docx` is refused as an image, and a text file with no extension still
 * passes a text tool. Returns the sniff so callers can log or warn with it.
 */
export function assertSourceFormat(
  name: string,
  bytes: Uint8Array,
  expected: { kinds: SourceKind[]; label: string; hint?: string },
): SniffedSource {
  const sniffed = sniffSource(bytes, name);
  if (sniffed.kind === 'empty') throw emptyFileError(name);
  if (expected.kinds.includes(sniffed.kind)) return sniffed;
  const hint = expected.hint ?? alternativeFor(sniffed);
  throw new ToolInputError(
    'UNSUPPORTED',
    `"${name}" is ${sniffed.label}, not ${expected.label}.`,
    { fileName: name, hint },
  );
}

/**
 * Files chosen in a `file` field, else the drop-zone inputs, in order.
 *
 * `refused`, when given, collects the sentences for files this route does not
 * take instead of throwing on the first one. A batch is a batch: one PNG among
 * ten JPEGs used to kill the whole run and hand back nothing, naming only the
 * PNG, while the card promised per-file refusal. Without the collector the
 * one-document converters keep the old throw-first behaviour.
 */
async function sourceBatches(
  context: ToolRunContext,
  expected: { kinds: SourceKind[]; label: string; hint?: string },
  refused?: string[],
): Promise<{ name: string; bytes: Uint8Array }[]> {
  const chosen = fileValues(context.values, 'files');
  const raw = chosen.length > 0
    ? chosen.map((file) => ({ name: file.name, bytes: file.bytes }))
    : [];
  if (raw.length === 0) {
    for (const file of context.inputs) {
      throwIfAborted(context.signal);
      raw.push({ name: file.name, bytes: await file.bytes() });
    }
  }
  if (raw.length === 0) {
    throw new ToolInputError('EMPTY_FILE', `Add ${expected.label} first.`, {
      hint: `Nothing was uploaded, so there is nothing to convert.`,
    });
  }
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const [index, item] of raw.entries()) {
    throwIfAborted(context.signal);
    try {
      assertSourceFormat(item.name, item.bytes, expected);
    } catch (error) {
      // One file keeps the old refusal word for word: there is no batch to
      // protect, and the single-file sentences are pinned by other tests.
      if (!refused || raw.length < 2 || !(error instanceof ToolInputError)) throw error;
      refused.push(`${error.message.replace(/\.$/, '')} — left out.`);
      context.log(`${item.name} was left out: ${error.message}`);
      context.progress(((index + 1) / raw.length) * 0.2, `Left out ${item.name}`);
      continue;
    }
    context.progress(((index + 1) / raw.length) * 0.2, `Read ${item.name} (${describeSize(item.bytes)})`);
    out.push(item);
  }
  if (out.length === 0 && refused?.length && raw.length > 0) {
    throw new ToolInputError('UNSUPPORTED', `Nothing could be read from ${raw.length} file(s): ${refused.join(' ')}`, {
      hint: expected.hint,
    });
  }
  return out;
}

/** The single document a one-file converter was given, validated (E1, E2). */
export async function readPrimarySource(
  context: ToolRunContext,
  expected: { kinds: SourceKind[]; label: string; hint?: string },
): Promise<{ name: string; bytes: Uint8Array; extra: number }> {
  const all = await sourceBatches(context, expected);
  const [first] = all;
  if (all.length > 1) {
    context.log(`Only "${first.name}" was converted; this tool handles one document at a time.`);
  }
  return { name: first.name, bytes: first.bytes, extra: all.length - 1 };
}

/* ----------------------------------------------------------------- sources */

/**
 * Every line terminator a text editor can hold, folded to `\n`.
 *
 * `core/layout.ts` folds CRLF and nothing else, so a file written with old-Mac
 * CRs — or with the Unicode separators — reached the writer holding a character
 * the standard-14 faces have no code for. Measured on the pre-fix build, a file
 * whose only crime was `\r` ended the run with `WinAnsi cannot encode "\r"
 * (0x000d)`: no file, no file name, and a stack word in its place.
 */
const LINE_ENDINGS = /\r\n|[\r\u000B\u001C-\u001E\u0085\u2028\u2029]/g; // eslint-disable-line no-control-regex

/**
 * Control characters with no glyph in any face the app can write with, and no
 * line or tab meaning: left out, and counted in a warning. A form feed is not
 * here — it is a page break, and the plain-text route hands it to the layout
 * engine's page-break block.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000E-\u001B\u001F\u007F\u0080-\u0084\u0086-\u009F]/g; // eslint-disable-line no-control-regex

/**
 * Fold line endings, drop the byte-order mark and the characters that have no
 * glyph, and report how many of the latter went missing.
 */
export function normalizeText(text: string): { text: string; dropped: number } {
  const ended = text.replace(LINE_ENDINGS, '\n').replace(/^\uFEFF/, '');
  let dropped = 0;
  const clean = ended.replace(UNPRINTABLE, () => {
    dropped += 1;
    return '';
  });
  return { text: clean, dropped };
}

/** `3 control characters`, `1 control character`. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Decode bytes as text, and say which encoding the words came out of.
 *
 * A byte-order mark decides for UTF-8 and UTF-16. Without one, a file that is not
 * valid UTF-8 is read as Windows-1252 — the encoding Notepad and Excel called
 * ANSI in every Western locale — rather than kept as the UTF-8 attempt's
 * replacement characters: measured on the pre-fix build, a CP1252 file whose
 * source said `Café résumé naïve “x” — MKEND` reached the sheets as
 * `Caf r sum na ve  MKSTART  MKEND`, under "Typeset 1 text source(s) into
 * 1 page(s)." with no warning at all.
 */
export function decodeText(bytes: Uint8Array, name = 'the source'): { text: string; warnings: string[] } {
  const utf16 = startsWith(bytes, [0xff, 0xfe])
    ? 'UTF-16LE'
    : startsWith(bytes, [0xfe, 0xff])
      ? 'UTF-16BE'
      : null;
  const warnings: string[] = [];
  let raw: string;
  if (utf16) {
    raw = new TextDecoder(utf16).decode(bytes.subarray(2));
    warnings.push(`"${name}" was decoded from ${utf16}.`);
  } else {
    try {
      raw = new TextDecoder('UTF-8', { fatal: true }).decode(bytes);
    } catch {
      const lenient = new TextDecoder('UTF-8').decode(bytes);
      const rejected = lenient.split('\uFFFD').length - 1;
      raw = new TextDecoder('windows-1252').decode(bytes);
      warnings.push(
        `"${name}" was read as Windows-1252, the legacy ANSI encoding, because ${counted(rejected, 'byte')} ` +
          'of it are not valid UTF-8. Re-save the file as UTF-8 if that is not what it holds.',
      );
    }
  }
  const text = normalizeText(raw);
  if (text.dropped > 0) {
    warnings.push(
      `"${name}" held ${counted(text.dropped, 'control character')} that no face can draw; they were left out.`,
    );
  }
  return { text: text.text, warnings };
}

/**
 * The text-ish tools share one panel: paste or upload, then lay out.
 *
 * Content that turns out to be another format is refused with that format named
 * (E2), and a source with nothing left to typeset is refused rather than typeset
 * as a blank sheet (E13).
 */
async function readSources(
  context: ToolRunContext,
  expected: { kinds: SourceKind[]; label: string; hint?: string },
): Promise<{ sources: { name: string; text: string }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const pasted = stringValue(context.values, 'paste');
  const wantPaste =
    stringValue(context.values, 'source', 'file') === 'paste'
    || (pasted.trim() !== '' && context.inputs.length === 0);
  if (wantPaste) {
    if (pasted.trim() === '') {
      throw new ToolInputError('EMPTY_FILE', 'Paste some content, or choose a file to convert.', {
        hint: 'The content box is empty and no file was added.',
      });
    }
    const clean = normalizeText(pasted);
    if (clean.dropped > 0) {
      warnings.push(`The pasted text held ${counted(clean.dropped, 'control character')} that no face can draw; they were left out.`);
    }
    return { sources: [{ name: 'pasted text', text: clean.text }], warnings };
  }
  const batches = await sourceBatches(context, expected);
  const sources: { name: string; text: string }[] = [];
  for (const batch of batches) {
    const decoded = decodeText(batch.bytes, batch.name);
    warnings.push(...decoded.warnings);
    if (decoded.text.trim() === '') {
      throw new ToolInputError(
        'UNSUPPORTED',
        `"${batch.name}" contains no characters to typeset (${describeSize(batch.bytes)} of whitespace, padding or control characters).`,
        { fileName: batch.name, hint: 'Open it in its real editor and re-save, or check the encoding.' },
      );
    }
    sources.push({ name: batch.name, text: decoded.text });
  }
  return { sources, warnings };
}

/** Terminal tab stops — the `expand` default that ASCII tables and code indent by. */
const TAB_STOP = 8;

/** The csv route's own size floor; `layoutOptionsFor` always sets one, this keeps the type honest. */
const DEFAULTS_FONT = 9;

/**
 * Tabs to the next stop, counted in columns along each line.
 *
 * `core/layout.ts` replaces a tab with four spaces wherever it happens to sit,
 * which keeps a space-aligned table in columns and scatters a tab-aligned one:
 * measured with the real monospace face, three columns of the same table landed
 * at 95.0, 100.8 and 106.6 pt on the sheet. Stopping at a multiple of the tab
 * width is what an editor means by a tab, and it is the only expansion under
 * which both kinds of source stay lined up.
 */
function expandTabs(text: string): string {
  return text.split('\n').map((line) => {
    let column = 0;
    let out = '';
    for (const char of [...line]) {
      if (char !== '\t') {
        out += char;
        column += 1;
        continue;
      }
      const to = TAB_STOP - (column % TAB_STOP);
      out += ' '.repeat(to);
      column += to;
    }
    return out;
  }).join('\n');
}

/**
 * The two pieces of Markdown syntax `core/layout.ts` hands the tag stripper, which
 * eats them whole.
 *
 * `stripRawHtml` runs before `marked`, so a `<br>` is deleted and the two halves of
 * the line arrive as one word — measured on the pre-fix build: "the hard break<br>
 * line three" reached the sheet as `hard breakline three` — and an autolink
 * `<https://example.com/x>`, which IS its own address, was deleted with its angle
 * brackets, so the URL vanished while an ordinary `[text](url)` at least kept its
 * words. Both are fixed in the source rather than in the shared stripper, because
 * both have an exact CommonMark spelling.
 */
function normalizeMarkdown(text: string): string {
  // The same fence spelling `stripRawHtml` guards with: inside a fenced block the
  // card promises HTML is kept, so `<br>` must stay two letters and a tag.
  const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
  let inside: string | null = null;
  let comment = false;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (marker) {
      if (inside === null) inside = marker;
      else if (marker[0] === inside[0]) inside = null;
      comment = false;
      kept.push(line);
      continue;
    }
    if (inside) {
      kept.push(line);
      continue;
    }
    if (comment) {
      // A comment opened on an earlier line runs to its closer; CommonMark keeps the
      // whole thing as raw HTML, which for this renderer means nothing on the page.
      comment = !line.includes('-->');
      continue;
    }
    const clean = line.replace(/<!--[\s\S]*?-->/g, '');
    comment = /<!--/.test(clean);
    kept.push(
      clean
        .replace(/<br\s*\/?>/gi, '  \n')
        .replace(/<((?:https?|ftp|mailto):[^<>\s]*)>/g, '$1'),
    );
  }
  return kept.join('\n');
}

/** A character reference as CommonMark accepts one: named, decimal or hexadecimal. */
const ENTITY = /&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,8}|[a-zA-Z][a-zA-Z]{1,30});/g;

/**
 * Decode the character references that reach the finished prose.
 *
 * `marked` re-escapes a bare `&` it is handed, so the `&amp;` the shared tag
 * stripper decodes came back to the page as the six characters `&amp;` — measured:
 * `A&amp;B` printed `A&amp;B` — and a name the five-item list does not know
 * (`&copy;`, `&nbsp;`) printed as written. Decoding on the way out fixes both, and
 * only in prose: a fenced or inline code span keeps its characters literally,
 * which is what the card promises.
 */
function decodeBlockEntities(blocks: Block[]): Block[] {
  let holder: HTMLTextAreaElement | null = null;
  const decode = (text: string): string => {
    if (!text.includes('&')) return text;
    holder ??= document.createElement('textarea');
    return text.replace(ENTITY, (reference) => {
      holder!.innerHTML = reference;
      return holder!.value === reference ? reference : holder!.value;
    });
  };
  // A code span keeps its characters literally, like a fenced block does.
  const inline = (run: Inline): Inline => (run.code ? run : { ...run, text: decode(run.text) });
  return blocks.map((block) => {
    if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote') {
      return { ...block, inlines: block.inlines.map(inline) };
    }
    if (block.kind === 'list') {
      return { ...block, items: block.items.map((item) => ({ ...item, inlines: item.inlines.map(inline) })) };
    }
    if (block.kind === 'table') {
      return {
        ...block,
        header: block.header?.map((cell) => cell.map(inline)),
        rows: block.rows.map((row) => row.map((cell) => cell.map(inline))),
      };
    }
    return block;
  });
}

/** The gutter `renderList` reserves between a marker and its text, in points. */
const MARKER_GUTTER = 14;

/**
 * Give a task item its box and an explicit ordered list its number.
 *
 * `markdownToBlocks` reads GFM's `checked` onto the item and then prints the
 * `checkbox` token a second time as text, so a task arrived as `• [x] done` — the
 * bullet of an ordinary item with the brackets inside the sentence — and it drops
 * the list's `start`, so `5. five / 6. six` printed `1. five / 2. six`. The blocks
 * handed back carry both fixes: `renderList` prefers an explicit `marker`, and an
 * extra `level` buys a wider text indent (the renderer hard-codes one marker
 * gutter, so a three-character `[x]` or a two-digit `10.` would otherwise sit on
 * top of the words — measured on the live README, `10.tenth`).
 */
function markStructuredLists(blocks: Block[], source: string): Block[] {
  const ordered = blocks.filter((block) => block.kind === 'list' && block.ordered).length;
  const starts = /<ol\b/i.test(source) ? orderedListStartsHtml(source, ordered) : orderedListStarts(source);
  let renumber = starts.length === ordered && ordered > 0;
  let listIndex = 0;
  return blocks.map((block) => {
    if (block.kind !== 'list') return block;
    const start = renumber && block.ordered ? starts[listIndex] ?? 1 : 1;
    if (renumber && block.ordered) listIndex += 1;
    let counter = start;
    const marked = block.items.map((item) => {
      const marker = item.marker
        ?? (item.checked === null || item.checked === undefined
          ? undefined
          : item.checked ? '[x]' : '[ ]');
      const inlines = marker === undefined ? item.inlines : stripCheckboxText(item.inlines);
      // An ordered item's number is set here too, so the gutter below is decided
      // from the real marker: the renderer's own `10.` is wider than the 14 pt it
      // reserves, and `10.tenth` printed overlapped on the live README. An ordinary
      // bullet is pinned for the same reason — the renderer picks its glyph from the
      // level, and the gutter below moves the level.
      const own = block.ordered && marker === undefined
        ? `${counter++}.`
        : marker ?? (block.ordered ? undefined : ['•', '◦', '▪'][item.level % 3]);
      return { item, marker: own, inlines };
    });
    // One gutter per list, so the items of a list keep one left edge: the widest
    // marker of the block decides it (`[x]` is ~12 pt, `10.` ~15 pt, against the
    // renderer's single 14 pt gutter).
    const widest = Math.max(0, ...marked.map((one) => (one.marker?.length ?? 0) * 6));
    const bump = widest > MARKER_GUTTER ? 1 : 0;
    return {
      ...block,
      items: marked.map((one) => ({ ...one.item, ...(one.marker === undefined ? {} : { marker: one.marker }), inlines: one.inlines, level: one.item.level + bump })),
    };
  });
}

/**
 * The `start` of each `<ol>` in the source, padded with the lists that carry none,
 * so the array lines up with the ordered list blocks the DOM walk produced.
 */
function orderedListStartsHtml(source: string, ordered: number): number[] {
  const tags = [...source.matchAll(/<ol\b[^>]*>/gi)];
  if (tags.length !== ordered) return [];
  return tags.map((tag) => Number(/\bstart\s*=\s*["']?(\d+)/i.exec(tag[0])?.[1] ?? 1));
}

/**
 * The characters a legal CSV cell can hold that the table branch cannot draw.
 *
 * `renderTable` hands a cell's text to the writer untouched — unlike the paragraph
 * and code branches, which expand tabs — so a tab inside a quoted field, which
 * RFC 4180 allows and which `Tab` files carry between quoted fields, ended the whole
 * run with `WinAnsi cannot encode "\t" (0x0009)` and no file; a form feed did the
 * same at `(0x000c)`. The card says quoted fields are handled and that the delimiter
 * is the only thing rows split on, so both belong to the cell: the tab stops at the
 * next eighth column, the form feed breaks the line inside the cell.
 */
function cellsToDrawable(blocks: Block[]): Block[] {
  const clean = (run: Inline): Inline => ({
    ...run,
    text: expandTabs(run.text.replace(/\f/g, '\n')),
  });
  return blocks.map((block) => (block.kind !== 'table' ? block : {
    ...block,
    header: block.header?.map((cell) => cell.map(clean)),
    rows: block.rows.map((row) => row.map((cell) => cell.map(clean))),
  }));
}

/** The number each ordered list in the source began with, in document order. */
function orderedListStarts(source: string): number[] {
  const starts: number[] = [];
  let inList = false;
  for (const line of source.split('\n')) {
    const item = /^ {0,3}(\d+)[.)][ \t]/.exec(line);
    if (item) {
      if (!inList) starts.push(Number(item[1]));
      inList = true;
      continue;
    }
    if (line.trim() !== '' && !/^\s+/.test(line)) inList = false;
  }
  return starts;
}

/** Drop the `[x] ` a task item carries twice, once as state and once as text. */
function stripCheckboxText(inlines: Inline[]): Inline[] {
  const [first, ...rest] = inlines;
  if (!first) return inlines;
  const stripped = first.text.replace(/^\s*\[[ xX]]\s?/, '');
  return stripped === '' ? rest : [{ ...first, text: stripped }, ...rest];
}

/* ------------------------------------------------------------------ output */

/**
 * Blocks → finished PDF, with the honesty built in.
 *
 * Rendering needs a Unicode face for non-Latin scripts. When that face cannot
 * be loaded the run is refused with the script named instead of printing boxes,
 * because a page of boxes downloads fine and reads like a broken converter.
 */
export async function blocksResult(
  blocks: Block[],
  options: LayoutOptions,
  message: string,
  warnings: string[] = [],
): Promise<ToolResult> {
  const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
  const doc = await newDocumentForLayout();
  let pages: Awaited<ReturnType<typeof renderBlocks>>;
  try {
    pages = await renderBlocks(doc, blocks, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/font|HTTP/i.test(reason)) {
      throw new ToolInputError('NEEDS_ENGINE', `${reason} The document needs a Unicode font face that is not bundled.`, {
        hint: 'Re-run once while online — the face is cached afterwards. Latin-only sources need no download.',
        detail: error,
      });
    }
    throw error;
  }
  if (pages.length === 0) {
    throw new ToolInputError('NO_PAGES', 'The content produced no pages.', {
      hint: 'Nothing was left after parsing; check that the source has readable text.',
    });
  }
  const bytes = await savePDF(doc);
  // Every “… to PDF” converter finishes here with the laid-out document in
  // hand, which is the one cheap moment its page count can be reported.
  return { kind: 'pdf', bytes, pages: doc.getPageCount(), message: `${message} ${pages.length} page(s).`, warnings };
}

/** Text-ish inputs share one panel: paste or upload, then lay out. */
function sourceFields(accept: string, pastePlaceholder: string, label: string) {
  return [
    {
      key: 'source',
      label: 'Source',
      type: 'segmented' as const,
      default: 'file',
      group: label,
      options: [
        { value: 'file', label: 'Uploaded file' },
        { value: 'paste', label: 'Pasted text' },
      ],
      help: 'Pasted text is read from the box below instead of from disk; nothing is uploaded either way.',
    },
    { key: 'paste', label: 'Content', type: 'textarea' as const, placeholder: pastePlaceholder, group: label, help: 'Read from the box instead of from disk, which is the only way to convert a fragment you have not saved yet.', when: (v: Record<string, unknown>) => v.source === 'paste' },
    { key: 'files', label: 'Files', type: 'file' as const, accept, multiple: true, maxFiles: 10, group: label, help: 'Several files are laid out in the order you added them, one after another in a single PDF.' },
    PAGE_FIELD,
    ORIENTATION_FIELD,
    MARGIN_FIELD,
  ];
}

const TEXT_SIZE_FIELDS = [
  { key: 'fontSize', label: 'Font size', type: 'number' as const, default: 11, min: 6, max: 24, step: 1, integer: true, unit: 'pt', half: true, group: 'Typography', help: 'Body text size. Headings stay proportional to it, so one number scales the whole document.' },
  { key: 'lineHeight', label: 'Line height', type: 'slider' as const, default: 1.45, min: 1, step: 0.05, max: 3, group: 'Typography', help: 'A multiple of the text size. Below about 1.2 the lines touch and long passages get hard to follow.' },
];

/** The expectation object for a text converter, built once per tool. */
function textFormat(label: string, hint?: string) {
  return { kinds: ['text'] as SourceKind[], label, hint };
}

/**
 * What each text route really parses, spelled once.
 *
 * The intake button reads the `accept` off the definition and the file picker
 * reads it off the field, so two different strings are two different promises
 * about what can be dropped. Every extension here is one the reader accepts on
 * content, not on name.
 */
const SOURCE_ACCEPT = {
  txt: '.txt,.text,.log,.md,.markdown',
  markdown: '.md,.markdown,.txt',
  html: '.html,.htm,.xhtml',
  csv: '.csv,.tsv,.txt',
  json: '.json,.ndjson,.txt',
  xml: '.xml,.xsd,.gpx,.kml,.rss,.atom',
  rtf: '.rtf',
};

/* ------------------------------------------------------------- tool catalog */

export const convertToTools: PdfToolDefinition[] = [
  {
    id: 'image-to-pdf',
    name: 'Images to PDF',
    description: 'Convert JPG, PNG, WEBP, GIF, AVIF, HEIC, BMP, TIFF, SVG or PSD into one PDF',
    icon: '🖼️',
    category: 'convert-to',
    keywords: ['photo', 'picture', 'scan', 'jpg to pdf', 'png to pdf', 'heic'],
    multiFile: true,
    inputKind: 'image',
    accept: 'image/*,.heic,.heif,.tif,.tiff,.svg,.psd,.avif,.jxl',
    outputSuffix: '_from_images.pdf',
    surface: 'custom',
    actionLabel: 'Create PDF',
    promise: 'One page per image, at the size you pick, assembled in this tab. Multi-page TIFFs become multiple pages.',
    notes: [
      'Images are placed as they decode: the pixels are kept at their decoded size and resolution, and the page either hugs the image or fits it inside a sheet.',
      'Each picture is embedded as PNG, so a PDF built from JPEGs is larger than the JPEGs themselves — the pixels are stored losslessly, not copied byte for byte.',
      RASTER_LOSS,
      'HEIC, AVIF and JXL depend on the browser decoder; when this browser cannot open one, the run says which file failed instead of guessing.',
      TIFF_VARIANTS,
      BMP_RLE4,
      PSD_COMPOSITE,
      'Scanned pages are still pictures. Digitize Document runs OCR and adds a real, selectable text layer on top.',
    ],
    fields: [
      {
        key: 'pageSize',
        label: 'Page size',
        type: 'select',
        default: 'fit',
        group: 'Page',
        options: [
          { value: 'fit', label: 'Hug each image' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
          { value: 'a3', label: 'A3' },
          { value: 'a5', label: 'A5' },
          { value: 'tabloid', label: 'Tabloid' },
        ],
        help: 'The sheet each picture is placed on. “Hug each image” sizes every page to its own picture, which leaves Fit and Orientation nothing to act on — both are hidden until a sheet is chosen.',
      },
      { key: 'fit', label: 'Fit', type: 'select', default: 'contain', group: 'Page', when: (v: ToolValues) => v.pageSize !== 'fit' && v.onePerSheet !== true, options: [
        { value: 'contain', label: 'Fit inside the page' },
        { value: 'cover', label: 'Fill the page (crop)' },
        { value: 'stretch', label: 'Stretch' },
      ],
        help: 'Nothing is cropped unless you ask for it: the picture is scaled down to the page here, cropped by fill, and distorted by stretch.',
      },
      { key: 'orientation', label: 'Orientation', type: 'select', default: 'auto', group: 'Page', when: (v: ToolValues) => v.pageSize !== 'fit' && v.onePerSheet !== true, help: 'Auto follows each picture’s own shape, so a rotated phone photo lands the way it was taken.', options: [
        { value: 'auto', label: 'Match each image' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' },
      ] },
      { key: 'margin', label: 'Margin', type: 'slider', default: 0, min: 0, max: 72, step: 1, unit: 'pt', group: 'Page',
        help: 'Space between the picture and the edge of the sheet. Zero runs to the trim, which most printers cannot do.',
      },
      { key: 'onePerSheet', label: 'Two images per sheet', type: 'toggle', default: false, group: 'Layout',
        help: 'Halves the page count for a contact sheet or a folded booklet; each picture is scaled down to fit.',
      },
    ],
    async run(context) {
      const warnings = [RASTER_LOSS];
      const { images } = await decodeImageBatch(context, {
        label: 'one or more images',
        hint: alternativeFor({ kind: 'image', label: 'an image' }),
        background: undefined,
      });
      const size = stringValue(context.values, 'pageSize', 'fit');
      const margin = clampNumber(numberValue(context.values, 'margin', 0), 0, 144);
      if (booleanValue(context.values, 'onePerSheet')) {
        if (size === 'fit') {
          warnings.push('Two images per sheet needs a fixed sheet, so the A4 sheet you did not choose was used instead of hugging each image.');
        }
        const packed = await pdfFromImages(
          images.map((image) => ({ data: image.canvas })),
          { pageSize: 'fit', margin: 0 },
        );
        const doc = await twoUp(packed.doc, size === 'fit' ? undefined : size, margin);
        return {
          ...(await pdfResult(doc, { message: `${images.length} image(s) placed two per sheet on ${doc.getPageCount()} page(s).` })),
          warnings,
        };
      }
      const packed = await pdfFromImages(
        images.map((image) => ({ data: image.canvas })),
        {
          pageSize: size,
          orientation: stringValue(context.values, 'orientation', 'auto') as 'portrait' | 'landscape' | 'auto',
          margin,
          fit: stringValue(context.values, 'fit', 'contain') as 'contain' | 'cover' | 'stretch',
        },
      );
      return {
        ...(await pdfResult(packed.doc, {
          message: `${images.length} image(s) placed on ${packed.pages} page(s).`,
        })),
        warnings,
      };
    },
  },

  ...(['jpg-to-pdf', 'png-to-pdf', 'webp-to-pdf', 'heic-to-pdf', 'bmp-to-pdf', 'tiff-to-pdf', 'psd-to-pdf'] as const).map((id): PdfToolDefinition => {
    const format = id.replace('-to-pdf', '');
    const label = format.toUpperCase();
    const isTiff = format === 'tiff';
    const isHeic = format === 'heic';
    // "Re-save the file as HEIC" is inert advice for a file that already is one:
    // measured on the dev build, the alert under a real 5 KB `ftypheic` file said
    // exactly that and a person following it lands back on the same refusal (`docs/
    // tasks/heic-decoder-claim-ticket.md`). What helps is the container change, or
    // a platform that owns the codec.
    const HEIC_DECODE_HINT = 'Re-save the photo as PNG or JPEG, or open this page where the system can decode HEIC (Safari on macOS or iOS), then try again.';
    // PNG is the one format in this family that carries transparency.
    const isPng = format === 'png';
    // BMP is the one whose header states, byte for byte, how much it must hold.
    const isBmp = format === 'bmp';
    // WebP carries alpha like PNG, states its own length like BMP, and is the
    // only advertised format that can hold more than one frame.
    const isWebp = format === 'webp';
    return {
      id,
      name: `${label} to PDF`,
      description: `Create a PDF from one or more ${label} images`,
      icon: '🖼️',
      category: 'convert-to',
      keywords: [format, 'image', 'picture'],
      multiFile: true,
      inputKind: 'image',
      accept: `.${format},image/*`,
      outputSuffix: `_from_${format}.pdf`,
      actionLabel: 'Create PDF',
      promise: `Every ${label} you add becomes its own PDF page, the size of the picture, in the order you added them.`,
      notes: [
        // The tail is conditional on a decoder, because on a build without one a
        // mixed batch converts nothing at all (measured: HEIC + JPEG on the dev
        // build, both named, no PDF) — the flat sentence read as a promise about
        // the very files that were about to be refused. The same over-reach was
        // measured for non-pictures on the other six routes: a text file in a
        // batch of real JPEGs is named and stops the run at the gate
        // (`tools/runner.ts:inputKindProblem`) — only files that *are* pictures
        // of the wrong format are left out while the rest converts (measured on
        // the rail: [photo.png, photo.jpg] → `1 JPG image(s) → 1 page(s).
        // 1 file(s) left out.`). The HEIC card was missing that second sentence
        // until chunk c2 measured the same gate stop on its own route: an 8-byte
        // `ftyp` stub named `tiny.heic` is refused as "binary data this converter
        // cannot read" and the run stops with no PDF (`docs/research/
        // convert-heic-spec.json`, run `c2-tiny`). A video keeps its own path:
        // `sniffImageMime` calls every `ftyp` file HEIC, so `mp4-as.heic` passes
        // the gate and is refused by the decoder sentence below, not this one.
        isHeic
          ? 'A file that is not really a HEIC is named and left out; where a decoder exists, the HEIC files beside it are still converted, never silently re-encoded. A file that is not a picture at all — text, a PDF, a ZIP, an MP3 — is named, and the run stops before any page is made.'
          : `A picture that is not really a ${label} is named and left out; the ${label} files beside it are still converted, never silently re-encoded. A file that is not a picture at all — text, a PDF, a ZIP, an MP3 — is named, and the run stops before any page is made.`,
        isTiff
          ? 'Multi-page TIFFs contribute one PDF page per frame, in page order.'
          : `The ${label} pixels are embedded as they decode; no resampling, no sharpening.`,
        isPng ? PNG_ALPHA : isWebp ? WEBP_ALPHA : '',
        // Measured on the dev build: a 24-bit 243 x 160 BMP cut after 10 rows
        // embedded as a complete page with 150 white rows Chrome invented, and
        // the card said `5 BMP image(s) → 5 page(s)` with nothing about it.
        isBmp ? BMP_TRUNCATED : '',
        isBmp ? BMP_RLE4 : '',
        isTiff ? TIFF_VARIANTS : '',
        format === 'psd' ? PSD_COMPOSITE : '',
        isWebp ? WEBP_TRUNCATED : '',
        isWebp ? WEBP_FIRST_FRAME : '',
        RASTER_DENSITY,
        // Measured rather than assumed: two real HEIC files (32 KB and 472 B, both
        // `ftypheic`/hvc1, both decoded by Pillow on this machine) opened in neither
        // `createImageBitmap` nor `<img>` here, so the whole run is a refusal.
        isHeic
          ? 'HEIC is decoded by the browser and the operating system, not by this page. Where that decoder is absent — measured on Chrome for Testing 151 on Linux, which has no HEIC decoder at all — nothing is converted: every file is refused by name and no PDF is produced. Convert the photo to PNG or JPEG first.'
          : '',
        RASTER_LOSS,
      ].filter((line) => line !== ''),
      fields: [IMAGE_PAGE_FIELD, IMAGE_MARGIN_FIELD, IMAGE_ORIENTATION_FIELD],
      async run(context) {
        // The refusals are collected apart from the standing note: `warnings`
        // already starts with `RASTER_LOSS`, so handing that array over as the
        // collector made every run count one file left out, even a single good
        // JPEG.
        const refused: string[] = [];
        // Facts about a *file* that the run has to say out loud, kept apart from
        // `refused` (those end “— left out.” and the count beside them).
        const notices: string[] = [];
        const { images } = await decodeImageBatch(context, {
          label: `one or more ${label} images`,
          hint: `Re-save the file as ${label}, or use Images to PDF, which sniffs the real format.`,
          decodeHint: isHeic
            ? HEIC_DECODE_HINT
            : isTiff
              ? TIFF_VARIANT_HINT
              : isBmp
                ? BMP_RLE4_HINT
                : format === 'psd'
                  ? PSD_PREVIEW_HINT
                  : undefined,
          expectLabel: `${label} image(s)`,
          mimes: FORMAT_MIMES[format],
          refused,
          notices,
        });
        const packed = await pdfFromImages(
          images.map((image) => ({ data: image.canvas })),
          {
            pageSize: stringValue(context.values, 'pageSize', 'fit'),
            margin: clampNumber(numberValue(context.values, 'margin', 0), 0, 144),
            orientation: stringValue(context.values, 'orientation', 'portrait') as 'portrait' | 'landscape',
          },
        );
        return {
          ...(await pdfResult(packed.doc, {
            message: `${images.length} ${label} image(s) → ${packed.pages} page(s).`
              + (refused.length ? ` ${refused.length} file(s) left out.` : ''),
          })),
          warnings: [RASTER_LOSS, ...(isPng ? [PNG_ALPHA] : isWebp ? [WEBP_ALPHA] : []), RASTER_DENSITY, ...notices, ...refused],
        };
      },
    };
  }),

  {
    id: 'svg-to-pdf',
    name: 'SVG to PDF',
    description: 'Convert SVG drawings into PDF pages',
    icon: '🧷',
    category: 'convert-to',
    keywords: ['vector', 'icon', 'diagram', 'logo'],
    multiFile: true,
    inputKind: 'image',
    accept: '.svg,image/svg+xml',
    outputSuffix: '_from_svg.pdf',
    actionLabel: 'Create PDF',
    promise: 'Your SVG artwork on a page you choose, rasterised at up to 4096 px on the long edge.',
    notes: [
      'SVG is painted through the browser canvas, so the result is a high-resolution bitmap: strokes, gradients and text become pixels and cannot be re-coloured or searched afterwards. A server-grade engine keeps them as vector operators.',
      'The artwork’s own `width`/`height` decide the sheet in “Fit the artwork”; “Square” keeps the long edge and pads the short one.',
      'Text inside the SVG renders in whatever font this browser resolved, not an embedded copy of yours.',
      'An SVG with no `width`/`height` is laid out in the browser default 300 × 150 box, kept to the drawing’s aspect: a 2:1 `viewBox` measures 300 × 150 and a square one 150 × 150 — the drawing is fitted to the box, never stretched into it (measured on Chrome for Testing 151).',
      'Animations never play and external references (`<image href="…">`, remote fonts) are not fetched: whatever they point at is simply missing from the page. SVG filter effects do paint — a blurred rectangle arrives blurred, measured — and an image carried inside the file as a `data:` URL is kept.',
    ],
    fields: [
      {
        key: 'pageSize',
        label: 'Page size',
        type: 'select',
        default: 'fit',
        group: 'Page',
        help: 'Fit to image keeps the artwork’s own proportions on a page sized to it.',
        options: [
          { value: 'fit', label: 'Fit the artwork' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
          { value: 'square', label: 'Square (long edge)' },
        ],
      },
      MARGIN_FIELD,
    ],
    async run(context) {
      const pages: { data: Uint8Array | Blob | HTMLCanvasElement }[] = [];
      const skipped: string[] = [];
      for (const batch of await sourceBatches(context, {
        kinds: ['svg', 'text'],
        label: 'an SVG drawing',
        hint: 'A raster file was named .svg — use Images to PDF instead.',
      })) {
        // Ask the browser's own XML parser before the image decoder: a broken
        // document is a broken document, and "this browser has no decoder for
        // SVG" — the sentence the decode route reaches for — tells the user to
        // change the file's format when the file needs a `</rect>`.
        const parsed = new DOMParser().parseFromString(
          new TextDecoder('utf-8', { fatal: false }).decode(batch.bytes),
          'image/svg+xml',
        );
        const failure = parsed.querySelector('parsererror');
        if (failure) {
          const detail = (failure.textContent ?? '')
            .split('\n')
            .map((row) => row.trim())
            .find((row) => /error|Line Number|unclosed|mismatched/i.test(row) && !/^xml parsing failed/i.test(row))
            ?? 'the parser stopped before the document ended';
          skipped.push(`"${batch.name}" is not well-formed XML (${detail}).`);
          continue;
        }
        try {
          const decoded = await decodeImage(batch.bytes, { mime: 'image/svg+xml', maxSide: 4096 });
          pages.push({ data: decoded.canvas });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          skipped.push(`"${batch.name}" (${reason})`);
        }
      }
      if (pages.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'No SVG drawing could be painted.', {
          hint: skipped[0] ?? 'The file had no drawable content.',
        });
      }
      const size = stringValue(context.values, 'pageSize', 'fit');
      const packed = await pdfFromImages(pages, {
        pageSize: size,
        margin: clampNumber(numberValue(context.values, 'margin', 56), 0, 144),
      });
      const warnings = [
        'SVG was rasterised at up to 4096 px: strokes, gradients and text are pixels now, not vectors.',
      ];
      if (skipped.length > 0) warnings.push(`Skipped ${skipped.length} file(s): ${skipped.join('; ')}.`);
      return {
        ...(await pdfResult(packed.doc, {
          message: `${pages.length} SVG(s) placed on ${packed.pages} page(s).`,
        })),
        warnings,
      };
    },
  },

  {
    id: 'cbz-to-pdf',
    name: 'CBZ to PDF',
    description: 'Turn a comic-book archive into a PDF, one page per image',
    icon: '📚',
    category: 'convert-to',
    keywords: ['comic', 'manga', 'archive', 'cbr'],
    inputKind: 'any',
    accept: '.cbz,.zip',
    outputSuffix: '_from_cbz.pdf',
    actionLabel: 'Create PDF',
    promise: 'Every page image inside the ZIP, in reading order, on a page that matches its own size — or on the sheet you choose.',
    notes: [
      'Only ZIP containers are read. CBR is a RAR archive renamed, and BrowserSnip does not bundle a RAR decompressor.',
      'A chosen sheet is turned sideways for artwork wider than it is tall, and the picture is scaled to fit inside it whole — oversized art is reduced, small art is enlarged (measured: 200 × 400 on A4 covers 422 × 842 pt) — never cropped.',
      'Pages are the pictures themselves: lettering is not extracted as text, so the result is not searchable.',
      'Entry names are sorted naturally, so page 2 sorts after page 1 rather than after page 10.',
    ],
    fields: [CBZ_PAGE_FIELD],
    async run(context) {
      const [input] = await sourceBatches(context, {
        kinds: ['zip'],
        label: 'a ZIP-based CBZ archive',
        hint: sniffArchiveHint,
      });
      const { readZip } = await import('../core/archive');
      let all;
      try {
        all = await readZip(input.bytes);
      } catch (error) {
        throw new ToolInputError('CORRUPT', `"${input.name}" is not a readable ZIP archive: ${error instanceof Error ? error.message : 'it could not be opened'}.`, {
          fileName: input.name,
          hint: sniffArchiveHint,
        });
      }
      // The seam hides folders and Mac resource-forks; this split is the part
      // the route owns: what counts as a page, and what the card must then say
      // it left out. Reading the whole archive is also how the ignored entries
      // get counted and named — the standing sentence used to claim "Non-image
      // entries ... were ignored" over an archive that held none at all
      // (measured: `c2-allimg`), with no count whenever it was true.
      const isPage = (entry: { name: string }) =>
        CBZ_PAGE_EXTENSIONS.some((ext) => entry.name.toLowerCase().endsWith(`.${ext}`));
      const files = all.filter(isPage);
      const extras = all.filter((entry) => !isPage(entry));
      if (files.length === 0) {
        throw new ToolInputError('UNSUPPORTED', `"${input.name}" is a valid archive but holds no page images.`, {
          fileName: input.name,
          hint: 'CBZ needs JPG, PNG, WEBP, GIF, BMP, TIFF or AVIF pages inside.',
        });
      }
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const size = stringValue(context.values, 'pageSize', 'fit');
      const packed = await pdfFromImages(
        files.map((file) => ({ data: file.bytes, mime: file.mime })),
        { pageSize: size, margin: 0 },
      );
      return {
        ...(await pdfResult(packed.doc, {
          // The card names the sheet the bytes carry: hugging and a chosen paper
          // are different answers now, and a sentence that hid which one ran is
          // what made this control look alive when it was not.
          message: size === 'fit'
            ? `${files.length} comic pages → ${packed.pages} PDF page(s), each page its own artwork's size.`
            : `${files.length} comic pages → ${packed.pages} PDF page(s) on ${sheetLabel(size)} paper.`,
        })),
        warnings: [
          RASTER_LOSS,
          ...(extras.length > 0
            ? [`Non-image entries (${extras.length} of ${all.length} files in the archive) were ignored: `
              + `${extras.slice(0, 5).map((entry) => entry.name).join(', ')}`
              + `${extras.length > 5 ? `, +${extras.length - 5} more` : ''}.`]
            : []),
        ],
      };
    },
  },

  {
    id: 'txt-to-pdf',
    name: 'Text to PDF',
    description: 'Turn a plain text file into a properly typeset PDF',
    icon: '📄',
    category: 'convert-to',
    keywords: ['plain text', 'txt', 'monospace', 'manuscript'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.txt,
    surface: 'none',
    outputSuffix: '_from_text.pdf',
    actionLabel: 'Typeset',
    promise: 'A paginated, selectable-text PDF with real margins, page numbers and optional monospace.',
    notes: [
      ...TEXT_NOTES,
      'Plain text carries no structure, so nothing is inferred: paragraphs come from blank lines, line breaks are kept, and no line is promoted to a title.',
      'Long lines are wrapped to the column; hard line breaks in the source are respected, whichever convention wrote them — CRLF, old-Mac CR, or a Unicode line separator all start a line, a tab stops at the next eighth column, and a form feed starts a new page.',
      'Bytes are read as UTF-8; a file that is not valid UTF-8 is read as Windows-1252 (the encoding Notepad called ANSI) and the run names the encoding it used. A byte-order mark wins over both. Control characters that no face can draw are left out and counted.',
    ],
    fields: [
      ...sourceFields(SOURCE_ACCEPT.txt, 'Paste your text here…', 'Source'),
      ...TEXT_SIZE_FIELDS,
      { key: 'monospace', label: 'Monospaced', type: 'toggle', default: false, group: 'Typography', help: 'One character wide, so aligned columns and code stay lined up. Proportional text is easier to read in prose.' },
      { key: 'paragraphs', label: 'Blank line starts a new paragraph', type: 'toggle', default: true, group: 'Typography', help: 'Off keeps every line break exactly as typed, which is what you want for verse, tables and code.' },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true, group: 'Footer', help: 'Draws the page number in the footer, next to any footer text you wrote.' },
    ],
    async run(context) {
      const { sources, warnings } = await readSources(context, textFormat('a plain text file'));
      if (sources.some((source) => /<\/?[a-z][\s\S]*>/i.test(source.text))) {
        warnings.push('The source contains HTML tags; they are printed as text here. HTML to PDF typesets them.');
      }
      const { textToBlocks } = await import('../core/layout');
      const options = {
        monospace: booleanValue(context.values, 'monospace'),
        paragraphs: booleanValue(context.values, 'paragraphs', true) ? '\n\n' as const : '\n' as const,
      };
      // A form feed is a page break to a line printer, to `enscript` and to
      // `txt2pdf`, and the layout engine has a page-break block for exactly that;
      // the manuscripts that mark their pages (Gutenberg, RFCs) mean it.
      const blocks: Block[] = sources.flatMap((source) =>
        source.text
          .split('\f')
          .filter((page) => page.trim() !== '')
          .flatMap((page, index) => {
            const blocksOnPage = textToBlocks(expandTabs(page), options);
            return index === 0 ? blocksOnPage : [{ kind: 'pagebreak' as const }, ...blocksOnPage];
          }),
      );
      return blocksResult(blocks, layoutOptions(context), `Typeset ${sources.length} text source(s) into`, warnings);
    },
  },

  {
    id: 'markdown-to-pdf',
    name: 'Markdown to PDF',
    description: 'Render Markdown with headings, lists, tables, code blocks and maths',
    icon: '🔣',
    category: 'convert-to',
    keywords: ['md', 'readme', 'notes', 'gfm'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.markdown,
    surface: 'none',
    outputSuffix: '_from_markdown.pdf',
    actionLabel: 'Render',
    promise: 'CommonMark and GFM structure — headings, lists, tables, fenced code, task lists — as selectable text.',
    notes: [
      ...TEXT_NOTES,
      'Only `data:` images can be embedded: a remote `src` is never fetched, so it stays as alt text — and a picture written inside a sentence prints its alt text too, because pictures are placed between paragraphs, not between words.',
      'Maths arrives as its LaTeX source: `$x^2 + y_1$` prints those exact characters in the body face, not typeset (a server engine would run KaTeX). `code` inside a sentence keeps its words but not a monospace face; a fenced block does.',
      'Footnotes, definition lists and Mermaid diagrams are not rendered: `[^1]` prints in the sentence and its definition prints as its own paragraph, and a `mermaid` fence is typeset as code, not drawn.',
      'A link is drawn blue and underlined, but the file carries no clickable target and the address is not printed; an autolink like `<https://example.com>` keeps its address, as plain text.',
      'A task list prints its box in the marker column — `[x] done`, `[ ] not yet` — and a nested list is laid out at the same depth as the list above it.',
      'Raw HTML inside the Markdown is stripped rather than rendered: `<b>` arrives as its words, a `<script>` or `<style>` block goes with its body (an unclosed tag prints its body as text instead), a `<!-- comment -->` never reaches the page, and a `<br>` ends the line. Tags inside a fenced block are kept — except a complete `<script>…</script>` or `<style>…</style>` pair, which is removed from the code too.',
      'Character references arrive as the characters they name — `&amp;`, `&copy;`, `&#8212;`, `&#x41;` each print their one character — in prose and in a `code span` alike. A fenced block keeps them written out, except the five the tag stripper knows (`&amp; &lt; &gt; &quot; &#39;`), which are decoded there too. A name no decoder knows (`&bareword;`) prints as written.',
    ],
    fields: [
      ...sourceFields(SOURCE_ACCEPT.markdown, '# Heading\n\nWrite **Markdown** here…', 'Source'),
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 6, max: 24, step: 1, integer: true, unit: 'pt', half: true, group: 'Typography',
        help: 'Body text size. Headings and code stay proportional to it, so one number scales the document.',
      },
      { key: 'lineHeight', label: 'Line height', type: 'slider', default: 1.45, min: 1, max: 3, step: 0.05, group: 'Typography', help: 'A multiple of the text size, so it stays readable when you change the size above.' },
      { key: 'columns', label: 'Columns', type: 'segmented', default: 1, group: 'Typography', help: 'Two columns re-flow the text; they do not reproduce a table or a magazine’s exact line breaks.', options: [
        { value: 1, label: 'One' }, { value: 2, label: 'Two' },
      ] },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true, group: 'Page',
        help: 'Draws the page number in the footer, alongside any footer text you wrote.',
      },
      { key: 'header', label: 'Header text', type: 'text', placeholder: 'Shown at the top of every page', group: 'Footer', help: 'Repeated at the top of every page, inside the margin above.' },
      { key: 'footer', label: 'Footer text', type: 'text', placeholder: 'Shown at the bottom of every page', group: 'Footer', help: 'Repeated at the bottom of every page; page numbers are drawn on the same line.' },
    ],
    async run(context) {
      const { sources, warnings } = await readSources(context, textFormat('a Markdown file'));
      const { markdownToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      let remote = 0;
      for (const source of sources) {
        remote += countMatches(source.text, /!\[[^\]]*\]\(\s*(?!data:)[^)]+\)/g);
        const text = normalizeMarkdown(source.text);
        const built = await markdownToBlocks(text, {
          images: async (src) => readDataUrl(src),
        });
        blocks.push(...decodeBlockEntities(markStructuredLists(built, text)));
      }
      if (remote > 0) {
        warnings.push(`${remote} image reference(s) point off-device and were kept as alt text — nothing is uploaded or fetched.`);
      }
      return blocksResult(blocks, layoutOptions(context), `Rendered ${sources.length} Markdown source(s) into`, warnings);
    },
  },

  {
    id: 'html-to-pdf',
    name: 'HTML to PDF',
    description: 'Lay out HTML as real selectable text — headings, lists, tables and images',
    icon: '🌐',
    category: 'convert-to',
    keywords: ['web page', 'markup', 'email', 'convert html'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.html,
    surface: 'none',
    outputSuffix: '_from_html.pdf',
    actionLabel: 'Lay out',
    promise: 'Document structure — headings, paragraphs, lists, tables, inline styles and data-URL images — as selectable text.',
    notes: [
      ...TEXT_NOTES,
      'The markup is parsed in a detached document, so author scripts never run and nothing is injected into this page.',
      'There is no CSS layout engine: floats, grid, flexbox, absolute positioning, ::before content and web fonts are not reproduced. Inline bold/italic/colour/size attributes are.',
      'Print CSS is not honoured either: an `@page { size: … }` rule cannot resize the sheet, so the Page size and Orientation controls above decide.',
      'An `<img>` that stands as its own block is embedded when it is a data: URL; one written inline inside a paragraph prints its alt text, because the renderer places pictures between paragraphs, not between words.',
      'Only `data:` images are embedded. `src` values that need the network are dropped and reported.',
      'A link is drawn blue and underlined, but the file carries no clickable target and its address is not printed; an `<a name>` anchor prints its words alone.',
    ],
    fields: [
      ...sourceFields(SOURCE_ACCEPT.html, '<h1>Title</h1><p>Body text…</p>', 'Source'),
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 6, max: 24, step: 1, integer: true, unit: 'pt', half: true, group: 'Typography', help: 'Body text size. Headings are scaled from it, so changing this resizes the whole document.' },
      { key: 'lineHeight', label: 'Line height', type: 'slider', default: 1.45, min: 1, max: 3, step: 0.05, group: 'Typography', help: 'A multiple of the text size, so it stays readable when you change the size above.' },
      { key: 'embedImages', label: 'Embed images referenced by data: URL', type: 'toggle', default: true, group: 'Typography',
        help: 'Only images already inlined as data: URLs can be embedded; remote ones are reported as skipped, never fetched.',
      },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: false, group: 'Page',
        help: 'Draws the page number in the footer, alongside any footer text you wrote.',
      },
    ],
    async run(context) {
      const { sources, warnings } = await readSources(context, textFormat('an HTML document'));
      const { htmlToBlocks } = await import('../core/layout');
      const embed = booleanValue(context.values, 'embedImages', true);
      const blocks: Block[] = [];
      let skippedImages = 0;
      let scriptBlocks = 0;
      let imageTags = 0;
      for (const source of sources) {
        skippedImages += countMatches(source.text, /<img[^>]+src="\s*(?!data:)[^"]+"/gi);
        imageTags += countMatches(source.text, /<img[\s>/]/gi);
        scriptBlocks += countMatches(source.text, /<script[\s>]/gi);
        const built = await htmlToBlocks(source.text, {
          fetchImage: embed
            ? async (src) => readDataUrl(src)
            : async () => null,
        });
        blocks.push(...markStructuredLists(built, source.text));
        // A file saved as `.html` that holds no markup is still a document with
        // words in it, and a browser lays those out as text: the detached DOM hands
        // them back as loose text nodes, which the block walk does not read, and the
        // run refused with "no readable body content" over two readable lines.
        if (built.length === 0 && !/<[a-z!/][^>]*>/i.test(source.text)) {
          const { textToBlocks } = await import('../core/layout');
          blocks.push(...textToBlocks(source.text, { paragraphs: '\n' }));
        }
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'That HTML had no readable body content.', {
          hint: 'Tables, headings, paragraphs, lists and data-URL images are supported; a page that is only a script-written app has none of them.',
        });
      }
      if (!embed && imageTags > 0) {
        warnings.push(imageTags === 1
          ? 'Image embedding is off, so the one <img> was skipped.'
          : `Image embedding is off, so all ${imageTags} <img>s were skipped.`);
      }
      else if (skippedImages > 0) {
        warnings.push(`${skippedImages} <img> reference(s) are not data: URLs and were skipped — no network requests are made.`);
      }
      if (scriptBlocks > 0) {
        warnings.push(`${scriptBlocks} <script> block(s) were ignored: author JavaScript does not run, so content created by scripts is not in the output.`);
      }
      return blocksResult(blocks, layoutOptions(context), `Laid out ${sources.length} HTML source(s) into`, warnings);
    },
  },

  {
    id: 'csv-to-pdf',
    name: 'CSV to PDF',
    description: 'Render a spreadsheet or CSV as a paginated table with repeating headers',
    icon: '🗃️',
    category: 'convert-to',
    keywords: ['spreadsheet', 'excel', 'table', 'delimiter'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.csv,
    multiFile: true,
    surface: 'none',
    outputSuffix: '_from_csv.pdf',
    actionLabel: 'Tabulate',
    promise: 'Every row as a real table row, with the header repeated on each page and columns sized to fit.',
    notes: [
      ...TEXT_NOTES,
      'Cells are text. Number, date and currency formats are whatever the file literally contains — a spreadsheet is not re-evaluated.',
      'Quoted fields, embedded newlines and CRLF are handled; a very wide table is scaled down and may drop to a small type size. A tab inside a quoted field becomes spaces up to the next eighth column, and a form feed breaks the line inside the cell. Where the columns cannot carry the size you chose, the type is dropped and the run says so; a single word longer than its column still runs over the column beside it.',
    ],
    fields: [
      ...sourceFields(SOURCE_ACCEPT.csv, 'name,qty,price\nWidget,3,9.99', 'Source'),
      { key: 'delimiter', label: 'Delimiter', type: 'select', default: ',', group: 'Table', help: 'Wrong delimiter, wrong table: rows are split on this character (or, with Detect, on the one the header line uses) and nothing else.', options: [
        { value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' }, { value: 'auto', label: 'Detect' },
      ] },
      { key: 'headerRow', label: 'First row is a header', type: 'toggle', default: true, group: 'Table',
        help: 'Drawn in bold and repeated at the top of each new page the table spills onto.',
      },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 9, min: 5, max: 18, step: 1, integer: true, unit: 'pt', half: true, group: 'Table', help: 'Small enough that a wide sheet fits one page without the columns being squeezed.' },
    ],
    async run(context) {
      const { sources, warnings } = await readSources(context, textFormat('a CSV or TSV file'));
      const { csvToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      let widest = 0;
      const delimiter = stringValue(context.values, 'delimiter', ',');
      for (const [index, source] of sources.entries()) {
        const tableBlocks = cellsToDrawable(await csvToBlocks(source.text, {
          delimiter: delimiter === 'auto' ? undefined : delimiter,
          header: booleanValue(context.values, 'headerRow', true),
        }));
        // Counted from the grid that is about to be drawn, so the warning below
        // cannot disagree with the table the user sees.
        for (const block of tableBlocks) {
          if (block.kind !== 'table') continue;
          widest = Math.max(widest, block.header?.length ?? 0, ...block.rows.map((row) => row.length));
        }
        // The file field promises "one after another in a single PDF", so a second
        // file starts on a sheet of its own instead of continuing the first table —
        // which would otherwise read as one grid whose header changed mid-column.
        if (index > 0 && blocks.length > 0) blocks.push({ kind: 'pagebreak' });
        blocks.push(...tableBlocks);
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'Those files had no rows to draw.', {
          hint: 'Check the delimiter, or open the file in a text editor to see what is really in it.',
        });
      }
      if (widest > 12) {
        warnings.push(`${widest} columns on the widest row: the table is squeezed onto the page, so narrow columns may wrap hard.`);
      }
      // The promise is "columns sized to fit", and `renderTable` splits the text
      // width evenly between the columns: measured with 15 columns at 18 pt, the
      // header words printed on top of each other (the download read one run
      // `namenotesqty`). So the size is capped at what a column can carry — five
      // average glyphs inside the space left after the cell padding — which is the
      // card's "may drop to a small type size" implemented, not merely promised.
      const options = layoutOptions(context);
      const [pageWidth] = options.pageSize as [number, number];
      const margin = options.margin ?? 56;
      const chosen = options.baseFontSize ?? DEFAULTS_FONT;
      const column = (pageWidth - margin * 2) / (options.columns === 2 ? 2 : 1) / Math.max(1, widest);
      const cap = Math.max(5, (column - 8) / 2.15);
      const baseFontSize = Math.min(chosen, cap);
      return blocksResult(
        blocks,
        { ...options, baseFontSize },
        `Tabulated ${sources.length} file(s) into`,
        [...warnings, ...(baseFontSize < chosen
          ? [`Type size dropped from ${chosen} pt to ${Math.round(baseFontSize * 100) / 100} pt so all ${widest} columns fit the page.`]
          : [])],
      );
    },
  },

  {
    id: 'json-to-pdf',
    name: 'JSON to PDF',
    description: 'Print structured JSON as a readable nested report',
    icon: '🧾',
    category: 'convert-to',
    keywords: ['data', 'api response', 'config', 'structured'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.json,
    surface: 'none',
    outputSuffix: '_from_json.pdf',
    actionLabel: 'Report',
    promise: 'A keyed report — one table per object, one heading per level — with every value as selectable text.',
    notes: [
      ...TEXT_NOTES,
      'Structure is preserved as headings, key/value tables and bulleted lists — not as a JSON literal, so copying text out will not paste back as valid JSON.',
      'Anything deeper than the Maximum depth control is replaced by a `(truncated)` marker and reported in the warnings.',
      'NDJSON (one document per line) is read as one report per line.',
    ],
    fields: [
      ...sourceFields(SOURCE_ACCEPT.json, '{\n  "name": "value"\n}', 'Source'),
      { key: 'maxDepth', label: 'Maximum depth', type: 'number', default: 8, min: 1, max: 20, step: 1, integer: true, group: 'Report', help: 'How deep nested objects and arrays are printed before the rest is collapsed to a count. Deeper is more faithful and much longer.' },
    ],
    async run(context) {
      const { sources, warnings } = await readSources(context, textFormat('a JSON document'));
      const { jsonToBlocks } = await import('../core/layout');
      const maxDepth = Math.round(clampNumber(numberValue(context.values, 'maxDepth', 8), 1, 20));
      const blocks: Block[] = [];
      const truncated: string[] = [];
      for (const source of sources) {
        const documents = splitNdjson(source.text);
        for (const [index, chunk] of documents.entries()) {
          let parsed: unknown;
          const where = documents.length > 1 ? ` (document ${index + 1})` : '';
          try {
            parsed = JSON.parse(chunk);
          } catch (error) {
            throw new ToolInputError(
              'UNSUPPORTED',
              `"${source.name}"${where} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}.`,
              { fileName: source.name, hint: 'Fix the syntax, or typeset it as text with Text to PDF.' },
            );
          }
          if (depthOf(parsed) > maxDepth) truncated.push(`"${source.name}"${where}`);
          blocks.push(...jsonToBlocks(parsed, { maxDepth }));
        }
      }
      if (truncated.length > 0) {
        warnings.push(`Depth ${maxDepth} cut off branches of ${truncated.join(', ')} — raise Maximum depth to print them.`);
      }
      return blocksResult(blocks, layoutOptions(context), `Reported ${sources.length} JSON file(s) into`, warnings);
    },
  },

  {
    id: 'xml-to-pdf',
    name: 'XML to PDF',
    description: 'Render an XML document as an indented, readable tree',
    icon: '🧬',
    category: 'convert-to',
    keywords: ['markup', 'gpx', 'svg source', 'data interchange'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.xml,
    surface: 'none',
    outputSuffix: '_from_xml.pdf',
    actionLabel: 'Print tree',
    promise: 'Elements, attributes and text as an indented tree you can read and search.',
    notes: [
      ...TEXT_NOTES,
      'The tree is printed as text: no stylesheet is applied, so XSLT, namespaces and entity resolution do not change what you see.',
      'A GPX or KML file therefore reads as a structure dump, not as a map.',
    ],
    fields: sourceFields(SOURCE_ACCEPT.xml, '<?xml version="1.0"?><root/>', 'Source'),
    async run(context) {
      // An SVG *is* XML, so the drawing kind is accepted here as well (E2).
      const { sources, warnings } = await readSources(context, {
        kinds: ['text', 'svg'],
        label: 'an XML document',
      });
      const { xmlToBlocks } = await import('../core/layout');
      for (const source of sources) {
        if (!/<[\w:-]+/.test(source.text)) {
          throw new ToolInputError('UNSUPPORTED', `"${source.name}" has no XML elements in it.`, {
            fileName: source.name,
            hint: 'If it is JSON or plain text, use the tool for that format instead.',
          });
        }
      }
      const blocks: Block[] = sources.flatMap((source) => {
        const built = xmlToBlocks(source.text);
        if (built.length === 1 && built[0]?.kind === 'code') {
          warnings.push(`"${source.name}" is not well-formed XML, so it was printed as plain text instead of a tag tree.`);
        }
        return built;
      });
      if (sources.some((source) => /<svg[\s>]/i.test(source.text))) {
        warnings.push('This is an SVG document printed as a tag tree; SVG to PDF paints it as artwork instead.');
      }
      return blocksResult(blocks, layoutOptions(context), `Printed ${sources.length} XML file(s) into`, warnings);
    },
  },

  {
    id: 'rtf-to-pdf',
    name: 'RTF to PDF',
    description: 'Convert Rich Text Format documents, including colour and lists',
    icon: '🖋️',
    category: 'convert-to',
    keywords: ['rich text', 'write', 'wordpad'],
    inputKind: 'text',
    accept: SOURCE_ACCEPT.rtf,
    surface: 'none',
    outputSuffix: '_from_rtf.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'Text, paragraphs, basic runs with bold/italic/underline, colour and bullet lists.',
    notes: [
      ...TEXT_NOTES,
      'The control words this reader understands are a subset: character tables, colour tables, embedded OLE objects, footnotes and pictures stored as raw binary are dropped and reported.',
      'Non-ASCII characters written as backslash-xx escapes are decoded with the document’s declared code page where it can be determined, otherwise Windows-1252.',
      'Use Word to PDF for .rtf too: it reaches the same output and accepts a DOCX alongside it.',
    ],
    fields: sourceFields(SOURCE_ACCEPT.rtf, '{\\rtf1 Hello}', 'Source'),
    async run(context) {
      const { sources, warnings } = await readSources(context, {
        kinds: ['text'],
        label: 'a Rich Text (RTF) document',
        hint: 'An RTF file starts with a backslash and the letters rtf1. A plain-text file can be typeset with Text to PDF instead.',
      });
      for (const source of sources) {
        if (!/^\s*\{\\rtf[0-9a-z]/.test(source.text)) {
          throw new ToolInputError(
            'UNSUPPORTED',
            `"${source.name}" is not a Rich Text document: it does not begin with the RTF signature.`,
            {
              fileName: source.name,
              hint: 'Plain text is typeset by Text to PDF, and HTML by HTML to PDF — both keep the words.',
            },
          );
        }
      }
      const dropped = sources
        .map((source) => {
          const count = countMatches(source.text, /\\(object|shppict|pict|footnote|sect|trowd|cell)\b/g);
          return count > 0 ? `${source.name}: ${count} construct(s)` : null;
        })
        .filter((line): line is string => line !== null);
      if (dropped.length > 0) {
        warnings.push(`Dropped unsupported RTF controls (${dropped.join('; ')}) — images, tables and section properties are not reproduced.`);
      }
      const { rtfToBlocks } = await import('../core/layout');
      const blocks: Block[] = sources.flatMap((source) => rtfToBlocks(source.text));
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'No readable RTF text could be recovered.', {
          hint: 'Re-save the document as .txt or .docx, or open it in WordPad and save again.',
        });
      }
      return blocksResult(blocks, layoutOptions(context), `Converted ${sources.length} RTF file(s) into`, warnings);
    },
  },

  {
    id: 'word-to-pdf',
    name: 'Word to PDF',
    description: 'Convert DOCX, DOC and ODT into a PDF with selectable text',
    icon: '📝',
    category: 'convert-to',
    keywords: ['docx', 'doc', 'odt', 'office', 'document'],
    multiFile: true,
    inputKind: 'office',
    accept: '.docx,.docm,.doc,.odt,.ott,.rtf',
    surface: 'none',
    outputSuffix: '_from_word.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'Re-flowed text with headings, lists, tables and embedded images as selectable PDF text.',
    notes: [
      ...TEXT_NOTES,
      'The DOCX route reads the document body (mammoth), so it is content-faithful but not page-faithful: your pagination, section breaks, headers and footers, footnotes, comments, tracked changes, text boxes and floating images do not survive, and Word’s own layout is not reproduced.',
      'Table cell shading, merged-cell formatting and column widths are flattened to a plain bordered table.',
      'ODT keeps its text, headings, lists and tables through the OpenDocument reader; the same pagination caveats apply.',
      'Legacy binary .doc needs the optional LibreOffice module, which BrowserSnip does not bundle — the refusal names it instead of producing an empty page.',
    ],
    fields: [
      PAGE_FIELD,
      MARGIN_FIELD,
      ORIENTATION_FIELD,
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: false, group: 'Page',
        help: 'Numbers the sheets this converter produces. The original document’s own page numbering cannot survive a re-flow.',
      },
    ],
    async run(context) {
      const inputs = await sourceBatches(context, {
        kinds: ['zip', 'ole', 'text'],
        label: 'a DOCX, DOC, ODT or RTF document',
      });
      const blocks: Block[] = [];
      const warnings: string[] = [
        'Layout is re-flowed, not copied: pagination, headers, footers, footnotes, comments and text boxes from the original document are not preserved.',
        'Merged cells, cell shading and column widths become a plain bordered table.',
      ];
      let route = '';
      for (const input of inputs) {
        const lower = input.name.toLowerCase();
        const before = blocks.length;
        if (lower.endsWith('.odt') || lower.endsWith('.ott')) {
          const { odtToBlocks } = await import('../core/office-in');
          blocks.push(...(await odtToBlocks(input.bytes)));
          route = mergeRoute(route, 'OpenDocument reader');
        } else if (lower.endsWith('.rtf')) {
          const { rtfToBlocks } = await import('../core/layout');
          blocks.push(...rtfToBlocks(decodeText(input.bytes).text));
          route = mergeRoute(route, 'RTF reader');
        } else if (lower.endsWith('.docx') || lower.endsWith('.docm') || sniffSource(input.bytes, input.name).kind === 'zip') {
          blocks.push(...(await docxToBlocks(input.bytes)));
          route = mergeRoute(route, 'mammoth (bundled, offline)');
        } else {
          await convertWithLibreOffice(context, input.bytes, input.name, 'pdf');
        }
        const produced = blocks.length - before;
        if (produced === 0) {
          warnings.push(`"${input.name}" had no readable body text.`);
        }
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'Those documents contained no readable body text.', {
          hint: 'A DOCX of only text boxes or drawings needs a server-grade converter to keep its appearance.',
        });
      }
      return blocksResult(blocks, layoutOptions(context), `Converted ${inputs.length} document(s) via ${route} into`, warnings);
    },
  },

  {
    id: 'excel-to-pdf',
    name: 'Excel to PDF',
    description: 'Convert XLSX, XLS and ODS spreadsheets into tabulated pages',
    icon: '📊',
    category: 'convert-to',
    keywords: ['xlsx', 'xls', 'ods', 'spreadsheet', 'workbook'],
    multiFile: true,
    inputKind: 'office',
    accept: '.xlsx,.xlsm,.xls,.ods,.ots,.csv',
    surface: 'none',
    outputSuffix: '_from_excel.pdf',
    actionLabel: 'Tabulate',
    promise: 'Every worksheet as a real table, header row repeated, page-broken down the rows.',
    notes: [
      ...TEXT_NOTES,
      'Cells are printed as their last-saved values. Formulas are not re-evaluated, so a workbook whose cached values are stale prints stale numbers.',
      'Formatting is lost: number and date formats, fonts, fills, borders, conditional formatting, merged cells, freeze panes, charts, pivot tables and images are not reproduced.',
      'Column widths are recomputed to fit the page, which reflows a wide sheet instead of honouring the original print area.',
      'Legacy binary .xls is read by the bundled SheetJS build; a .xls written by a newer engine may lose the sheets it cannot parse, which is reported.',
    ],
    fields: [
      PAGE_FIELD,
      ORIENTATION_FIELD,
      { key: 'fontSize', label: 'Font size', type: 'number', default: 8, min: 5, max: 16, step: 1, integer: true, unit: 'pt', half: true, group: 'Typography', help: 'Spreadsheets are wide: 8 pt is the largest size that usually keeps a sheet on one page.' },
      { key: 'allSheets', label: 'Every worksheet', type: 'toggle', default: true, group: 'Sheets',
        help: 'Off converts only the workbook’s active sheet, which is not necessarily the one you were looking at.',
      },
    ],
    async run(context) {
      const inputs = await sourceBatches(context, {
        kinds: ['zip', 'ole', 'text', 'binary'],
        label: 'an XLSX, XLS, ODS or CSV workbook',
      });
      const { tableBlock } = await import('../core/layout');
      const blocks: Block[] = [];
      const warnings: string[] = [
        'Values are printed as the workbook last saved them: formulas are not re-evaluated and no recalculation happens.',
        'Merged cells, number and date formats, fills, borders, conditional formatting, charts, pivot tables and embedded images are dropped.',
      ];
      let sheetCount = 0;
      for (const input of inputs) {
        const lower = input.name.toLowerCase();
        if (lower.endsWith('.ods') || lower.endsWith('.ots')) {
          const { odsToBlocks } = await import('../core/office-in');
          const sheetBlocks = await odsToBlocks(input.bytes);
          blocks.push(...sheetBlocks);
          sheetCount += countSheetHeadings(sheetBlocks);
          continue;
        }
        const XLSX = await import('xlsx');
        let workbook;
        try {
          workbook = XLSX.read(input.bytes, { type: 'array', cellDates: true });
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'it could not be parsed';
          throw new ToolInputError('CORRUPT', `"${input.name}" is not a readable spreadsheet: ${reason}.`, {
            fileName: input.name,
            hint: sniffSource(input.bytes, input.name).kind === 'ole'
              ? 'This looks like a legacy .xls written by a new engine — re-save it as .xlsx.'
              : 'Re-save it as .xlsx and try again.',
          });
        }
        const sheets = booleanValue(context.values, 'allSheets', true)
          ? workbook.SheetNames
          : workbook.SheetNames.slice(0, 1);
        if (!booleanValue(context.values, 'allSheets', true) && workbook.SheetNames.length > 1) {
          warnings.push(`Only the first of ${workbook.SheetNames.length} sheets in "${input.name}" was printed.`);
        }
        if (inputs.length > 1) blocks.push({ kind: 'heading', level: 1, inlines: [{ text: input.name }] });
        for (const name of sheets) {
          const rows = (XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }) ?? []) as string[][];
          if (rows.length === 0) {
            warnings.push(`Sheet "${name}" in "${input.name}" is empty and was skipped.`);
            continue;
          }
          sheetCount += 1;
          blocks.push({ kind: 'heading', level: 2, inlines: [{ text: inputs.length > 1 ? `${input.name} · ${name}` : name }] });
          blocks.push(tableBlock(rows));
        }
        if (workbook.SheetNames.length > sheets.length) {
          context.log(`${input.name}: ${workbook.SheetNames.length - sheets.length} sheet(s) not included.`);
        }
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'That workbook had no readable sheets.', {
          hint: 'Chartsheets, pivot caches and macro-only sheets carry no cells to print.',
        });
      }
      warnings.push(`${sheetCount} sheet(s) were laid out on the page width; the original print area and column widths are not preserved.`);
      return blocksResult(blocks, layoutOptions(context), `Converted ${sheetCount} worksheet(s) into`, warnings);
    },
  },

  {
    id: 'powerpoint-to-pdf',
    name: 'PowerPoint to PDF',
    description: 'Convert PPTX, PPT and ODP slides into pages',
    icon: '📽️',
    category: 'convert-to',
    keywords: ['pptx', 'ppt', 'odp', 'slides', 'presentation'],
    multiFile: true,
    inputKind: 'office',
    accept: '.pptx,.ppt,.odp',
    surface: 'none',
    outputSuffix: '_from_slides.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'One PDF page per slide, with the slide text as selectable text at the aspect you pick.',
    notes: [
      ...TEXT_NOTES,
      'Slides are rebuilt, not traced: every text frame is read, but its position, the theme, master layouts, SmartArt, charts, animations, embedded video and pictures are not reproduced.',
      'The page uses the aspect ratio you choose rather than the deck’s own slide size, so exact overlap of the original is not claimed.',
      'Legacy binary .ppt needs the optional LibreOffice module, which is not bundled; the refusal names it.',
    ],
    fields: [
      {
        key: 'slideSize',
        label: 'Slide aspect',
        type: 'select',
        default: '16:9',
        group: 'Slide',
        help: 'The output page shape, not the deck’s own: pick the aspect the slides were authored in or the re-flow shifts everything.',
        options: [
          { value: '16:9', label: '16:9 (960 × 540)' },
          { value: '4:3', label: '4:3 (720 × 540)' },
        ],
      },
      { key: 'margin', label: 'Margin', type: 'number', default: 28, min: 0, max: 144, step: 1, integer: true, unit: 'pt', group: 'Slide', help: 'White space kept around each slide so a printed copy is not edge-to-edge ink.' },
      { key: 'notes', label: 'Include speaker notes', type: 'toggle', default: false, group: 'Output', help: 'Off prints the slides only. On adds a page of speaker notes under each slide that has them.' },
    ],
    async run(context) {
      const inputs = await sourceBatches(context, {
        kinds: ['zip', 'ole'],
        label: 'a PPTX or ODP presentation',
      });
      const blocks: Block[] = [];
      let route = '';
      const warnings = [
        'Slide geometry is approximate: text frames are read in order, but their position, theme, masters, SmartArt, charts, animations and pictures are not reproduced.',
      ];
      if (!booleanValue(context.values, 'notes')) {
        warnings.push('Speaker notes were left out because Include speaker notes is off.');
      }
      for (const input of inputs) {
        const lower = input.name.toLowerCase();
        if (lower.endsWith('.odp') || lower.endsWith('.otp')) {
          const { odpToBlocks } = await import('../core/office-in');
          blocks.push(...(await odpToBlocks(input.bytes)));
          route = mergeRoute(route, 'OpenDocument reader');
        } else if (lower.endsWith('.pptx') || lower.endsWith('.pptm') || sniffSource(input.bytes, input.name).kind === 'zip') {
          const { pptxToBlocks } = await import('../core/office-in');
          blocks.push(...(await pptxToBlocks(input.bytes, { notes: booleanValue(context.values, 'notes') })));
          route = mergeRoute(route, 'OOXML reader');
        } else {
          await convertWithLibreOffice(context, input.bytes, input.name, 'pdf');
        }
        if (!blocks.some((block) => block.kind !== 'pagebreak')) {
          throw new ToolInputError(
            'UNSUPPORTED',
            `"${input.name}" has no text frames this reader can see, so every slide would come out blank.`,
            { fileName: input.name, hint: 'If the deck is only images or SmartArt, export it to PDF from PowerPoint instead.' },
          );
        }
      }
      const [width, height] = stringValue(context.values, 'slideSize', '16:9') === '4:3' ? [720, 540] : [960, 540];
      const margin = clampNumber(numberValue(context.values, 'margin', 28), 0, 144);
      warnings.push(`Every slide is drawn on a ${width} × ${height} pt page, which is the aspect you chose rather than the deck’s own slide size.`);
      return blocksResult(
        blocks,
        { pageSize: [width, height], margin, baseFontSize: 14 },
        `Converted ${inputs.length} presentation(s) via ${route} into`,
        warnings,
      );
    },
  },

  {
    id: 'epub-to-pdf',
    name: 'EPUB to PDF',
    description: 'Reflow an ebook into a paginated PDF',
    icon: '📖',
    category: 'convert-to',
    keywords: ['ebook', 'book', 'mobi', 'fb2', 'reader'],
    multiFile: true,
    inputKind: 'office',
    accept: '.epub,.fb2',
    surface: 'none',
    outputSuffix: '_from_epub.pdf',
    actionLabel: 'Reflow',
    promise: 'The book’s text, in spine order, re-typeset on the page size you choose.',
    notes: [
      ...TEXT_NOTES,
      'EPUB is re-flowed, never imitated: the page count is yours, not the book’s, and printed page numbers from the source are not carried over.',
      'Embedded images, CSS styling, custom fonts, footnotes pop-ups, media overlays and DRM are not applied. A DRM’d book reads as no chapters at all and is reported.',
      'MOBI and AZW are PalmDB containers that need a converter BrowserSnip does not bundle; FB2 is read by the FictionBook route.',
    ],
    fields: [
      PAGE_FIELD,
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 7, max: 20, step: 1, integer: true, unit: 'pt', half: true, group: 'Typography',
        help: 'Body text size for the re-flowed book. The chapter text is laid out again, not copied at its original size.',
      },
      { key: 'margin', label: 'Margin', type: 'number', default: 64, min: 0, max: 144, step: 1, integer: true, unit: 'pt', half: true, group: 'Page', help: 'Generous by default: a re-flowed book needs a thumb margin more than it needs the space.' },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true, group: 'Page',
        help: 'Numbers the sheets this converter produces, which will not match the page numbers of a printed book.',
      },
    ],
    async run(context) {
      const inputs = await sourceBatches(context, {
        kinds: ['zip', 'text'],
        label: 'an EPUB or FB2 ebook',
        hint: 'MOBI and AZW are PalmDB files: re-save as EPUB (Calibre does it in one click), which is converted in this tab.',
      });
      const blocks: Block[] = [];
      const warnings: string[] = [
        'Images, CSS, embedded fonts and footnotes in the book are not reproduced — the text and chapter order are.',
      ];
      for (const input of inputs) {
        const lower = input.name.toLowerCase();
        const { epubToBlocks, ebookToBlocks } = await import('../core/office-in');
        blocks.push(...(lower.endsWith('.fb2')
          ? await ebookToBlocks(input.bytes, input.name)
          : await epubToBlocks(input.bytes)));
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'No readable chapters were found in that ebook.', {
          hint: 'A DRM-protected EPUB decrypts to nothing here; remove the DRM or re-export the book.',
        });
      }
      return blocksResult(blocks, layoutOptions(context), `Reflowed ${inputs.length} ebook(s) into`, warnings);
    },
  },

  {
    id: 'email-to-pdf',
    name: 'Email to PDF',
    description: 'Convert EML and MSG files into a printable PDF',
    icon: '✉️',
    category: 'convert-to',
    keywords: ['eml', 'msg', 'message', 'outlook'],
    multiFile: true,
    inputKind: 'office',
    accept: '.eml,.msg',
    surface: 'none',
    outputSuffix: '_from_email.pdf',
    actionLabel: 'Print',
    promise: 'Headers, body and an attachment list as selectable text, one message after another.',
    notes: [
      ...TEXT_NOTES,
      'Attachments are listed by name, type and size — they are not extracted to files and are not embedded in the PDF.',
      'HTML bodies go through the same structural reader as HTML to PDF: inline styles are kept, CSS layout is not.',
      'Quoted-printable and base64 bodies and UTF-8 headers are decoded; images referenced by `cid:` cannot be resolved from the file and are dropped.',
      'Outlook .msg is a compound-binary container that needs the optional LibreOffice module, which is not bundled — forward as .eml instead.',
    ],
    fields: [
      PAGE_FIELD,
      MARGIN_FIELD,
      { key: 'includeAttachments', label: 'List attachments', type: 'toggle', default: true, group: 'Page',
        help: 'Names and sizes of the enclosed files are printed at the end; their contents are never read or uploaded.',
      },
    ],
    async run(context) {
      const inputs = await sourceBatches(context, {
        kinds: ['text', 'ole'],
        label: 'an EML message',
        hint: 'Save the message as .eml (Outlook: Save As → .eml); .msg is compound-binary and needs LibreOffice.',
      });
      const blocks: Block[] = [];
      const warnings: string[] = [
        'Attachments are listed, not extracted: any file inside the message has to be saved separately.',
      ];
      for (const input of inputs) {
        if (input.name.toLowerCase().endsWith('.msg')) {
          throw new ToolInputError(
            'UNSUPPORTED',
            `"${input.name}" is an Outlook MSG (a compound-binary container), not an EML file.`,
            {
              fileName: input.name,
              hint: 'Forward the message as .eml, which BrowserSnip reads entirely in the tab. MSG needs the LibreOffice module, which is not bundled.',
            },
          );
        }
        const { emailToBlocks } = await import('../core/office-in');
        const messageBlocks = await emailToBlocks(input.bytes, input.name, {
          attachments: booleanValue(context.values, 'includeAttachments', true),
        });
        if (inputs.length > 1 && blocks.length > 0) blocks.push({ kind: 'pagebreak' });
        blocks.push(...messageBlocks);
        if (/<img[^>]+src="cid:/i.test(decodeText(input.bytes).text)) {
          warnings.push(`"${input.name}" references inline images by cid: URL; those pixels are not resolved and print as gaps.`);
        }
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'Those messages had no readable body.', {
          hint: 'A message with only a signature block may parse to nothing; open the .eml in a text editor to check.',
        });
      }
      return blocksResult(blocks, layoutOptions(context), `Printed ${inputs.length} message(s) into`, warnings);
    },
  },

  {
    id: 'digitize-document',
    name: 'Digitize Document',
    description: 'OCR a photo of a page into a clean, searchable PDF',
    icon: '📑',
    category: 'convert-to',
    keywords: ['ocr', 'scan', 'photo to pdf', 'recognise'],
    multiFile: true,
    inputKind: 'image',
    accept: 'image/*,.heic,.tif,.tiff',
    surface: 'custom',
    outputSuffix: '_digitized.pdf',
    actionLabel: 'Recognise text',
    promise: 'Your page image kept at full quality with a real, invisible text layer written on top — selectable and searchable.',
    notes: [
      'The recogniser is the bundled ONNX model running in this tab; nothing is uploaded.',
      'OCR output is selectable text, but it is machine-read: expect errors in small print, handwriting, tables and low-contrast scans, and no recovery of fonts, colours or layout.',
      'The page image is not downscaled or deskewed — only the optional white-point pass touches it — and it is embedded as PNG, so the PDF is at least as large as the scan.',
      'The Language control is a hint for the status line: the bundled model is dictionary-driven and recognises scripts without a language switch.',
      'The first run downloads the recognition models; after that they are cached for the session.',
    ],
    fields: [
      PAGE_FIELD,
      { key: 'language', label: 'Language', type: 'select', default: 'en', group: 'Recognition', options: [
        { value: 'en', label: 'English' }, { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' },
        { value: 'fr', label: 'French' }, { value: 'zh', label: 'Chinese' }, { value: 'ja', label: 'Japanese' },
      ],
        help: 'Recorded on the status line and in the report. The bundled model is dictionary-driven and reads the scripts it was trained on without a switch, so this does not change what it finds.',
      },
      { key: 'keepImage', label: 'Keep the page image and add an invisible text layer', type: 'toggle', default: true, group: 'Recognition',
        help: 'On keeps the page looking exactly like the scan, with the words hidden underneath for searching and selecting.',
      },
      { key: 'enhance', label: 'Composite onto white before recognising', type: 'toggle', default: true, group: 'Recognition',
        help: 'Whitens the page background. Skew is not corrected.' },
      { key: 'margin', label: 'Margin', type: 'slider', default: 20, min: 0, max: 72, step: 1, unit: 'pt', group: 'Page', help: 'Space kept around the text so a recognised page does not run into the trim.' },
    ],
    async run(context) {
      const warnings: string[] = [];
      const enhance = booleanValue(context.values, 'enhance', true);
      const { images } = await decodeImageBatch(context, {
        label: 'one or more photos or scans',
        hint: 'Add a JPG, PNG, WEBP, TIFF, HEIC or BMP page.',
        background: enhance ? '#ffffff' : undefined,
      });
      if (enhance) warnings.push('Pages were composited onto a white background; skew and perspective are not corrected.');
      else warnings.push('No image preparation was applied, so a skewed or shadowed scan may recognise poorly.');
      const packed = await pdfFromImages(
        images.map((image) => ({ data: image.canvas })),
        {
          pageSize: stringValue(context.values, 'pageSize', 'a4'),
          margin: clampNumber(numberValue(context.values, 'margin', 20), 0, 144),
        },
      );
      if (!booleanValue(context.values, 'keepImage', true)) {
        return {
          ...(await pdfResult(packed.doc, {
            message: `${images.length} page(s) converted to an image-only PDF.`,
          })),
          warnings: [...warnings, 'OCR was skipped: no page has a text layer, so nothing in this PDF is selectable or searchable.'],
        };
      }
      const { openRender } = await import('../core/render');
      const { ocrDocument, addSearchableTextLayer } = await import('../core/ocr');
      const { openPDF } = await import('../core/doc');
      const bytes = await savePDF(packed.doc);
      let session: Awaited<ReturnType<typeof openRender>> | undefined;
      let results: Awaited<ReturnType<typeof ocrDocument>>;
      try {
        session = await openRender(bytes);
        results = await ocrDocument(session, {
          dpi: 300,
          lang: stringValue(context.values, 'language', 'en'),
          signal: context.signal,
          onProgress: (done, total) => context.progress(done / total, `Read page ${done} of ${total}`),
        });
      } catch (error) {
        await session?.destroy().catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        // E10/E20: the pictures are still a useful PDF, but saying so beats
        // reporting a digitised document with no text anywhere in it.
        return {
          ...(await pdfResult(packed.doc, {
            message: `${images.length} page(s) placed as images; the recogniser did not run, so there is no text layer.`,
          })),
          warnings: [
            ...warnings,
            `OCR failed: ${reason}`,
            'The output is images only — no page has selectable or searchable text.',
          ],
        };
      }
      // The text layer is written onto a document re-opened from those bytes, not
      // onto `packed.doc`: this pdf-lib fork leaves a page pointing at the stream it
      // already serialised, so operators pushed after a `save()` never reach the next
      // one — which is how a "digitised" PDF shipped with no text in it at all.
      const layered = await openPDF(bytes);
      const added = await addSearchableTextLayer(layered, results, { invisible: true });
      await session.destroy();
      // E10: "no text" is three findings, not one — a sheet with nothing on it, a
      // sheet whose ink is not letters, and a page this run never measured. The
      // split comes from `core/ocr`'s reading of the **painted** bitmap; one
      // sentence used to cover all three (measured on a sheet 84.40 % covered in
      // grey and a sheet of bare paper).
      warnings.push(...silentPageWarnings(results));
      const skipped = results.filter((result) => result.alreadySearchable).length;
      if (skipped > 0) warnings.push(`${skipped} page(s) already had a text layer and were left untouched.`);
      const digitised = added.words > 0
        ? `${images.length} page(s) digitised with ${added.words} recognised words on ${added.pages} page(s) behind the images — now selectable and searchable.`
        : `${images.length} page(s) placed as images: the recogniser found no words, so nothing in this PDF is selectable.`;
      return {
        ...(await pdfResult(layered, {
          message: digitised,
        })),
        warnings,
      };
    },
  },
];

/* --------------------------------------------------------------- internals */

const sniffArchiveHint =
  'A .cbz is a ZIP archive: re-save the RAR-based .cbr as ZIP, or extract its images and use Images to PDF.';

/** Merge a route label into the “converted via …” sentence without repeats. */
function mergeRoute(current: string, next: string): string {
  return current.includes(next) ? current : current ? `${current} + ${next}` : next;
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Decode a `data:` URL to bytes; anything remote returns null. */
async function readDataUrl(src: string): Promise<Uint8Array | null> {
  if (!src.startsWith('data:')) return null;
  const [, meta] = src.split(',');
  if (!meta) return null;
  try {
    const binary = atob(meta);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * DOCX through mammoth, with images kept only when they are inline.
 *
 * The browser bundle has no shipped type declarations and its `imgElement`
 * helper is a builder object, so the surface actually used is narrowed here
 * rather than typed as `any`.
 */
async function docxToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const mammoth = await import('mammoth/mammoth.browser');
  const { htmlToBlocks } = await import('../core/layout');
  // SAFETY: `mammoth/mammoth.browser` ships no declarations; these are the two
  // members the UMD export really provides (verified against mammoth 1.13).
  const api = (mammoth.default ?? mammoth) as unknown as {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }, options: unknown) => Promise<{ value: string }>;
    imgElement?: { attributes: (attrs: Record<string, string>) => unknown };
  };
  const result = await api.convertToHtml(
    { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer },
    {
      convertImage: api.imgElement?.attributes({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }),
    },
  );
  return htmlToBlocks(result.value);
}

/**
 * Decode every image the tool was given, refusing per file (E1, E2, E7).
 *
 * A browser that cannot decode HEIC is a fact about the engine, not a bug in
 * the file, so the message names the file and the format instead of throwing a
 * decode stack.
 *
 * `refused`, when given, is where a rejected file's sentence goes while the
 * rest of the batch is still decoded; the caller puts those lines on the result
 * card. A batch of nothing but wrong-format files still fails, with every name.
 *
 * A refusal is pushed and *not* also logged: the runner promotes a logged line
 * containing "could not" into `warnings`, so the same sentence reached the card
 * twice — `"cut.bmp" could not be decoded: … — left out.` under
 * `cut.bmp was left out: "cut.bmp" could not be decoded: …` — while a
 * wrong-format refusal, whose sentence has no such word, printed once. The
 * progress line below names the file for the log reader.
 */
/**
 * Note an animated WebP for the card — the frames past the first are not in the
 * file, and a reader of the page cannot tell.
 *
 * Pulled out of `decodeImageBatch` so the loop keeps one statement rather than
 * three branches; `webpFrameCount` answers `1` for a still, so nothing else needs
 * a format test.
 */
function collectNotice(
  notices: string[] | undefined,
  mime: string | undefined,
  bytes: Uint8Array,
  name: string,
): void {
  if (!notices || mime !== 'image/webp') return;
  const frames = webpFrameCount(bytes);
  if (frames > 1) {
    notices.push(`"${name}" is an animated WebP with ${frames} frames — only the first one is on its page, and the PDF will not play the rest.`);
  }
}

/**
 * The format words for a tool's accepted MIME list, for "…is a JPEG image, not …".
 *
 * Two MIME types can name one format, and the family's HEIC list holds both, so a
 * plain join printed "not a HEIC/HEIF image or a HEIF image" on the dev build. A
 * label contained in another one is dropped.
 */
function advertisedFormats(mimes: string[]): string {
  const labels = mimes.map((type) => IMAGE_LABELS[type] ?? type);
  // Compared without the leading article: the shared labels are "a HEIC/HEIF image"
  // and "a HEIF image", and the article alone stops one being a substring.
  const bare = (line: string) => line.replace(/^(a|an) /, '');
  return labels
    .filter((line) => !labels.some((other) => other !== line && bare(other).includes(bare(line))))
    .join(' or ');
}

/**
 * The remedy each variant gate hands the user, and the refusals it prints.
 *
 * The sentences end in a fact about the file, not advice: a refusal collected
 * into `refused` gains "— left out." after them, and a single-file run adds its
 * hint underneath, so advice inside the sentence would print twice with
 * different punctuation.
 */
const BMP_RLE4_HINT = 'Re-save it as an uncompressed BMP, or as PNG or JPEG, then try again.';
const TIFF_VARIANT_HINT = 'Re-save the file uncompressed or with LZW/Deflate coding, or as PNG or JPEG, then try again.';

/**
 * RLE4 in header terms: a BMP whose `biCompression` says 4-bit run-length.
 *
 * Only 40-byte-and-up headers are judged — an OS/2 12-byte header carries no
 * compression field at all, and guessing about a coding the browser answers
 * blank is worse than the blank. Same rule the shared BMP length reader uses:
 * a refusal only on what the file's own header states.
 */
function bmpVariantProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length < 34 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(14, true) < 40) return null;
  if (view.getUint32(30, true) !== 2) return null;
  return `"${name}" is a 4-bit run-length BMP, which this browser decodes to an empty picture — its page would come out blank (measured on Chrome for Testing 151 on Linux).`;
}

/**
 * The two misdecoded TIFF codings in header terms: tag 259 (Compression) 6/7
 * and tag 284 (PlanarConfiguration) 2, on any page of the file.
 *
 * Classic TIFF (version 42) only, walked defensively: a chain that runs off
 * the end returns `null` so the decoder still gets its try — the file is only
 * refused on tags it actually states. Tiled or stripped makes no difference:
 * the two bad codings are wrong either way.
 */
function tiffVariantProblem(name: string, bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(2) !== 42) return null;
  let at = u32(4);
  for (let guard = 0; guard < 128 && at + 2 <= bytes.length; guard += 1) {
    const count = u16(at);
    const table = at + 2;
    for (let i = 0; i < count; i += 1) {
      const entry = table + i * 12;
      if (entry + 12 > bytes.length) return null;
      const tag = u16(entry);
      if (u16(entry + 2) !== 3) continue; // the two tags are SHORT-valued
      const value = u16(entry + 8);
      if (tag === 259 && (value === 6 || value === 7)) {
        return `"${name}" keeps its picture as JPEG inside the TIFF, which this app’s TIFF reader colours wrongly (measured against the same file opened by other decoders).`;
      }
      if (tag === 284 && value === 2) {
        return `"${name}" keeps its colour planes in separate strips (planar configuration 2), which this app’s TIFF reader reassembles wrongly (measured against the same file opened by other decoders).`;
      }
    }
    const nextAt = table + count * 12;
    if (nextAt + 4 > bytes.length) return null;
    at = u32(nextAt);
    if (at === 0) return null;
  }
  return null;
}

/**
 * The hint a refused batch raises with.
 *
 * A batch can be refused file by file for different reasons and the raised
 * sentence carries one hint, so a decode failure outranks a wrong format: it is
 * the one the batch cannot get around by renaming anything.
 */
function refusedHint(
  expected: { hint?: string; decodeHint?: string },
  decodeRefused: boolean,
): string | undefined {
  return (decodeRefused ? expected.decodeHint : undefined) ?? expected.hint;
}

async function decodeImageBatch(
  context: ToolRunContext,
  expected: {
    kinds?: SourceKind[];
    label: string;
    hint?: string;
    background?: string;
    /**
     * The hint for "this browser cannot open that picture", when it differs from
     * the one for "that is not the format this tool takes".
     *
     * The two failures have different remedies and the family used to hand both
     * the same line: on `heic-to-pdf` a real HEIC came back "Re-save the file as
     * HEIC", which is what the file already is.
     */
    decodeHint?: string;
    expectLabel?: string;
    /** MIME types a format-specific tool will actually accept (E2). */
    mimes?: string[];
    /** Collect refusals here instead of throwing on the first one. */
    refused?: string[];
    /** Collect facts about a file that made it through, for the card. */
    notices?: string[];
  },
): Promise<{ images: DecodedImage[]; refused: string[] }> {
  const refused = expected.refused ?? [];
  // Every file in a batch can be refused for a different reason, but the raised
  // sentence carries one hint: once a decode has failed, the decode remedy is the
  // one that applies to the batch (see `refusedHint`).
  let decodeRefused = false;
  const batches = await sourceBatches(context, {
    kinds: expected.kinds ?? ['image', 'svg', 'psd'],
    label: expected.label,
    hint: expected.hint,
  }, expected.refused);
  const images: DecodedImage[] = [];
  for (const [index, batch] of batches.entries()) {
    throwIfAborted(context.signal);
    const mime = sniffImageMime(batch.bytes) ?? undefined;
    if (expected.mimes && mime && !expected.mimes.includes(mime)) {
      const wanted = advertisedFormats(expected.mimes);
      const sentence = `"${batch.name}" is ${IMAGE_LABELS[mime] ?? `an ${mime} image`}, not ${wanted}.`;
      const hint = 'Re-save it in the advertised format, or use Images to PDF, which takes anything this browser can decode.';
      if (!expected.refused) throw new ToolInputError('UNSUPPORTED', sentence, { fileName: batch.name, hint });
      refused.push(`${sentence.replace(/\.$/, '')} — left out.`);
      context.progress(((index + 1) / batches.length) * 0.4, `Left out ${batch.name}`);
      continue;
    }
    // One push only: `collectNotice` is this call's own extraction out of the
    // loop, but the block it was pulled out of stayed behind, and the animated
    // note reached the tool result twice (hidden from the card only by the
    // runner's `new Set`).
    collectNotice(expected.notices, mime, batch.bytes, batch.name);
    // Codings whose decode is known-wrong here — a blank page (RLE4) or wrong
    // colours (JPEG-in-TIFF, planar 2) — are refused on the header before the
    // decoder is asked, so a success count can never print over bad pixels.
    const variant = mime === 'image/tiff'
      ? tiffVariantProblem(batch.name, batch.bytes)
      : mime === 'image/bmp'
        ? bmpVariantProblem(batch.name, batch.bytes)
        : mime === 'image/vnd.adobe.photoshop'
          ? psdCompositeProblem(batch.name, batch.bytes)
          : null;
    if (variant) {
      decodeRefused = true;
      if (!expected.refused) {
        throw new ToolInputError('UNSUPPORTED', variant, {
          fileName: batch.name,
          hint: expected.decodeHint ?? 'Re-save it as PNG or JPEG, or use a converter for its real format.',
        });
      }
      refused.push(`${variant.replace(/\.$/, '')} — left out.`);
      context.progress(((index + 1) / batches.length) * 0.4, `Left out ${batch.name}`);
      continue;
    }
    let pages;
    try {
      pages = await decodeImagePages(batch.bytes, { mime, background: expected.background });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'this browser could not decode it';
      const sentence = `"${batch.name}" could not be decoded: ${reason}`;
      const hint = expected.decodeHint
        ?? 'Re-save it as PNG or JPEG, or use a converter for its real format.';
      decodeRefused = true;
      if (!expected.refused) {
        throw new ToolInputError('UNSUPPORTED', sentence, { fileName: batch.name, hint, detail: error });
      }
      refused.push(`${sentence.replace(/\.$/, '')} — left out.`);
      context.progress(((index + 1) / batches.length) * 0.4, `Left out ${batch.name}`);
      continue;
    }
    context.log(`${batch.name} — ${pages.length} page(s), ${mime ?? 'unknown format'}`);
    context.progress(((index + 1) / batches.length) * 0.4, `Decoded ${batch.name}`);
    images.push(...pages);
  }
  if (images.length === 0) {
    // Nothing survived: the refusal that was collected is the answer, not a
    // generic sentence about the count — for one file it is exactly the sentence
    // the throw-first path used to raise, name and all.
    const both = refused
      .map((line) => line.replace(/\s*—\s*left out\.$/, '.'))
      .filter((line) => line !== '');
    if (both.length > 0) {
      throw new ToolInputError('UNSUPPORTED', both.join(' '), {
        hint: refusedHint(expected, decodeRefused),
      });
    }
    throw new ToolInputError('UNSUPPORTED', `No readable ${expected.expectLabel ?? 'image'} was added.`, {
      hint: expected.hint,
    });
  }
  return { images, refused };
}

/**
 * Place the packed pages two per sheet.
 *
 * `pdfFromImages` is one image per page by design, so the pair-up happens on the
 * finished pages: each sheet gets two source pages scaled into halves of it,
 * which keeps the original pixels and only changes geometry.
 *
 * The packed document is serialised and reopened first. `embedPage` copies a
 * page's objects into the target and keeps the ref it was handed for the copied
 * form; on a document that was never written, the copier allocates its objects
 * out of the same number space, that form ref is never assigned, and the sheet
 * draws `/EmbeddedPdfPage-… Do` at an object absent from the xref — measured on
 * this build, one page of `/Subtype /Form` with no image a reader could follow,
 * 0 ink px rendered, and MuPDF reporting “cannot find object in xref”. A loaded
 * source numbers its objects itself, so the copied refs resolve.
 */
async function twoUp(
  source: Awaited<ReturnType<typeof pdfFromImages>>['doc'],
  sheet: string | undefined,
  margin: number,
): Promise<Awaited<ReturnType<typeof pdfFromImages>>['doc']> {
  const [sheetWidth, sheetHeight] = pageSize(sheet ?? 'a4', false);
  const target = await newPDF();
  const pages = (await openPDF(await savePDF(source), { updateMetadata: false })).getPages();
  for (let index = 0; index < pages.length; index += 2) {
    const page = target.addPage([sheetWidth, sheetHeight]);
    const usableWidth = sheetWidth - margin * 2;
    const usableHeight = (sheetHeight - margin * 3) / 2;
    await drawPageInto(target, page, pages[index], {
      x: margin, y: margin * 2 + usableHeight, width: usableWidth, height: usableHeight,
    });
    if (pages[index + 1]) {
      await drawPageInto(target, page, pages[index + 1], {
        x: margin, y: margin, width: usableWidth, height: usableHeight,
      });
    }
  }
  return target;
}

/** Count the worksheet headings among OpenDocument spreadsheet blocks. */
function countSheetHeadings(blocks: Block[]): number {
  return blocks.filter((block) => block.kind === 'heading').length;
}

/** `{"a":{"b":1}}` → 3. Used to warn when the depth control truncates. */
function depthOf(value: unknown, depth = 1): number {
  if (value === null || typeof value !== 'object') return depth - 1;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return depth;
  return Math.max(...children.map((child) => depthOf(child, depth + 1)));
}

/** NDJSON: one document per non-empty line, else the whole text. */
function splitNdjson(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return [trimmed];
    } catch {
      /* fall through: assume newline-delimited documents */
    }
  }
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines : [trimmed];
}

/**
 * What to say about the pages the recogniser read and found no words on.
 *
 * A page nothing was written on is not one finding: bare paper and a picture are
 * different documents to a user, and the ink the reader measured is what tells
 * them apart. A page whose bitmap was never measured keeps the vaguer sentence
 * rather than borrowing either claim.
 */
function silentPageWarnings(results: readonly OcrPageResult[]): string[] {
  const silent = results
    .filter((result) => !result.alreadySearchable && result.words.length === 0)
    .map((result) => ocrSilentPageOf(result))
    .filter((entry): entry is OcrSilentPage => entry !== null);
  const of = (kind: OcrSilentPage['kind']) => silent.filter((entry) => entry.kind === kind);
  const named = (list: OcrSilentPage[]) => `Page ${list.map((entry) => entry.page).join(', ')}`;
  const measured = (list: OcrSilentPage[]) => list.map((entry) => `${entry.percent?.toFixed(2)} %`).join(', ');
  const out: string[] = [];
  const blank = of('blank');
  if (blank.length > 0) {
    out.push(`${named(blank)} ${blank.length === 1 ? 'is' : 'are'} blank — the rendered ${blank.length === 1 ? 'sheet measures' : 'sheets measure'} ${measured(blank)} ink, so there was nothing on ${blank.length === 1 ? 'it' : 'them'} to read.`);
  }
  const inked = of('unreadable');
  if (inked.length > 0) {
    out.push(`${named(inked)} had no text layer: ${measured(inked)} of the rendered ${inked.length === 1 ? 'page is' : 'pages are'} ink, but the recogniser found no letters on ${inked.length === 1 ? 'it' : 'them'} — a picture, handwriting or a scan too faint to resolve.`);
  }
  const unmeasured = of('unexamined');
  if (unmeasured.length > 0) {
    out.push(`${named(unmeasured)} had no text layer: the recogniser found nothing to write on it.`);
  }
  return out;
}

/**
 * LibreOffice is the only faithful route for legacy binary Office formats.
 * It is not bundled, so the refusal is the product: it names the format, says
 * why, and gives an alternative that works in this tab (E20).
 */
export async function convertWithLibreOffice(
  context: ToolRunContext,
  bytes: Uint8Array,
  name: string,
  target: string,
): Promise<Uint8Array> {
  const { convertOffice, officeReady } = await import('../core/office-in');
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() ?? 'Office';
  if (!officeReady()) {
    throw new ToolInputError(
      'NEEDS_ENGINE',
      `"${name}" is a legacy ${extension} container, and a faithful conversion needs the optional LibreOffice module that BrowserSnip does not bundle (~100 MB of WASM).`,
      {
        fileName: name,
        hint: `Re-save it as DOCX, XLSX or PPTX — those are read entirely in this tab — or export it to ${target.toUpperCase()} from your office suite.`,
      },
    );
  }
  context.progress(0.1, 'Loading the office converter');
  return convertOffice(bytes, name, target, context.progress);
}
