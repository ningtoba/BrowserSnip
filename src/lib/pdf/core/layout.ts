/**
 * The shared text-to-PDF layout engine.
 *
 * Every "…to PDF" tool that produces text — txt, Markdown, HTML, CSV, JSON,
 * XML, RTF, DOCX, EPUB, email — parses into the `Block` model below and is then
 * rendered here. That is deliberate: the previous `html-to-pdf` painted a
 * screenshot of a hidden div, so the output had no selectable text, could not
 * paginate, and injected author HTML straight into the live document.
 *
 * All drawing goes through `core/fonts`, never a raw standard font, so
 * Cyrillic, Greek, CJK, Arabic and Indic text work instead of throwing
 * `WinAnsi cannot encode …`.
 */
import type { PDFDocument, PDFPage } from './doc';
import { newPDF, rgb } from './doc';
import { getFont, drawTextU, measureText, embedUnicodeFace } from './fonts';
import { decodeImage } from './images';
import { displayedSize, pageSize as resolvePageSize } from './pages';

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  link?: string;
  code?: boolean;
  size?: number;
  superscript?: boolean;
  subscript?: boolean;
  /** A named face hint; 'auto' or omitted picks by script. */
  font?: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | {
      kind: 'paragraph';
      inlines: Inline[];
      align?: 'left' | 'center' | 'right' | 'justify';
      indent?: number;
      spaceBefore?: number;
      spaceAfter?: number;
    }
  | {
      kind: 'list';
      ordered?: boolean;
      items: { inlines: Inline[]; level: number; checked?: boolean | null; marker?: string }[];
    }
  | { kind: 'quote'; inlines: Inline[]; attribution?: string }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'table'; header?: Inline[][]; rows: Inline[][][]; widths?: number[]; caption?: string }
  | { kind: 'image'; bytes: Uint8Array; mime?: string; caption?: string; width?: number; alt?: string }
  | { kind: 'rule' }
  | { kind: 'pagebreak' };

export interface LayoutOptions {
  pageSize?: string | [number, number];
  margin?: number;
  baseFontSize?: number;
  /** Multiplier of the font size. Default 1.45. */
  lineHeight?: number;
  fontFamily?: string;
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
  columns?: 1 | 2;
  color?: string;
  /** Draw a hairline under top-level headings. */
  headingRules?: boolean;
  codeBackground?: string;
}

const DEFAULTS: Required<Pick<LayoutOptions, 'pageSize' | 'margin' | 'baseFontSize' | 'lineHeight' | 'color' | 'codeBackground'>> = {
  pageSize: 'a4',
  margin: 56,
  baseFontSize: 11,
  lineHeight: 1.45,
  color: '#1b1b18',
  codeBackground: '#f1f1ec',
};

const MONO_URL = '/fonts/jetbrains-mono-400.ttf';
const HEADING_SIZES = [2.1, 1.7, 1.4, 1.2, 1.1, 1.0];

/** A fresh document ready to receive `renderBlocks`. */
export async function newDocumentForLayout(): Promise<PDFDocument> {
  return newPDF();
}

// ── the renderer ────────────────────────────────────────────────────────────

interface Surface {
  doc: PDFDocument;
  page: PDFPage;
  /** Left edge of the current column in PDF user space. */
  columnX: number;
  /** Bottom edge of the current column. */
  limitY: number;
  topY: number;
  width: number;
  height: number;
  y: number;
  index: number;
}

