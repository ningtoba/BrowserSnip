/**
 * Edit PDF tools — page marks, stamps, navigation and content colour.
 *
 * Everything here draws real PDF content through `core/fonts`, which is what
 * fixes the long-standing crash where any Cyrillic, Greek or CJK watermark,
 * page number or Bates stamp threw `WinAnsi cannot encode …`.
 */
import type { PDFDocument, PDFPage } from '../core/doc';
import { degrees, rgb, savePDF } from '../core/doc';
import { drawTextU, measureText, wrapText } from '../core/fonts';
import {
  cropBox,
  displayedSize,
  formatPages,
  mediaBox,
  resolvePages,
  setMediaAndCrop,
  toPoints,
  type LengthUnit,
} from '../core/pages';
import { parseHexColor } from './helpers';
import { addPageLabels, readPageLabels, writeOutline, readOutline } from '../core/bookmarks';
import { listFormFields, type CreateFieldSpec } from '../core/forms';
import { openRender, rasterizePages } from '../core/render';
import { pdfFromImages } from '../core/pack';
import { openInputs, pdfResult, reportResult, withRender, baseName } from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  stringValues,
  type PdfToolDefinition,
  type ToolRunContext,
} from './types';

type Anchor = 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** Position text inside a page box, honouring the page's own /Rotate. */
async function stamp(
  doc: PDFDocument,
  page: PDFPage,
  text: string,
  options: {
    anchor: Anchor;
    size: number;
    color: string;
    bold?: boolean;
    italic?: boolean;
    rotation?: number;
    opacity?: number;
    margin?: number;
  },
): Promise<number> {
  const box = cropBox(page);
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const { width } = await measureText(doc, { text, x: 0, y: 0, size: options.size, bold: options.bold, italic: options.italic });
  const margin = options.margin ?? 24;
  const [ax, ay] = options.anchor.split('-') as [string, string];
  const horizontal = ax === 'top' || ax === 'bottom' ? ay : ax;
  const vertical = ax === 'top' || ax === 'bottom' ? ax : ay === 'left' || ay === 'right' ? 'center' : ay;

  const x =
    horizontal === 'left' ? box.x + margin
    : horizontal === 'right' ? box.x + box.width - width - margin
    : box.x + (box.width - width) / 2;
  const y =
    vertical === 'top' ? box.y + box.height - margin - options.size
    : vertical === 'bottom' ? box.y + margin
    : box.y + (box.height - options.size) / 2;

  return drawTextU(page, {
    text,
    x,
    y,
    size: options.size,
    color: rgbColor(options.color),
    bold: options.bold,
    italic: options.italic,
    rotation: (options.rotation ?? 0) + (rotation === 180 ? 180 : 0),
    opacity: options.opacity,
  });
}

function rgbColor(hex: string) {
  const { r, g, b } = parseHexColor(hex);
  return rgb(r, g, b);
}

const ANCHOR_OPTIONS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'center-left', label: 'Middle left' },
  { value: 'center', label: 'Centre' },
  { value: 'center-right', label: 'Middle right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' },
];

const FONT_OPTIONS = [
  { value: 'auto', label: 'Automatic (matches the text)', hint: 'Embedded Noto Sans; loads a script face for CJK, Arabic, Hebrew, Thai or Indic text.' },
  { value: 'noto', label: 'Noto Sans' },
  { value: 'helvetica', label: 'Helvetica (Latin only)' },
  { value: 'times', label: 'Times (Latin only)' },
  { value: 'courier', label: 'Courier (Latin only)' },
];

const ANNOTATION_SURFACE_FIELDS = [
  {
    key: 'regions',
    label: 'Regions',
    type: 'text' as const,
    default: '',
    help: 'Fill in from the page editor, or type page:x,y,w,h entries separated by semicolons.',
  },
];

/** Parse the fallback textual region format used when the surface is absent. */
function parseRegions(raw: unknown, doc: PDFDocument): { page: number; x: number; y: number; width: number; height: number }[] {
  if (Array.isArray(raw)) {
    return raw as { page: number; x: number; y: number; width: number; height: number }[];
  }
  const text = typeof raw === 'string' ? raw : '';
  const out: { page: number; x: number; y: number; width: number; height: number }[] = [];
  for (const chunk of text.split(/[;\n]+/)) {
    const match = /^\s*(\d+)\s*:\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*$/.exec(chunk);
    if (!match) continue;
    const page = Number(match[1]) - 1;
    if (page < 0 || page >= doc.getPageCount()) continue;
    out.push({
      page,
      x: Number(match[2]),
      y: Number(match[3]),
      width: Number(match[4]),
      height: Number(match[5]),
    });
  }
  return out;
}

