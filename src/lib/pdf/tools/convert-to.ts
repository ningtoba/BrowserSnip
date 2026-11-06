/**
 * Convert to PDF.
 *
 * Every text-ish format goes through the same two steps: parse into the
 * `Block` model in `core/layout`, then render with real, selectable PDF text.
 * That replaces the old `html-to-pdf`, which screenshotted markup into a
 * fixed-width A4 image (no selectable text, no pagination control) and injected
 * author HTML into the live document.
 */
import { savePDF } from '../core/doc';
import { decodeImage, decodeImagePages, sniffImageMime } from '../core/images';
import { pdfFromImages } from '../core/pack';
import { pageSize } from '../core/pages';
import { openInputs, filesResult, pdfResult, baseName } from './helpers';
import {
  booleanValue,
  numberValue,
  fileValues,
  stringValue,
  type PdfToolDefinition,
  type ToolRunContext,
} from './types';

type Block = import('../core/layout').Block;
type LayoutOptions = import('../core/layout').LayoutOptions;

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

function layoutOptions(context: ToolRunContext, overrides: Partial<LayoutOptions> = {}): LayoutOptions {
  const size = stringValue(context.values, 'pageSize', 'a4');
  const landscape = stringValue(context.values, 'orientation', 'portrait') === 'landscape';
  return {
    pageSize: landscape ? [pageSize(size, true)[0], pageSize(size, true)[1]] : size,
    margin: numberValue(context.values, 'margin', 56),
    baseFontSize: numberValue(context.values, 'fontSize', 11),
    lineHeight: numberValue(context.values, 'lineHeight', 1.45),
    fontFamily: stringValue(context.values, 'fontFamily', 'auto'),
    header: stringValue(context.values, 'header') || undefined,
    footer: stringValue(context.values, 'footer') || undefined,
    pageNumbers: booleanValue(context.values, 'pageNumbers'),
    columns: numberValue(context.values, 'columns', 1) === 2 ? 2 : 1,
    ...overrides,
  };
}

/** Text-ish inputs share one panel: paste or upload, then lay out. */
function sourceFields(accept: string, pastePlaceholder: string) {
  return [
    {
      key: 'source',
      label: 'Source',
      type: 'segmented' as const,
      default: 'file',
      options: [
        { value: 'file', label: 'Uploaded file' },
        { value: 'paste', label: 'Pasted text' },
      ],
    },
    { key: 'paste', label: 'Content', type: 'textarea' as const, placeholder: pastePlaceholder, when: (v: Record<string, unknown>) => v.source === 'paste' },
    { key: 'files', label: 'Files', type: 'file' as const, accept, multiple: true, maxFiles: 10 },
    PAGE_FIELD,
    ORIENTATION_FIELD,
    MARGIN_FIELD,
  ];
}

async function blocksToPdf(
  context: ToolRunContext,
  blocks: Block[],
  options: LayoutOptions,
  message: string,
) {
  const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
  const doc = await newDocumentForLayout();
  const pages = await renderBlocks(doc, blocks, options);
  const bytes = await savePDF(doc);
  return pdfResultFromBytes(bytes, `${message} ${pages.length} page(s).`);
}

function pdfResultFromBytes(bytes: Uint8Array, message?: string) {
  return { kind: 'pdf' as const, bytes, message };
}

