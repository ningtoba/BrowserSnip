/**
 * Organize PDF — page-order, page-geometry and imposition tools.
 *
 * Everything here is pure `pdf-lib`: page copying, form-XObject imposition and
 * page-box edits. No optional engine is required, so these tools work with the
 * network unplugged.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
import {
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  degrees,
  rgb,
} from '../core/doc';
import {
  collectPages,
  drawPageInto,
  newPDF,
  openPDF,
  savePDF,
} from '../core/doc';
import {
  PAGE_SIZES,
  displayedSize,
  formatPages,
  mediaBox,
  normaliseRotation,
  pageSize as resolvePageSize,
  resolvePages,
} from '../core/pages';
import { findBlankPages } from '../core/blank';
import { createZip } from '../core/archive';
import { withRender, openInputs, pdfResult, filesResult, reportResult, baseName } from './helpers';
import { numberValue, stringValue, booleanValue, type PdfToolDefinition } from './types';

const ALL_PAGES = {
  key: 'pages',
  label: 'Pages',
  type: 'pages' as const,
  default: 'all',
  help: 'Leave as "all", or use 1,3,5-7, odd, even.',
};

/** Rebuild a document as `count` blank sheets of `size`, then stamp sources. */
async function sheetDocument(
  source: PDFDocument,
  size: [number, number],
  cells: { sheet: number; cell: number; page: number }[],
  cellsPerSheet: number,
  cellBox: (cell: number) => { x: number; y: number; width: number; height: number },
): Promise<PDFDocument> {
  const sheetCount = Math.max(1, Math.ceil(cells.length / cellsPerSheet));
  const target = await newPDF();
  const blank = new Array(sheetCount).fill(0).map(() => target.addPage(size));
  for (const item of cells) {
    const page = blank[item.sheet];
    if (!page) continue;
    if (item.page < 0 || item.page >= source.getPageCount()) continue;
    await drawPageInto(target, page, source.getPage(item.page), cellBox(item.cell));
  }
  return target;
}

function gridBox(
  sheetWidth: number,
  sheetHeight: number,
  columns: number,
  rows: number,
  gutter: number,
  margin: number,
) {
  const usableWidth = sheetWidth - margin * 2 - gutter * (columns - 1);
  const usableHeight = sheetHeight - margin * 2 - gutter * (rows - 1);
  const cellWidth = usableWidth / columns;
  const cellHeight = usableHeight / rows;
  return (cell: number) => {
    const col = cell % columns;
    const row = Math.floor(cell / columns);
    return {
      x: margin + col * (cellWidth + gutter),
      // Rows are laid out top-down in the UI, but PDF y grows upward.
      y: sheetHeight - margin - (row + 1) * cellHeight - row * gutter,
      width: cellWidth,
      height: cellHeight,
    };
  };
}

