/**
 * Office and ebook formats whose readers already exist in `core/office-in.ts`.
 *
 * The OpenDocument family (ODT/ODS/ODP), XPS and FB2 are all "a zip of XML" or
 * plain XML, so they are decoded and re-laid out in the tab with real selectable
 * text. The remaining legacy containers are registered with an honest
 * `unavailable` reason instead of producing a page that merely looks right:
 * compound-file and PalmDB formats need a full office-suite decoder, and
 * BrowserSnip does not bundle LibreOffice's ~100 MB of WASM.
 *
 * These tools do *not* open their input through `openInputs`: that gate decides
 * whether bytes are a usable PDF (E1–E5), and an ODT is never one. They use the
 * converter-side guard in `tools/convert-to`, which refuses a 0-byte upload and
 * a mislabelled file by naming the format the bytes really are.
 */
import { marginField, orientationField, pageSizeField, ToolInputError, clampNumber } from './helpers';
import {
  blocksResult,
  layoutOptionsFor,
  readPrimarySource,
  type SourceKind,
} from './convert-to';
import {
  booleanValue,
  numberValue,
  stringValue,
  type PdfToolDefinition,
} from './types';

type Block = import('../core/layout').Block;

const PAGE_FIELD = pageSizeField();

const MARGIN_FIELD = marginField();

const ORIENTATION_FIELD = orientationField();

/** What a document must sniff as before the reader is allowed to parse it. */
const OPC: { kinds: SourceKind[]; label: string; hint?: string } = {
  kinds: ['zip'],
  label: 'an OpenDocument package (a ZIP of XML parts)',
  hint: 'A legacy binary .odt written by an old suite, or a file renamed from something else, is not the same container — re-save it as .odt first.',
};

const LAYOUT_LOSS =
  'Text is re-flowed and drawn as selectable PDF text with the app’s own faces: your document’s fonts, exact pagination, headers and footers, footnotes, comments and text-box positions are not preserved.';

/**
 * Drop page breaks that cannot start or end a document.
 *
 * The slide and fixed-page readers emit one break *before* every page, which
 * would open the result with a blank sheet — "one page per slide" shipping two
 * pages for one slide, and an extra empty page on the end.
 */
function trimStrayBreaks(blocks: Block[]): Block[] {
  let from = 0;
  let to = blocks.length;
  while (from < to && blocks[from].kind === 'pagebreak') from += 1;
  while (to > from && blocks[to - 1].kind === 'pagebreak') to -= 1;
  return from === 0 && to === blocks.length ? blocks : blocks.slice(from, to);
}

/** Shared block → PDF tail, so every office route reports pages the same way. */
async function blocksToPdf(
  blocks: Block[],
  values: Parameters<typeof layoutOptionsFor>[0],
  message: string,
  warnings: string[] = [],
) {
  return blocksResult(trimStrayBreaks(blocks), layoutOptionsFor(values), `${message} with selectable text into`, warnings);
}

