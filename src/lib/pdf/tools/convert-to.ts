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
import { drawPageInto, newPDF, savePDF } from '../core/doc';
import { decodeImage, decodeImagePages, sniffImageMime, type DecodedImage } from '../core/images';
import { pdfFromImages } from '../core/pack';
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
  type ToolResult,
  type ToolRunContext,
  type ToolValues,
} from './types';

type Block = import('../core/layout').Block;
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

/** The word the result card uses for a chosen sheet, taken from the field itself. */
function sheetLabel(value: string): string {
  return SHEET_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

const MARGIN_FIELD = marginField();

const ORIENTATION_FIELD = orientationField();

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
      return 'The bytes do not match any format this tool reads.';
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

/** Files chosen in a `file` field, else the drop-zone inputs, in order. */
async function sourceBatches(
  context: ToolRunContext,
  expected: { kinds: SourceKind[]; label: string; hint?: string },
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
    assertSourceFormat(item.name, item.bytes, expected);
    context.progress(((index + 1) / raw.length) * 0.2, `Read ${item.name} (${describeSize(item.bytes)})`);
    out.push(item);
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

/** Decode bytes as text, honouring a UTF-8/UTF-16 BOM instead of garbling it. */
export function decodeText(bytes: Uint8Array): { text: string; warning?: string } {
  const utf16 = startsWith(bytes, [0xff, 0xfe])
    ? 'UTF-16LE'
    : startsWith(bytes, [0xfe, 0xff])
      ? 'UTF-16BE'
      : null;
  if (utf16) {
    return {
      text: new TextDecoder(utf16).decode(bytes.subarray(2)).replace(/^\uFEFF/, ''),
      warning: `decoded from ${utf16}`,
    };
  }
  const text = new TextDecoder('UTF-8').decode(bytes);
  return { text: text.replace(/^\uFEFF/, '') };
}

/**
 * The text-ish tools share one panel: paste or upload, then lay out.
 *
 * Content that turns out to be another format is refused with that format named
 * (E2), and a whitespace-only source is refused rather than typeset as a blank
 * sheet (E13).
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
    return { sources: [{ name: 'pasted text', text: pasted }], warnings };
  }
  const batches = await sourceBatches(context, expected);
  const sources: { name: string; text: string }[] = [];
  for (const batch of batches) {
    const decoded = decodeText(batch.bytes);
    if (decoded.warning) warnings.push(`"${batch.name}" was ${decoded.warning}.`);
    if (decoded.text.trim() === '') {
      throw new ToolInputError(
        'UNSUPPORTED',
        `"${batch.name}" contains no characters to typeset (${describeSize(batch.bytes)} of whitespace or padding).`,
        { fileName: batch.name, hint: 'Open it in its real editor and re-save, or check the encoding.' },
      );
    }
    sources.push({ name: batch.name, text: decoded.text });
  }
  return { sources, warnings };
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
        help: 'The sheet each picture is placed on. Fit to image sizes the page to the picture instead.',
      },
      { key: 'fit', label: 'Fit', type: 'select', default: 'contain', group: 'Page', options: [
        { value: 'contain', label: 'Fit inside the page' },
        { value: 'cover', label: 'Fill the page (crop)' },
        { value: 'stretch', label: 'Stretch' },
      ],
        help: 'Nothing is cropped unless you ask for it: the picture is scaled down to the page here, cropped by fill, and distorted by stretch.',
      },
      { key: 'orientation', label: 'Orientation', type: 'select', default: 'auto', group: 'Page', help: 'Auto follows each picture’s own shape, so a rotated phone photo lands the way it was taken.', options: [
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
      const images = await decodeImageBatch(context, {
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
      promise: `Every ${label} you add becomes a PDF page, in the order you added them.`,
      notes: [
        `Files whose bytes are not ${label} are refused by name instead of being silently re-encoded.`,
        isTiff
          ? 'Multi-page TIFFs contribute one PDF page per frame, in page order.'
          : `The ${label} pixels are embedded as they decode; no resampling, no sharpening.`,
        RASTER_LOSS,
      ],
      fields: [PAGE_FIELD, MARGIN_FIELD, ORIENTATION_FIELD],
      async run(context) {
        const images = await decodeImageBatch(context, {
          label: `one or more ${label} images`,
          hint: `Re-save the file as ${label}, or use Images to PDF, which sniffs the real format.`,
          expectLabel: `${label} image(s)`,
          mimes: FORMAT_MIMES[format],
        });
        const packed = await pdfFromImages(
          images.map((image) => ({ data: image.canvas })),
          {
            pageSize: stringValue(context.values, 'pageSize', 'a4'),
            margin: clampNumber(numberValue(context.values, 'margin', 0), 0, 144),
            orientation: stringValue(context.values, 'orientation', 'auto') as 'auto',
          },
        );
        return {
          ...(await pdfResult(packed.doc, {
            message: `${images.length} ${label} image(s) → ${packed.pages} page(s).`,
          })),
          warnings: [RASTER_LOSS],
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
      'Animations, filters and external references (`<image href="…">`) are not reproduced.',
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
      'A chosen sheet is turned sideways for artwork wider than it is tall, and the picture is scaled down to fit inside it rather than cropped.',
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
      let files;
      try {
        files = await readZip(input.bytes, {
          filterExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'],
        });
      } catch (error) {
        throw new ToolInputError('CORRUPT', `"${input.name}" is not a readable ZIP archive: ${error instanceof Error ? error.message : 'it could not be opened'}.`, {
          fileName: input.name,
          hint: sniffArchiveHint,
        });
      }
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
          'Non-image entries inside the archive (CBA-style extras, metadata, cover text) were ignored.',
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
      'Long lines are wrapped to the column; hard line breaks in the source are respected.',
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
      const blocks: Block[] = sources.flatMap((source) => textToBlocks(source.text, {
        monospace: booleanValue(context.values, 'monospace'),
        paragraphs: booleanValue(context.values, 'paragraphs', true) ? '\n\n' : '\n',
      }));
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
      'Only `data:` images can be embedded: no network requests are made, so remote image URLs stay as alt text — and a picture written inside a sentence prints its alt text too, because pictures are placed between paragraphs, not between words.',
      'Maths is written out as its LaTeX source in a code face, not typeset — a server engine would run KaTeX.',
      'Footnotes, definition lists and Mermaid diagrams are not rendered.',
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
        blocks.push(...(await markdownToBlocks(source.text, {
          images: async (src) => readDataUrl(src),
        })));
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
      for (const source of sources) {
        skippedImages += countMatches(source.text, /<img[^>]+src="\s*(?!data:)[^"]+"/gi);
        scriptBlocks += countMatches(source.text, /<script[\s>]/gi);
        blocks.push(...(await htmlToBlocks(source.text, {
          fetchImage: embed
            ? async (src) => readDataUrl(src)
            : async () => null,
        })));
      }
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', 'That HTML had no readable body content.', {
          hint: 'Tables, headings, paragraphs, lists and data-URL images are supported; a page that is only a script-written app has none of them.',
        });
      }
      if (!embed) warnings.push('Image embedding is off, so every <img> was skipped.');
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
    surface: 'none',
    outputSuffix: '_from_csv.pdf',
    actionLabel: 'Tabulate',
    promise: 'Every row as a real table row, with the header repeated on each page and columns sized to fit.',
    notes: [
      ...TEXT_NOTES,
      'Cells are text. Number, date and currency formats are whatever the file literally contains — a spreadsheet is not re-evaluated.',
      'Quoted fields, embedded newlines and CRLF are handled; a very wide table is scaled down and may drop to a small type size.',
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
      for (const source of sources) {
        const tableBlocks = await csvToBlocks(source.text, {
          delimiter: delimiter === 'auto' ? undefined : delimiter,
          header: booleanValue(context.values, 'headerRow', true),
        });
        // Counted from the grid that is about to be drawn, so the warning below
        // cannot disagree with the table the user sees.
        for (const block of tableBlocks) {
          if (block.kind !== 'table') continue;
          widest = Math.max(widest, block.header?.length ?? 0, ...block.rows.map((row) => row.length));
        }
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
      return blocksResult(blocks, layoutOptions(context), `Tabulated ${sources.length} file(s) into`, warnings);
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
      const blocks: Block[] = sources.flatMap((source) => xmlToBlocks(source.text));
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
      const images = await decodeImageBatch(context, {
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
      const empty = results
        .filter((result) => !result.alreadySearchable && result.words.length === 0)
        .map((result) => result.page);
      if (empty.length > 0) {
        warnings.push(`Page ${empty.join(', ')} had no text layer: the recogniser found nothing to write on it.`);
      }
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
 */
async function decodeImageBatch(
  context: ToolRunContext,
  expected: {
    kinds?: SourceKind[];
    label: string;
    hint?: string;
    background?: string;
    expectLabel?: string;
    /** MIME types a format-specific tool will actually accept (E2). */
    mimes?: string[];
  },
): Promise<DecodedImage[]> {
  const batches = await sourceBatches(context, {
    kinds: expected.kinds ?? ['image', 'svg', 'psd'],
    label: expected.label,
    hint: expected.hint,
  });
  const images: DecodedImage[] = [];
  for (const [index, batch] of batches.entries()) {
    throwIfAborted(context.signal);
    const mime = sniffImageMime(batch.bytes) ?? undefined;
    if (expected.mimes && mime && !expected.mimes.includes(mime)) {
      const wanted = expected.mimes.map((type) => IMAGE_LABELS[type] ?? type).join(' or ');
      throw new ToolInputError(
        'UNSUPPORTED',
        `"${batch.name}" is ${IMAGE_LABELS[mime] ?? `an ${mime} image`}, not ${wanted}.`,
        {
          fileName: batch.name,
          hint: 'Re-save it in the advertised format, or use Images to PDF, which takes anything this browser can decode.',
        },
      );
    }
    let pages;
    try {
      pages = await decodeImagePages(batch.bytes, { mime, background: expected.background });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'this browser could not decode it';
      throw new ToolInputError('UNSUPPORTED', `"${batch.name}" could not be decoded: ${reason}`, {
        fileName: batch.name,
        hint: `Re-save it as PNG or JPEG, or use a converter for its real format.`,
        detail: error,
      });
    }
    context.log(`${batch.name} — ${pages.length} page(s), ${mime ?? 'unknown format'}`);
    context.progress(((index + 1) / batches.length) * 0.4, `Decoded ${batch.name}`);
    images.push(...pages);
  }
  if (images.length === 0) {
    throw new ToolInputError('UNSUPPORTED', `No readable ${expected.expectLabel ?? 'image'} was added.`, {
      hint: expected.hint,
    });
  }
  return images;
}

/**
 * Place the packed pages two per sheet.
 *
 * `pdfFromImages` is one image per page by design, so the pair-up happens on the
 * finished pages: each sheet gets two source pages scaled into halves of it,
 * which keeps the original pixels and only changes geometry.
 */
async function twoUp(
  source: Awaited<ReturnType<typeof pdfFromImages>>['doc'],
  sheet: string | undefined,
  margin: number,
): Promise<Awaited<ReturnType<typeof pdfFromImages>>['doc']> {
  const [sheetWidth, sheetHeight] = pageSize(sheet ?? 'a4', false);
  const target = await newPDF();
  const pages = source.getPages();
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