export async function renderBlocks(
  doc: PDFDocument,
  blocks: Block[],
  options: LayoutOptions = {},
): Promise<PDFPage[]> {
  const settings = { ...DEFAULTS, ...options };
  const size = Array.isArray(settings.pageSize)
    ? settings.pageSize
    : resolvePageSize(settings.pageSize);
  const columns = options.columns ?? 1;
  const gutter = columns === 2 ? settings.margin * 0.6 : 0;
  const columnWidth = (size[0] - settings.margin * 2 - gutter * (columns - 1)) / columns;

  const surface: Surface = {
    doc,
    page: doc.addPage(size),
    columnX: settings.margin,
    limitY: settings.margin,
    topY: size[1] - settings.margin,
    width: columnWidth,
    height: size[1],
    y: size[1] - settings.margin,
    index: 0,
  };
  if (settings.header) surface.y -= await advanceHeader(surface, settings.header, settings);
  const footerReserved = (settings.footer ? 1 : 0) + (settings.pageNumbers ? 1 : 0);
  if (footerReserved) surface.limitY -= footerReserved * (settings.baseFontSize + 4);

  const pages: PDFPage[] = [surface.page];

  const turn = async (): Promise<void> => {
    if (columns === 1 || surface.index + 1 >= columns) {
      surface.page = doc.addPage(size);
      pages.push(surface.page);
      surface.index = 0;
      surface.columnX = settings.margin;
    } else {
      surface.index += 1;
      surface.columnX = settings.margin + surface.index * (columnWidth + gutter);
    }
    surface.y = size[1] - settings.margin;
    if (settings.header) surface.y -= await advanceHeader(surface, settings.header, settings);
  };

  const needs = (height: number): boolean => surface.y - height < surface.limitY;

  for (const block of blocks) {
    if (block.kind === 'pagebreak') {
      await turn();
      continue;
    }
    if (block.kind === 'rule') {
      if (needs(14)) await turn();
      surface.y -= 8;
      surface.page.drawLine({
        start: { x: surface.columnX, y: surface.y },
        end: { x: surface.columnX + columnWidth, y: surface.y },
        thickness: 0.6,
        color: rgb(0.75, 0.75, 0.72),
      });
      surface.y -= 8;
      continue;
    }
    if (block.kind === 'heading') {
      const scale = HEADING_SIZES[Math.min(5, Math.max(0, block.level - 1))];
      const fontSize = settings.baseFontSize * scale;
      const lines = await wrapInlines(doc, block.inlines, {
        size: fontSize,
        maxWidth: columnWidth,
        bold: true,
        fontFamily: options.fontFamily,
      });
      const height = lines.length * fontSize * settings.lineHeight + fontSize * 0.5;
      if (needs(height)) await turn();
      surface.y -= fontSize * 0.5;
      for (const line of lines) {
        surface.y -= fontSize * settings.lineHeight;
        await drawLine(surface, line, {
          size: fontSize,
          bold: true,
          color: settings.color,
          align: 'left',
          width: columnWidth,
          fontFamily: options.fontFamily,
        });
      }
      if (options.headingRules !== false && block.level <= 2) {
        surface.page.drawLine({
          start: { x: surface.columnX, y: surface.y - 2 },
          end: { x: surface.columnX + columnWidth, y: surface.y - 2 },
          thickness: 0.8,
          color: rgb(0.85, 0.85, 0.82),
        });
      }
      surface.y -= fontSize * 0.45;
      continue;
    }
    if (block.kind === 'paragraph' || block.kind === 'quote') {
      const quote = block.kind === 'quote';
      const spaceBefore = block.kind === 'paragraph' ? block.spaceBefore ?? (quote ? 6 : 0) : 6;
      const spaceAfter = block.kind === 'paragraph' ? block.spaceAfter ?? 5 : 6;
      const align = block.kind === 'paragraph' ? block.align ?? 'left' : 'left';
      const indent = quote ? 16 : (block.kind === 'paragraph' ? block.indent ?? 0 : 0);
      const fontSize = settings.baseFontSize * (quote ? 0.98 : 1);
      const inlines = quote
        ? block.inlines.map((run) => ({ ...run, italic: run.italic ?? true }))
        : block.inlines;
      const lines = await wrapInlines(doc, inlines, {
        size: fontSize,
        maxWidth: columnWidth - indent - (quote ? 12 : 0),
        fontFamily: options.fontFamily,
      });
      const lineHeight = fontSize * settings.lineHeight;
      const height = lines.length * lineHeight + spaceBefore;
      // A block that could fit on a fresh page is moved whole to one, which is what
      // keeps a paragraph from starting on the last three lines of a sheet. One
      // that is taller than any page cannot be moved, so it continues across the
      // break: painting every line from wherever the block began ran the tail
      // below the bottom edge, where the bytes hold it and no reader shows it.
      if (needs(height)) await turn();
      surface.y -= spaceBefore;
      let barTop = surface.y;
      const paintBar = (from: number): void => {
        if (!quote || from - surface.y <= 0) return;
        surface.page.drawRectangle({
          x: surface.columnX + 2,
          y: surface.y,
          width: 2.5,
          height: from - surface.y,
          color: rgb(0.72, 0.72, 0.68),
        });
      };
      for (const line of lines) {
        if (needs(lineHeight)) {
          paintBar(barTop);
          await turn();
          barTop = surface.y;
        }
        surface.y -= lineHeight;
        await drawLine(surface, line, {
          size: fontSize,
          color: quote ? '#55554e' : settings.color,
          align,
          indent: indent + (quote ? 12 : 0),
          width: columnWidth - indent - (quote ? 12 : 0),
          italic: quote,
          fontFamily: options.fontFamily,
        });
      }
      paintBar(barTop);
      surface.y -= spaceAfter;
      continue;
    }
    if (block.kind === 'list') {
      surface.y = await renderList(surface, block, doc, settings, columnWidth, needs, turn, pages);
      continue;
    }
    if (block.kind === 'code') {
      const fontSize = Math.max(7, settings.baseFontSize * 0.88);
      const raw = block.text.replace(/\t/g, '    ').split(/\r?\n/);
      const wrapped: string[] = [];
      for (const line of raw) {
        const chunks = Math.max(1, Math.ceil((line.length * fontSize * 0.6) / (columnWidth - 20)));
        if (chunks === 1 || line.length <= 90) wrapped.push(line);
        else {
          const per = Math.ceil(line.length / chunks);
          for (let i = 0; i < line.length; i += per) wrapped.push(line.slice(i, i + per));
        }
      }
      const lineHeight = fontSize * 1.35;
      const height = wrapped.length * lineHeight + 16;
      if (needs(Math.min(height, lineHeight * 8))) await turn();
      const background = await monoFont(doc);
      const startTop = surface.y;
      let drawn = 0;
      for (const line of wrapped) {
        if (needs(lineHeight + 4)) {
          paintCodeBox(surface, startTop, settings);
          await turn();
        }
        surface.y -= lineHeight;
        surface.page.drawText(line.slice(0, 4000), {
          x: surface.columnX + 10,
          y: surface.y + (lineHeight - fontSize) / 2,
          size: fontSize,
          font: background,
          color: rgb(0.15, 0.15, 0.13),
        });
        drawn += 1;
      }
      void drawn;
      paintCodeBox(surface, startTop, settings);
      surface.y -= 8;
      continue;
    }
    if (block.kind === 'table') {
      await renderTable(surface, block, doc, settings, columnWidth, needs, turn, pages);
      continue;
    }
    if (block.kind === 'image') {
      const embedded = await embedBytes(doc, block.bytes, block.mime);
      const scale = Math.min(
        1,
        (block.width ?? columnWidth) / Math.max(1, embedded.width),
        (size[1] * 0.6) / Math.max(1, embedded.height),
      );
      const drawWidth = embedded.width * scale;
      const drawHeight = embedded.height * scale;
      const caption = block.caption ? await wrapTextSimple(doc, block.caption, { size: settings.baseFontSize * 0.9, maxWidth: columnWidth }) : [];
      if (needs(drawHeight + caption.length * 14 + 10)) await turn();
      surface.y -= drawHeight;
      surface.page.drawImage(embedded, {
        x: surface.columnX + (columnWidth - drawWidth) / 2,
        y: surface.y,
        width: drawWidth,
        height: drawHeight,
      });
      for (const line of caption) {
        surface.y -= settings.baseFontSize * 1.3;
        await drawLine(surface, [{ text: line.text, italic: true }], {
          size: settings.baseFontSize * 0.9,
          color: '#55554e',
          align: 'center',
          width: columnWidth,
        });
      }
      surface.y -= 8;
    }
  }

  if (settings.footer || settings.pageNumbers) {
    const all = doc.getPages();
    for (let i = 0; i < all.length; i++) {
      const page = all[i];
      const box = displayedSize(page);
      const footerText = settings.footer
        ? expandTokens(settings.footer, { page: i + 1, total: all.length })
        : null;
      if (footerText) {
        await drawTextU(page, {
          text: footerText,
          x: settings.margin,
          y: settings.margin * 0.55,
          size: settings.baseFontSize * 0.85,
          color: rgb(0.45, 0.45, 0.42),
        });
      }
      if (settings.pageNumbers) {
        await drawTextU(page, {
          text: String(i + 1),
          x: box.width - settings.margin,
          y: settings.margin * 0.55,
          size: settings.baseFontSize * 0.85,
          color: rgb(0.45, 0.45, 0.42),
          align: 'right',
          width: 0,
        });
      }
    }
  }
  void pages;
  return doc.getPages();
}

// ── line and run drawing ────────────────────────────────────────────────────

interface LineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  size?: number;
  link?: string;
  superscript?: boolean;
  subscript?: boolean;
  code?: boolean;
}

