/**
 * Office and ebook formats whose readers already exist in `core/office-in.ts`.
 *
 * The OpenDocument family (ODT/ODS/ODP), XPS and FB2 are all "a zip of XML" or
 * plain XML, so they are decoded and re-laid out in the tab with real selectable
 * text. The remaining legacy containers are registered with an honest
 * `unavailable` reason instead of producing a page that merely looks right:
 * compound-file and PalmDB formats need a full office-suite decoder, and
 * BrowserSnip does not bundle LibreOffice's ~100 MB of WASM.
 */
import { savePDF } from '../core/doc';
import { pageSize as resolvePageSize } from '../core/pages';
import { openInputs, pdfResult, rebuildDocument } from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  type PdfToolDefinition,
  type ToolRunContext,
  type ToolValues,
} from './types';

const PAGE_FIELD = {
  key: 'pageSize',
  label: 'Page size',
  type: 'select' as const,
  default: 'a4',
  options: [
    { value: 'a4', label: 'A4' },
    { value: 'letter', label: 'Letter' },
    { value: 'legal', label: 'Legal' },
    { value: 'a3', label: 'A3' },
    { value: 'a5', label: 'A5' },
    { value: 'tabloid', label: 'Tabloid' },
  ],
};

const MARGIN_FIELD = {
  key: 'margin',
  label: 'Margin',
  type: 'slider' as const,
  default: 56,
  min: 0,
  max: 144,
  step: 2,
  unit: 'pt',
};

const ORIENTATION_FIELD = {
  key: 'orientation',
  label: 'Orientation',
  type: 'segmented' as const,
  default: 'portrait',
  options: [
    { value: 'portrait', label: 'Portrait' },
    { value: 'landscape', label: 'Landscape' },
  ],
};

function layoutOptions(values: ToolValues) {
  const size = stringValue(values, 'pageSize', 'a4');
  const landscape = stringValue(values, 'orientation', 'portrait') === 'landscape';
  return {
    pageSize: landscape ? resolvePageSize(size, true) : size,
    margin: numberValue(values, 'margin', 56),
    baseFontSize: numberValue(values, 'fontSize', 11),
    lineHeight: numberValue(values, 'lineHeight', 1.45),
    pageNumbers: booleanValue(values, 'pageNumbers'),
    columns: numberValue(values, 'columns', 1) === 2 ? (2 as const) : (1 as const),
  };
}

async function blocksToPdf(
  context: ToolRunContext,
  blocks: Awaited<ReturnType<typeof import('../core/office-in').odtToBlocks>>,
  message: string,
) {
  const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
  const doc = await newDocumentForLayout();
  const pages = await renderBlocks(doc, blocks, layoutOptions(context.values));
  const bytes = await savePDF(doc);
  return pdfResult(doc, { message: `${message} ${pages.length} page(s).` });
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
    fields: [PAGE_FIELD, ORIENTATION_FIELD, MARGIN_FIELD],
    async run(context) {
      const [input] = await openInputs(context);
      const { odtToBlocks } = await import('../core/office-in');
      const blocks = await odtToBlocks(input.bytes);
      return blocksToPdf(context, blocks, 'Converted the OpenDocument text file into');
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
    fields: [PAGE_FIELD, ORIENTATION_FIELD],
    async run(context) {
      const [input] = await openInputs(context);
      const { odsToBlocks } = await import('../core/office-in');
      const blocks = await odsToBlocks(input.bytes);
      return blocksToPdf(context, blocks, 'Converted the OpenDocument spreadsheet into');
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
    fields: [
      {
        key: 'slideSize',
        label: 'Slide aspect',
        type: 'select',
        default: '16:9',
        options: [
          { value: '16:9', label: '16:9 (960 × 540)' },
          { value: '4:3', label: '4:3 (720 × 540)' },
        ],
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { odpToBlocks } = await import('../core/office-in');
      const blocks = await odpToBlocks(input.bytes);
      const [width, height] = stringValue(context.values, 'slideSize', '16:9') === '4:3'
        ? [720, 540]
        : [960, 540];
      const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
      const doc = await newDocumentForLayout();
      const pages = await renderBlocks(doc, blocks, { pageSize: [width, height], margin: 28, baseFontSize: 14 });
      return pdfResult(doc, { message: `${pages.length} slide(s) written from the OpenDocument presentation.` });
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
    fields: [PAGE_FIELD],
    notes: ['Text runs are recovered as flow text; strokes, gradients and exact glyph positioning are not reproduced.'],
    async run(context) {
      const [input] = await openInputs(context);
      const { xpsToBlocks } = await import('../core/office-in');
      const blocks = await xpsToBlocks(input.bytes);
      return blocksToPdf(context, blocks, 'Converted the XPS document into');
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
    fields: [PAGE_FIELD, MARGIN_FIELD],
    async run(context) {
      const [input] = await openInputs(context);
      const { ebookToBlocks } = await import('../core/office-in');
      const blocks = await ebookToBlocks(input.bytes, input.name);
      return blocksToPdf(context, blocks, 'Converted the FictionBook file into');
    },
  },
];

/**
 * Registered so the capability is discoverable rather than silently absent.
 * `unavailable` is surfaced in the UI and as a clear error instead of a
 * plausible-looking but wrong conversion.
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
    hint: 'Re-save the book as EPUB (Calibre does this in one click), which BrowserSnip converts entirely in the tab.',
  },
  {
    id: 'pages-to-pdf',
    name: 'Pages to PDF',
    label: 'Apple Pages',
    accept: '.pages',
    hint: 'In Pages choose File → Export To → PDF, or unzip the .pages bundle and convert the PDF inside it.',
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
    hint: 'Export from Visio to PDF, or save the drawing as SVG and use SVG to PDF. VSDX is partly readable — try SVG export for reliable results.',
  },
  {
    id: 'wpd-to-pdf',
    name: 'WPD to PDF',
    label: 'WordPerfect',
    accept: '.wpd',
    hint: 'Re-export from CorelDRAW or LibreOffice as DOCX or PDF first.',
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
  notes: [`Needs a full office-suite decoder. ${entry.hint}`],
  unavailable: `${entry.name} is not available offline: the ${entry.label} container needs LibreOffice, which BrowserSnip does not bundle (~100 MB of WASM). ${entry.hint}`,
}));

void rebuildDocument;