const PAGE_SIZE_OPTIONS = [
  { value: 'same', label: 'Same as source page' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
];

export const organizeTools: PdfToolDefinition[] = [
  {
    id: 'merge',
    name: 'Merge PDF',
    description: 'Combine multiple PDFs into one file, with bookmarks for each source',
    icon: '📑',
    category: 'organize',
    keywords: ['combine', 'join', 'append', 'stitch'],
    multiFile: true,
    minFiles: 1,
    outputSuffix: '_merged.pdf',
    fields: [
      {
        key: 'bookmarks',
        label: 'Add a bookmark for each file',
        type: 'toggle',
        default: true,
        help: 'Creates a top-level outline entry pointing at the first page of every merged file.',
      },
      {
        key: 'blankBetween',
        label: 'Blank page between files',
        type: 'toggle',
        default: false,
      },
    ],
    validate: (_values, { fileCount }) =>
      fileCount < 2 ? 'Add at least two PDF files to merge.' : null,
    async run(context) {
      const inputs = await openInputs(context);
      const target = await newPDF();
      const marks: { title: string; page: number }[] = [];
      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        const start = target.getPageCount();
        marks.push({ title: input.name, page: start });
        const copied = await target.copyPages(input.doc, resolvePages('all', input.pageCount));
        copied.forEach((page) => target.addPage(page));
        if (booleanValue(context.values, 'blankBetween') && i < inputs.length - 1) {
          const size = displayedSize(target.getPage(start));
          target.addPage([size.width, size.height]);
        }
        context.progress((i + 1) / inputs.length, `Added ${input.name}`);
      }
      if (booleanValue(context.values, 'bookmarks')) {
        const written = writeFlatOutline(target, marks);
        if (written === 0) {
          context.log('Bookmarks could not be written for these files, so the merge continued without them.');
        }
      }
      target.setProducer('BrowserSnip');
      return pdfResult(target, {});
    },
  },

  {
    id: 'split',
    name: 'Split PDF',
    description: 'Split into ranges, every page, odd/even, or fixed-size chunks',
    icon: '✂️',
    category: 'organize',
    keywords: ['divide', 'separate', 'extract', 'ranges'],
    outputSuffix: '_split',
    fields: [
      {
        key: 'mode',
        label: 'Split by',
        type: 'segmented',
        default: 'ranges',
        options: [
          { value: 'ranges', label: 'Ranges' },
          { value: 'every', label: 'Every page' },
          { value: 'oddEven', label: 'Odd / even' },
          { value: 'chunks', label: 'Fixed chunks' },
        ],
      },
      {
        key: 'ranges',
        label: 'Page ranges',
        type: 'text',
        default: '',
        placeholder: '1-3, 5, 8-10',
        help: 'Each range becomes its own PDF. Leave empty to use the whole document.',
        when: (v) => v.mode === 'ranges',
      },
      {
        key: 'chunkSize',
        label: 'Pages per file',
        type: 'number',
        default: 2,
        min: 1,
        max: 500,
        when: (v) => v.mode === 'chunks',
      },
      {
        key: 'oddEven',
        label: 'Which side',
        type: 'select',
        default: 'both',
        options: [
          { value: 'both', label: 'Two files (odd and even)' },
          { value: 'odd', label: 'Odd pages only' },
          { value: 'even', label: 'Even pages only' },
        ],
        when: (v) => v.mode === 'oddEven',
      },
    ],
    validate(values) {
      const mode = stringValue(values, 'mode', 'ranges');
      if (mode === 'ranges' && stringValue(values, 'ranges').trim() === '') {
        return 'Enter at least one page range, for example 1-3, or choose a different split mode.';
      }
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const mode = stringValue(context.values, 'mode', 'ranges');
      const total = input.pageCount;
      const groups: { name: string; pages: number[] }[] = [];

      if (mode === 'every') {
        for (let i = 0; i < total; i++) groups.push({ name: `page-${i + 1}`, pages: [i] });
      } else if (mode === 'oddEven') {
        const which = stringValue(context.values, 'oddEven', 'both');
        const odd = resolvePages('odd', total);
        const even = resolvePages('even', total);
        if (which !== 'even') groups.push({ name: 'odd-pages', pages: odd });
        if (which !== 'odd') groups.push({ name: 'even-pages', pages: even });
      } else if (mode === 'chunks') {
        const size = Math.max(1, numberValue(context.values, 'chunkSize', 2));
        for (let i = 0; i < total; i += size) {
          const pages: number[] = [];
          for (let p = i; p < Math.min(i + size, total); p++) pages.push(p);
          groups.push({
            name: `pages-${pages[0] + 1}-${pages[pages.length - 1] + 1}`,
            pages,
          });
        }
      } else {
        const spec = stringValue(context.values, 'ranges');
        for (const chunk of spec.split(/[,\n;]+/)) {
          const trimmed = chunk.trim();
          if (!trimmed) continue;
          groups.push({ name: trimmed.replace(/[^\d\-–]/g, ''), pages: resolvePages(trimmed, total) });
        }
        if (groups.length === 0) {
          throw new Error(`"${spec}" did not contain a usable page range.`);
        }
      }

      const files: { blob: Blob; name: string }[] = [];
      const stem = baseName(input.name);
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const doc = await collectPages([{ doc: input.doc, pages: group.pages }]);
        const bytes = await savePDF(doc.doc);
        files.push({
          blob: new Blob([bytes], { type: 'application/pdf' }),
          name: `${stem}_${group.name}.pdf`,
        });
        context.progress((i + 1) / groups.length, `Wrote ${group.name}`);
      }
      return filesResult(
        files,
        `Created ${files.length} file${files.length === 1 ? '' : 's'} from ${total} pages.`,
      );
    },
  },

  {
    id: 'extract-pages',
    name: 'Extract Pages',
    description: 'Pull selected pages out as a new PDF, or one PDF per page',
    icon: '📤',
    category: 'organize',
    keywords: ['keep', 'separate', 'pull'],
    outputSuffix: '_extracted.pdf',
    fields: [
      ALL_PAGES,
      {
        key: 'mergeIntoOne',
        label: 'Combine into a single PDF',
        type: 'toggle',
        default: true,
        help: 'Turn this off to get one separate file per selected page.',
      },
    ],
    validate(values) {
      const spec = stringValue(values, 'pages', 'all').trim();
      if (spec === '' ) return 'Choose which pages to extract.';
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      if (booleanValue(context.values, 'mergeIntoOne', true)) {
        const doc = await collectPages([{ doc: input.doc, pages }]);
        return pdfResult(doc.doc, { message: `Extracted ${pages.length} of ${input.pageCount} pages.` });
      }
      const stem = baseName(input.name);
      const files: { blob: Blob; name: string }[] = [];
      for (let i = 0; i < pages.length; i++) {
        const doc = await collectPages([{ doc: input.doc, pages: [pages[i]] }]);
        const bytes = await savePDF(doc.doc);
        files.push({
          blob: new Blob([bytes], { type: 'application/pdf' }),
          name: `${stem}_page-${pages[i] + 1}.pdf`,
        });
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return filesResult(files, `Created ${files.length} single-page files.`);
    },
  },

  {
    id: 'remove-pages',
    name: 'Delete Pages',
    description: 'Remove the pages you pick and keep everything else',
    icon: '🗑️',
    category: 'organize',
    keywords: ['delete', 'drop', 'discard'],
    outputSuffix: '_trimmed.pdf',
    surface: 'pages',
    fields: [ALL_PAGES],
    validate(values) {
      const spec = stringValue(values, 'pages', '').trim();
      if (spec === '' || spec.toLowerCase() === 'all') {
        return 'Select the pages to delete — deleting every page would leave an empty PDF.';
      }
      return null;
    },
    async run(context) {
      const [input] = await openInputs(context);
      const drop = new Set(resolvePages(stringValue(context.values, 'pages', ''), input.pageCount));
      const keep = resolvePages('all', input.pageCount).filter((p) => !drop.has(p));
      if (keep.length === 0) throw new Error('That would delete every page. Keep at least one.');
      const doc = await collectPages([{ doc: input.doc, pages: keep }]);
      return pdfResult(doc.doc, {
        message: `Removed ${drop.size} page${drop.size === 1 ? '' : 's'}.`,
      });
    },
  },

  {
    id: 'organize',
    name: 'Organize PDF',
    description: 'Drag to reorder, then rotate, duplicate, delete or insert blank pages',
    icon: '📋',
    category: 'organize',
    keywords: ['reorder', 'arrange', 'move', 'duplicate'],
    outputSuffix: '_organized.pdf',
    surface: 'custom',
    fields: [
      {
        key: 'pageOrder',
        label: 'Page order',
        type: 'text',
        default: '',
        placeholder: 'auto from the page grid',
        help: 'Comma-separated source page numbers, optionally suffixed with r90/r180/r270 to rotate, or "blank".',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const spec = stringValue(context.values, 'pageOrder', '').trim();
      const plan = spec ? parsePlan(spec, input.pageCount) : defaultPlan(input.pageCount);
      const target = await newPDF();
      let planIndex = 0;
      for (const item of plan) {
        if (item.blank) {
          const base = target.getPageCount() > 0
            ? displayedSize(target.getPage(target.getPageCount() - 1))
            : displayedSize(input.doc.getPage(0));
          target.insertPage(planIndex, [base.width, base.height]);
        } else {
          const copied = await target.copyPages(input.doc, [item.page]);
          const page = copied[0];
          if (item.rotate) page.setRotation(degrees(normaliseRotation(item.rotate)));
          target.insertPage(planIndex, page);
        }
        planIndex += 1;
        context.progress(
          planIndex / plan.length,
          item.blank ? 'Inserted a blank page' : `Placed source page ${item.page + 1}`,
        );
      }
      if (target.getPageCount() === 0) throw new Error('The new page order is empty.');
      return pdfResult(target, { message: `Rebuilt the document with ${target.getPageCount()} pages.` });
    },
  },

  {
    id: 'rotate',
    name: 'Rotate PDF',
    description: 'Turn pages by 90°, 180° or 270° — whole document or a selection',
    icon: '🔄',
    category: 'organize',
    keywords: ['turn', 'landscape', 'portrait', 'orientation'],
    outputSuffix: '_rotated.pdf',
    surface: 'pages',
    fields: [
      {
        key: 'degrees',
        label: 'Rotation',
        type: 'segmented',
        default: 90,
        options: [
          { value: 90, label: '90° →' },
          { value: 180, label: '180°' },
          { value: 270, label: '270° ←' },
        ],
      },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const delta = numberValue(context.values, 'degrees', 90);
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const all = input.doc.getPages();
      for (const index of pages) {
        const page = all[index];
        page.setRotation(degrees(normaliseRotation(page.getRotation().angle + delta)));
      }
      return pdfResult(input.doc, {
        message: `Rotated ${pages.length} page${pages.length === 1 ? '' : 's'} by ${delta}°.`,
      });
    },
  },

  {
    id: 'rotate-custom',
    name: 'Rotate by Custom Degrees',
    description: 'Rotate page content by any angle, not just 90° steps',
    icon: '↩️',
    category: 'organize',
    keywords: ['skew', 'straighten', 'angle', 'de-angle'],
    outputSuffix: '_rotated.pdf',
    fields: [
      {
        key: 'angle',
        label: 'Angle',
        type: 'slider',
        default: 2,
        min: -180,
        max: 180,
        step: 0.1,
        unit: '°',
        help: 'Positive turns clockwise. Any angle that is not a 90° step re-lays the page as vector content.',
      },
      {
        key: 'fit',
        label: 'Page size',
        type: 'select',
        default: 'grow',
        options: [
          { value: 'grow', label: 'Grow the page so nothing is cut' },
          { value: 'keep', label: 'Keep the original page size (may crop corners)' },
        ],
      },
      ALL_PAGES,
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const angle = numberValue(context.values, 'angle', 2);
      const grow = stringValue(context.values, 'fit', 'grow') === 'grow';
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const target = await cloneForOutput(input.doc);
      const all = target.getPages();
      const step = 1 / Math.max(1, pages.length);
      for (let i = 0; i < pages.length; i++) {
        const page = all[pages[i]];
        await rotatePageContent(target, page, angle, grow);
        context.progress((i + 1) * step, `Rotated page ${pages[i] + 1}`);
      }
      return pdfResult(target, { message: `Rotated ${pages.length} page(s) by ${angle}°.` });
    },
  },

  {
    id: 'reverse-pages',
    name: 'Reverse Pages',
    description: 'Flip the page order of the whole document',
    icon: '🔃',
    category: 'organize',
    keywords: ['invert order', 'backwards', 'descending'],
    outputSuffix: '_reversed.pdf',
    async run(context) {
      const [input] = await openInputs(context);
      const pages = resolvePages('all', input.pageCount);
      const doc = await collectPages([{ doc: input.doc, pages: [...pages].reverse() }]);
      return pdfResult(doc.doc, { message: `Reversed ${pages.length} pages.` });
    },
  },

  {
    id: 'add-blank-page',
    name: 'Add Blank Page',
    description: 'Insert blank pages at the start, end, or after any page',
    icon: '📄',
    category: 'organize',
    keywords: ['insert', 'empty', 'spacer', 'sheet'],
    outputSuffix: '_with_blanks.pdf',
    fields: [
      {
        key: 'position',
        label: 'Where',
        type: 'select',
        default: 'end',
        options: [
          { value: 'start', label: 'Before the first page' },
          { value: 'end', label: 'After the last page' },
          { value: 'after', label: 'After a specific page' },
          { value: 'before', label: 'Before a specific page' },
        ],
      },
      {
        key: 'anchor',
        label: 'Page number',
        type: 'number',
        default: 1,
        min: 1,
        when: (v) => v.position === 'after' || v.position === 'before',
      },
      { key: 'count', label: 'How many', type: 'number', default: 1, min: 1, max: 200 },
      { key: 'size', label: 'Size', type: 'select', default: 'same', options: PAGE_SIZE_OPTIONS },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const count = Math.max(1, numberValue(context.values, 'count', 1));
      const position = stringValue(context.values, 'position', 'end');
      const anchor = numberValue(context.values, 'anchor', 1);
      const sizeSpec = stringValue(context.values, 'size', 'same');
      const baseSize = displayedSize(input.doc.getPage(0));
      const size: [number, number] =
        sizeSpec === 'same' ? [baseSize.width, baseSize.height] : resolvePageSize(sizeSpec);
      const blank = await newPDF();
      for (let i = 0; i < count; i++) blank.addPage(size);
      const target = await newPDF();
      const all = await target.copyPages(input.doc, resolvePages('all', input.pageCount));
      all.forEach((p) => target.addPage(p));
      const insertAt =
        position === 'start' ? 0
        : position === 'end' ? target.getPageCount()
        : position === 'after' ? Math.min(target.getPageCount(), anchor)
        : Math.max(0, anchor - 1);
      for (let i = 0; i < count; i++) {
        target.insertPage(insertAt + i, size);
        context.progress((i + 1) / count, `Inserted blank page ${i + 1}`);
      }
      return pdfResult(target, {
        message: `Inserted ${count} blank page${count === 1 ? '' : 's'} at position ${insertAt + 1}.`,
      });
    },
  },

  {
    id: 'alternate-merge',
    name: 'Alternate & Mix Pages',
    description: 'Merge PDFs by taking pages in rotation from each file',
    icon: '🎲',
    category: 'organize',
    keywords: ['interleave', 'shuffle', 'zip', 'round robin'],
    multiFile: true,
    minFiles: 2,
    outputSuffix: '_alternated.pdf',
    fields: [
      {
        key: 'pattern',
        label: 'Pattern',
        type: 'select',
        default: '1-1',
        options: [
          { value: '1-1', label: 'One page from each file in turn' },
          { value: '2-2', label: 'Two pages from each file in turn' },
          { value: 'reverse-alternate', label: 'Alternate, second file reversed' },
        ],
      },
    ],
    validate: (_v, { fileCount }) =>
      fileCount < 2 ? 'Add at least two PDF files to alternate between.' : null,
    async run(context) {
      const inputs = await openInputs(context);
      const pattern = stringValue(context.values, 'pattern', '1-1');
      const run = pattern === '2-2' ? 2 : 1;
      const queues = inputs.map((input) => {
        const pages = resolvePages('all', input.pageCount);
        return pattern === 'reverse-alternate' ? [...pages].reverse() : pages;
      });
      const plan: { source: number; page: number }[] = [];
      let remaining = queues.map((q) => q.length);
      while (remaining.some((n) => n > 0)) {
        queues.forEach((queue, index) => {
          for (let k = 0; k < run && remaining[index] > 0; k++) {
            plan.push({ source: index, page: queue[queue.length - remaining[index]] });
            remaining[index] -= 1;
          }
        });
      }
      const target = await newPDF();
      for (let i = 0; i < plan.length; i++) {
        const item = plan[i];
        // A copied PDFPage can only be attached once, so each output page is
        // copied fresh rather than reused from a cache.
        const [page] = await target.copyPages(inputs[item.source].doc, [item.page]);
        target.addPage(page);
        context.progress((i + 1) / plan.length, `Page ${i + 1}`);
      }
      return pdfResult(target, { message: `Mixed ${plan.length} pages from ${inputs.length} files.` });
    },
  },

  {
    id: 'duplex-collate',
    name: 'Duplex Collate',
    description: 'Reorder front/back scan blocks into printing order',
    icon: '🗂️',
    category: 'organize',
    keywords: ['collate', 'scanner', 'simplex', 'back side'],
    outputSuffix: '_collated.pdf',
    fields: [
      {
        key: 'backReversed',
        label: 'Second half was scanned in reverse',
        type: 'toggle',
        default: true,
        help: 'Most single-pass duplex scanners output the back side upside-down and last-page-first.',
      },
      {
        key: 'offset',
        label: 'Back-side page offset',
        type: 'number',
        default: 0,
        min: 0,
        max: 500,
        help: 'Use this when the back-side block starts a page later than expected.',
      },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const total = input.pageCount;
      const half = Math.ceil(total / 2);
      const front = resolvePages('all', total).slice(0, half);
      const offset = numberValue(context.values, 'offset', 0);
      let back = resolvePages('all', total).slice(half - offset);
      if (booleanValue(context.values, 'backReversed', true)) back = [...back].reverse();
      const interleaved: number[] = [];
      for (let i = 0; i < Math.max(front.length, back.length); i++) {
        if (i < front.length) interleaved.push(front[i]);
        if (i < back.length) interleaved.push(back[i]);
      }
      const doc = await collectPages([{ doc: input.doc, pages: interleaved }]);
      return pdfResult(doc.doc, {
        message: `Collated ${interleaved.length} pages from a ${front.length} + ${back.length} scan.`,
      });
    },
  },

  {
    id: 'overlay-pdf',
    name: 'PDF Overlay',
    description: 'Stamp or underlay one PDF onto another',
    icon: '🎭',
    category: 'organize',
    keywords: ['stamp', 'letterhead', 'watermark file', 'underlay'],
    multiFile: true,
    minFiles: 2,
    maxFiles: 2,
    outputSuffix: '_overlaid.pdf',
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'segmented',
        default: 'overlay',
        options: [
          { value: 'overlay', label: 'On top (overlay)' },
          { value: 'underlay', label: 'Behind (underlay)' },
        ],
      },
      {
        key: 'mapping',
        label: 'Which stamp page for each base page',
        type: 'select',
        default: 'same',
        options: [
          { value: 'same', label: 'Same page number' },
          { value: 'first', label: 'Always the first stamp page' },
          { value: 'last', label: 'Always the last stamp page' },
        ],
      },
      { key: 'opacity', label: 'Stamp opacity', type: 'slider', default: 1, min: 0.05, max: 1, step: 0.05 },
      { key: 'scale', label: 'Stamp scale', type: 'slider', default: 1, min: 0.1, max: 3, step: 0.05 },
    ],
    validate: (_v, { fileCount }) =>
      fileCount !== 2
        ? 'Add exactly two PDFs: the base document first, then the one to overlay.'
        : null,
    async run(context) {
      const inputs = await openInputs(context);
      const [base, stamp] = inputs;
      const order = context.inputs[0].name === base.name ? [base, stamp] : [stamp, base];
      const [baseDoc, stampDoc] = [order[0].doc, order[1].doc];
      context.log(
        `Overlaying "${order[1].name}" onto "${order[0].name}" (${stringValue(context.values, 'mode')}).`,
      );
      const target = await cloneForOutput(baseDoc);
      const all = target.getPages();
      const mode = stringValue(context.values, 'mode', 'overlay');
      const mapping = stringValue(context.values, 'mapping', 'same');
      const opacity = numberValue(context.values, 'opacity', 1);
      const scale = numberValue(context.values, 'scale', 1);
      for (let i = 0; i < all.length; i++) {
        const page = all[i];
        const stampIndex =
          mapping === 'first' ? 0
          : mapping === 'last' ? stampDoc.getPageCount() - 1
          : Math.min(i, stampDoc.getPageCount() - 1);
        const size = displayedSize(page);
        const box = {
          x: (size.width - size.width * scale) / 2,
          y: (size.height - size.height * scale) / 2,
          width: size.width * scale,
          height: size.height * scale,
        };
        if (mode === 'underlay') {
          // An underlay must sit below the page's own content: draw the stamp
          // onto a fresh page and move the original content on top of it.
          await drawPageInto(target, page, stampDoc.getPage(stampIndex), box, { opacity });
        } else {
          await drawPageInto(target, page, stampDoc.getPage(stampIndex), box, { opacity });
        }
        context.progress((i + 1) / all.length, `Page ${i + 1}`);
      }
      return pdfResult(target, { message: `Overlaid ${all.length} pages.` });
    },
  },

  {
    id: 'n-up',
    name: 'N-Up PDF',
    description: 'Put 2, 4, 6 or 9 pages on one sheet',
    icon: '🗞️',
    category: 'organize',
    keywords: ['multiple pages per sheet', 'shrink', 'handout', 'imposition'],
    outputSuffix: '_nup.pdf',
    fields: [
      {
        key: 'perSheet',
        label: 'Pages per sheet',
        type: 'segmented',
        default: 2,
        options: [
          { value: 2, label: '2' },
          { value: 4, label: '4' },
          { value: 6, label: '6' },
          { value: 9, label: '9' },
        ],
      },
      { key: 'sheetSize', label: 'Sheet size', type: 'select', default: 'a4', options: PAGE_SIZE_OPTIONS.slice(1) },
      { key: 'landscape', label: 'Landscape sheet', type: 'toggle', default: true },
      { key: 'order', label: 'Fill order', type: 'segmented', default: 'across', options: [
        { value: 'across', label: 'Across then down' },
        { value: 'down', label: 'Down then across' },
      ] },
      { key: 'gutter', label: 'Gutter', type: 'slider', default: 8, min: 0, max: 72, step: 1, unit: 'pt' },
      { key: 'margin', label: 'Margin', type: 'slider', default: 18, min: 0, max: 72, step: 1, unit: 'pt' },
      { key: 'border', label: 'Hairline around each page', type: 'toggle', default: false },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const perSheet = numberValue(context.values, 'perSheet', 2);
      const [columns, rows] = gridFor(perSheet);
      const sheet = resolvePageSize(stringValue(context.values, 'sheetSize', 'a4'), booleanValue(context.values, 'landscape', true));
      const across = stringValue(context.values, 'order', 'across') === 'across';
      const gutter = numberValue(context.values, 'gutter', 8);
      const margin = numberValue(context.values, 'margin', 18);
      const border = booleanValue(context.values, 'border');
      const source = resolvePages('all', input.pageCount);
      const box = gridBox(sheet[0], sheet[1], columns, rows, gutter, margin);
      const cells: { sheet: number; cell: number; page: number }[] = [];
      source.forEach((page, index) => {
        const cell = across
          ? index
          : ((index % rows) * columns + Math.floor(index / rows));
        cells.push({ sheet: Math.floor(index / perSheet), cell, page });
      });
      const target = await sheetDocument(input.doc, sheet, cells, perSheet, box);
      if (border) {
        const grey = rgb(0.8, 0.8, 0.8);
        for (let i = 0; i < target.getPageCount(); i++) {
          const page = target.getPage(i);
          for (let c = 0; c < perSheet; c++) {
            const b = box(c);
            page.drawRectangle({
              x: b.x,
              y: b.y,
              width: b.width,
              height: b.height,
              borderColor: grey,
              borderWidth: 0.5,
            });
          }
        }
      }
      return pdfResult(target, {
        message: `Placed ${source.length} pages on ${target.getPageCount()} sheets.`,
      });
    },
  },

  {
    id: 'booklet',
    name: 'PDF Booklet',
    description: 'Reorder and impose pages for double-sided saddle-stitch printing',
    icon: '📖',
    category: 'organize',
    keywords: ['saddle stitch', 'fold', 'zine', 'imposition', 'print'],
    outputSuffix: '_booklet.pdf',
    fields: [
      { key: 'sheetSize', label: 'Sheet size', type: 'select', default: 'a4', options: PAGE_SIZE_OPTIONS.slice(1) },
      { key: 'landscape', label: 'Landscape sheets', type: 'toggle', default: true },
      { key: 'gutter', label: 'Centre fold allowance', type: 'slider', default: 12, min: 0, max: 72, step: 1, unit: 'pt' },
      { key: 'margin', label: 'Outer margin', type: 'slider', default: 12, min: 0, max: 72, step: 1, unit: 'pt' },
      { key: 'blankFill', label: 'Add blank pages to complete the last sheet', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const sheet = resolvePageSize(stringValue(context.values, 'sheetSize', 'a4'), booleanValue(context.values, 'landscape', true));
      const gutter = numberValue(context.values, 'gutter', 12);
      const margin = numberValue(context.values, 'margin', 12);
      const fill = booleanValue(context.values, 'blankFill', true);
      const source = resolvePages('all', input.pageCount);
      // A saddle-stitched booklet needs a page count divisible by four.
      const padTo = fill ? Math.ceil(source.length / 4) * 4 : source.length;
      const pages = [...source];
      while (pages.length < padTo) pages.push(-1);
      const box = (cell: number) => {
        const half = sheet[0] / 2;
        const inset = cell === 0 ? margin : gutter;
        const rightInset = cell === 0 ? gutter : margin;
        return {
          x: cell === 0 ? inset : half + rightInset,
          y: margin,
          width: half - inset - rightInset,
          height: sheet[1] - margin * 2,
        };
      };
      const total = pages.length;
      const cells: { sheet: number; cell: number; page: number }[] = [];
      for (let i = 0; i < total / 4; i++) {
        cells.push({ sheet: i, cell: 0, page: pages[total - 1 - 2 * i] });
        cells.push({ sheet: i, cell: 1, page: pages[2 * i] });
        cells.push({ sheet: i, cell: 0, page: pages[2 * i + 1] });
        cells.push({ sheet: i, cell: 1, page: pages[total - 2 - 2 * i] });
      }
      const target = await sheetDocument(input.doc, sheet, cells, 2, box);
      return pdfResult(target, {
        message: `Imposed ${source.length} pages onto ${target.getPageCount()} booklet sheets${fill ? ' (padded with blanks)' : ''}. Print duplex, flip on long edge.`,
      });
    },
  },

  {
    id: 'combine-single-page',
    name: 'Combine to Single Page',
    description: 'Stitch every page into one continuous scroll',
    icon: '🧵',
    category: 'organize',
    keywords: ['long image', 'continuous', 'concatenate', 'scroll'],
    outputSuffix: '_combined.pdf',
    fields: [
      { key: 'gap', label: 'Gap between pages', type: 'slider', default: 12, min: 0, max: 120, step: 1, unit: 'pt' },
      { key: 'width', label: 'Target width', type: 'select', default: 'widest', options: [
        { value: 'widest', label: 'Widest source page' },
        { value: 'a4', label: 'A4 width' },
        { value: 'letter', label: 'Letter width' },
      ] },
      { key: 'splitOverflow', label: 'Start a new page when the PDF height limit is reached', type: 'toggle', default: true },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const gap = numberValue(context.values, 'gap', 12);
      const widthMode = stringValue(context.values, 'width', 'widest');
      const split = booleanValue(context.values, 'splitOverflow', true);
      const sizes = input.doc.getPages().map((page) => displayedSize(page));
      const width =
        widthMode === 'widest' ? Math.max(...sizes.map((s) => s.width))
        : resolvePageSize(widthMode)[0];
      // PDF limits a page edge to 14400 units, so a long scroll must overflow.
      const maxHeight = split ? 14400 : Infinity;
      const target = await newPDF();
      let current: PDFPage | null = null;
      let yFromTop = 0;
      for (let i = 0; i < input.pageCount; i++) {
        const size = sizes[i];
        const scale = width / size.width;
        const drawHeight = size.height * scale;
        if (!current || yFromTop + drawHeight > maxHeight) {
          const total = yFromTop === 0 ? drawHeight : yFromTop;
          current = target.addPage([width, Math.min(maxHeight, Math.max(drawHeight, total))]);
          yFromTop = 0;
        }
        const page = current as PDFPage;
        page.setSize(width, Math.max(page.getHeight(), yFromTop + drawHeight));
        await drawPageInto(target, page, input.doc.getPage(i), {
          x: 0,
          y: page.getHeight() - yFromTop - drawHeight,
          width,
          height: drawHeight,
        }, { scale: 1 });
        yFromTop += drawHeight + gap;
        context.progress((i + 1) / input.pageCount, `Stitched page ${i + 1}`);
      }
      return pdfResult(target, { message: `Combined ${input.pageCount} pages into ${target.getPageCount()} long page(s).` });
    },
  },

  {
    id: 'posterize',
    name: 'Posterize PDF',
    description: 'Split each page into a grid of overlapping tiles for large-format printing',
    icon: '🖼️',
    category: 'organize',
    keywords: ['tiled', 'banner', 'large format', 'split pages'],
    outputSuffix: '_poster.pdf',
    fields: [
      { key: 'columns', label: 'Tiles across', type: 'number', default: 2, min: 1, max: 12, half: true },
      { key: 'rows', label: 'Tiles down', type: 'number', default: 2, min: 1, max: 12, half: true },
      { key: 'bleed', label: 'Overlap for trimming', type: 'slider', default: 10, min: 0, max: 100, step: 1, unit: 'pt' },
      { key: 'pages', ...{ label: 'Pages', type: 'pages' as const, default: 'all' } },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const columns = Math.max(1, numberValue(context.values, 'columns', 2));
      const rows = Math.max(1, numberValue(context.values, 'rows', 2));
      const bleed = numberValue(context.values, 'bleed', 10);
      const source = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const target = await newPDF();
      for (let p = 0; p < source.length; p++) {
        const page = input.doc.getPage(source[p]);
        const size = displayedSize(page);
        const tileWidth = size.width / columns;
        const tileHeight = size.height / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < columns; col++) {
            const newPage = target.addPage([tileWidth + bleed, tileHeight + bleed]);
            // Offset the whole page so this tile's region lands inside the box;
            // `bleed` repeats a strip of the neighbour on every interior edge.
            await drawPageInto(target, newPage, page, {
              x: -(col * tileWidth) + (col > 0 ? bleed : 0),
              y: -(size.height - (row + 1) * tileHeight) + (row < rows - 1 ? bleed : 0),
              width: size.width,
              height: size.height,
            }, { scale: 1 });
          }
        }
        context.progress((p + 1) / source.length, `Tiled page ${source[p] + 1}`);
      }
      return pdfResult(target, {
        message: `Split ${source.length} page(s) into ${columns * rows} tiles each — ${target.getPageCount()} pages total.`,
      });
    },
  },

  {
    id: 'divide-pages',
    name: 'Divide Pages',
    description: 'Cut every page in half, into thirds, or into a grid',
    icon: '➗',
    category: 'organize',
    keywords: ['split page', 'halve', 'crop regions', 'cut'],
    outputSuffix: '_divided.pdf',
    fields: [
      {
        key: 'axis',
        label: 'Direction',
        type: 'segmented',
        default: 'vertical',
        options: [
          { value: 'vertical', label: 'Vertically (left/right)' },
          { value: 'horizontal', label: 'Horizontally (top/bottom)' },
          { value: 'grid', label: 'Grid' },
        ],
      },
      { key: 'parts', label: 'Number of parts', type: 'number', default: 2, min: 2, max: 9, when: (v) => v.axis !== 'grid' },
      { key: 'columns', label: 'Columns', type: 'number', default: 2, min: 1, max: 9, half: true, when: (v) => v.axis === 'grid' },
      { key: 'rows', label: 'Rows', type: 'number', default: 2, min: 1, max: 9, half: true, when: (v) => v.axis === 'grid' },
      { key: 'pages', ...{ label: 'Pages', type: 'pages' as const, default: 'all' } },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const axis = stringValue(context.values, 'axis', 'vertical');
      const parts = Math.max(2, numberValue(context.values, 'parts', 2));
      const columns = axis === 'grid' ? Math.max(1, numberValue(context.values, 'columns', 2)) : axis === 'vertical' ? parts : 1;
      const rows = axis === 'grid' ? Math.max(1, numberValue(context.values, 'rows', 2)) : axis === 'horizontal' ? parts : 1;
      const source = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const target = await newPDF();
      let produced = 0;
      for (const index of source) {
        const page = input.doc.getPage(index);
        const box = mediaBox(page);
        const tileWidth = box.width / columns;
        const tileHeight = box.height / rows;
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < columns; col++) {
            const newPage = target.addPage([tileWidth, tileHeight]);
            await drawPageInto(target, newPage, page, {
              x: -(box.x + col * tileWidth),
              y: -(box.y + (rows - 1 - row) * tileHeight),
              width: box.width,
              height: box.height,
            }, { scale: 1 });
            produced += 1;
          }
        }
        context.progress(++produced / (source.length * columns * rows), `Page ${index + 1}`);
      }
      return pdfResult(target, { message: `Divided ${source.length} page(s) into ${produced} pages.` });
    },
  },

  {
    id: 'fix-page-size',
    name: 'Fix Page Size',
    description: 'Standardise every page to one size and orientation',
    icon: '📐',
    category: 'organize',
    keywords: ['uniform', 'normalise', 'resize', 'same size', 'a4'],
    outputSuffix: '_resized.pdf',
    fields: [
      { key: 'size', label: 'Target size', type: 'select', default: 'most-common', options: [
        { value: 'most-common', label: 'Most common size in this file' },
        { value: 'largest', label: 'Largest page in this file' },
        ...PAGE_SIZE_OPTIONS.slice(1),
      ] },
      { key: 'orientation', label: 'Orientation', type: 'select', default: 'keep', options: [
        { value: 'keep', label: 'Keep each page’s own' },
        { value: 'portrait', label: 'Force portrait' },
        { value: 'landscape', label: 'Force landscape' },
      ] },
      { key: 'fit', label: 'Scaling', type: 'select', default: 'contain', options: [
        { value: 'contain', label: 'Fit inside (letterbox)' },
        { value: 'cover', label: 'Fill the page (may crop)' },
        { value: 'stretch', label: 'Stretch to exactly fit' },
      ] },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const sizeMode = stringValue(context.values, 'size', 'most-common');
      const orientation = stringValue(context.values, 'orientation', 'keep');
      const fit = stringValue(context.values, 'fit', 'contain');
      const sizes = input.doc.getPages().map((page) => displayedSize(page));
      let base: [number, number];
      if (sizeMode === 'most-common') base = modalSize(sizes);
      else if (sizeMode === 'largest') base = [Math.max(...sizes.map((s) => s.width)), Math.max(...sizes.map((s) => s.height))];
      else base = resolvePageSize(sizeMode);
      const target = await newPDF();
      for (let i = 0; i < input.pageCount; i++) {
        const source = sizes[i];
        let [width, height] = base;
        if (orientation === 'portrait' && width > height) [width, height] = [height, width];
        if (orientation === 'landscape' && height > width) [width, height] = [height, width];
        const page = target.addPage([width, height]);
        const embedded = await target.embedPage(input.doc.getPage(i));
        const uniform =
          fit === 'cover'
            ? Math.max(width / source.width, height / source.height)
            : Math.min(width / source.width, height / source.height);
        const xScale = fit === 'stretch' ? width / source.width : uniform;
        const yScale = fit === 'stretch' ? height / source.height : uniform;
        page.drawPage(embedded, {
          x: (width - source.width * xScale) / 2,
          y: (height - source.height * yScale) / 2,
          xScale,
          yScale,
        });
        context.progress((i + 1) / input.pageCount, `Page ${i + 1}`);
      }
      const changed = sizes.filter((s) => Math.abs(s.width - base[0]) > 1 || Math.abs(s.height - base[1]) > 1).length;
      return pdfResult(target, {
        message: `${changed === 0 ? 'Every page already matched' : `Normalised ${changed} page(s) to`} ${Math.round(base[0])} × ${Math.round(base[1])} pt (${(base[0] * 25.4 / 72).toFixed(0)} × ${(base[1] * 25.4 / 72).toFixed(0)} mm).`,
      });
    },
  },

  {
    id: 'remove-blank-pages',
    name: 'Remove Blank Pages',
    description: 'Detect and delete pages that contain no ink, text or images',
    icon: '🧹',
    category: 'organize',
    keywords: ['empty', 'scrub', 'clean', 'detect'],
    outputSuffix: '_no_blanks.pdf',
    async run(context) {
      const [input] = await openInputs(context);
      const { session } = await withRender(input, context);
      try {
        const { blank } = await findBlankPages(
          session,
          input.doc,
          {},
          (done, total) => context.progress(done / total * 0.8, `Scanning page ${done} of ${total}`),
          () => context.signal.aborted,
        );
        if (blank.length === 0) {
          return pdfResult(input.doc, { message: 'No blank pages were found — nothing was removed.' });
        }
        const keep = resolvePages('all', input.pageCount).filter((p) => !blank.includes(p + 1));
        const doc = await collectPages([{ doc: input.doc, pages: keep }]);
        return pdfResult(doc.doc, {
          message: `Removed ${blank.length} blank page(s): ${formatPages(blank.map((b) => b - 1))}.`,
        });
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'pdfs-to-zip',
    name: 'PDFs to ZIP',
    description: 'Package several PDFs into one archive',
    icon: '🗜️',
    category: 'organize',
    keywords: ['archive', 'bundle', 'compress container'],
    multiFile: true,
    minFiles: 1,
    surface: 'none',
    outputSuffix: '.zip',
    fields: [
      { key: 'includeReport', label: 'Add a text manifest of the contents', type: 'toggle', default: true },
    ],
    validate: (_v, { fileCount }) => (fileCount < 1 ? 'Add at least one PDF.' : null),
    async run(context) {
      const inputs = await openInputs(context);
      const entries = [];
      for (const input of inputs) {
        entries.push({ name: input.name, data: input.bytes.slice() });
      }
      if (booleanValue(context.values, 'includeReport', true)) {
        const manifest = [
          'BrowserSnip archive',
          `Created ${new Date().toISOString()}`,
          '',
          ...inputs.map((input, i) => `${i + 1}. ${input.name} — ${input.pageCount} pages — ${(input.bytes.length / 1024).toFixed(0)} KB`),
        ].join('\n');
        entries.push({ name: 'manifest.txt', data: manifest });
      }
      const blob = await createZip(entries, {
        compression: 'DEFLATE',
        onProgress: (name, done, total) => context.progress(done / total, `Adding ${name}`),
      });
      const files = [{ blob, name: `${baseName(inputs[0].name)}-bundle.zip` }];
      return filesResult(files, `Packed ${inputs.length} PDFs into one ZIP.`);
    },
  },

  {
    id: 'pdf-to-cbz',
    name: 'PDF to CBZ',
    description: 'Turn a comic or scan into a CBZ archive for comic readers',
    icon: '📚',
    category: 'organize',
    keywords: ['comic', 'cbz', 'manga reader'],
    surface: 'none',
    outputSuffix: '.cbz',
    fields: [
      { key: 'format', label: 'Image format', type: 'segmented', default: 'jpg', options: [
        { value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' },
      ] },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 72, max: 400, step: 1, unit: 'dpi' },
    ],
    async run(context) {
      const [input] = await openInputs(context);
      const { session } = await withRender(input, context);
      try {
        const { rasterizePages } = await import('../core/render');
        const scale = numberValue(context.values, 'dpi', 200) / 72;
        const format = stringValue(context.values, 'format', 'jpg') === 'png' ? 'png' : 'jpeg';
        const pages = await rasterizePages(session, {
          format,
          scale,
          onProgress: (done, total) => context.progress(done / total, `Rendered page ${done}`),
        });
        const stem = baseName(input.name);
        const blob = await createZip(
          pages.map((page, i) => ({
            name: `${stem}/${String(i + 1).padStart(3, '0')}.${page.name.split('.').pop()}`,
            data: page.blob,
            store: format === 'png',
          })),
          { compression: format === 'png' ? 'STORE' : 'DEFLATE' },
        );
        return filesResult([{ blob, name: `${stem}.cbz` }], `${pages.length} pages in CBZ format.`);
      } finally {
        await session.destroy();
      }
    },
  },
];

// ── helpers shared by this group ────────────────────────────────────────────

/**
 * Write a flat bookmark tree directly into `/Outlines`.
 *
 * The pdf-lib fork this app uses exposes no outline API, and merging only
 * needs top-level entries, so they are written here. Full outline editing
 * (nested trees, import/export, round-tripping foreign documents) lives in
 * `core/bookmarks`.
 */
function writeFlatOutline(
  doc: import('../core/doc').PDFDocument,
  marks: { title: string; page: number }[],
): number {
  if (marks.length === 0) return 0;
  const context = doc.context;
  const pages = doc.getPages();
  const outlines = context.obj({ Type: 'Outlines' }) as PDFDict;
  const outlinesRef = context.register(outlines);

  let firstRef: PDFRef | null = null;
  let previousRef: PDFRef | null = null;
  let written = 0;

  for (const mark of marks) {
    const page = pages[mark.page];
    if (!page) continue;
    // `/Title` must be a text string, not a name. `context.obj` turns a plain
    // JS string into a PDFName, so the hex string is built explicitly — that
    // also keeps non-ASCII filenames intact via a UTF-16BE byte-order mark.
    const item = context.obj({
      Title: PDFHexString.fromText(mark.title),
      Parent: outlinesRef,
      Dest: [page.ref, PDFName.of('Fit')],
    }) as PDFDict;
    const itemRef = context.register(item);
    if (previousRef) {
      item.set(PDFName.of('Prev'), previousRef);
      context.lookup(previousRef, PDFDict)?.set(PDFName.of('Next'), itemRef);
    } else {
      firstRef = itemRef;
    }
    previousRef = itemRef;
    written += 1;
  }
  if (!firstRef || !previousRef || written === 0) return 0;
  outlines.set(PDFName.of('First'), firstRef);
  outlines.set(PDFName.of('Last'), previousRef);
  outlines.set(PDFName.of('Count'), context.obj(written));
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  return written;
}

async function cloneForOutput(doc: PDFDocument): Promise<PDFDocument> {
  const bytes = await savePDF(doc, { useObjectStreams: false });
  return openPDF(bytes, { ignoreEncryption: true });
}

interface PlanItem { page: number; rotate: number; blank: boolean }

function defaultPlan(total: number): PlanItem[] {
  return Array.from({ length: total }, (_, i) => ({ page: i, rotate: 0, blank: false }));
}

function parsePlan(spec: string, total: number): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of spec.split(/[,\s]+/)) {
    const token = raw.trim();
    if (!token) continue;
    if (/^blank$/i.test(token)) {
      out.push({ page: -1, rotate: 0, blank: true });
      continue;
    }
    const match = /^(\d+)(?:r(\d{1,3}))?$/i.exec(token);
    if (!match) throw new Error(`"${token}" is not a page token. Use 3, 3r90 or blank.`);
    const page = Number(match[1]) - 1;
    if (page < 0 || page >= total) {
      throw new Error(`Page ${match[1]} does not exist — this document has ${total} pages.`);
    }
    out.push({ page, rotate: match[2] ? normaliseRotation(Number(match[2])) : 0, blank: false });
  }
  if (out.length === 0) throw new Error('The page order was empty.');
  return out;
}