async function drawLine(
  surface: Surface,
  runs: LineRun[],
  options: {
    size: number;
    color: string;
    align: 'left' | 'center' | 'right' | 'justify';
    width: number;
    indent?: number;
    bold?: boolean;
    italic?: boolean;
    fontFamily?: string;
  },
): Promise<void> {
  const text = runs.map((run) => run.text).join('');
  if (text.trim() === '') return;
  const x = surface.columnX + (options.indent ?? 0);
  let cursor = x;
  if (options.align === 'center' || options.align === 'right') {
    const measured = await measureText(surface.doc, { text, x: 0, y: 0, size: options.size, bold: runs[0]?.bold, italic: runs[0]?.italic ?? options.italic });
    cursor = options.align === 'center'
      ? x + (options.width - measured.width) / 2
      : x + options.width - measured.width;
  }
  for (const run of runs) {
    const size = run.size ?? options.size;
    const width = await drawTextU(surface.page, {
      text: run.text,
      x: cursor,
      y: surface.y + (options.size - size) / 2 + (run.superscript ? size * 0.35 : run.subscript ? -size * 0.2 : 0),
      size,
      bold: run.bold,
      italic: run.italic ?? options.italic,
      color: hex(run.color ?? options.color),
    });
    const paint = run.underline || run.strike || run.link;
    if (paint && width > 0) {
      const ruleY = run.strike
        ? surface.y + options.size * 0.32
        : surface.y - 0.8;
      surface.page.drawLine({
        start: { x: cursor, y: ruleY },
        end: { x: cursor + width, y: ruleY },
        thickness: run.link ? 0.5 : Math.max(0.5, size * 0.05),
        color: run.link ? rgb(0.145, 0.388, 0.922) : hex(run.color ?? options.color),
      });
    }
    cursor += width;
  }
}

async function advanceHeader(surface: Surface, header: string, settings: LayoutOptions): Promise<number> {
  const size = (settings.baseFontSize ?? DEFAULTS.baseFontSize) * 0.85;
  const y = surface.y - size;
  await drawTextU(surface.page, {
    text: expandTokens(header, { page: surface.index + 1, total: 0 }),
    x: surface.columnX,
    y,
    size,
    color: rgb(0.45, 0.45, 0.42),
  });
  return size + 10;
}

function paintCodeBox(surface: Surface, top: number, settings: LayoutOptions): void {
  const height = top - surface.y;
  if (height <= 0) return;
  surface.page.drawRectangle({
    x: surface.columnX,
    y: surface.y,
    width: surface.width,
    height,
    color: hex(settings.codeBackground ?? DEFAULTS.codeBackground),
  });
}

async function renderList(
  surface: Surface,
  block: Extract<Block, { kind: 'list' }>,
  doc: PDFDocument,
  settings: LayoutOptions & typeof DEFAULTS,
  columnWidth: number,
  needs: (height: number) => boolean,
  turn: () => Promise<void>,
  pages: PDFPage[],
): Promise<number> {
  const size = settings.baseFontSize;
  let orderedCounter = 0;
  let previousLevel = -1;
  for (const item of block.items) {
    if (item.level !== previousLevel) orderedCounter = 0;
    previousLevel = item.level;
    const marker = item.marker
      ?? (block.ordered ? `${++orderedCounter}.` : ['•', '◦', '▪'][item.level % 3]);
    const indent = 14 + item.level * 14;
    const lines = await wrapInlines(doc, item.inlines, {
      size,
      maxWidth: Math.max(40, columnWidth - indent),
      fontFamily: settings.fontFamily,
    });
    const height = lines.length * size * settings.lineHeight + 2;
    if (needs(height)) await turn();
    await drawTextU(surface.page, {
      text: marker,
      x: surface.columnX + 2,
      y: surface.y - size,
      size,
      color: hex(settings.color),
    });
    let first = true;
    for (const line of lines) {
      surface.y -= size * settings.lineHeight;
      await drawLine(surface, line, {
        size,
        color: settings.color,
        align: 'left',
        indent,
        width: Math.max(40, columnWidth - indent),
      });
      first = false;
    }
    void first;
    surface.y -= 2;
  }
  void pages;
  return surface.y;
}

async function renderTable(
  surface: Surface,
  block: Extract<Block, { kind: 'table' }>,
  doc: PDFDocument,
  settings: LayoutOptions & typeof DEFAULTS,
  columnWidth: number,
  needs: (height: number) => boolean,
  turn: () => Promise<void>,
  pages: PDFPage[],
): Promise<void> {
  const rows = block.rows ?? [];
  const columns = Math.max(
    1,
    block.header?.length ?? 0,
    ...rows.map((row) => row.length),
  );
  if (rows.length === 0 && !block.header) return;
  const size = Math.max(6.5, settings.baseFontSize * 0.86);
  const cellPadding = 4;
  const widths = await columnWidths(doc, block, columns, columnWidth, size, settings);

  const renderRow = async (
    cells: Inline[][],
    bold: boolean,
    afterTurn?: () => Promise<void>,
  ): Promise<void> => {
    const wrapped = await Promise.all(
      cells.map((cell, index) =>
        wrapInlines(doc, normalizeCells(cell), { size, maxWidth: Math.max(16, widths[index] - cellPadding * 2) }),
      ),
    );
    const lineCount = Math.max(1, ...wrapped.map((lines) => lines.length));
    const height = lineCount * size * 1.28 + cellPadding * 2;
    if (needs(height)) {
      await turn();
      // Moving to a fresh sheet neither cancels this row nor loses the header:
      // `afterTurn` re-draws it, and the row follows underneath. Every sheet a
      // table spills onto therefore repeats the header, which is what the CSV
      // and Excel routes promise.
      if (afterTurn) await afterTurn();
      if (needs(height)) await turn();
    }
    const top = surface.y;
    surface.y -= height;
    if (bold) {
      surface.page.drawRectangle({
        x: surface.columnX,
        y: surface.y,
        width: columnWidth,
        height,
        color: rgb(0.945, 0.945, 0.925),
      });
    }
    let x = surface.columnX;
    for (let index = 0; index < columns; index++) {
      const cellWidth = widths[index] ?? columnWidth / columns;
      let y = top - cellPadding - size;
      for (const line of wrapped[index] ?? []) {
        await drawLine(surface, line, {
          size,
          color: settings.color,
          align: 'left',
          indent: x - surface.columnX + cellPadding,
          width: cellWidth - cellPadding * 2,
          italic: false,
        });
        y -= size * 1.28;
      }
      x += cellWidth;
    }
    // Cell rules are drawn after the text so they sit underneath nothing.
    surface.page.drawLine({
      start: { x: surface.columnX, y: surface.y },
      end: { x: surface.columnX + columnWidth, y: surface.y },
      thickness: 0.4,
      color: rgb(0.82, 0.82, 0.79),
    });
  };

  if (settings.header) void settings.header;
  const drawHeader = async (): Promise<void> => {
    if (block.header) await renderRow(block.header, true);
  };
  await drawHeader();
  for (const row of rows) await renderRow(row, false, block.header ? drawHeader : undefined);

  if (block.caption) {
    surface.y -= 4;
    const lines = await wrapTextSimple(doc, block.caption, { size: settings.baseFontSize * 0.9, maxWidth: columnWidth });
    for (const line of lines) {
      surface.y -= settings.baseFontSize * 1.3;
      await drawTextU(surface.page, {
        text: line.text,
        x: surface.columnX,
        y: surface.y,
        size: settings.baseFontSize * 0.9,
        italic: true,
        color: rgb(0.35, 0.35, 0.32),
      });
    }
  }
  surface.y -= 8;
  void pages;
}