export const officeTools: PdfToolDefinition[] = [
  {
    id: 'odt-to-pdf',
    name: 'ODT to PDF',
    description: 'Convert OpenDocument Text documents into a PDF with selectable text',
    icon: '📝',
    category: 'convert-to',
    keywords: ['libreoffice', 'opendocument', 'openoffice', 'writer'],
    inputKind: 'office',
    accept: '.odt,.ott',
    surface: 'none',
    outputSuffix: '_from_odt.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'Your ODT’s headings, paragraphs, lists and tables as a paginated PDF with real selectable text.',
    notes: [
      LAYOUT_LOSS,
      'Drawings, charts, embedded spreadsheets, indexes and Master-Page content are skipped; the reader walks the text body.',
      'A 0-byte or renamed file is refused with its real format named, not converted into a blank page.',
    ],
    fields: [PAGE_FIELD, ORIENTATION_FIELD, MARGIN_FIELD],
    async run(context) {
      const input = await readPrimarySource(context, OPC);
      const { odtToBlocks } = await import('../core/office-in');
      const blocks = await odtToBlocks(input.bytes);
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', `"${input.name}" has no text body to convert.`, {
          fileName: input.name,
          hint: 'A drawing-only or chart-only ODT produces nothing here; export it to PDF from LibreOffice.',
        });
      }
      return blocksToPdf(blocks, context.values, `Converted the OpenDocument text file`, [
        LAYOUT_LOSS,
        ...(input.extra > 0 ? [`Only "${input.name}" was converted; this tool handles one document at a time.`] : []),
      ]);
    },
  },

  {
    id: 'ods-to-pdf',
    name: 'ODS to PDF',
    description: 'Convert OpenDocument spreadsheets into tabulated pages',
    icon: '📊',
    category: 'convert-to',
    keywords: ['libreoffice', 'opendocument', 'spreadsheet', 'calc'],
    inputKind: 'office',
    accept: '.ods',
    surface: 'none',
    outputSuffix: '_from_ods.pdf',
    actionLabel: 'Tabulate',
    promise: 'Every sheet as a real table of values, page-broken down the rows, with selectable text.',
    notes: [
      LAYOUT_LOSS,
      'Cell values are printed as the file saved them: formulas are not re-evaluated, and number/date formats, styles, merged cells, charts and conditional formatting are lost.',
      'Columns are re-sized to the page, so a wide sheet reflows instead of keeping the original print range.',
    ],
    fields: [PAGE_FIELD, ORIENTATION_FIELD],
    async run(context) {
      const input = await readPrimarySource(context, OPC);
      const { odsToBlocks } = await import('../core/office-in');
      const blocks = await odsToBlocks(input.bytes);
      if (blocks.length === 0) {
        throw new ToolInputError('UNSUPPORTED', `"${input.name}" has no cells to print.`, {
          fileName: input.name,
          hint: 'Every sheet is empty, or holds only charts.',
        });
      }
      return blocksToPdf(blocks, context.values, 'Converted the OpenDocument spreadsheet', [
        'Values are printed as last saved: no recalculation, and number formats, merged cells, styles and charts are dropped.',
        ...(input.extra > 0 ? [`Only "${input.name}" was converted; this tool handles one document at a time.`] : []),
      ]);
    },
  },

  {
    id: 'odp-to-pdf',
    name: 'ODP to PDF',
    description: 'Convert OpenDocument presentations into one page per slide',
    icon: '📽️',
    category: 'convert-to',
    keywords: ['libreoffice', 'opendocument', 'presentation', 'impress'],
    inputKind: 'office',
    accept: '.odp',
    surface: 'none',
    outputSuffix: '_from_odp.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'One page per slide, with the slide text re-flowed as selectable text at the aspect you pick.',
    notes: [
      LAYOUT_LOSS,
      'Slide geometry is not reproduced: text frames are read in order and re-laid out, so positions, masters, themes, animations, speaker notes and pictures do not survive.',
      'Text is read out of the presentation shapes in `content.xml`; a deck whose slides hold only pictures is refused rather than converted into blank pages.',
      'The output page uses the aspect ratio you choose, not the deck’s own slide size.',
    ],
    fields: [
      {
        key: 'slideSize',
        label: 'Slide aspect',
        type: 'select',
        default: '16:9',
        group: 'Slide',
        help: 'The output page shape, not the deck’s own: the slide text is re-flowed into whatever aspect you choose.',
        options: [
          { value: '16:9', label: '16:9 (960 × 540)' },
          { value: '4:3', label: '4:3 (720 × 540)' },
        ],
      },
      { key: 'margin', label: 'Margin', type: 'number', default: 28, min: 0, max: 144, step: 1, integer: true, unit: 'pt', group: 'Slide', help: 'White border kept around the re-flowed slide text so a printed copy is not edge-to-edge ink.' },
    ],
    async run(context) {
      const input = await readPrimarySource(context, OPC);
      const { odpToBlocks } = await import('../core/office-in');
      const blocks = await odpToBlocks(input.bytes);
      if (!blocks.some((block) => block.kind !== 'pagebreak')) {
        throw new ToolInputError(
          'UNSUPPORTED',
          `"${input.name}" has no text frames this reader can see, so every slide would come out blank.`,
        );
      }
      const [width, height] = stringValue(context.values, 'slideSize', '16:9') === '4:3'
        ? [720, 540]
        : [960, 540];
      const margin = clampNumber(numberValue(context.values, 'margin', 28), 0, 144, { integer: true });
      return blocksResult(
        trimStrayBreaks(blocks),
        { pageSize: [width, height], margin, baseFontSize: 14, lineHeight: 1.4 },
        `Converted the OpenDocument presentation into`,
        [
          'Slide geometry is approximate: text order is kept, positions, masters, themes, animations and pictures are not.',
          `Pages are ${width} × ${height} pt — the aspect you chose, not the deck’s own slide size.`,
        ],
      );
    },
  },

  {
    id: 'xps-to-pdf',
    name: 'XPS to PDF',
    description: 'Convert an XPS or OXPS document into PDF pages',
    icon: '🖨️',
    category: 'convert-to',
    keywords: ['xml paper specification', 'oxps', 'windows', 'print'],
    inputKind: 'office',
    accept: '.xps,.oxps',
    surface: 'none',
    outputSuffix: '_from_xps.pdf',
    actionLabel: 'Convert to PDF',
    promise: 'The text of every fixed page, re-flowed as selectable PDF text.',
    notes: [
      'Text runs are recovered from each page’s `UnicodeString` attributes, so wording and reading order survive.',
      'A package whose text runs this reader cannot see is refused with that said, rather than converted into pages that look fine and contain nothing.',
      'Strokes, gradients, images, exact glyph positioning, embedded fonts and page geometry are not reproduced — a server engine would keep them as vector content.',
      LAYOUT_LOSS,
    ],
    fields: [PAGE_FIELD, ORIENTATION_FIELD, MARGIN_FIELD],
    async run(context) {
      const input = await readPrimarySource(context, {
        kinds: ['zip'],
        label: 'an XPS or OXPS package (a ZIP of fixed-page XML)',
        hint: 'If it is an XML paper file saved uncompressed, print it to PDF from Windows first.',
      });
      const { xpsToBlocks } = await import('../core/office-in');
      const blocks = await xpsToBlocks(input.bytes);
      if (!blocks.some((block) => block.kind !== 'pagebreak')) {
        throw new ToolInputError(
          'UNSUPPORTED',
          `"${input.name}" has no text runs this reader can recover, so every page would come out blank.`,
          { fileName: input.name, hint: 'Print it to PDF in Windows first; XPS to PDF is a text-recovery route, not a pixel-accurate one.' },
        );
      }
      return blocksToPdf(blocks, context.values, 'Converted the XPS document', [
        'Only text runs survive: strokes, gradients, images and exact glyph positions are dropped.',
        ...(input.extra > 0 ? [`Only "${input.name}" was converted; this tool handles one document at a time.`] : []),
      ]);
    },
  },

  {
    id: 'fb2-to-pdf',
    name: 'FB2 to PDF',
    description: 'Convert a FictionBook ebook into a paginated PDF',
    icon: '📚',
    category: 'convert-to',
    keywords: ['fictionbook', 'ebook', 'xml', 'book'],
    inputKind: 'office',
    accept: '.fb2',
    surface: 'none',
    outputSuffix: '_from_fb2.pdf',
    actionLabel: 'Reflow',
    promise: 'The book’s title, chapters and paragraphs re-typeset as a paginated PDF with selectable text.',
    notes: [
      'FB2 is plain XML, so text and chapter order are read without any external converter.',
      'Cover images, epigraphs, verse indentation, footnotes, annotations and binary inclusions are not reproduced.',
      LAYOUT_LOSS,
    ],
    fields: [PAGE_FIELD, MARGIN_FIELD, { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true, group: 'Page',
        help: 'Numbers the sheets this converter produces, which will not match the original book’s pagination.',
      }],
    async run(context) {
      const input = await readPrimarySource(context, {
        kinds: ['text'],
        label: 'an FB2 (FictionBook XML) file',
        hint: 'FictionBook is XML text; an EPUB or MOBI needs the ebook converter instead.',
      });
      const { ebookToBlocks } = await import('../core/office-in');
      const blocks = await ebookToBlocks(input.bytes, input.name);
      return blocksToPdf(blocks, context.values, 'Converted the FictionBook file', [
        'Cover art, footnotes, annotations and verse formatting in the book are not reproduced.',
        ...(booleanValue(context.values, 'pageNumbers') ? [] : ['Page numbers are off.']),
      ]);
    },
  },
];