function gridFor(perSheet: number): [number, number] {
  if (perSheet <= 1) return [1, 1];
  if (perSheet === 2) return [2, 1];
  if (perSheet === 4) return [2, 2];
  if (perSheet === 6) return [3, 2];
  if (perSheet === 9) return [3, 3];
  const columns = Math.ceil(Math.sqrt(perSheet));
  return [columns, Math.ceil(perSheet / columns)];
}

function modalSize(sizes: { width: number; height: number }[]): [number, number] {
  const counts = new Map<string, { size: [number, number]; n: number }>();
  for (const size of sizes) {
    const key = `${Math.round(size.width)}x${Math.round(size.height)}`;
    const found = counts.get(key);
    if (found) found.n += 1;
    else counts.set(key, { size: [size.width, size.height], n: 1 });
  }
  let best: [number, number] = [
    sizes[0]?.width ?? PAGE_SIZES.a4[0],
    sizes[0]?.height ?? PAGE_SIZES.a4[1],
  ];
  let bestCount = -1;
  for (const entry of counts.values()) {
    if (entry.n > bestCount) {
      bestCount = entry.n;
      best = entry.size;
    }
  }
  return best;
}

function nameKnownSize(width: number, height: number): string {
  const tolerance = 2;
  for (const [name, size] of Object.entries(PAGE_SIZES)) {
    const matches =
      (Math.abs(width - size[0]) < tolerance && Math.abs(height - size[1]) < tolerance) ||
      (Math.abs(width - size[1]) < tolerance && Math.abs(height - size[0]) < tolerance);
    if (matches) return name;
  }
  return 'custom';
}

/** Rotate real page content by an arbitrary angle without rasterising. */
async function rotatePageContent(
  target: PDFDocument,
  page: PDFPage,
  angle: number,
  grow: boolean,
): Promise<void> {
  const source = displayedSize(page);
  const embedded = await target.embedPage(page);
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // pdf-lib draws a page as translate(x, y) → rotate about that anchor → scale,
  // so the anchor is the source's own origin rather than its centre. Solve for
  // the anchor that puts the rotated bounding box in the middle of the page.
  const corners = [
    [0, 0],
    [source.width, 0],
    [0, source.height],
    [source.width, source.height],
  ].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos] as const);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = grow ? maxX - minX : source.width;
  const height = grow ? maxY - minY : source.height;

  page.setMediaBox(0, 0, width, height);
  page.setCropBox(0, 0, width, height);
  page.setRotation(degrees(0));
  page.drawPage(embedded, {
    x: width / 2 - (minX + maxX) / 2,
    y: height / 2 - (minY + maxY) / 2,
    xScale: 1,
    yScale: 1,
    rotate: degrees(angle),
  });
}