function normalizeCells(cell: Inline[]): Inline[] {
  if (cell.length > 0) return cell;
  return [{ text: '' }];
}

async function columnWidths(
  doc: PDFDocument,
  block: Extract<Block, { kind: 'table' }>,
  columns: number,
  total: number,
  size: number,
  settings: LayoutOptions,
): Promise<number[]> {
  if (block.widths?.length === columns && block.widths.every((w) => w > 0)) {
    const sum = block.widths.reduce((a, b) => a + b, 0);
    return block.widths.map((w) => (w / sum) * total);
  }
  const wanted: number[] = Array.from({ length: columns }, () => size * 3);
  const sample: Inline[][][] = [
    ...(block.header ? [block.header] : []),
    ...block.rows.slice(0, 60),
  ];
  for (const row of sample) {
    for (let index = 0; index < columns; index++) {
      const text = (row[index] ?? []).map((run) => run.text).join('');
      const longest = text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
      const font = await getFont(doc, { text: longest || 'M', size, bold: false });
      const width = font.widthOfTextAtSize(longest || 'M', size) + 12;
      wanted[index] = Math.max(wanted[index], Math.min(total * 0.55, width));
    }
  }
  const sum = wanted.reduce((a, b) => a + b, 0);
  void settings;
  return wanted.map((w) => (w / sum) * total);
}

// ── wrapping ────────────────────────────────────────────────────────────────

export async function wrapInlines(
  doc: PDFDocument,
  inlines: Inline[],
  options: { size: number; maxWidth: number; bold?: boolean; fontFamily?: string },
): Promise<LineRun[][]> {
  const runs = (inlines ?? []).filter((run) => typeof run.text === 'string');
  const lines: LineRun[][] = [];
  let current: LineRun[] = [];
  let currentWidth = 0;

  const push = () => {
    if (current.length > 0 || lines.length === 0) lines.push(current);
    current = [];
    currentWidth = 0;
  };

  for (const run of runs) {
    const size = run.size ?? options.size;
    const bold = run.bold ?? options.bold;
    const chunks = run.text.split(/(\s+)/);
    let buffer = '';
    for (const chunk of chunks) {
      if (chunk === '') continue;
      if (chunk.includes('\n')) {
        for (const piece of chunk.split('\n')) {
          buffer += piece;
          if (buffer.trim() !== '') {
            current.push({ ...run, text: buffer });
          }
          buffer = '';
          push();
        }
        continue;
      }
      const candidate = buffer + chunk;
      const { width } = await measureText(doc, {
        text: candidate.trimStart() || candidate,
        x: 0,
        y: 0,
        size,
        bold,
        italic: run.italic,
      });
      if (currentWidth + width > options.maxWidth && (current.length > 0 || buffer !== '')) {
        // The whitespace that caused the break belongs to neither line: left here
        // it widens the finished line past the text it shows, and two runs read
        // back as one string come out with a double space in the middle.
        if (buffer.trim() !== '') current.push({ ...run, text: buffer.replace(/\s+$/, '') });
        push();
        buffer = chunk.replace(/^\s+/, '');
        const remeasured = await measureText(doc, { text: buffer || ' ', x: 0, y: 0, size, bold, italic: run.italic });
        currentWidth = remeasured.width;
      } else {
        buffer = candidate;
        currentWidth += width;
      }
    }
    if (buffer !== '') {
      current.push({ ...run, text: buffer });
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [[{ text: '' }]];
}

async function wrapTextSimple(
  doc: PDFDocument,
  text: string,
  options: { size: number; maxWidth: number },
): Promise<{ text: string }[]> {
  const lines = await wrapInlines(doc, [{ text }], options);
  return lines.map((line) => ({ text: line.map((run) => run.text).join('') }));
}

async function monoFont(doc: PDFDocument) {
  try {
    const response = await fetch(MONO_URL);
    if (!response.ok) throw new Error('missing');
    // `embedUnicodeFace` rather than `doc.embedFont`: pdf-lib reads a face's
    // flavour off a property this fontkit never sets, so bytes handed to it can
    // land in the wrong slot and paint nothing while still extracting.
    return await embedUnicodeFace(doc, new Uint8Array(await response.arrayBuffer()));
  } catch {
    return getFont(doc, { text: 'code', size: 10 });
  }
}

async function embedBytes(doc: PDFDocument, bytes: Uint8Array, mime?: string) {
  if (mime === 'image/png' || mime === undefined) {
    const png = await doc.embedPng(bytes).catch(() => null);
    if (png) return png;
  }
  if (mime === 'image/jpeg') {
    const jpg = await doc.embedJpg(bytes).catch(() => null);
    if (jpg) return jpg;
  }
  const decoded = await decodeImage(bytes, { mime });
  const canvas = decoded.canvas;
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('This browser could not encode an image for the PDF.');
  return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
}

function hex(value: string) {
  const clean = value.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const number = (index: number) => Math.min(1, Math.max(0, parseInt(full.slice(index, index + 2), 16) / 255 || 0));
  return rgb(number(0), number(2), number(4));
}

function expandTokens(value: string, context: { page: number; total: number }): string {
  return value
    .replace(/\{page\}/g, String(context.page))
    .replace(/\{total\}/g, context.total > 0 ? String(context.total) : '');
}

// ── parsers: concrete formats → blocks ──────────────────────────────────────

export function textToBlocks(
  text: string,
  options: { monospace?: boolean; paragraphs?: '\n\n' | '\n' } = {},
): Block[] {
  const separator = options.paragraphs ?? '\n\n';
  const chunks = text.replace(/\r\n/g, '\n').split(separator);
  return chunks
    .filter((chunk) => chunk.trim() !== '')
    .map((chunk) =>
      options.monospace
        ? { kind: 'code' as const, text: chunk.replace(separator, '\n') }
        : {
            kind: 'paragraph' as const,
            inlines: chunk.split('\n').map((line, index) => ({
              // Spaces, the same expansion the code branch gets in `renderBlocks`:
              // a tab has no WinAnsi code, so one anywhere in the source made the
              // standard face throw and the whole run produced no file.
              text: (index === 0 ? line : `\n${line}`).replace(/\t/g, '    '),
            })),
          },
    );
}

/** Build a table block from plain rows — shared by the CSV and Excel paths. */
export function tableBlock(rows: string[][], options: { header?: boolean } = {}): Block {
  const [head, ...body] = rows;
  return {
    kind: 'table',
    header: options.header === false ? undefined : head
      ? head.map((cell) => [{ text: cell, bold: true } as Inline])
      : undefined,
    rows: (options.header === false ? rows : body).map((row) => row.map((cell) => [{ text: cell }])),
  };
}

export async function csvToBlocks(
  text: string,
  options: { delimiter?: string; header?: boolean } = {},
): Promise<Block[]> {
  const XLSX = await import('xlsx');
  // `FS` is what separates fields: pinning it to a comma while the caller asked
  // for `;` or a tab turned every row into one wide cell. Left unset, SheetJS
  // detects the separator, which is what the “Detect” option means.
  const sheet = XLSX.read(text, {
    type: 'string',
    ...(options.delimiter ? { FS: options.delimiter } : {}),
  });
  const first = sheet.SheetNames[0];
  const rows = (XLSX.utils.sheet_to_json(sheet.Sheets[first] ?? {}, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  }) as unknown[][]).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))));
  if (rows.length === 0) return [];
  return [tableBlock(rows, { header: options.header !== false })];
}

