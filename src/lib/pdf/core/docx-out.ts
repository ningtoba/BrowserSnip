/**
 * PDF structure → Word (.docx).
 *
 * The previous implementation ran pdf.js text runs through a y-coordinate
 * heuristic and forced every run to Calibri, so a heading became body text and
 * italics were lost. This builds on the block model from `core/convert`: heading
 * levels come from font-height clustering, lists keep their markers, and
 * detected tables become real Word tables.
 *
 * Fidelity note for the UI: this is a *reflow* conversion, not a layout copy —
 * Word re-lays the text. Absolute page positions are not preserved.
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { PdfJsonBlock, PdfJsonDocument, PdfJsonPage } from './convert';
import type { QuadRect } from './annotations';

export interface DocxOptions {
  headings?: boolean;
  tables?: boolean;
  /** Insert a page break for each source page. Default false. */
  pageBreaks?: boolean;
  headingHeights?: number[];
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
}

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

export async function buildDocx(
  json: PdfJsonDocument,
  options: DocxOptions = {},
): Promise<Blob> {
  const headingsEnabled = options.headings !== false;
  const headingHeights = options.headingHeights ?? detectHeights(json);
  const children: Paragraph[] = [];

  for (const page of json.pages) {
    const blocks = [...page.blocks].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    for (const block of blocks) {
      if (block.type === 'table' && options.tables !== false) {
        children.push(...tableParagraphs(block));
        continue;
      }
      const text = (block.text ?? '').trim();
      if (!text) continue;
      children.push(...blockParagraphs(block, page, { headingsEnabled, headingHeights }));
    }
    if (options.pageBreaks && page.page !== json.pages[json.pages.length - 1].page) {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }

  if (children.length === 0) {
    children.push(new Paragraph({ text: '(no selectable text was found in this PDF)' }));
  }

  const doc = new Document({
    title: options.title ?? asString(json.meta?.title),
    creator: options.author ?? 'BrowserSnip',
    description: options.subject ?? undefined,
    keywords: options.keywords ?? asString(json.meta?.keywords),
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
        },
      },
    },
    sections: [{ properties: {}, children }],
  });

  return Packer.toBlob(doc);
}

function blockParagraphs(
  block: PdfJsonBlock,
  page: PdfJsonPage,
  context: { headingsEnabled: boolean; headingHeights: number[] },
): Paragraph[] {
  const lines = block.lines?.length ? block.lines : [{ text: block.text ?? '', bbox: block.rect, fontHeight: 11 }];
  const height = dominantHeight(lines.map((line) => line.fontHeight));
  const level = context.headingsEnabled ? headingLevelFor(height, context.headingHeights) : 0;
  const align = alignmentFor(block.rect, page);

  if (level > 0) {
    return [
      new Paragraph({
        text: (block.text ?? '').trim(),
        heading: HEADING_LEVELS[Math.min(level, 6) - 1],
        alignment: align,
        spacing: { before: 240, after: 120 },
      }),
    ];
  }

  const listMarker = /^\s*(?:[-•◦*]|\d{1,3}[.)])\s+/.exec(block.text ?? '');
  if (listMarker) {
    const ordered = /\d/.test(listMarker[0]);
    return [
      new Paragraph({
        children: [new TextRun({ text: (block.text ?? '').slice(listMarker[0].length).trim() })],
        bullet: ordered ? undefined : { level: 0 },
        numbering: ordered ? { reference: 'pdf-list', level: 0 } : undefined,
        alignment: align,
      }),
    ];
  }

  return lines.map(
    (line) =>
      new Paragraph({
        children: [
          new TextRun({
            text: line.text.trim(),
            bold: height >= 13 && height < 18,
            size: Math.round(clamp(height, 6, 96) * 2),
          }),
        ],
        alignment: align,
        spacing: { after: 60 },
      }),
  );
}

function tableParagraphs(block: PdfJsonBlock): Paragraph[] {
  const rows = block.rows ?? [];
  if (rows.length === 0) {
    const text = (block.text ?? '').trim();
    return text ? [new Paragraph({ text })] : [];
  }
  const columns = Math.max(...rows.map((row) => row.length), 1);
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (row, index) =>
        new TableRow({
          tableHeader: index === 0,
          children: Array.from({ length: columns }, (_, column) => {
            const cell = row[column] ?? '';
            return new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: cell, bold: index === 0 })],
                }),
              ],
            });
          }),
        }),
    ),
  });
  return [new Paragraph({ children: [] }), paragraphFromTable(table)];
}

/**
 * `docx` accepts a Table directly in a section's children array; this wraps the
 * cast so the public signature above stays honest about returning Paragraph[].
 */
function paragraphFromTable(table: Table): Paragraph {
  // SAFETY: `docx` accepts `Paragraph | Table` in a section's children array;
  // the return type here is narrowed only so callers can keep pushing into a
  // single array without re-switching on the kind.
  return table as unknown as Paragraph;
}

function alignmentFor(rect: QuadRect, page: PdfJsonPage): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const pageCenter = page.width / 2;
  const blockCenter = rect.x + rect.width / 2;
  const widthRatio = rect.width / Math.max(1, page.width);
  if (widthRatio > 0.75) return undefined;
  if (Math.abs(blockCenter - pageCenter) < page.width * 0.06) return AlignmentType.CENTER;
  if (blockCenter > pageCenter) return AlignmentType.RIGHT;
  return undefined;
}

function headingLevelFor(height: number, headingHeights: number[]): number {
  if (headingHeights.length === 0) return 0;
  for (let index = 0; index < headingHeights.length; index++) {
    if (height >= headingHeights[index] - 0.6) return index + 1;
  }
  return 0;
}

/**
 * Cluster font heights, largest first, and keep the top few as heading levels.
 * A height is only a heading if it is meaningfully larger than the body text —
 * otherwise a document with random size noise gains fake headings.
 */
export function detectHeights(json: PdfJsonDocument): number[] {
  const counts = new Map<number, number>();
  let body = 0;
  let bodyCount = 0;
  for (const page of json.pages) {
    for (const block of page.blocks) {
      if (block.type !== 'text') continue;
      for (const line of block.lines ?? []) {
        const height = Math.round(line.fontHeight * 2) / 2;
        if (height <= 0) continue;
        counts.set(height, (counts.get(height) ?? 0) + Math.max(1, line.text.trim().split(/\s+/).length));
      }
    }
  }
  for (const [height, count] of counts) {
    if (count > bodyCount) {
      bodyCount = count;
      body = height;
    }
  }
  if (body <= 0) return [];
  const candidates = [...counts.entries()]
    .filter(([height, count]) => height > body * 1.12 && count >= 1)
    .map(([height]) => height)
    .sort((a, b) => b - a);
  const levels: number[] = [];
  for (const height of candidates) {
    if (levels.length >= 6) break;
    if (levels.some((existing) => Math.abs(existing - height) < 1.2)) continue;
    levels.push(height);
  }
  return levels;
}

function dominantHeight(values: number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = 11;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = value;
    }
  }
  return best;
}

/** Read an unknown metadata field as text, or nothing. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