/**
 * Registered so the capability is discoverable rather than silently absent.
 * `unavailable` is surfaced in the UI and as a clear error from the runner
 * instead of a plausible-looking but wrong conversion (E20).
 */
const LEGACY_ONLY: {
  id: string;
  name: string;
  label: string;
  accept: string;
  hint: string;
}[] = [
  {
    id: 'mobi-to-pdf',
    name: 'MOBI to PDF',
    label: 'MOBI',
    accept: '.mobi,.azw,.azw3',
    hint: 'Re-save the book as EPUB — Calibre exports it directly — which BrowserSnip converts entirely in the tab.',
  },
  {
    id: 'pages-to-pdf',
    name: 'Pages to PDF',
    label: 'Apple Pages',
    accept: '.pages',
    hint: 'In Pages choose File → Export To → PDF. A .pages bundle is a ZIP: if it already holds a PDF, that file is the one to use.',
  },
  {
    id: 'pub-to-pdf',
    name: 'PUB to PDF',
    label: 'Microsoft Publisher',
    accept: '.pub',
    hint: 'Open in LibreOffice or Publisher and save as DOCX or PDF; both convert in the tab.',
  },
  {
    id: 'vsd-to-pdf',
    name: 'VSD to PDF',
    label: 'Microsoft Visio',
    accept: '.vsd,.vsdx',
    hint: 'Export from Visio to PDF, or save the drawing as SVG and use SVG to PDF, which paints the artwork.',
  },
  {
    id: 'wpd-to-pdf',
    name: 'WPD to PDF',
    label: 'WordPerfect',
    accept: '.wpd',
    hint: 'Re-export from Corel WordPerfect or LibreOffice as DOCX or PDF first.',
  },
  {
    id: 'wps-to-pdf',
    name: 'WPS to PDF',
    label: 'Kingsoft Writer',
    accept: '.wps',
    hint: 'Re-save as DOCX in WPS Office, which converts in the tab.',
  },
  {
    id: 'odg-to-pdf',
    name: 'ODG to PDF',
    label: 'OpenDocument Draw',
    accept: '.odg',
    hint: 'Export the drawing as SVG or PNG from LibreOffice Draw and use those converters, which preserve the artwork.',
  },
];

export const legacyOfficeTools: PdfToolDefinition[] = LEGACY_ONLY.map((entry) => ({
  id: entry.id,
  name: entry.name,
  description: `Convert ${entry.label} files to PDF`,
  icon: '🗄️',
  category: 'convert-to' as const,
  keywords: ['office', 'legacy', 'binary format', entry.label.toLowerCase()],
  inputKind: 'office' as const,
  accept: entry.accept,
  surface: 'none' as const,
  outputSuffix: `_${entry.id.replace('-to-pdf', '')}.pdf`,
  promise: `Listed so the capability is findable. ${entry.label} is not converted offline — the notes name a format that is.`,
  actionLabel: 'Convert to PDF',
  notes: [
    `Needs a full office-suite decoder. ${entry.hint}`,
    'Text and images in the container are not read here, so nothing is quietly substituted: the run is refused before any page is written.',
  ],
  unavailable: `${entry.name} is not available offline: the ${entry.label} container needs LibreOffice, which BrowserSnip does not bundle (~100 MB of WASM). ${entry.hint}`,
}));