export function jsonToBlocks(value: unknown, options: { maxDepth?: number } = {}): Block[] {
  const maxDepth = options.maxDepth ?? 8;
  const blocks: Block[] = [];
  const walk = (node: unknown, depth: number, key?: string): void => {
    if (depth > maxDepth) {
      blocks.push({ kind: 'code', text: `${key ?? ''} …(truncated)` });
      return;
    }
    if (node === null || node === undefined || typeof node !== 'object') {
      blocks.push({
        kind: 'paragraph',
        inlines: [
          ...(key ? [{ text: `${key}: `, bold: true } as Inline] : []),
          { text: formatScalar(node), code: true } as Inline,
        ],
      });
      return;
    }
    if (Array.isArray(node)) {
      if (key) blocks.push({ kind: 'heading', level: Math.min(6, depth + 1) as 1, inlines: [{ text: key }] });
      if (node.length === 0) {
        blocks.push({ kind: 'paragraph', inlines: [{ text: '(empty list)', italic: true }] });
        return;
      }
      blocks.push({
        kind: 'list',
        items: node.map((item) => ({
          inlines: [{ text: typeof item === 'object' && item !== null ? describeObject(item) : formatScalar(item) }],
          level: 0,
        })),
      });
      for (const [index, item] of node.entries()) walk(item, depth + 1, `[${index}]`);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (key) blocks.push({ kind: 'heading', level: Math.min(6, depth + 1) as 1, inlines: [{ text: key }] });
    if (entries.length === 0) {
      blocks.push({ kind: 'paragraph', inlines: [{ text: '(empty object)', italic: true }] });
      return;
    }
    blocks.push({
      kind: 'table',
      header: [[{ text: 'Key', bold: true } as Inline], [{ text: 'Value', bold: true } as Inline]],
      rows: entries.map(([name, item]) => [
        [{ text: name, bold: true } as Inline],
        [{ text: typeof item === 'object' && item !== null ? describeObject(item) : formatScalar(item) } as Inline],
      ]),
    });
    for (const [name, item] of entries) {
      if (item !== null && typeof item === 'object') walk(item, depth + 1, name);
    }
  };
  walk(value, 0);
  return blocks;
}

function describeObject(node: unknown): string {
  if (Array.isArray(node)) return `array of ${node.length}`;
  const keys = Object.keys((node ?? {}) as Record<string, unknown>);
  return `{ ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''} }`;
}

function formatScalar(node: unknown): string {
  if (node === null) return 'null';
  if (node === undefined) return 'undefined';
  if (typeof node === 'string') return node;
  return String(node);
}

export function xmlToBlocks(text: string): Block[] {
  const document = new DOMParser().parseFromString(text.replace(/^\uFEFF/, ''), 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) {
    return [{ kind: 'code', text: text.slice(0, 20000) }];
  }
  const blocks: Block[] = [];
  const root = document.documentElement;
  const walk = (element: Element, depth: number): void => {
    const children = Array.from(element.children ?? []);
    const text = Array.from(element.childNodes ?? [])
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    const attributes = Array.from(element.attributes ?? [])
      .map((attribute) => `${attribute.name}="${attribute.value}"`)
      .join(' ');
    if (depth === 0) {
      blocks.push({ kind: 'heading', level: 1, inlines: [{ text: element.nodeName }] });
    }
    if (text || attributes) {
      blocks.push({
        kind: 'paragraph',
        inlines: [
          { text: `${'  '.repeat(depth)}<${element.nodeName}${attributes ? ` ${attributes}` : ''}>`, code: true } as Inline,
          ...(text ? [{ text: ` ${text}`, bold: true } as Inline] : []),
        ],
        indent: depth * 12,
      });
    }
    for (const child of children) walk(child, depth + 1);
  };
  if (root) walk(root, 0);
  return blocks;
}

/** One `marked` lexer token, narrowed to the fields this renderer reads. */
interface MdToken extends Record<string, unknown> {
  type: string;
  items?: MdToken[];
  tokens?: MdToken[];
  raw?: string;
  text?: string;
  depth?: number;
  ordered?: boolean;
  checked?: boolean;
  header?: MdToken[];
  rows?: MdToken[][];
  href?: string;
  alt?: string;
  lang?: string;
}

/**
 * Markdown via the `marked` lexer, so tables, task lists and fenced code are
 * real structure rather than a regex approximation.
 */
export async function markdownToBlocks(
  markdown: string,
  options: { images?: (src: string) => Promise<Uint8Array | null> } = {},
): Promise<Block[]> {
  const { marked } = await import('marked');
  // SAFETY: `marked` types its lexer output as a wide `TokensList` union whose
  // members carry the fields read below; `MdToken` is that shared shape narrowed
  // to what this renderer consumes, so no field is invented by the cast.
  const tokens = marked.lexer(markdown) as unknown as MdToken[];
  const inlineOf = (tokens: MdToken[] | undefined): Inline[] => walkInline(tokens ?? []);
  const blocks: Block[] = [];

  /** Embed a picture the caller can supply (a data: URL), else keep its alt. */
  const pushImage = async (token: MdToken): Promise<void> => {
    const href = String(token.href ?? '');
    const alt = String(token.alt ?? token.text ?? '');
    const bytes = await options.images?.(href);
    if (bytes) {
      blocks.push({
        kind: 'image',
        bytes,
        mime: mimeOfDataUrl(href),
        alt,
        caption: alt || undefined,
      });
      return;
    }
    blocks.push({ kind: 'paragraph', inlines: [{ text: `[image: ${alt || href}]`, italic: true }] });
  };

  const walk = async (list: MdToken[]): Promise<void> => {
    for (const token of list) {
      switch (token.type) {
        case 'heading':
          blocks.push({
            kind: 'heading',
            level: Math.min(6, Math.max(1, Number(token.depth ?? 1))) as 1,
            inlines: inlineOf(token.tokens),
          });
          break;
        case 'paragraph': {
          // A line holding nothing but `![alt](src)` is a picture in its own
          // right; `walkInline` can only print its alt text, because the
          // renderer places pictures between paragraphs rather than between
          // words. Mixed paragraphs keep the alt text, and say so.
          const inner = token.tokens ?? [];
          const images = inner.filter((sub) => sub.type === 'image');
          const onlyImages = images.length > 0
            && inner.every((sub) => sub.type === 'image'
              || (sub.type === 'text' && String(sub.text ?? sub.raw ?? '').trim() === ''));
          if (onlyImages) {
            for (const image of images) await pushImage(image);
            break;
          }
          blocks.push({ kind: 'paragraph', inlines: inlineOf(inner) });
          break;
        }
        case 'text': {
          const text = String(token.raw ?? token.text ?? '');
          if (text.trim()) blocks.push({ kind: 'paragraph', inlines: [{ text: text.trim() }] });
          break;
        }
        case 'list': {
          const items = (token.items ?? []).map((item: MdToken) => ({
            inlines: inlineOf(item.tokens?.filter((sub) => sub.type !== 'list')),
            level: Number(item.tokens?.[0]?.spaceDepth ?? 0) > 0 ? 1 : 0,
            checked: typeof item.checked === 'boolean' ? item.checked : null,
          }));
          blocks.push({ kind: 'list', ordered: Boolean(token.ordered), items });
          for (const item of token.items ?? []) {
            for (const nested of item.tokens ?? []) {
              if (nested.type === 'list') await walk([nested]);
            }
          }
          break;
        }
        case 'code':
          blocks.push({ kind: 'code', text: String(token.text ?? ''), language: token.lang ? String(token.lang) : undefined });
          break;
        case 'blockquote':
          blocks.push({ kind: 'quote', inlines: inlineOf(token.tokens) });
          break;
        case 'table': {
          const header = (token.header as MdToken[] | undefined)?.map((cell) => inlineOf(cell.tokens ?? [cell])) ?? [];
          const rows = ((token.rows as MdToken[][] | undefined) ?? []).map((row) =>
            row.map((cell) => inlineOf(cell.tokens ?? [cell])),
          );
          blocks.push({ kind: 'table', header, rows });
          break;
        }
        case 'hr':
          blocks.push({ kind: 'rule' });
          break;
        case 'image':
          await pushImage(token);
          break;
        case 'br':
          break;
        case 'html': {
          const raw = String(token.text ?? token.raw ?? '');
          if (raw.trim()) blocks.push({ kind: 'code', text: raw.trim() });
          break;
        }
        case 'def':
        case 'space':
          break;
        default: {
          const text = String(token.text ?? token.raw ?? '');
          if (text.trim()) blocks.push({ kind: 'paragraph', inlines: [{ text: text.trim() }] });
        }
      }
    }
  };
  await walk(tokens);
  return blocks.length > 0 ? blocks : textToBlocks(markdown);
}

function walkInline(tokens: MdToken[]): Inline[] {
  const out: Inline[] = [];
  const visit = (list: MdToken[], style: Partial<Inline>): void => {
    for (const token of list) {
      switch (token.type) {
        case 'strong':
          visit(tokensOf(token), { ...style, bold: true });
          break;
        case 'em':
          visit(tokensOf(token), { ...style, italic: true });
          break;
        case 'codespan':
          out.push({ text: String(token.text ?? ''), code: true, ...style });
          break;
        case 'del':
          visit(tokensOf(token), { ...style, strike: true });
          break;
        case 'link':
          visit(tokensOf(token), { ...style, link: String(token.href ?? ''), color: '#2563eb' });
          break;
        case 'br':
          out.push({ text: '\n', ...style });
          break;
        case 'escape':
          out.push({ text: String(token.text ?? token.raw ?? ''), ...style });
          break;
        case 'image':
          out.push({ text: `[${String(token.alt ?? 'image')}]`, ...style, italic: true });
          break;
        default: {
          const text = String(token.text ?? token.raw ?? '');
          if (text) out.push({ text, ...style });
        }
      }
    }
  };
  visit(tokens, {});
  return out.length > 0 ? out : [{ text: '' }];
}

function tokensOf(token: MdToken): MdToken[] {
  if (Array.isArray(token.tokens)) return token.tokens;
  if (typeof token.text === 'string') return [{ type: 'text', text: token.text }];
  if (typeof token.raw === 'string') return [{ type: 'text', text: token.raw }];
  return [];
}

/**
 * HTML → blocks by walking a detached `DOMParser` tree.
 *
 * The document is never touched: author markup cannot run scripts, load pixels
 * or reach our own origin's storage, which is the hole the old implementation
 * had.
 */
export async function htmlToBlocks(
  html: string,
  options: { fetchImage?: (src: string) => Promise<Uint8Array | null> } = {},
): Promise<Block[]> {
  const document = new DOMParser().parseFromString(sanitiseSource(html), 'text/html');
  const body = document.body;
  const blocks: Block[] = [];
  if (!body) return blocks;

  const flushInline = (container: Element, kind: 'paragraph' | 'heading' = 'paragraph', level = 1): void => {
    const inlines = collectInlines(container, options);
    if (inlines.every((run) => run.text.trim() === '')) return;
    blocks.push(
      kind === 'heading'
        ? { kind: 'heading', level: Math.min(6, Math.max(1, level)) as 1, inlines }
        : { kind: 'paragraph', inlines },
    );
  };

  const visit = (element: Element): void => {
    for (const child of Array.from(element.children)) {
      const tag = child.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        flushInline(child, 'heading', Number(tag[1]));
        continue;
      }
      switch (tag) {
        case 'p':
        case 'div':
        case 'section':
        case 'article':
        case 'main':
        case 'header':
        case 'footer':
        case 'aside':
        case 'figcaption':
        case 'span':
        case 'font': {
          const hasBlockChild = Array.from(child.children).some((inner) =>
            /^(p|div|h[1-6]|ul|ol|table|pre|blockquote|section|article|figure)$/.test(inner.tagName.toLowerCase()),
          );
          if (hasBlockChild) visit(child);
          else flushInline(child);
          break;
        }
        case 'br':
          blocks.push({ kind: 'paragraph', inlines: [{ text: '' }] });
          break;
        case 'hr':
          blocks.push({ kind: 'rule' });
          break;
        case 'ul':
        case 'ol':
          blocks.push(listFromElement(child, tag === 'ol', options));
          break;
        case 'blockquote': {
          const inlines = collectInlines(child, options);
          if (inlines.some((run) => run.text.trim())) blocks.push({ kind: 'quote', inlines });
          break;
        }
        case 'pre':
          blocks.push({ kind: 'code', text: (child.textContent ?? '').replace(/^\n|\n$/g, '') });
          break;
        case 'table': {
          const block = tableFromElement(child);
          if (block) blocks.push(block);
          break;
        }
        case 'img': {
          const image = imageFromElement(child, options);
          if (image) blocks.push(image);
          else {
            const alt = child.getAttribute('alt') ?? '';
            if (alt) blocks.push({ kind: 'paragraph', inlines: [{ text: `[image: ${alt}]`, italic: true }] });
          }
          break;
        }
        case 'style':
        case 'script':
        case 'noscript':
        case 'head':
        case 'title':
        case 'meta':
        case 'link':
          break;
        default: {
          const hasElementChildren = child.children.length > 0;
          if (hasElementChildren) visit(child);
          else flushInline(child.parentElement ?? child);
        }
      }
    }
  };
  visit(body);
  return blocks;
}