/** Read the chosen file(s), or the pasted text, as UTF-8. */
async function readSources(context: ToolRunContext): Promise<{ name: string; text: string }[]> {
  const pasted = stringValue(context.values, 'paste');
  if (stringValue(context.values, 'source', 'file') === 'paste' || (pasted.trim() !== '' && context.inputs.length === 0)) {
    if (pasted.trim() === '') throw new Error('Paste some content, or choose a file to convert.');
    return [{ name: 'pasted', text: pasted }];
  }
  const chosen = fileValues(context.values, 'files');
  const pool = chosen.length > 0
    ? chosen.map((file) => ({ name: file.name, bytes: file.bytes }))
    : context.inputs.map((file) => ({ name: file.name, bytes: null as Uint8Array | null }));
  if (pool.length === 0) throw new Error('Choose at least one file to convert.');
  const out: { name: string; text: string }[] = [];
  for (const item of pool) {
    const fromField = item.bytes;
    const fromInput = context.inputs.find((file) => file.name === item.name);
    const bytes = fromField ?? (fromInput ? await fromInput.bytes() : new Uint8Array());
    out.push({ name: item.name, text: new TextDecoder('utf-8').decode(bytes) });
  }
  return out;
}

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
    fields: [
      PAGE_FIELD,
      { key: 'fit', label: 'Fit', type: 'select', default: 'contain', options: [
        { value: 'contain', label: 'Fit inside the page' },
        { value: 'cover', label: 'Fill the page (crop)' },
        { value: 'stretch', label: 'Stretch' },
      ] },
      { key: 'orientation', label: 'Orientation', type: 'select', default: 'auto', options: [
        { value: 'auto', label: 'Match each image' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' },
      ] },
      { key: 'margin', label: 'Margin', type: 'slider', default: 0, min: 0, max: 72, step: 1, unit: 'pt' },
      { key: 'onePerSheet', label: 'Put two images on each sheet', type: 'toggle', default: false },
    ],
    async run(context) {
      const sources = context.inputs.length > 0 ? context.inputs : [];
      const images = [];
      for (const file of sources) {
        const bytes = await file.bytes();
        const mime = sniffImageMime(bytes) ?? file.type;
        const pages = await decodeImagePages(bytes, { mime });
        images.push(...pages);
        context.log(`${file.name} — ${pages.length} page(s), ${mime}`);
      }
      if (images.length === 0) throw new Error('No readable images were added.');
      const size = stringValue(context.values, 'pageSize', 'a4');
      const packed = await pdfFromImages(
        images.map((image) => ({ data: image.canvas })),
        {
          pageSize: size,
          orientation: stringValue(context.values, 'orientation', 'auto') as 'portrait' | 'landscape' | 'auto',
          margin: numberValue(context.values, 'margin', 0),
          fit: stringValue(context.values, 'fit', 'contain') as 'contain' | 'cover' | 'stretch',
        },
      );
      return pdfResult(packed.doc, {
        message: `${images.length} image(s) placed on ${packed.pages} page(s).`,
      });
    },
  },

  ...(['jpg-to-pdf', 'png-to-pdf', 'webp-to-pdf', 'heic-to-pdf', 'bmp-to-pdf', 'tiff-to-pdf', 'psd-to-pdf'] as const).map((id): PdfToolDefinition => {
    const format = id.replace('-to-pdf', '');
    const label = format.toUpperCase();
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
      fields: [PAGE_FIELD, MARGIN_FIELD, ORIENTATION_FIELD],
      async run(context) {
        const images: { canvas: HTMLCanvasElement }[] = [];
        for (const file of context.inputs) {
          const bytes = await file.bytes();
          const decoded = await decodeImagePages(bytes, { mime: file.type || `image/${format}` });
          images.push(...decoded);
        }
        if (images.length === 0) throw new Error(`No ${label} images were added.`);
        const packed = await pdfFromImages(
          images.map((image) => ({ data: image.canvas })),
          {
            pageSize: stringValue(context.values, 'pageSize', 'a4'),
            margin: numberValue(context.values, 'margin', 0),
            orientation: stringValue(context.values, 'orientation', 'auto') as 'auto',
          },
        );
        return pdfResult(packed.doc, { message: `${images.length} ${label} image(s) → ${packed.pages} page(s).` });
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
    fields: [PAGE_FIELD, MARGIN_FIELD],
    async run(context) {
      const pages: { data: Uint8Array | Blob | HTMLCanvasElement }[] = [];
      for (const file of context.inputs) {
        const bytes = await file.bytes();
        const decoded = await decodeImage(bytes, { mime: 'image/svg+xml', maxSide: 4096 });
        pages.push({ data: decoded.canvas });
      }
      if (pages.length === 0) throw new Error('Add at least one SVG file.');
      const packed = await pdfFromImages(pages, {
        pageSize: stringValue(context.values, 'pageSize', 'fit') === 'fit' ? 'fit' : stringValue(context.values, 'pageSize', 'a4'),
        margin: numberValue(context.values, 'margin', 0),
      });
      return pdfResult(packed.doc, { message: `${pages.length} SVG(s) placed on ${packed.pages} page(s).` });
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
    fields: [PAGE_FIELD],
    async run(context) {
      const [input] = await openInputs(context);
      const { readZip } = await import('../core/archive');
      const files = await readZip(input.bytes, {
        filterExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif'],
      });
      if (files.length === 0) throw new Error('That archive contained no readable page images.');
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const packed = await pdfFromImages(
        files.map((file) => ({ data: file.bytes, mime: file.mime })),
        { pageSize: 'original', margin: 0 },
      );
      return pdfResult(packed.doc, { message: `${files.length} comic pages → ${packed.pages} PDF page(s).` });
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
    accept: '.txt,.text,.log,.md,.markdown',
    surface: 'none',
    outputSuffix: '_from_text.pdf',
    fields: [
      ...sourceFields('.txt,.text,.log', 'Paste your text here…'),
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 6, max: 24, half: true },
      { key: 'lineHeight', label: 'Line height', type: 'slider', default: 1.45, min: 1, max: 3, step: 0.05, half: true },
      { key: 'monospace', label: 'Monospaced', type: 'toggle', default: false },
      { key: 'paragraphs', label: 'Blank line starts a new paragraph', type: 'toggle', default: true },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true },
    ],
    async run(context) {
      const sources = await readSources(context);
      const { textToBlocks } = await import('../core/layout');
      const blocks: Block[] = sources.flatMap((source) => textToBlocks(source.text, {
        monospace: booleanValue(context.values, 'monospace'),
        paragraphs: booleanValue(context.values, 'paragraphs', true) ? '\n\n' : '\n',
      }));
      return blocksToPdf(context, blocks, layoutOptions(context), `Typeset ${sources.length} text source(s) into`);
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
    accept: '.md,.markdown,.txt',
    surface: 'none',
    outputSuffix: '_from_markdown.pdf',
    fields: [
      ...sourceFields('.md,.markdown', '# Heading\n\nWrite **Markdown** here…'),
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 6, max: 24, half: true },
      { key: 'columns', label: 'Columns', type: 'segmented', default: 1, options: [
        { value: 1, label: 'One' }, { value: 2, label: 'Two' },
      ] },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: true },
      { key: 'header', label: 'Header text', type: 'text', placeholder: 'Shown at the top of every page' },
      { key: 'footer', label: 'Footer text', type: 'text', placeholder: 'Shown at the bottom of every page' },
    ],
    async run(context) {
      const sources = await readSources(context);
      const { markdownToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      for (const source of sources) {
        blocks.push(...(await markdownToBlocks(source.text)));
      }
      return blocksToPdf(context, blocks, layoutOptions(context), `Rendered ${sources.length} Markdown source(s) into`);
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
    accept: '.html,.htm,.xhtml',
    surface: 'none',
    outputSuffix: '_from_html.pdf',
    fields: [
      ...sourceFields('.html,.htm', '<h1>Title</h1><p>Body text…</p>'),
      { key: 'fontSize', label: 'Base font size', type: 'number', default: 11, min: 6, max: 24, half: true },
      { key: 'embedImages', label: 'Embed images referenced by data: URL', type: 'toggle', default: true },
      { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: false },
    ],
    async run(context) {
      const sources = await readSources(context);
      const { htmlToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      for (const source of sources) {
        blocks.push(...(await htmlToBlocks(source.text, {
          fetchImage: async (src) => {
            if (!src.startsWith('data:')) return null;
            const [, meta] = src.split(',');
            if (!meta) return null;
            const binary = atob(meta);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
          },
        })));
      }
      if (blocks.length === 0) {
        throw new Error('That HTML had no readable body content. Tables, headings, paragraphs, lists and images are supported.');
      }
      return blocksToPdf(context, blocks, layoutOptions(context), `Laid out ${sources.length} HTML source(s) into`);
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
    accept: '.csv,.tsv,.txt',
    surface: 'none',
    outputSuffix: '_from_csv.pdf',
    fields: [
      ...sourceFields('.csv,.tsv', 'name,qty,price\nWidget,3,9.99'),
      { key: 'delimiter', label: 'Delimiter', type: 'select', default: ',', options: [
        { value: ',', label: 'Comma' }, { value: ';', label: 'Semicolon' }, { value: '\t', label: 'Tab' }, { value: 'auto', label: 'Detect' },
      ] },
      { key: 'headerRow', label: 'First row is a header', type: 'toggle', default: true },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 9, min: 5, max: 18, half: true },
    ],
    async run(context) {
      const sources = await readSources(context);
      const { csvToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      for (const source of sources) {
        const delimiter = stringValue(context.values, 'delimiter', ',');
        blocks.push(...(await csvToBlocks(source.text, {
          delimiter: delimiter === 'auto' ? undefined : delimiter,
          header: booleanValue(context.values, 'headerRow', true),
        })));
      }
      return blocksToPdf(context, blocks, layoutOptions(context), `Tabulated ${sources.length} file(s) into`);
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
    accept: '.json,.ndjson,.txt',
    surface: 'none',
    outputSuffix: '_from_json.pdf',
    fields: [...sourceFields('.json', '{\n  "name": "value"\n}'), { key: 'maxDepth', label: 'Maximum depth', type: 'number', default: 8, min: 1, max: 20 }],
    async run(context) {
      const sources = await readSources(context);
      const { jsonToBlocks } = await import('../core/layout');
      const blocks: Block[] = [];
      for (const source of sources) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(source.text);
        } catch (error) {
          throw new Error(`${source.name} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}.`);
        }
        blocks.push(...jsonToBlocks(parsed, { maxDepth: numberValue(context.values, 'maxDepth', 8) }));
      }
      return blocksToPdf(context, blocks, layoutOptions(context), `Reported ${sources.length} JSON file(s) into`);
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
    accept: '.xml,.xsd,.gpx,.kml',
    surface: 'none',
    outputSuffix: '_from_xml.pdf',
    fields: sourceFields('.xml', '<?xml version="1.0"?><root/>'),
    async run(context) {
      const sources = await readSources(context);
      const { xmlToBlocks } = await import('../core/layout');
      const blocks: Block[] = sources.flatMap((source) => xmlToBlocks(source.text));
      return blocksToPdf(context, blocks, layoutOptions(context), `Printed ${sources.length} XML file(s) into`);
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
    accept: '.rtf',
    surface: 'none',
    outputSuffix: '_from_rtf.pdf',
    fields: sourceFields('.rtf', '{\\rtf1 Hello}'),
    async run(context) {
      const sources = await readSources(context);
      const { rtfToBlocks } = await import('../core/layout');
      const blocks: Block[] = sources.flatMap((source) => rtfToBlocks(source.text));
      return blocksToPdf(context, blocks, layoutOptions(context), `Converted ${sources.length} RTF file(s) into`);
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
    accept: '.docx,.doc,.odt,.rtf',
    surface: 'none',
    outputSuffix: '_from_word.pdf',
    fields: [PAGE_FIELD, MARGIN_FIELD, { key: 'pageNumbers', label: 'Page numbers', type: 'toggle', default: false }],
    async run(context) {
      const [input] = await openInputs(context);
      const lower = input.name.toLowerCase();
      let blocks: Block[] = [];
      let route = '';
      if (lower.endsWith('.docx')) {
        const mammoth = await import('mammoth/mammoth.browser');
        const { htmlToBlocks } = await import('../core/layout');
        const result = await (mammoth.default ?? mammoth).convertToHtml(
          { arrayBuffer: input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer },
          { convertImage: (mammoth.default ?? mammoth).imgElement?.attributes({ src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }) },
        );
        blocks = await htmlToBlocks(result.value);
        route = 'mammoth (bundled, offline)';
      } else if (lower.endsWith('.odt')) {
        const { odtToBlocks } = await import('../core/office-in');
        blocks = await odtToBlocks(input.bytes);
        route = 'OpenDocument reader';
      } else if (lower.endsWith('.rtf')) {
        const { rtfToBlocks } = await import('../core/layout');
        blocks = rtfToBlocks(new TextDecoder().decode(input.bytes));
        route = 'RTF reader';
      } else {
        const result = await convertWithLibreOffice(context, input.bytes, input.name, 'pdf');
        return { kind: 'pdf', bytes: result, message: 'Converted with the optional LibreOffice module.' };
      }
      const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
      const doc = await newDocumentForLayout();
      const pages = await renderBlocks(doc, blocks, layoutOptions(context));
      const bytes = await savePDF(doc);
      return {
        kind: 'pdf',
        bytes,
        message: `Converted via ${route} into ${pages.length} page(s). Complex Word layout may differ from the original.`,
      };
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
    accept: '.xlsx,.xls,.ods,.csv',
    surface: 'none',
    outputSuffix: '_from_excel.pdf',
    fields: [PAGE_FIELD, ORIENTATION_FIELD, { key: 'fontSize', label: 'Font size', type: 'number', default: 8, min: 5, max: 16, half: true }, { key: 'allSheets', label: 'Every worksheet', type: 'toggle', default: true }],
    async run(context) {
      const [input] = await openInputs(context);
      if (input.name.toLowerCase().endsWith('.ods')) {
        const { odsToBlocks } = await import('../core/office-in');
        const blocks = await odsToBlocks(input.bytes);
        return blocksToPdf(context, blocks, layoutOptions(context), 'Converted the OpenDocument spreadsheet into');
      }
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(input.bytes, { type: 'array', cellDates: true });
      const sheets = booleanValue(context.values, 'allSheets', true)
        ? workbook.SheetNames
        : workbook.SheetNames.slice(0, 1);
      const { tableBlock } = await import('../core/layout');
      const blocks: Block[] = [];
      for (const name of sheets) {
        const rows: string[][] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: '' }) as string[][];
        if (rows.length === 0) continue;
        blocks.push({ kind: 'heading', level: 2, inlines: [{ text: name }] });
        blocks.push(tableBlock(rows));
      }
      if (blocks.length === 0) throw new Error('That workbook had no readable sheets.');
      return blocksToPdf(context, blocks, layoutOptions(context), `Converted ${sheets.length} worksheet(s) into`);
    },
  },

  {
    id: 'powerpoint-to-pdf',
    name: 'PowerPoint to PDF',
    description: 'Convert PPTX, PPT and ODP slides into pages',
    icon: '📽️',
    category: 'convert-to',
    keywords: ['pptx', 'ppt', 'odp', 'slides', 'presentation'],
    inputKind: 'office',
    accept: '.pptx,.ppt,.odp',
    surface: 'none',
    outputSuffix: '_from_slides.pdf',
    fields: [
      { key: 'slideSize', label: 'Slide aspect', type: 'select', default: '16:9', options: [
        { value: '16:9', label: '16:9 (960 × 540)' }, { value: '4:3', label: '4:3 (720 × 540)' },
      ] },
      { key: 'notes', label: 'Include speaker notes', type: 'toggle', default: false },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { pptxToBlocks } = await import('../core/office-in');
      const blocks = await pptxToBlocks(input.bytes, { notes: booleanValue(context.values, 'notes') });
      const [width, height] = stringValue(context.values, 'slideSize', '16:9') === '4:3' ? [720, 540] : [960, 540];
      const { renderBlocks, newDocumentForLayout } = await import('../core/layout');
      const doc = await newDocumentForLayout();
      const pages = await renderBlocks(doc, blocks, { pageSize: [width, height], margin: 28, baseFontSize: 14 });
      const bytes = await savePDF(doc);
      return {
        kind: 'pdf',
        bytes,
        message: `${pages.length} slide(s) written. Slide geometry is approximate — text position in the original is not preserved.`,
      };
    },
  },

  {
    id: 'epub-to-pdf',
    name: 'EPUB to PDF',
    description: 'Reflow an ebook into a paginated PDF',
    icon: '📖',
    category: 'convert-to',
    keywords: ['ebook', 'book', 'mobi', 'fb2', 'reader'],
    inputKind: 'office',
    accept: '.epub,.mobi,.fb2',
    surface: 'none',
    outputSuffix: '_from_epub.pdf',
    fields: [PAGE_FIELD, { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 7, max: 20, half: true }, { key: 'margin', label: 'Margin', type: 'number', default: 64, min: 0, max: 144, half: true }],
    async run(context) {
      const [input] = await openInputs(context);
      const { epubToBlocks } = await import('../core/office-in');
      const blocks = await epubToBlocks(input.bytes);
      if (blocks.length === 0) throw new Error('No readable chapters were found in that ebook.');
      return blocksToPdf(context, blocks, layoutOptions(context), `Reflowed ${blocks.length} block(s) into`);
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
    fields: [PAGE_FIELD, { key: 'includeAttachments', label: 'List attachments', type: 'toggle', default: true }],
    async run(context) {
      const [input] = await openInputs(context);
      const { emailToBlocks } = await import('../core/office-in');
      const blocks = await emailToBlocks(input.bytes, input.name, {
        attachments: booleanValue(context.values, 'includeAttachments', true),
      });
      return blocksToPdf(context, blocks, layoutOptions(context), `Printed the message into`);
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
    fields: [
      PAGE_FIELD,
      { key: 'language', label: 'Language', type: 'select', default: 'en', options: [
        { value: 'en', label: 'English' }, { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' },
        { value: 'fr', label: 'French' }, { value: 'zh', label: 'Chinese' }, { value: 'ja', label: 'Japanese' },
      ] },
      { key: 'keepImage', label: 'Keep the page image and add an invisible text layer', type: 'toggle', default: true },
      { key: 'enhance', label: 'Deskew and whiten first', type: 'toggle', default: true },
      { key: 'margin', label: 'Margin', type: 'slider', default: 20, min: 0, max: 72, step: 1, unit: 'pt' },
    ],
    async run(context) {
      const images: { data: Uint8Array | Blob | HTMLCanvasElement }[] = [];
      for (const file of context.inputs) {
        const bytes = await file.bytes();
        const decoded = await decodeImagePages(bytes, { mime: file.type });
        images.push(...decoded.map((image) => ({ data: image.canvas })));
      }
      if (images.length === 0) throw new Error('Add at least one photo or scan.');
      const packed = await pdfFromImages(images, {
        pageSize: stringValue(context.values, 'pageSize', 'a4'),
        margin: numberValue(context.values, 'margin', 20),
      });
      if (!booleanValue(context.values, 'keepImage', true)) {
        return pdfResult(packed.doc, { message: `${images.length} page(s) converted to an image-only PDF.` });
      }
      const { openRender } = await import('../core/render');
      const { ocrDocument, addSearchableTextLayer } = await import('../core/ocr');
      const bytes = await savePDF(packed.doc);
      const session = await openRender(bytes);
      try {
        const results = await ocrDocument(session, {
          dpi: 300,
          lang: stringValue(context.values, 'language', 'en'),
          signal: context.signal,
          onProgress: (done, total) => context.progress(done / total, `Read page ${done} of ${total}`),
        });
        const added = await addSearchableTextLayer(packed.doc, results, { invisible: true });
        return pdfResult(packed.doc, {
          message: `${images.length} page(s) digitised with ${added.words} recognised words behind the images — now selectable and searchable.`,
        });
      } finally {
        await session.destroy();
      }
    },
  },

];

/**
 * LibreOffice is the only faithful route for legacy binary Office formats.
 * It is not bundled: the caller gets a clear message if the module is absent.
 */
async function convertWithLibreOffice(
  context: ToolRunContext,
  bytes: Uint8Array,
  name: string,
  target: string,
): Promise<Uint8Array> {
  const { convertOffice, officeReady } = await import('../core/office-in');
  if (!officeReady()) {
    throw new Error(
      `"${name}" is a legacy binary Office file. Faithful conversion needs the optional LibreOffice module — enable it in WASM settings, or re-save the file as .docx / .xlsx first.`,
    );
  }
  context.progress(0.1, 'Loading the office converter');
  return convertOffice(bytes, name, target, context.progress);
}