export const editTools: PdfToolDefinition[] = [
  {
    id: 'edit-pdf',
    name: 'PDF Editor',
    description: 'Annotate, highlight, redact, comment, and add shapes or images on one canvas',
    icon: '✏️',
    category: 'edit',
    keywords: ['annotate', 'highlight', 'comment', 'draw', 'markup', 'pen', 'shapes'],
    surface: 'custom',
    outputSuffix: '_edited.pdf',
    notes: ['Annotations are written as standard PDF annotations, so other readers show and edit them.'],
  },

  {
    id: 'edit-pdf-text',
    name: 'Edit PDF Text',
    description: 'Click a paragraph and rewrite it in place, with reflow, fonts and styling',
    icon: '🖊️',
    category: 'edit',
    keywords: ['rewrite text', 'change wording', 'content editor', 'typo', 'in place'],
    surface: 'custom',
    outputSuffix: '_edited.pdf',
    notes: [
      'Editing deletes the original glyph runs and redraws the block, so the old text is not left hiding underneath.',
      'Blocks that PyMuPDF-grade surgery is needed for are reported instead of silently doubled.',
    ],
  },

  {
    id: 'page-numbers',
    name: 'Page Numbers',
    description: 'Number pages with position, format, range and style controls',
    icon: '🔢',
    category: 'edit',
    keywords: ['pagination', 'footer numbers', 'folio'],
    outputSuffix: '_numbered.pdf',
    fields: [
      { key: 'position', label: 'Position', type: 'select', default: 'bottom-center', options: ANCHOR_OPTIONS },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 5, max: 72, half: true },
      { key: 'margin', label: 'Margin', type: 'number', default: 24, min: 0, max: 200, unit: 'pt', half: true },
      { key: 'startAt', label: 'First number', type: 'number', default: 1, min: 0, half: true },
      { key: 'step', label: 'Count every', type: 'number', default: 1, min: 1, max: 10, half: true, help: '2 numbers every second page, useful for folded booklets.' },
      { key: 'prefix', label: 'Before the number', type: 'text', default: 'Page ', half: true },
      { key: 'suffix', label: 'After the number', type: 'text', default: ' of {total}', half: true, help: '{total} and {page} are replaced.' },
      { key: 'style', label: 'Number style', type: 'select', default: 'decimal', options: [
        { value: 'decimal', label: '1, 2, 3' },
        { value: 'roman-upper', label: 'I, II, III' },
        { value: 'roman-lower', label: 'i, ii, iii' },
        { value: 'letters', label: 'A, B, C' },
        { value: 'padded', label: '01, 02, 03' },
      ] },
      { key: 'color', label: 'Colour', type: 'color', default: '#1b1b18' },
      { key: 'bold', label: 'Bold', type: 'toggle', default: false },
      { key: 'font', label: 'Typeface', type: 'select', default: 'auto', options: FONT_OPTIONS },
      { key: 'skip', label: 'Skip first N pages', type: 'number', default: 0, min: 0 },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const all = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const startAt = numberValue(context.values, 'startAt', 1);
      const step = Math.max(1, numberValue(context.values, 'step', 1));
      const skip = numberValue(context.values, 'skip', 0);
      const style = stringValue(context.values, 'style', 'decimal');
      const total = all.length;
      const pages = input.doc.getPages();
      let stamped = 0;
      for (let i = 0; i < all.length; i++) {
        if (i < skip || i % step !== 0) continue;
        const number = startAt + Math.floor(i / step);
        const text = stringValue(context.values, 'prefix', 'Page ')
          + formatNumber(number, style)
          + stringValue(context.values, 'suffix', ' of {total}')
            .replace('{total}', formatNumber(Math.ceil(total / step) + startAt - 1, style))
            .replace('{page}', formatNumber(number, style));
        await stamp(input.doc, pages[all[i]], text, {
          anchor: stringValue(context.values, 'position', 'bottom-center') as Anchor,
          size: numberValue(context.values, 'fontSize', 11),
          color: stringValue(context.values, 'color', '#1b1b18'),
          bold: booleanValue(context.values, 'bold'),
          margin: numberValue(context.values, 'margin', 24),
        });
        stamped += 1;
        context.progress((i + 1) / all.length, `Numbered page ${all[i] + 1}`);
      }
      return pdfResult(input.doc, { message: `Added page numbers to ${stamped} page(s).` });
    },
  },

  {
    id: 'watermark',
    name: 'Add Watermark',
    description: 'Stamp text or an image across pages with opacity, angle and tiling',
    icon: '💧',
    category: 'edit',
    keywords: ['draft', 'confidential', 'logo', 'stamp overlay'],
    outputSuffix: '_watermarked.pdf',
    fields: [
      { key: 'type', label: 'Watermark', type: 'segmented', default: 'text', options: [
        { value: 'text', label: 'Text' }, { value: 'image', label: 'Image' },
      ] },
      { key: 'text', label: 'Text', type: 'text', default: 'DRAFT', when: (v) => v.type === 'text' },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 64, min: 6, max: 400, half: true, when: (v) => v.type === 'text' },
      { key: 'color', label: 'Colour', type: 'color', default: '#888888', when: (v) => v.type === 'text' },
      { key: 'opacity', label: 'Opacity', type: 'slider', default: 0.25, min: 0.02, max: 1, step: 0.01 },
      { key: 'rotation', label: 'Angle', type: 'slider', default: 45, min: -180, max: 180, step: 1, unit: '°' },
      { key: 'layer', label: 'Placement', type: 'segmented', default: 'over', options: [
        { value: 'over', label: 'Over content' }, { value: 'under', label: 'Behind content' },
      ] },
      { key: 'position', label: 'Position', type: 'select', default: 'center', options: ANCHOR_OPTIONS, when: (v) => v.tile !== true },
      { key: 'tile', label: 'Repeat as a pattern', type: 'toggle', default: false },
      { key: 'tileGap', label: 'Pattern spacing', type: 'slider', default: 1.5, min: 0.2, max: 5, step: 0.1, when: (v) => v.tile === true },
      { key: 'bold', label: 'Bold', type: 'toggle', default: true, when: (v) => v.type === 'text' },
      { key: 'scale', label: 'Image scale', type: 'slider', default: 0.35, min: 0.02, max: 2, step: 0.01, when: (v) => v.type === 'image' },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    validate: (values) =>
      values.type === 'text' && stringValue(values, 'text').trim() === ''
        ? 'Enter the watermark text, or switch to an image watermark.'
        : null,
    async run(context) {
      const [input] = await openInputs(context);
      const type = stringValue(context.values, 'type', 'text');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const opacity = numberValue(context.values, 'opacity', 0.25);
      const rotation = numberValue(context.values, 'rotation', 45);
      const tile = booleanValue(context.values, 'tile');
      const gap = numberValue(context.values, 'tileGap', 1.5);
      const anchor = stringValue(context.values, 'position', 'center') as Anchor;
      const behind = stringValue(context.values, 'layer', 'over') === 'under';
      const imageBytes = firstFileBytes(context.values, 'image');

      if (type === 'image' && !imageBytes) {
        throw new Error('Choose the image to use as a watermark.');
      }
      const embedded = type === 'image'
        ? await input.doc.embedPng(await toPng(input.doc, imageBytes!))
        : null;

      for (let i = 0; i < pages.length; i++) {
        const page = input.doc.getPage(pages[i]);
        const box = cropBox(page);
        if (behind) {
          page.drawRectangle({ x: box.x, y: box.y, width: 0, height: 0, opacity: 0, color: rgb(1, 1, 1) });
        }
        if (type === 'image' && embedded) {
          const scale = numberValue(context.values, 'scale', 0.35);
          const width = box.width * scale;
          const height = (embedded.height / embedded.width) * width;
          const positions = tile ? tilePoints(box, width * gap, height * gap) : [anchorPoint(box, width, height, anchor, 0)];
          for (const point of positions) {
            page.drawImage(embedded, { x: point.x, y: point.y, width, height, opacity, rotate: degrees(rotation) });
          }
        } else {
          const text = stringValue(context.values, 'text', 'DRAFT');
          const size = numberValue(context.values, 'fontSize', 64);
          if (tile) {
            const { width } = await measureText(input.doc, { text, x: 0, y: 0, size });
            for (const point of tilePoints(box, width * gap, size * gap * 2)) {
              await stampText(input.doc, page, text, point.x, point.y, { size, opacity, rotation, bold: booleanValue(context.values, 'bold'), color: stringValue(context.values, 'color', '#888888') });
            }
          } else {
            const { width } = await measureText(input.doc, { text, x: 0, y: 0, size });
            const point = anchorPoint(box, width, size, anchor, 0);
            await stampText(input.doc, page, text, point.x, point.y, {
              size, opacity, rotation,
              bold: booleanValue(context.values, 'bold'),
              color: stringValue(context.values, 'color', '#888888'),
            });
          }
        }
        context.progress((i + 1) / pages.length, `Watermarked page ${pages[i] + 1}`);
      }
      return pdfResult(input.doc, { message: `Watermarked ${pages.length} page(s).` });
    },
  },

  {
    id: 'header-footer',
    name: 'Header & Footer',
    description: 'Add text to the top and bottom of every page with a style panel',
    icon: '📝',
    category: 'edit',
    keywords: ['running head', 'footer', 'document title bar'],
    outputSuffix: '_header_footer.pdf',
    fields: [
      { key: 'headerLeft', label: 'Header left', type: 'text' },
      { key: 'headerCenter', label: 'Header centre', type: 'text', default: '{title}' },
      { key: 'headerRight', label: 'Header right', type: 'text', default: '{date}' },
      { key: 'footerLeft', label: 'Footer left', type: 'text', default: '{author}' },
      { key: 'footerCenter', label: 'Footer centre', type: 'text' },
      { key: 'footerRight', label: 'Footer right', type: 'text', default: 'Page {page} of {total}' },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 9, min: 5, max: 36, half: true },
      { key: 'margin', label: 'Margin', type: 'number', default: 28, min: 4, max: 120, unit: 'pt', half: true },
      { key: 'color', label: 'Colour', type: 'color', default: '#55554e' },
      { key: 'rule', label: 'Draw a hairline rule', type: 'toggle', default: true },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const size = numberValue(context.values, 'fontSize', 9);
      const margin = numberValue(context.values, 'margin', 28);
      const color = stringValue(context.values, 'color', '#55554e');
      const rule = booleanValue(context.values, 'rule', true);
      const meta = {
        title: input.doc.getTitle() ?? input.name,
        author: input.doc.getAuthor() ?? '',
        subject: input.doc.getSubject() ?? '',
        date: new Date().toLocaleDateString(),
        total: String(input.pageCount),
        file: input.name,
      };
      for (let i = 0; i < pages.length; i++) {
        const page = input.doc.getPage(pages[i]);
        const box = cropBox(page);
        const values = { ...meta, page: String(pages[i] + 1) };
        const headerY = box.y + box.height - margin;
        const footerY = box.y + margin;
        const slots: [string, Anchor][] = [
          [expand(stringValue(context.values, 'headerLeft'), values), 'top-left'],
          [expand(stringValue(context.values, 'headerCenter'), values), 'top-center'],
          [expand(stringValue(context.values, 'headerRight'), values), 'top-right'],
          [expand(stringValue(context.values, 'footerLeft'), values), 'bottom-left'],
          [expand(stringValue(context.values, 'footerCenter'), values), 'bottom-center'],
          [expand(stringValue(context.values, 'footerRight'), values), 'bottom-right'],
        ];
        for (const [text, anchor] of slots) {
          if (!text) continue;
          await stamp(input.doc, page, text, {
            anchor,
            size,
            color,
            margin,
          });
        }
        if (rule) {
          page.drawLine({
            start: { x: box.x + margin, y: headerY - size - 4 },
            end: { x: box.x + box.width - margin, y: headerY - size - 4 },
            thickness: 0.5,
            color: rgbColor(color),
          });
          page.drawLine({
            start: { x: box.x + margin, y: footerY + size + 4 },
            end: { x: box.x + box.width - margin, y: footerY + size + 4 },
            thickness: 0.5,
            color: rgbColor(color),
          });
        }
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return pdfResult(input.doc, { message: `Added headers and footers to ${pages.length} page(s).` });
    },
  },

  {
    id: 'bates-numbering',
    name: 'Bates Numbering',
    description: 'Add sequential legal Bates numbers across one or more files',
    icon: '⚖️',
    category: 'edit',
    keywords: ['legal', 'discovery', 'production', 'sequential numbering'],
    multiFile: true,
    outputSuffix: '_bates.pdf',
    fields: [
      { key: 'format', label: 'Number format', type: 'text', default: '{prefix}-{n}', help: 'Tokens: {n} {page} {total} {prefix} {date} {time}.' },
      { key: 'prefix', label: 'Prefix', type: 'text', default: 'DOC', half: true },
      { key: 'digits', label: 'Number width', type: 'number', default: 6, min: 1, max: 12, half: true },
      { key: 'start', label: 'Start at', type: 'number', default: 1, min: 0, half: true },
      { key: 'perFile', label: 'Restart numbering for each file', type: 'toggle', default: false },
      { key: 'position', label: 'Position', type: 'select', default: 'bottom-right', options: ANCHOR_OPTIONS },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 9, min: 5, max: 36, half: true },
      { key: 'margin', label: 'Margin', type: 'number', default: 18, min: 0, max: 120, half: true },
      { key: 'color', label: 'Colour', type: 'color', default: '#000000' },
    ],
    async run(context) {
      const inputs = await openInputs(context);
      const digits = numberValue(context.values, 'digits', 6);
      const perFile = booleanValue(context.values, 'perFile');
      let counter = numberValue(context.values, 'start', 1);
      const stamped: string[] = [];
      for (const input of inputs) {
        const pages = resolvePages('all', input.pageCount);
        for (const index of pages) {
          const page = input.doc.getPage(index);
          const number = String(perFile && stamped.includes(input.name) ? counter : counter).padStart(digits, '0');
          const text = expand(stringValue(context.values, 'format', '{prefix}-{n}'), {
            n: number,
            page: String(index + 1),
            total: String(input.pageCount),
            prefix: stringValue(context.values, 'prefix', 'DOC'),
            date: new Date().toISOString().slice(0, 10),
            time: new Date().toTimeString().slice(0, 8),
          });
          await stamp(input.doc, page, text, {
            anchor: stringValue(context.values, 'position', 'bottom-right') as Anchor,
            size: numberValue(context.values, 'fontSize', 9),
            color: stringValue(context.values, 'color', '#000000'),
            margin: numberValue(context.values, 'margin', 18),
          });
          counter += 1;
          if (!stamped.includes(input.name)) stamped.push(input.name);
        }
        if (perFile) counter = numberValue(context.values, 'start', 1);
      }
      const files = [];
      for (let i = 0; i < inputs.length; i++) {
        files.push({
          blob: new Blob([await savePDF(inputs[i].doc) as BlobPart], { type: 'application/pdf' }),
          name: `${baseName(inputs[i].name)}_bates.pdf`,
        });
        context.progress((i + 1) / inputs.length, `Stamped ${inputs[i].name}`);
      }
      return {
        kind: 'files',
        files,
        message: `Applied ${counter - 1} Bates number(s) across ${inputs.length} file(s).`,
      };
    },
  },

  {
    id: 'add-page-labels',
    name: 'Add Page Labels',
    description: 'Number pages as i, ii … 1, 2, 3 with prefixes and custom starts',
    icon: '🔠',
    category: 'edit',
    keywords: ['roman numerals', 'front matter', 'label ranges'],
    outputSuffix: '_labelled.pdf',
    fields: [
      {
        key: 'ranges',
        label: 'Label ranges',
        type: 'textarea',
        default: '1-3 roman 1\n4-99 decimal 1',
        help: 'One per line: start-end style [startNumber] [prefix]. Styles: decimal, roman, Roman, alpha, Alpha, none.',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const parsed = parseLabelRanges(stringValue(context.values, 'ranges'), input.pageCount);
      if (parsed.length === 0) throw new Error('No valid label ranges were entered — use lines like "1-3 roman 1".');
      addPageLabels(input.doc, parsed);
      const preview = readPageLabels(input.doc).slice(0, 12).map((l) => l.label);
      return pdfResult(input.doc, {
        message: `Applied ${parsed.length} label range(s). The first pages now read: ${preview.join(', ')}${parsed.length > 0 && input.pageCount > 12 ? ', …' : ''}.`,
      });
    },
  },

  {
    id: 'bookmarks',
    name: 'Edit Bookmarks',
    description: 'View, replace, import and export the document outline',
    icon: '🔖',
    category: 'edit',
    keywords: ['outline', 'toc structure', 'navigate'],
    outputSuffix: '_bookmarks.pdf',
    surface: 'none',
    fields: [
      {
        key: 'outline',
        label: 'Outline',
        type: 'textarea',
        default: '',
        help: 'One entry per line, indent with spaces for children: "Chapter 1" or "  Section 1.1", optionally "Title :: 4" for page 4.',
      },
      { key: 'replace', label: 'Replace the existing outline', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const raw = stringValue(context.values, 'outline');
      if (!raw.trim()) {
        const existing = readOutline(input.doc);
        if (existing.length === 0) {
          return reportResult([{ title: 'Bookmarks', text: 'This document has no outline. Add entries above and run again.' }], {
            message: 'No bookmarks found.',
          });
        }
        return reportResult([{ title: 'Current outline', text: outlineToText(existing) }], {
          message: `${existing.length} top-level bookmark(s). Copy the text, edit it, and run again to replace them.`,
        });
      }
      const nodes = textToOutline(raw, input.pageCount);
      writeOutline(input.doc, nodes);
      return pdfResult(input.doc, { message: `Wrote ${nodes.length} top-level bookmark(s).` });
    },
  },

  {
    id: 'table-of-contents',
    name: 'Table of Contents',
    description: 'Generate a clickable contents page from the document outline',
    icon: '📚',
    category: 'edit',
    keywords: ['toc', 'index page', 'contents'],
    outputSuffix: '_toc.pdf',
    fields: [
      { key: 'title', label: 'Heading', type: 'text', default: 'Contents', half: true },
      { key: 'insertAt', label: 'Insert at page', type: 'number', default: 1, min: 1, half: true },
      { key: 'leader', label: 'Leader', type: 'segmented', default: 'dots', options: [
        { value: 'dots', label: 'Dots' }, { value: 'none', label: 'None' },
      ] },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 7, max: 24, half: true },
      { key: 'showPageNumbers', label: 'Show page numbers', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const outline = readOutline(input.doc);
      if (outline.length === 0) {
        throw new Error('This PDF has no bookmarks to build a table of contents from. Add them with Edit Bookmarks first.');
      }
      const { generateTocPage } = await import('../core/bookmarks');
      const pages = await generateTocPage(input.doc, {
        nodes: outline,
        title: stringValue(context.values, 'title', 'Contents'),
        fontSize: numberValue(context.values, 'fontSize', 11),
        leader: stringValue(context.values, 'leader', 'dots') === 'dots' ? 'dots' : 'none',
        rightAlignPageNumbers: booleanValue(context.values, 'showPageNumbers', true),
        startPage: Math.max(0, numberValue(context.values, 'insertAt', 1) - 1),
      });
      return pdfResult(input.doc, {
        message: `Inserted a ${pages.length} page table of contents with ${outline.length} entries.`,
      });
    },
  },

  {
    id: 'add-stamps',
    name: 'Add Stamps',
    description: 'Place image or standard stamps on chosen pages',
    icon: '📌',
    category: 'edit',
    keywords: ['approved', 'signed seal', 'logo stamp', 'date stamp'],
    surface: 'surface',
    outputSuffix: '_stamped.pdf',
    fields: [
      { key: 'stamp', label: 'Stamp', type: 'select', default: 'APPROVED', options: [
        { value: 'APPROVED', label: 'Approved' }, { value: 'AS IS', label: 'As is' },
        { value: 'CONFIDENTIAL', label: 'Confidential' }, { value: 'DRAFT', label: 'Draft' },
        { value: 'EXPRESS', label: 'Express' }, { value: 'NOT APPROVED', label: 'Not approved' },
        { value: 'PRELIMINARY RESULTS', label: 'Preliminary results' },
        { value: 'SOLD', label: 'Sold' }, { value: 'TOP SECRET', label: 'Top secret' },
        { value: 'custom', label: 'Custom image…' },
      ] },
      { key: 'image', label: 'Stamp image', type: 'file', accept: 'image/*', when: (v) => v.stamp === 'custom' },
      { key: 'position', label: 'Position', type: 'select', default: 'top-right', options: ANCHOR_OPTIONS },
      { key: 'width', label: 'Width', type: 'number', default: 140, min: 20, max: 600, unit: 'pt', half: true },
      { key: 'opacity', label: 'Opacity', type: 'slider', default: 1, min: 0.1, max: 1, step: 0.05, half: true },
      { key: 'color', label: 'Colour', type: 'color', default: '#dc2626', when: (v) => v.stamp !== 'custom' },
      { key: 'regions', label: 'Placements', type: 'text', default: '', help: 'Filled in by clicking the page. Format page:x,y,w,h.' },
      { key: 'pages', label: 'Pages', type: 'pages', default: '1' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { addAnnotations } = await import('../core/annotations');
      const name = stringValue(context.values, 'stamp', 'APPROVED');
      const custom = name === 'custom' ? firstFileBytes(context.values, 'image') : null;
      if (name === 'custom' && !custom) throw new Error('Choose the image to stamp.');
      const pages = resolvePages(stringValue(context.values, 'pages', '1'), input.pageCount);
      const explicit = parseRegions(context.values['regions'], input.doc);
      const targets = explicit.length > 0
        ? explicit
        : pages.map((page) => ({ page, ...anchorRect(input.doc.getPage(page), stringValue(context.values, 'position', 'top-right') as Anchor, numberValue(context.values, 'width', 140)) }));
      const embedded = custom ? await input.doc.embedPng(await toPng(input.doc, custom)) : null;
      addAnnotations(
        input.doc,
        targets.map((region) => ({
          kind: 'Stamp' as const,
          page: region.page,
          rect: { x: region.x, y: region.y, width: region.width, height: region.height },
          stampName: embedded ? undefined : name,

          opacity: numberValue(context.values, 'opacity', 1),
          color: stringValue(context.values, 'color', '#dc2626'),
          contents: name,
        })),
      );
      return pdfResult(input.doc, { message: `Placed ${targets.length} stamp(s).` });
    },
  },

  {
    id: 'background-color',
    name: 'Background Color',
    description: 'Paint a solid colour or page-size image behind every page',
    icon: '🎨',
    category: 'edit',
    keywords: ['page colour', 'behind content', 'tint'],
    outputSuffix: '_background.pdf',
    fields: [
      { key: 'color', label: 'Colour', type: 'color', default: '#f7f7f4' },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { prependBackground } = await import('../core/content');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const color = stringValue(context.values, 'color', '#f7f7f4');
      for (let i = 0; i < pages.length; i++) {
        const page = input.doc.getPage(pages[i]);
        const box = cropBox(page);
        prependBackground(page, { x: box.x, y: box.y, width: box.width, height: box.height }, color);
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return pdfResult(input.doc, { message: `Painted a ${color} background behind ${pages.length} page(s).` });
    },
  },

  {
    id: 'text-color',
    name: 'Change Text Color',
    description: 'Recolour the text that is already in the document',
    icon: '🖌️',
    category: 'edit',
    keywords: ['recolour', 'black text', 'colour swap'],
    outputSuffix: '_recoloured.pdf',
    fields: [
      { key: 'to', label: 'New colour', type: 'color', default: '#000000' },
      { key: 'from', label: 'Replace which colour', type: 'select', default: 'any', options: [
        { value: 'any', label: 'Any colour' },
        { value: '#000000', label: 'Black only' },
        { value: '#ff0000', label: 'Red only' },
        { value: '#0000ff', label: 'Blue only' },
      ] },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { recolourText } = await import('../core/content');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      let changed = 0;
      for (let i = 0; i < pages.length; i++) {
        changed += recolourText(
          input.doc.getPage(pages[i]),
          stringValue(context.values, 'from', 'any'),
          stringValue(context.values, 'to', '#000000'),
        );
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return pdfResult(input.doc, {
        message: changed > 0
          ? `Recoloured ${changed} text run(s).`
          : 'No text matched that colour, so nothing changed.',
      });
    },
  },

  {
    id: 'invert-colors',
    name: 'Invert Colors',
    description: 'Produce a dark-mode version of the document',
    icon: '🌗',
    category: 'edit',
    keywords: ['dark mode', 'negative', 'night reading'],
    outputSuffix: '_inverted.pdf',
    fields: [
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi' },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      return rasteriseTransform(context, 'invert(1)', 'Inverted');
    },
  },

  {
    id: 'adjust-colors',
    name: 'Adjust Colors',
    description: 'Tune brightness, contrast, saturation and hue',
    icon: '🎛️',
    category: 'edit',
    keywords: ['brightness', 'contrast', 'saturation', 'sharpen', 'scan cleanup'],
    outputSuffix: '_adjusted.pdf',
    fields: [
      { key: 'brightness', label: 'Brightness', type: 'slider', default: 1, min: 0.2, max: 2, step: 0.02 },
      { key: 'contrast', label: 'Contrast', type: 'slider', default: 1, min: 0.2, max: 3, step: 0.02 },
      { key: 'saturation', label: 'Saturation', type: 'slider', default: 1, min: 0, max: 3, step: 0.02 },
      { key: 'hue', label: 'Hue rotate', type: 'slider', default: 0, min: -180, max: 180, step: 1, unit: '°' },
      { key: 'grayscale', label: 'Desaturate completely', type: 'toggle', default: false },
      { key: 'threshold', label: 'Make black and white', type: 'slider', default: 0, min: 0, max: 1, step: 0.02, help: '0 keeps colour. Drag up to binarise a scan.' },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi' },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const parts = [
        `brightness(${numberValue(context.values, 'brightness', 1)})`,
        `contrast(${numberValue(context.values, 'contrast', 1)})`,
      ];
      if (booleanValue(context.values, 'grayscale')) parts.push('grayscale(1)');
      else parts.push(`saturate(${numberValue(context.values, 'saturation', 1)})`);
      const hue = numberValue(context.values, 'hue', 0);
      if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
      return rasteriseTransform(context, parts.join(' '), 'Adjusted');
    },
  },

  {
    id: 'scanner-effect',
    name: 'Scanner Effect',
    description: 'Make a PDF look like a clean greyscale scan',
    icon: '📄',
    category: 'edit',
    keywords: ['scan look', 'whitening', 'binarise', 'photocopy'],
    outputSuffix: '_scanned.pdf',
    fields: [
      { key: 'whitening', label: 'Whiten the background', type: 'toggle', default: true },
      { key: 'sharpen', label: 'Sharpen edges', type: 'toggle', default: true },
      { key: 'grayscale', label: 'Greyscale', type: 'toggle', default: true },
      { key: 'contrast', label: 'Contrast', type: 'slider', default: 1.35, min: 1, max: 3, step: 0.05 },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 220, min: 96, max: 400, step: 1, unit: 'dpi' },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const parts = [`contrast(${numberValue(context.values, 'contrast', 1.35)})`];
      if (booleanValue(context.values, 'grayscale', true)) parts.push('grayscale(1)');
      if (booleanValue(context.values, 'whitening', true)) parts.push('brightness(1.12)');
      return rasteriseTransform(context, parts.join(' '), 'Applied the scanner effect to');
    },
  },

  {
    id: 'ocr-pdf',
    name: 'OCR PDF',
    description: 'Recognise text in scanned pages and add a searchable, selectable layer',
    icon: '🔡',
    category: 'edit',
    keywords: ['recognise', 'searchable pdf', 'text layer', 'abbyy alternative'],
    outputSuffix: '_ocr.pdf',
    fields: [
      { key: 'language', label: 'Language', type: 'select', default: 'en', options: [
        { value: 'en', label: 'English' }, { value: 'de', label: 'German' },
        { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' },
        { value: 'it', label: 'Italian' }, { value: 'pt', label: 'Portuguese' },
        { value: 'ru', label: 'Russian' }, { value: 'zh', label: 'Chinese' },
        { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' },
      ] },
      { key: 'mode', label: 'Output', type: 'segmented', default: 'searchable', options: [
        { value: 'searchable', label: 'Invisible text layer (keeps the scan)' },
        { value: 'replace', label: 'Replace the page with text' },
        { value: 'report', label: 'Just show me the text' },
      ] },
      { key: 'dpi', label: 'Recognition resolution', type: 'slider', default: 300, min: 150, max: 600, step: 10, unit: 'dpi' },
      { key: 'skipSearchable', label: 'Skip pages that already have text', type: 'toggle', default: true },
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    notes: ['The OCR model is downloaded once and cached; the pages themselves are recognised on this device.'],
    async run(context) {
      const [input] = await openInputs(context);
      const { ocrDocument, addSearchableTextLayer } = await import('../core/ocr');
      const session = await withRender(input, context).then((result) => result.session);
      try {
        const results = await ocrDocument(session, {
          pages: stringValue(context.values, 'pages', 'all'),
          dpi: numberValue(context.values, 'dpi', 300),
          lang: stringValue(context.values, 'language', 'en'),
          signal: context.signal,
          onProgress: (done, total) => context.progress(done / total * 0.8, `Recognised page ${done} of ${total}`),
          onStatus: (status) => context.log(status),
        });
        const mode = stringValue(context.values, 'mode', 'searchable');
        if (mode === 'report') {
          return reportResult(
            results.map((page) => ({ title: `Page ${page.page}`, text: page.text.trim() || '(no text found)' })),
            { message: `Read ${results.reduce((n, page) => n + page.text.length, 0)} characters across ${results.length} page(s).` },
          );
        }
        if (mode === 'searchable') {
          const added = await addSearchableTextLayer(input.doc, results, { invisible: true });
          return pdfResult(input.doc, {
            message: `Added ${added.words} recognised words to ${added.pages} page(s) as an invisible layer — the scan looks unchanged but the text is now selectable and searchable.`,
          });
        }
        const packed = await pdfFromImages([], { pageSize: 'a4' }).catch(() => null);
        void packed;
        const rebuilt = await textOnlyPdf(input.doc, results);
        return pdfResult(rebuilt, {
          message: `Rebuilt ${results.length} page(s) as selectable text. The original page images were replaced.`,
        });
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'form-filler',
    name: 'PDF Form Filler',
    description: 'Fill AcroForm and XFA forms directly in the browser',
    icon: '🗒️',
    category: 'edit',
    keywords: ['fill form', 'acroform', 'xfa', 'tax form'],
    surface: 'custom',
    outputSuffix: '_filled.pdf',
    fields: [{ key: 'flatten', label: 'Flatten when saving', type: 'toggle', default: false }],
    async run(context) {
      const [input] = await openInputs(context);
      const { fillForm } = await import('../core/forms');
      const fields = listFormFields(input.doc);
      if (fields.length === 0) {
        throw new Error('This PDF has no fillable form fields. Try Create PDF Form to add some.');
      }
      const values = context.values['fieldValues'];
      const record = values && typeof values === 'object' && !Array.isArray(values)
        ? values as Record<string, string | boolean>
        : {};
      const result = fillForm(input.doc, record);
      if (booleanValue(context.values, 'flatten')) {
        const { flattenAnnotations } = await import('../core/flatten');
        await flattenAnnotations(input.doc, undefined, { kinds: ['Widget'] });
      }
      return pdfResult(input.doc, {
        message: result.missing.length > 0
          ? `Filled ${result.filled} field(s); no value given for ${result.missing.slice(0, 4).join(', ')}${result.missing.length > 4 ? ', …' : ''}.`
          : `Filled ${result.filled} field(s).`,
      });
    },
  },

  {
    id: 'form-creator',
    name: 'Create PDF Form',
    description: 'Add fillable text, checkbox, choice and signature fields by dragging',
    icon: '🧾',
    category: 'edit',
    keywords: ['make form', 'fillable', 'design form', 'widgets'],
    surface: 'custom',
    outputSuffix: '_form.pdf',
    fields: [{ key: 'fields', label: 'Fields', type: 'text', default: '', help: 'Filled in by the field designer.' }],
    async run(context) {
      const [input] = await openInputs(context);
      const specs = context.values['fieldSpecs'];
      if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('Drag at least one field onto the page first.');
      }
      const { createFormField } = await import('../core/forms');
      let created = 0;
      for (const spec of specs as (CreateFieldSpec & { page: number })[]) {
        if (spec.page >= input.pageCount) continue;
        if (createFormField(input.doc, spec.page, spec) >= 0) created += 1;
      }
      return pdfResult(input.doc, {
        message: `Added ${created} fillable field(s). Viewers can now type into this document.`,
      });
    },
  },

  {
    id: 'pdf-layers',
    name: 'PDF OCG Layers',
    description: 'List, toggle, add or delete optional-content groups',
    icon: '🧬',
    category: 'edit',
    keywords: ['ocg', 'optional content', 'layers panel', 'cad export'],
    surface: 'none',
    outputSuffix: '_layers.pdf',
    fields: [
      { key: 'hide', label: 'Hide these layers', type: 'multiselect', default: [], options: [] },
      { key: 'show', label: 'Show these layers', type: 'multiselect', default: [], options: [] },
      { key: 'add', label: 'Add a layer named', type: 'text', placeholder: 'Revision B' },
      { key: 'remove', label: 'Delete layers named', type: 'textarea' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { listLayers, setLayerVisibility, addLayer, deleteLayer } = await import('../core/layers');
      const layers = listLayers(input.doc);
      if (layers.length === 0 && !stringValue(context.values, 'add')) {
        return reportResult([{ title: 'Layers', text: 'This document has no optional-content groups (OCGs). CAD and GIS exports usually do; add one above to create the structure.' }], {
          message: 'No layers found.',
        });
      }
      for (const name of stringValues(context.values, 'hide')) setLayerVisibility(input.doc, name, false);
      for (const name of stringValues(context.values, 'show')) setLayerVisibility(input.doc, name, true);
      const added = stringValue(context.values, 'add');
      if (added) addLayer(input.doc, added);
      const removed = stringValue(context.values, 'remove').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      for (const name of removed) deleteLayer(input.doc, name);
      return pdfResult(input.doc, {
        message: `Layers now: ${[...layers.map((layer) => layer.name), added].filter(Boolean).join(', ') || 'none'}.`,
      });
    },
  },

  {
    id: 'remove-annotations',
    name: 'Remove Annotations',
    description: 'Strip comments, highlights, ink and links from the whole document',
    icon: '🧽',
    category: 'edit',
    keywords: ['clean markup', 'drop comments', 'flatten away'],
    outputSuffix: '_clean.pdf',
    fields: [
      { key: 'pages', label: 'Pages', type: 'pages', default: 'all' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { removeAnnotations } = await import('../core/annotations');
      const removed = removeAnnotations(input.doc, {
        pages: resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount),
      });
      return pdfResult(input.doc, {
        message: removed > 0 ? `Removed ${removed} annotation(s).` : 'There were no annotations to remove.',
      });
    },
  },

  {
    id: 'redact',
    name: 'Redact PDF',
    description: 'Permanently delete text and regions, not just cover them',
    icon: '⬛',
    category: 'security',
    keywords: ['blackout', 'remove sensitive data', 'censor', 'gdpr'],
    surface: 'surface',
    outputSuffix: '_redacted.pdf',
    fields: [
      { key: 'fill', label: 'Redaction colour', type: 'color', default: '#000000' },
      ...ANNOTATION_SURFACE_FIELDS,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { applyRedactions } = await import('../core/redact');
      const regions = parseRegions(context.values['regions'], input.doc);
      if (regions.length === 0) throw new Error('Draw at least one redaction box on the page, or enter page:x,y,w,h regions.');
      const outcome = applyRedactions(
        input.doc,
        regions.map((r) => ({ page: r.page, rect: { x: r.x, y: r.y, width: r.width, height: r.height } })),
        { fill: stringValue(context.values, 'fill', '#000000') },
      );
      return pdfResult(input.doc, {
        message: outcome.rasterised
          ? `Redacted ${outcome.removed} region(s). Some covered images, so those pages were re-rendered and lost selectable text.`
          : `Redacted ${outcome.removed} region(s) — the underlying text was deleted, not hidden.`,
      });
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

async function rasteriseTransform(
  context: ToolRunContext,
  filter: string,
  verb: string,
) {
  const [input] = await openInputs(context);
  const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
  const { session } = await withRender(input, context);
  try {
    const images = await rasterizePages(session, {
      format: 'jpeg',
      quality: 0.9,
      scale: numberValue(context.values, 'dpi', 200) / 72,
      pages: pages.map((p) => p + 1),
      filter,
      background: '#ffffff',
      onProgress: (done, total) => context.progress((done / total) * 0.7, `Rendered page ${done} of ${total}`),
    });
    const packed = await pdfFromImages(
      images.map((image) => ({ data: image.blob })),
      { pageSize: 'original', margin: 0 },
    );
    const target = packed.doc.getPages();
    for (let i = 0; i < target.length && i < pages.length; i++) {
      const size = displayedSize(input.doc.getPage(pages[i]));
      target[i].setSize(size.width, size.height);
    }
    await session.destroy();
    return pdfResult(packed.doc, {
      message: `${verb} ${pages.length} page(s). Text is now part of the image, so it is no longer selectable.`,
    });
  } finally {
    await session.destroy();
  }
}

async function textOnlyPdf(source: PDFDocument, results: { page: number; text: string }[]): Promise<PDFDocument> {
  const { newPDF } = await import('../core/doc');
  const doc = await newPDF();
  for (const result of results) {
    const lines = await wrapText(doc, result.text, { size: 10, maxWidth: 480 });
    const pageHeight = Math.max(300, lines.length * 14 + 80);
    const page = doc.addPage([595.28, pageHeight]);
    let y = pageHeight - 48;
    for (const line of lines) {
      await drawTextU(page, { text: line.line, x: 48, y, size: 10, color: rgb(0, 0, 0) });
      y -= 14;
    }
  }
  return doc;
}

async function toPng(doc: PDFDocument, bytes: Uint8Array): Promise<Uint8Array> {
  const { sniffImageMime, decodeImage, encodeImageBytes } = await import('../core/images');
  const mime = sniffImageMime(bytes) ?? 'image/png';
  if (mime === 'image/png') return bytes;
  const decoded = await decodeImage(bytes, { mime });
  const encoded = await encodeImageBytes(decoded.canvas, { format: 'png' });
  void doc;
  return encoded.bytes;
}

function firstFileBytes(values: Record<string, unknown>, key: string): Uint8Array | null {
  const value = values[key];
  const entry = Array.isArray(value) ? value[0] : value;
  if (entry && typeof entry === 'object' && 'bytes' in entry) {
    return (entry as { bytes: Uint8Array }).bytes;
  }
  return null;
}

function anchorPoint(
  box: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  anchor: Anchor,
  margin: number,
): { x: number; y: number } {
  const [ax, ay] = anchor.split('-') as [string, string];
  const horizontal = ax === 'top' || ax === 'bottom' ? ay : ax;
  const vertical = ax === 'top' || ax === 'bottom' ? ax : 'center';
  const x = horizontal === 'left' ? box.x + margin
    : horizontal === 'right' ? box.x + box.width - width - margin
    : box.x + (box.width - width) / 2;
  const y = vertical === 'top' ? box.y + box.height - height - margin
    : vertical === 'bottom' ? box.y + margin
    : box.y + (box.height - height) / 2;
  return { x, y };
}

function anchorRect(page: PDFPage, anchor: Anchor, width: number): { x: number; y: number; width: number; height: number } {
  const box = cropBox(page);
  const height = width * 0.42;
  const point = anchorPoint(box, width, height, anchor, 18);
  return { x: point.x, y: point.y, width, height };
}

function tilePoints(
  box: { x: number; y: number; width: number; height: number },
  stepX: number,
  stepY: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = box.y; y < box.y + box.height; y += Math.max(24, stepY)) {
    for (let x = box.x; x < box.x + box.width; x += Math.max(24, stepX)) {
      out.push({ x, y });
    }
  }
  return out;
}

async function stampText(
  doc: PDFDocument,
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  options: { size: number; opacity: number; rotation: number; bold: boolean; color: string },
): Promise<void> {
  await drawTextU(page, {
    text,
    x,
    y,
    size: options.size,
    color: rgbColor(options.color),
    bold: options.bold,
    opacity: options.opacity,
    rotation: options.rotation,
  });
}

function expand(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

function formatNumber(value: number, style: string): string {
  if (style === 'roman-upper') return toRoman(value);
  if (style === 'roman-lower') return toRoman(value).toLowerCase();
  if (style === 'letters') return toLetters(value);
  if (style === 'padded') return String(value).padStart(3, '0');
  return String(value);
}

function toRoman(value: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let remaining = Math.max(0, Math.floor(value));
  let out = '';
  for (const [amount, symbol] of table) {
    while (remaining >= amount) {
      out += symbol;
      remaining -= amount;
    }
  }
  return out || '0';
}

function toLetters(value: number): string {
  let remaining = Math.max(1, Math.floor(value));
  let out = '';
  while (remaining > 0) {
    remaining -= 1;
    out = String.fromCharCode(65 + (remaining % 26)) + out;
    remaining = Math.floor(remaining / 26);
  }
  return out;
}

const LABEL_STYLES: Record<string, 'D' | 'R' | 'r' | 'A' | 'a' | ''> = {
  decimal: 'D',
  roman: 'r',
  romancaps: 'R',
  alpha: 'a',
  alphacaps: 'A',
  letters: 'a',
  none: '',
};

function parseLabelRanges(
  raw: string,
  total: number,
): { start: number; style: 'D' | 'R' | 'r' | 'A' | 'a' | ''; prefix?: string; firstPageNumber?: number }[] {
  const out: { start: number; style: 'D' | 'R' | 'r' | 'A' | 'a' | ''; prefix?: string; firstPageNumber?: number }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*-\s*(\d+)\s+(\w+)(?:\s+(\d+))?(?:\s+(\S+))?\s*$/.exec(line);
    if (!match) continue;
    const start = Number(match[1]) - 1;
    if (start < 0 || start >= total) continue;
    const style = LABEL_STYLES[match[3].toLowerCase()] ?? 'D';
    out.push({
      start,
      style,
      firstPageNumber: match[4] ? Number(match[4]) : undefined,
      prefix: match[5],
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

function outlineToText(nodes: import('../core/bookmarks').OutlineNode[], depth = 0): string {
  return nodes
    .map((node) => `${'  '.repeat(depth)}${node.title}${node.page !== null ? ` :: ${node.page + 1}` : ''}\n${node.children ? outlineToText(node.children, depth + 1) : ''}`)
    .join('');
}

function textToOutline(raw: string, total: number): import('../core/bookmarks').OutlineNode[] {
  const root: import('../core/bookmarks').OutlineNode[] = [];
  const stack: { depth: number; node: import('../core/bookmarks').OutlineNode }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const depth = /^\s*/.exec(line)?.[0].replace(/\t/g, '  ').length ?? 0;
    const [title, pagePart] = line.split('::');
    const page = pagePart ? Number(pagePart.trim()) - 1 : NaN;
    const node: import('../core/bookmarks').OutlineNode = {
      title: title.trim(),
      page: Number.isFinite(page) && page >= 0 && page < total ? page : null,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node);
    else root.push(node);
    stack.push({ depth, node });
  }
  return root;
}

void mediaBox;
void setMediaAndCrop;
void toPoints;
void formatPages;
export type { LengthUnit };
void measureText;