/** Synchronously ignore things a parser would have to fetch. */
function sanitiseSource(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(meta|link)\b[^>]*>/gi, '');
}

function listFromElement(
  element: Element,
  ordered: boolean,
  options: { fetchImage?: (src: string) => Promise<Uint8Array | null> },
): Block {
  const items: { inlines: Inline[]; level: number; checked: boolean | null }[] = [];
  const walkList = (node: Element, level: number): void => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag !== 'li') continue;
      const own = cloneWithInlineOnly(child);
      items.push({
        inlines: collectInlines(own, options),
        level,
        checked: /^(true|false)$/.test(child.getAttribute('data-checked') ?? '')
          ? child.getAttribute('data-checked') === 'true'
          : /\[x\]/i.test(child.textContent ?? '')
            ? true
            : /\[ \]/.test(child.textContent ?? '')
              ? false
              : null,
      });
      for (const inner of Array.from(child.children)) {
        if (/^(ul|ol)$/.test(inner.tagName.toLowerCase())) walkList(inner, level + 1);
      }
    }
  };
  walkList(element, 0);
  return { kind: 'list', ordered, items };
}

function cloneWithInlineOnly(item: Element): Element {
  const clone = item.cloneNode(true) as Element;
  for (const nested of Array.from(clone.querySelectorAll('ul, ol, table, pre, blockquote'))) {
    nested.remove();
  }
  return clone;
}

function tableFromElement(table: Element): Block | null {
  const rowElements = Array.from(table.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr'));
  if (rowElements.length === 0) return null;
  const parsed = rowElements.map((row) =>
    Array.from(row.querySelectorAll(':scope > th, :scope > td')).map((cell) =>
      (cell.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  );
  const columns = Math.max(1, ...parsed.map((row) => row.length));
  const grid = parsed.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ''));
  const hasHeader = rowElements.some((row) => Array.from(row.children).some((cell) => cell.tagName.toLowerCase() === 'th'));
  const [head, ...body] = grid;
  return {
    kind: 'table',
    header: hasHeader && head ? head.map((cell) => [{ text: cell, bold: true } as Inline]) : undefined,
    rows: (hasHeader ? body : grid).map((row) => row.map((cell) => [{ text: cell }])),
  };
}

function imageFromElement(
  element: Element,
  options: { fetchImage?: (src: string) => Promise<Uint8Array | null> },
): Block | null {
  const src = element.getAttribute('src') ?? '';
  if (!src.startsWith('data:')) {
    if (!options.fetchImage) return null;
    return null;
  }
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src);
  if (!match) return null;
  const payload = match[3] ?? '';
  try {
    const bytes = match[2]
      ? base64ToBytes(decodeURIComponent(payload))
      : new TextEncoder().encode(decodeURIComponent(payload));
    return {
      kind: 'image',
      bytes,
      mime: match[1] ?? 'image/png',
      caption: element.getAttribute('alt') ?? undefined,
      width: Number(element.getAttribute('width') ?? '0') || undefined,
    };
  } catch {
    return null;
  }
}

/** The MIME a `data:` URL declares, which is the only one a caller can hand over. */
function mimeOfDataUrl(src: string): string | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(src);
  return match?.[1] ?? undefined;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function collectInlines(
  container: Element,
  options: { fetchImage?: (src: string) => Promise<Uint8Array | null> },
): Inline[] {
  const runs: Inline[] = [];
  const push = (text: string, style: Partial<Inline>): void => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, style)) last.text += text;
    else runs.push({ text, ...style });
  };
  const walk = (node: Node, style: Partial<Inline>): void => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType === 3) {
        push((child.textContent ?? '').replace(/\s+/g, ' '), style);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      const next = applyStyle(tag, element, style);
      if (tag === 'br') push('\n', style);
      else if (tag === 'img') {
        const image = imageFromElement(element, options);
        push(image ? `[image: ${element.getAttribute('alt') ?? 'image'}]` : element.getAttribute('alt') ?? '', {
          ...next,
          italic: true,
        });
      } else walk(element, next);
    }
  };
  walk(container, {});
  return runs.length > 0 ? runs : [{ text: (container.textContent ?? '').trim() }].filter((run) => run.text);
}

function applyStyle(tag: string, element: Element, style: Partial<Inline>): Partial<Inline> {
  const css = (element.getAttribute('style') ?? '').toLowerCase();
  const next = { ...style };
  if (tag === 'strong' || tag === 'b' || /font-weight\s*:\s*(bold|[6-9]00)/.test(css)) next.bold = true;
  if (tag === 'em' || tag === 'i' || /font-style\s*:\s*italic/.test(css)) next.italic = true;
  if (tag === 'u' || /text-decoration[^;]*underline/.test(css)) next.underline = true;
  if (tag === 's' || tag === 'del' || tag === 'strike' || /line-through/.test(css)) next.strike = true;
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || /font-family[^;]*(mono|courier)/.test(css)) next.code = true;
  if (tag === 'sup') next.superscript = true;
  if (tag === 'sub') next.subscript = true;
  if (tag === 'a') {
    next.link = element.getAttribute('href') ?? undefined;
    next.color = next.color ?? '#2563eb';
  }
  const color = /color\s*:\s*(#[0-9a-f]{3,8}|[a-z]+|[rR][gG]B\([^)]+\))/.exec(css)?.[1];
  if (color) next.color = color;
  const size = /font-size\s*:\s*(\d+(?:\.\d+)?)(px|pt|em|%)/.exec(css);
  if (size) {
    const value = Number(size[1]);
    next.size = size[2] === 'em' ? value * 11 : size[2] === '%' ? (value / 100) * 11 : size[2] === 'pt' ? value : value * 0.75;
  }
  return next;
}

function sameStyle(run: Inline, style: Partial<Inline>): boolean {
  const sameFlag = (a: boolean | undefined, b: boolean | undefined): boolean =>
    Boolean(a) === Boolean(b);
  return (
    sameFlag(run.bold, style.bold)
    && sameFlag(run.italic, style.italic)
    && sameFlag(run.underline, style.underline)
    && sameFlag(run.strike, style.strike)
    && sameFlag(run.code, style.code)
    && (run.color ?? '') === (style.color ?? '')
  );
}

/**
 * A pragmatic RTF reader.
 *
 * Handles the control words that carry meaning for a PDF conversion — \b \i \ul
 * \strike \fs \par \line \tab \u \ansicpg and {\pict} — plus {\row {\cell}}
 * tables. Colour tables, stylesheets, embedded objects and field codes are
 * ignored, and nested destinations are skipped rather than guessed at.
 */
export function rtfToBlocks(rtf: string): Block[] {
  const encoding = /\\ansicpg(\d{3,5})/.exec(rtf)?.[1] ?? '1252';
  const decoder = makeDecoder(encoding);
  const blocks: Block[] = [];
  let paragraph: Inline[] = [];
  let current: Partial<Inline> = {};
  let depth = 0;
  const skipDepth: number[] = [];
  let row: string[][] = [];
  let cells: string[] = [];
  let inTable = false;

  const flushParagraph = (): void => {
    const text = paragraph.map((run) => run.text).join('');
    if (text.trim() !== '') {
      if (inTable) cells.push(text.trim());
      else blocks.push({ kind: 'paragraph', inlines: paragraph });
    }
    paragraph = [];
  };

  for (let i = 0; i < rtf.length; i++) {
    const char = rtf[i];
    if (skipDepth.length > 0 && depth >= skipDepth[skipDepth.length - 1] && char === '}') {
      skipDepth.pop();
    }
    if (skipDepth.length > 0 && depth >= skipDepth[skipDepth.length - 1]) {
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === '{') {
      depth += 1;
      // A destination group is `{\name …}`: the brace is part of it, so the name
      // is matched after the brace rather than instead of it. Written the other
      // way only `{\* …}` was skipped, and every colour table, font table and
      // stylesheet printed its own plumbing as document text.
      const destination = /^\{\\(\*|stylesheet|colortbl|info|fonttbl|header|footer|pict|nonshppict|shppict|object|listtable|generator|themedata|colorschememapping)/.test(rtf.slice(i, i + 40));
      if (destination && !/\\pict\b/.test(rtf.slice(i, i + 60))) skipDepth.push(depth);
      continue;
    }
    if (char === '}') {
      flushParagraph();
      if (inTable && cells.length > 0) {
        row.push(cells);
        cells = [];
      }
      if (row.length > 0) {
        blocks.push(tableBlock(row));
        row = [];
        inTable = false;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char !== '\\') {
      if (char === '\r' || char === '\n') continue;
      paragraph.push({ text: char, ...current });
      continue;
    }
    // `\'hh` is one byte in the declared code page, not a control word. Left
    // alone it survives as the literal characters `hh` beside a quote mark.
    const byteEscape = /^\\'([0-9A-Fa-f]{2})/.exec(rtf.slice(i));
    if (byteEscape) {
      const decoded = decoder(new Uint8Array([Number.parseInt(byteEscape[1], 16)]));
      if (decoded) paragraph.push({ text: decoded, ...current });
      i += 3;
      continue;
    }
    const control = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(rtf.slice(i));
    if (!control) {
      const escaped = rtf[i + 1];
      if (escaped === '{' || escaped === '}' || escaped === '\\') {
        paragraph.push({ text: escaped, ...current });
        i += 1;
      }
      continue;
    }
    const word = control[1];
    const argument = control[2] === undefined ? null : Number(control[2]);
    i += control[0].length - 1;
    switch (word) {
      case 'b':
        current = { ...current, bold: argument !== 0 };
        break;
      case 'i':
        current = { ...current, italic: argument !== 0 };
        break;
      case 'ul':
      case 'ulw':
      case 'uld':
        current = { ...current, underline: argument !== 0 };
        break;
      case 'strike':
        current = { ...current, strike: argument !== 0 };
        break;
      case 'fs':
        if (argument) current = { ...current, size: argument / 2 };
        break;
      case 'par':
      case 'line':
      case 'sect':
        flushParagraph();
        break;
      case 'tab':
        paragraph.push({ text: '\t', ...current });
        break;
      case 'cell':
      case 'nestcell':
        flushParagraph();
        inTable = true;
        if (cells.length > 0) {
          row.push(cells);
          cells = [];
        }
        break;
      case 'row':
      case 'nestrow':
        if (cells.length > 0) {
          row.push(cells);
          cells = [];
        }
        if (row.length > 0) {
          blocks.push(tableBlock(row));
          row = [];
        }
        inTable = false;
        break;
      case 'u':
        if (argument !== null) paragraph.push({ text: String.fromCharCode(argument < 0 ? argument + 65536 : argument), ...current });
        break;
      case 'hex':
      case 'bin': {
        const count = argument ?? 0;
        i += control[0].length ? 0 : 0;
        const raw = rtf.slice(i + 1, i + 1 + count * 2);
        i += raw.length;
        const decoded = decoder(hexToBytes(raw.replace(/\s+/g, '')));
        if (/[^\x00-\x08\x0e-\x1f]/.test(decoded)) paragraph.push({ text: decoded, ...current });
        break;
      }
      case 'pict':
      case 'jpegblip':
      case 'pngblip': {
        const hexStart = rtf.indexOf('\\', i + 1);
        const hexBody = rtf.slice(i + 1, hexStart === -1 ? rtf.length : hexStart);
        const bytes = hexToBytes(hexBody.replace(/[^0-9A-Fa-f]/g, ''));
        if (bytes.length > 64) {
          flushParagraph();
          blocks.push({
            kind: 'image',
            bytes,
            mime: word === 'pngblip' || rtf.includes('\\pngblip') ? 'image/png' : 'image/jpeg',
          });
        }
        break;
      }
      case 'ansicpg':
      case 'deff':
      case 'rtf':
      case 'ansi':
      case 'mac':
      case 'pc':
      case 'pctext':
      case 'brdrb':
      case 'plain':
        if (word === 'plain') current = {};
        break;
      default:
        break;
    }
  }
  flushParagraph();
  return blocks.length > 0 ? blocks : textToBlocks(stripRtf(rtf));
}

function stripRtf(rtf: string): string {
  return rtf.replace(/\\[a-z]{1,32}-?\d{0,10} ?/gi, '').replace(/[{}]/g, '');
}

function hexToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(value.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const LABELS: Record<string, string> = {
  newDocumentForLayout: 'newDocumentForLayout',
};
void LABELS;

function makeDecoder(ansiCodePage: string): (bytes: Uint8Array) => string {
  const label = ansiCodePage === '936' ? 'gbk' : ansiCodePage === '950' ? 'big5' : ansiCodePage === '932' ? 'shift_jis' : ansiCodePage === '1252' ? 'windows-1252' : `windows-${ansiCodePage}`;
  const decodeWith = (encoding: string) => {
    try {
      return new TextDecoder(encoding).decode(new Uint8Array([65]));
    } catch {
      return false;
    }
  };
  const supported = decodeWith(label);
  void supported;
  return (bytes: Uint8Array) => {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  };
}
