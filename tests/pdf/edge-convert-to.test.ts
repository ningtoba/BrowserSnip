/**
 * Edge cases for the Convert-to-PDF family (brief section B5).
 *
 * The complaint these tests answer is fidelity: a converter that says "done"
 * after dropping the text layer, printing a page of boxes, or quietly ignoring
 * every image in the file. So the assertions are made against the *produced*
 * PDF — its content streams, its embedded fonts and the text a viewer can select
 * out of them — plus the refusal sentences a user meets first.
 *
 * jsdom has no canvas, so a minimal one is installed for the image routes: it
 * reports a fixed bitmap size and hands back real PNG bytes. pdf.js cannot boot
 * a worker under jsdom either, so `core/render` and the OCR engine are the two
 * seams that are stubbed; the text layer, the layout engine and the font
 * embedding are the real code paths.
 *
 * Groups follow the matrix rows: E1 empty upload, E2 wrong format, E6 single
 * item, E7 large batch, E10 no text layer, E11 CJK/accents, E13 nothing to
 * convert, E15 out of range, E19 cancel mid-run, E20 absent engine.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { pageContentOps, pageContentStreams, streamBytes } from '@/lib/pdf/core/content';
import type { ArrayOperand, NameOperand, StringOperand } from '@/lib/pdf/core/content';
import { ToolInputError } from '@/lib/pdf/core/guard';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { convertToTools } from '@/lib/pdf/tools/convert-to';
import { legacyOfficeTools, officeTools } from '@/lib/pdf/tools/office';
import type { ToolFile, ToolRunContext, ToolValues } from '@/lib/pdf/tools/types';

/* ------------------------------------------------------------------ *
 * Stubbed seams: canvas, fonts, pdf.js, the recogniser               *
 * ------------------------------------------------------------------ */

const OCR = vi.hoisted(() => ({
  words: [] as { text: string; x: number; y: number; width: number; height: number }[],
  failWith: null as string | null,
  calls: 0,
}));

/** What the canvas shim reports, and how many times white was painted. */
const CANVAS = vi.hoisted(() => ({ width: 8, height: 10, fills: 0 }));

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// pdf.js cannot start its worker in jsdom, and the OCR pipeline only needs a
// page box, the page's existing text items and a canvas to recognise.
vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    openRender: async (bytes: ArrayBuffer | Uint8Array) => {
      const doc = await PDFDocument.load(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      const count = doc.getPageCount();
      return {
        numPages: count,
        page: async () => ({ view: [0, 0, 595, 842], rotate: 0 }),
        textItems: async () => [],
        renderPage: async (_n: number, scale: number) => ({
          canvas: makeCanvas(Math.round(595 * scale), Math.round(842 * scale)),
          width: Math.round(595 * scale),
          height: Math.round(842 * scale),
          cancel: () => undefined,
        }),
        metadata: async () => ({ numPages: count, info: {}, metadata: {} }),
        destroy: async () => undefined,
      } as unknown as Awaited<ReturnType<typeof real.openRender>>;
    },
  };
});

vi.mock('@/lib/ocr/engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ocr/engine')>();
  return {
    ...real,
    initOcr: async () => {
      if (OCR.failWith) throw new Error(OCR.failWith);
    },
    recognizeCanvas: async (canvas: HTMLCanvasElement) => {
      OCR.calls += 1;
      if (OCR.failWith) throw new Error(OCR.failWith);
      const width = canvas.width || 1785;
      const height = canvas.height || 2526;
      return {
        text: OCR.words.map((row) => row.text).join('\n'),
        results: OCR.words.map((row) => ({
          text: row.text,
          // Boxes are given in viewer units and returned in raster pixels, which
          // is the contract `core/ocr` documents for this engine.
          box: {
            x: (row.x / 595) * width,
            y: (row.y / 842) * height,
            width: (row.width / 595) * width,
            height: (row.height / 842) * height,
          },
          confidence: 0.94,
        })),
      };
    },
  };
});

const PNG_1PX = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/7AAAAABJRU5ErkJggg==',
    'base64',
  ),
);
/** RAR magic — the container a `.cbr` really is. */
const RAR_BYTES = new Uint8Array([...Buffer.from('Rar!\x1a\x07\x01\x00'), 1, 2, 3]);
/** OLE compound-file magic: DOC, XLS, PPT, MSG. */
const OLE_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1, 2, 3, 4, 5]);
/** A PalmDB header: the `BOOK` type field at offset 60 is what MOBI starts as. */
function palmBytes(): Uint8Array {
  const bytes = new Uint8Array(256);
  bytes.set(Buffer.from('BOOK'), 60);
  return bytes;
}

/** When false, only the bundled faces resolve: the CDN is "offline". */
let cdnReachable = true;
const realFetch = globalThis.fetch;

beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: () => unknown;
    toBlob: (cb: (blob: Blob | null) => void, type?: string) => void;
  };
  proto.getContext = () => ({
    fillStyle: '#000',
    drawImage: () => undefined,
    fillRect: () => {
      CANVAS.fills += 1;
    },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    }),
    putImageData: () => undefined,
  });
  proto.toBlob = (cb, type) => cb(new Blob([PNG_1PX], { type: type ?? 'image/png' }));
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({
    width: CANVAS.width,
    height: CANVAS.height,
    close: () => undefined,
  });

  // `core/fonts` fetches faces by URL. Serve the bundled ones from `public/`,
  // and stand in for the script faces so the *embedding* path is exercised
  // rather than stubbed away.
  const face = (file: string) => new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const local = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    if (local) return new Response(face(`NotoSans-${local[1]}.ttf`), { headers: { 'content-type': 'font/ttf' } });
    if (/jetbrains-mono/.test(url)) return new Response(face('NotoSans-Regular.ttf'), { headers: { 'content-type': 'font/ttf' } });
    if (!cdnReachable) return new Response('offline', { status: 404 });
    if (/NotoSans(SC|TC|JP|KR)_400Regular\.ttf$/.test(url)) {
      return new Response(face('NotoSans-Regular.ttf'), { headers: { 'content-type': 'font/ttf' } });
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  OCR.words = [];
  OCR.failWith = null;
  OCR.calls = 0;
  CANVAS.fills = 0;
  cdnReachable = true;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ *
 * Driving a tool, and reading its output back                        *
 * ------------------------------------------------------------------ */

function fileFrom(bytes: Uint8Array | string, name: string, type = ''): File {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  // SAFETY: a copy of the bytes is a valid BlobPart.
  return new File([new Uint8Array(data)], name, { type });
}

async function run(
  id: string,
  values: ToolValues = {},
  files: File[] = [fileFrom('hello', 'source.txt', 'text/plain')],
): Promise<RunOutcome> {
  const outcome = await runPdfTool({ toolId: id, files, values, onProgress: () => {}, onLog: () => {} });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome!;
}

async function firstPdf(outcome: RunOutcome): Promise<Uint8Array> {
  expect(outcome.outputs.length).toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

/** A context for the paste path, which the runner still refuses to start (see b5-request R2). */
function contextFor(values: ToolValues, files: File[] = []): ToolRunContext {
  const inputs: ToolFile[] = files.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type,
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
    blob: () => file.slice(0, file.size, file.type || 'application/octet-stream'),
  }));
  return {
    inputs,
    values,
    progress: () => undefined,
    log: () => undefined,
    signal: new AbortController().signal,
  };
}

/** The `/ToUnicode` CMap of an embedded face, as glyph code → Unicode. */
function parseToUnicode(bytes: Uint8Array): Map<number, number> {
  const text = new TextDecoder('latin1').decode(bytes);
  const map = new Map<number, number>();
  const code = (hex: string) => Number.parseInt(hex, 16);
  const asString = (hex: string) => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(code(hex.slice(i, i + 4)));
    return out;
  };
  for (const block of text.split(/beginbfchar|endbfchar/)) {
    for (const [, from, to] of block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const point = asString(to).codePointAt(0);
      if (point !== undefined) map.set(code(from), point);
    }
  }
  return map;
}

function pageFonts(doc: PDFDocument, page: PDFPage) {
  const resources = page.node.Resources();
  const fonts = resources instanceof PDFDict ? resources.get(PDFName.of('Font')) : undefined;
  const fontDict = fonts instanceof PDFRef ? doc.context.lookup(fonts, PDFDict) : fonts;
  if (!(fontDict instanceof PDFDict)) return [];
  return fontDict
    .entries()
    .map(([name, value]) => ({
      name: name.asString().replace(/^\//, ''),
      dict: (value instanceof PDFRef ? doc.context.lookup(value, PDFDict) : value) as PDFDict | undefined,
    }))
    .filter((entry): entry is { name: string; dict: PDFDict } => entry.dict instanceof PDFDict)
    .map((entry) => {
      const subtype = entry.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() ?? '';
      const toUnicode = entry.dict.get(PDFName.of('ToUnicode'));
      const stream = toUnicode instanceof PDFRef ? doc.context.lookup(toUnicode) : toUnicode;
      return {
        name: entry.name,
        dict: entry.dict,
        subtype,
        // Identity CID fonts are two-byte coded; simple fonts one byte.
        codeSize: subtype === '/Type0' ? 2 : 1,
        unicode: stream ? parseToUnicode(streamBytes(stream as never)) : undefined,
      };
    });
}

/** Collapse the run boundaries a writer chooses into readable text. */
function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Like `squash` with every space removed, for pages whose text is shown one
 * glyph per operator (the RTF route does that), where the gaps between runs are
 * advances rather than spaces.
 */
function compact(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * The text a viewer can select on each page.
 *
 * Decoded from the page's own content streams through its own font resources,
 * which is the same information a viewer uses. `core/content`'s `textRects` is
 * the in-app reader but reports one glyph per run for text this app wrote
 * (docs/tasks/b5-request.md R3), so it cannot prove selectability here.
 */
async function extractText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages: string[] = [];
  for (const page of doc.getPages()) {
    const fonts = new Map(pageFonts(doc, page).map((font) => [font.name, font]));
    let current: ReturnType<typeof pageFonts>[number] | undefined;
    const parts: string[] = [];
    for (const op of pageContentOps(page)) {
      if (op.name === 'BT') {
        parts.push('\n');
        continue;
      }
      if (op.name === 'Tf') {
        const name = op.operands.find((operand): operand is NameOperand => operand.kind === 'name');
        current = name ? fonts.get(name.value) : undefined;
        continue;
      }
      if (!['Tj', 'TJ', "'", '"'].includes(op.name)) continue;
      const strings = op.operands.flatMap((operand) => {
        if (operand.kind === 'string') return [operand as StringOperand];
        if (operand.kind === 'array') {
          return (operand as ArrayOperand).items.filter((item) => item.kind === 'string') as StringOperand[];
        }
        return [];
      });
      for (const value of strings) {
        let out = '';
        if (current?.codeSize === 2) {
          for (let i = 0; i + 1 < value.bytes.length; i += 2) {
            const point = current.unicode?.get((value.bytes[i] << 8) | value.bytes[i + 1]);
            out += point ? String.fromCodePoint(point) : '';
          }
        } else {
          for (const byte of value.bytes) out += String.fromCharCode(byte);
        }
        parts.push(out);
      }
    }
    pages.push(parts.join(''));
  }
  return pages.join('\n');
}

/* ------------------------------------------------------------------ *
 * Fixtures: real containers, built here                              *
 * ------------------------------------------------------------------ */

/**
 * `core/archive`'s `createZip` flattens entry names for download archives, so an
 * OPC package (DOCX/PPTX/EPUB/XPS/ODF) is zipped with JSZip to keep its paths.
 */
async function zipBytes(entries: { name: string; data: string | Uint8Array }[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.data);
  return new Uint8Array(await zip.generateAsync({ type: 'arraybuffer' }));
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>';

function docxBytes(body = '<w:p><w:r><w:t>Quarterly numbers in the body text</w:t></w:r></w:p>'): Promise<Uint8Array> {
  return zipBytes([
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    },
    {
      name: 'word/document.xml',
      data: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    },
  ]);
}

const ODF_NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
].join(' ');

function odtBytes(paragraphs: string[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:text>` +
        paragraphs.map((text) => `<text:p>${text}</text:p>`).join('') +
        '</office:text></office:body></office:document-content>',
    },
  ]);
}

function odsBytes(rows: string[][]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:spreadsheet><table:table table:name="Budget">` +
        rows.map((row) => `<table:table-row>${row.map((cell) => `<table:table-cell><text:p>${cell}</text:p></table:table-cell>`).join('')}</table:table-row>`).join('') +
        '</table:table></office:spreadsheet></office:body></office:document-content>',
    },
  ]);
}

/**
 * `draw:shape` rather than the `draw:frame` LibreOffice writes: the reader in
 * `core/office-in` only walks `shape` elements, so a real deck yields no text and
 * the tool refuses instead of shipping blank slides (docs/tasks/b5-request.md R6).
 */
function odpBytes(slides: { title: string; body: string }[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'content.xml',
      data:
        `${XML}<office:document-content ${ODF_NS}><office:body><office:presentation>` +
        slides
          .map(
            (slide) =>
              '<draw:page>' +
              `<draw:frame><draw:shape presentation:presentationclass="title"><draw:text-box><text:p>${slide.title}</text:p></draw:text-box></draw:shape></draw:frame>` +
              `<draw:frame><draw:shape><draw:text-box><text:p>${slide.body}</text:p></draw:text-box></draw:shape></draw:frame></draw:page>`,
          )
          .join('') +
        '</office:presentation></office:body></office:document-content>',
    },
  ]);
}

function pptxBytes(slides: string[]): Promise<Uint8Array> {
  return zipBytes(
    slides.map((text, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      data:
        `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    })),
  );
}

function epubBytes(chapters: string[]): Promise<Uint8Array> {
  return zipBytes([
    {
      name: 'META-INF/container.xml',
      data: `${XML}<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    },
    {
      name: 'OEBPS/content.opf',
      data:
        `${XML}<package xmlns="http://www.idpf.org/2007/opf"><manifest>` +
        chapters.map((_, index) => `<item id="c${index}" href="chapter${index + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('') +
        '</manifest><spine>' +
        chapters.map((_, index) => `<itemref idref="c${index}"/>`).join('') +
        '</spine></package>',
    },
    ...chapters.map((text, index) => ({
      name: `OEBPS/chapter${index + 1}.xhtml`,
      data: `${XML}<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter ${index + 1}</h1><p>${text}</p></body></html>`,
    })),
  ]);
}

/** Lowercase `glyphs` for the same reason as the ODP fixture above (R6). */
function xpsBytes(pages: string[]): Promise<Uint8Array> {
  return zipBytes(
    pages.map((text, index) => ({
      name: `FixedDoc01/Pages/Page${index + 1}.fpage`,
      data: `${XML}<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="800" Height="1000"><glyphs UnicodeString="${text}" Indices="0" Size="12" BidiLevel="0"/></FixedPage>`,
    })),
  );
}

const cbzBytes = (pages: number) =>
  zipBytes(Array.from({ length: pages }, (_, index) => ({ name: `page${index + 1}.png`, data: PNG_1PX })));

async function workbookBytes(): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Item', 'Qty', 'Price'],
    ['Widget', 3, 9.99],
    ['Gizmo', 12, 4.5],
  ]);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sales');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), 'Empty');
  return new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

async function pdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return new Uint8Array(await doc.save());
}

/* ------------------------------------------------------------------ *
 * E1 — a file with no bytes                                          *
 * ------------------------------------------------------------------ */

describe('empty uploads are refused before any parsing (E1)', () => {
  const cases: [string, string][] = [
    ['txt-to-pdf', 'notes.txt'],
    ['markdown-to-pdf', 'README.md'],
    ['csv-to-pdf', 'data.csv'],
    ['json-to-pdf', 'api.json'],
    ['html-to-pdf', 'page.html'],
    ['xml-to-pdf', 'feed.xml'],
    ['rtf-to-pdf', 'letter.rtf'],
    ['image-to-pdf', 'scan.png'],
    ['png-to-pdf', 'scan.png'],
    ['svg-to-pdf', 'mark.svg'],
    ['word-to-pdf', 'report.docx'],
    ['excel-to-pdf', 'sheet.xlsx'],
    ['powerpoint-to-pdf', 'deck.pptx'],
    ['epub-to-pdf', 'book.epub'],
    ['email-to-pdf', 'mail.eml'],
    ['cbz-to-pdf', 'comic.cbz'],
    ['digitize-document', 'photo.jpg'],
    ['odt-to-pdf', 'letter.odt'],
    ['ods-to-pdf', 'ledger.ods'],
    ['odp-to-pdf', 'talk.odp'],
    ['xps-to-pdf', 'print.xps'],
    ['fb2-to-pdf', 'novel.fb2'],
  ];

  for (const [id, name] of cases) {
    it(`${id} names the empty file instead of failing inside a parser`, async () => {
      const error = await run(id, {}, [fileFrom(new Uint8Array(0), name)]).catch((err) => err);
      expect(error, `${id} should refuse a 0-byte upload`).toBeInstanceOf(ToolInputError);
      expect((error as ToolInputError).code).toBe('EMPTY_FILE');
      expect((error as ToolInputError).message).toContain(name);
      expect((error as ToolInputError).message).toMatch(/empty \(0 bytes\)/);
    });
  }
});

/* ------------------------------------------------------------------ *
 * E2 — the name says one thing, the bytes say another                 *
 * ------------------------------------------------------------------ */

describe('a wrong-format upload is refused with the format named (E2)', () => {
  it('says a PDF is a PDF when it is renamed .txt', async () => {
    const error = await run('txt-to-pdf', {}, [fileFrom(await pdfBytes(), 'notes.txt')]).catch((err) => err);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).code).toBe('UNSUPPORTED');
    expect((error as ToolInputError).message).toMatch(/"notes\.txt" is a PDF, not a plain text file/);
    expect((error as ToolInputError).hint).toMatch(/already a PDF/i);
  });

  it('names PNG when a picture is dropped on Word to PDF', async () => {
    const error = await run('word-to-pdf', {}, [fileFrom(PNG_1PX, 'report.docx')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is a PNG image, not a DOCX/);
    expect((error as ToolInputError).hint).toMatch(/Images to PDF|Digitize/);
  });

  it('names the ZIP container when a DOCX is renamed .txt', async () => {
    const error = await run('txt-to-pdf', {}, [fileFrom(await docxBytes(), 'report.txt')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is a ZIP package .* not a plain text file/);
    expect((error as ToolInputError).hint).toMatch(/Word to PDF/);
  });

  it('names the container when a text file is renamed .odt', async () => {
    const error = await run('odt-to-pdf', {}, [fileFrom('just words', 'letter.odt')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is a text file, not an OpenDocument package/);
  });

  it('points at ZIP when a RAR-based .cbr is dropped on CBZ to PDF', async () => {
    const error = await run('cbz-to-pdf', {}, [fileFrom(RAR_BYTES, 'comic.cbr')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/not a ZIP-based CBZ archive/);
    expect((error as ToolInputError).hint).toMatch(/\.cbr|RAR/);
  });

  it('names a real image dropped on SVG to PDF', async () => {
    const error = await run('svg-to-pdf', {}, [fileFrom(PNG_1PX, 'logo.svg')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is a PNG image, not an SVG drawing/);
    expect((error as ToolInputError).hint).toMatch(/Images to PDF/);
  });

  it('refuses a PNG dropped on TIFF to PDF and names both formats', async () => {
    const error = await run('tiff-to-pdf', {}, [fileFrom(PNG_1PX, 'fax.tif', 'image/tiff')]).catch((err) => err);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).message).toMatch(/is a PNG image, not a TIFF image/);
    expect((error as ToolInputError).hint).toMatch(/Images to PDF/);
  });

  it('quotes the parse error and the file for invalid JSON', async () => {
    const error = await run('json-to-pdf', {}, [fileFrom('{ "a": ', 'api.json')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/"api\.json" is not valid JSON/);
    expect((error as ToolInputError).hint).toMatch(/Text to PDF/);
  });

  it('says which NDJSON document broke', async () => {
    const error = await run('json-to-pdf', {}, [fileFrom('{"a":1}\n{"b":2,}', 'events.ndjson')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/"events\.ndjson" \(document 2\) is not valid JSON/);
  });

  it('refuses text with no XML element in it, rather than printing nothing', async () => {
    const error = await run('xml-to-pdf', {}, [fileFrom('no tags at all', 'notes.xml')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/has no XML elements/);
  });

  it('refuses an RTF file that is not RTF instead of emitting a blank page', async () => {
    const error = await run('rtf-to-pdf', {}, [fileFrom('plain words only', 'notes.rtf')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is not a Rich Text document/);
    expect((error as ToolInputError).hint).toMatch(/Text to PDF/);
  });

  it('converts a real RTF document to selectable text', async () => {
    const rtf = "{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0\\fs24 Rich text body with caf\\'e9.}";
    const outcome = await run('rtf-to-pdf', {}, [fileFrom(rtf, 'letter.rtf')]);
    expect(compact(await extractText(await firstPdf(outcome)))).toContain('richtextbodywith');
  });

  it('refuses a document with no characters to typeset (E13)', async () => {
    const error = await run('txt-to-pdf', {}, [fileFrom('   \n\n\t \n', 'blank.txt')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/contains no characters to typeset/);
  });

  it('refuses an archive that holds no page images (E13)', async () => {
    const error = await run('cbz-to-pdf', {}, [
      fileFrom(await zipBytes([{ name: 'notes.txt', data: 'only text inside' }]), 'empty.cbz'),
    ]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/holds no page images/);
  });

  it('asks for content when the paste box is the empty source', async () => {
    const tool = getPdfTool('txt-to-pdf');
    await expect(tool!.run!(contextFor({ source: 'paste', paste: '   ' }))).rejects.toThrow(/Paste some content/);
  });
});

/* ------------------------------------------------------------------ *
 * E6 / E7 — batch size                                               *
 * ------------------------------------------------------------------ */

describe('one item and a hundred-item batch both work (E6, E7)', () => {
  it('converts a single image to a single page', async () => {
    const outcome = await run('image-to-pdf', { pageSize: 'a4' }, [fileFrom(PNG_1PX, 'one.png', 'image/png')]);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(1);
    expect(outcome.message).toMatch(/1 image\(s\) placed on 1 page\(s\)/);
  });

  it('converts 100 images without dropping or duplicating any', async () => {
    const files = Array.from({ length: 100 }, (_, index) => fileFrom(PNG_1PX, `scan-${index + 1}.png`, 'image/png'));
    const progress: string[] = [];
    const outcome = await runPdfTool({
      toolId: 'image-to-pdf',
      files,
      values: { pageSize: 'a4' },
      onProgress: (_fraction, message) => progress.push(message ?? ''),
      onLog: () => undefined,
    });
    expect((await PDFDocument.load(await firstPdf(outcome!))).getPageCount()).toBe(100);
    expect(outcome!.message).toMatch(/100 image\(s\) placed on 100 page\(s\)/);
    // Progress is reported while it works, not only at the end (E7).
    expect(progress.filter((line) => /Decoded scan-/.test(line)).length).toBeGreaterThanOrEqual(50);
  });

  it('puts two images on each sheet when asked', async () => {
    const files = Array.from({ length: 5 }, (_, index) => fileFrom(PNG_1PX, `p${index}.png`, 'image/png'));
    const outcome = await run('image-to-pdf', { onePerSheet: true, pageSize: 'a4' }, files);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(3);
    expect(outcome.message).toMatch(/two per sheet/);
  });

  it('converts a CBZ of one page and of twenty pages', async () => {
    const single = await run('cbz-to-pdf', {}, [fileFrom(await cbzBytes(1), 'one.cbz')]);
    expect((await PDFDocument.load(await firstPdf(single))).getPageCount()).toBe(1);
    const many = await run('cbz-to-pdf', {}, [fileFrom(await cbzBytes(20), 'many.cbz')]);
    expect((await PDFDocument.load(await firstPdf(many))).getPageCount()).toBe(20);
    expect(many.message).toMatch(/20 comic pages/);
    expect(many.warnings.join(' ')).toMatch(/no text layer/i);
  });

  it('converts a PNG on the PNG route and says there is no text layer', async () => {
    const outcome = await run('png-to-pdf', {}, [fileFrom(PNG_1PX, 'shot.png', 'image/png')]);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(1);
    expect(outcome.warnings.join(' ')).toMatch(/no text layer/i);
  });

  it('stops a cancelled batch instead of emitting a partial file (E19)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPdfTool({
        toolId: 'image-to-pdf',
        files: [fileFrom(PNG_1PX, 'a.png', 'image/png')],
        values: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });
});

/* ------------------------------------------------------------------ *
 * E10 — no text layer, said out loud                                 *
 * ------------------------------------------------------------------ */

describe('images-only input is described as images-only (E10)', () => {
  it('warns that an image PDF has nothing to select or search', async () => {
    const outcome = await run('image-to-pdf', {}, [fileFrom(PNG_1PX, 'scan.png', 'image/png')]);
    expect(outcome.warnings.join(' ')).toMatch(/no text layer to select or search/i);
  });

  it('adds a real, selectable text layer when OCR recognises words', async () => {
    OCR.words = [
      { text: 'Recognised invoice total', x: 60, y: 120, width: 220, height: 18 },
      { text: 'cafés and accents', x: 60, y: 200, width: 160, height: 18 },
    ];
    const outcome = await run('digitize-document', { enhance: false }, [
      fileFrom(PNG_1PX, 'invoice.png', 'image/png'),
    ]);
    const bytes = await firstPdf(outcome);
    const text = squash(await extractText(bytes));
    expect(text).toMatch(/Recognised invoice total/);
    expect(text).toMatch(/cafés and accents/);
    expect(outcome.message).toMatch(/recognised words/);
    expect(outcome.message).toMatch(/selectable and searchable/);
    expect(OCR.calls).toBe(1);
    // Invisible render mode is what keeps the image readable while text selects.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const stream = pageContentStreams(doc.getPages()[0]!).map((entry) => Buffer.from(entry.bytes).toString('latin1')).join('\n');
    expect(stream).toMatch(/\b3 Tr\b/);
  });

  it('names the page that yielded no text instead of reporting an empty success', async () => {
    const outcome = await run('digitize-document', {}, [fileFrom(PNG_1PX, 'blank-scan.png', 'image/png')]);
    expect(outcome.warnings.join(' ')).toMatch(/Page 1 had no text layer/);
    expect(outcome.message).not.toMatch(/selectable and searchable/);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(1);
  });

  it('degrades honestly when the recogniser cannot load (E20)', async () => {
    OCR.failWith = 'The OCR models could not be downloaded';
    const outcome = await run('digitize-document', {}, [fileFrom(PNG_1PX, 'scan.png', 'image/png')]);
    expect(outcome.message).toMatch(/the recogniser did not run, so there is no text layer/i);
    expect(outcome.warnings.join(' ')).toMatch(/OCR failed: The OCR models could not be downloaded/);
    expect(outcome.warnings.join(' ')).toMatch(/images only/i);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(1);
  });

  it('skips OCR entirely when the page image alone was asked for', async () => {
    const outcome = await run('digitize-document', { keepImage: false }, [
      fileFrom(PNG_1PX, 'scan.png', 'image/png'),
    ]);
    expect(OCR.calls).toBe(0);
    expect(outcome.message).toMatch(/image-only PDF/);
    expect(outcome.warnings.join(' ')).toMatch(/no page has a text layer/i);
  });

  it('only paints the white background when the preparation toggle is on', async () => {
    await run('digitize-document', { enhance: true }, [fileFrom(PNG_1PX, 'scan.png', 'image/png')]);
    expect(CANVAS.fills).toBeGreaterThan(0);
    CANVAS.fills = 0;
    await run('digitize-document', { enhance: false }, [fileFrom(PNG_1PX, 'scan.png', 'image/png')]);
    expect(CANVAS.fills).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * E11 — CJK, accents, Greek, Cyrillic                                *
 * ------------------------------------------------------------------ */

describe('non-Latin text goes through core/fonts (E11)', () => {
  // First in this group: `core/fonts` caches a fetched face for the whole
  // session, so the offline refusal has to run before anything CJK succeeds.
  it('refuses a CJK source when the CDN face is unreachable, naming the face', async () => {
    cdnReachable = false;
    const error = await run('txt-to-pdf', {}, [fileFrom('文档段落', 'han.txt')]).catch((err) => err);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).code).toBe('NEEDS_ENGINE');
    expect((error as ToolInputError).message).toMatch(/font/i);
    expect((error as ToolInputError).hint).toMatch(/online/i);
  });

  it('extracts accented Latin, Greek and Cyrillic back out of a Markdown PDF', async () => {
    const source = '# café naïve\n\nΩμέγα γειά και Согласовано и Ünïcödé – with dashes.';
    const outcome = await run('markdown-to-pdf', {}, [fileFrom(source, 'README.md')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('café naïve');
    expect(text).toContain('Ωμέγα');
    expect(text).toContain('Согласовано');
    expect(text).toContain('Ünïcödé');
  });

  it('embeds a Unicode CID font for Chinese instead of raising the WinAnsi error', async () => {
    const outcome = await run('txt-to-pdf', {}, [fileFrom('文档段落 東京 서울', 'notes.txt')]);
    const bytes = await firstPdf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const fonts = pageFonts(doc, doc.getPages()[0]!);
    const cid = fonts.find((font) => font.subtype === '/Type0');
    expect(cid, 'a Type0/Identity-H face must carry the CJK run').toBeTruthy();
    expect(cid!.dict.get(PDFName.of('ToUnicode')), 'the embedded face needs a /ToUnicode CMap').toBeTruthy();
    const descendant = cid!.dict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
    const descriptor = descendant?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    expect(
      descriptor && ['FontFile', 'FontFile2', 'FontFile3'].some((key) => descriptor.get(PDFName.of(key)) !== undefined),
      'the face is embedded, not just named',
    ).toBe(true);
  });

  it('announces a UTF-16 source instead of printing it as noise', async () => {
    const utf16 = new Uint8Array(Buffer.from('\uFEFFcafé report', 'utf16le'));
    const outcome = await run('txt-to-pdf', {}, [fileFrom(utf16, 'legacy.txt')]);
    expect(outcome.warnings.join(' ')).toMatch(/decoded from UTF-16LE/);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('café report');
  });
});

/* ------------------------------------------------------------------ *
 * Loss reported in warnings, not buried in a log                     *
 * ------------------------------------------------------------------ */

describe('every conversion says what it dropped', () => {
  it('HTML: structure survives, CSS layout and remote pixels do not', async () => {
    const html = [
      '<html><body>',
      '<h1>Release notes</h1>',
      '<p>Fixed the <b>merge</b> order for <i>rotated</i> pages.</p>',
      '<img src="https://example.com/diagram.png">',
      '<script>document.body.innerHTML = "rendered later";</script>',
      '<table><tr><th>Key</th><th>Value</th></tr><tr><td>alpha</td><td>1</td></tr></table>',
      '</body></html>',
    ].join('\n');
    const outcome = await run('html-to-pdf', {}, [fileFrom(html, 'page.html')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('Release notes');
    expect(text).toContain('Fixed the merge order for rotated pages.');
    expect(text).toContain('alpha');
    expect(outcome.warnings.join(' ')).toMatch(/1 <img> reference\(s\) are not data: URLs/);
    expect(outcome.warnings.join(' ')).toMatch(/<script> block\(s\) were ignored/);
  });

  it('HTML: the embed-images toggle is honoured', async () => {
    const html = '<p>text body here</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    const off = await run('html-to-pdf', { embedImages: false }, [fileFrom(html, 'page.html')]);
    expect(off.warnings.join(' ')).toMatch(/Image embedding is off/);
  });

  it('Markdown: maths stays LaTeX source and remote images stay alt text', async () => {
    const markdown = '# Notes\n\nEnergy: $\\frac{1}{2}mv^2$\n\n![plot](https://example.com/plot.png)\n';
    const outcome = await run('markdown-to-pdf', {}, [fileFrom(markdown, 'README.md')]);
    expect(outcome.warnings.join(' ')).toMatch(/1 image reference\(s\) point off-device/);
    expect(squash(await extractText(await firstPdf(outcome)))).toMatch(/frac\{1\}\{2\}mv\^2/);
  });

  it('CSV: a very wide table is announced as squeezed', async () => {
    const header = Array.from({ length: 15 }, (_, index) => `c${index}`).join(',');
    const outcome = await run('csv-to-pdf', {}, [
      fileFrom(`${header}\n1,2,3,4,5,6,7,8,9,10,11,12,13,14,15`, 'wide.csv'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/15 columns on the widest row/);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('c14');
  });

  it('JSON: the depth control truncating a branch is a warning, not silence', async () => {
    const deep = JSON.stringify({ a: { b: { c: { d: { e: 'keepme' } } } } });
    const outcome = await run('json-to-pdf', { maxDepth: 2 }, [fileFrom(deep, 'api.json')]);
    expect(outcome.warnings.join(' ')).toMatch(/Depth 2 cut off branches of "api\.json"/);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('(truncated)');
  });

  it('XML: an SVG printed as a tree says so', async () => {
    const outcome = await run('xml-to-pdf', {}, [
      fileFrom('<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>', 'logo.xml'),
    ]);
    expect(outcome.warnings.join(' ')).toMatch(/printed as a tag tree/);
  });

  it('SVG: the vector is now pixels', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>';
    const outcome = await run('svg-to-pdf', {}, [fileFrom(svg, 'logo.svg')]);
    expect(outcome.warnings.join(' ')).toMatch(/rasterised at up to 4096 px/);
    expect((await PDFDocument.load(await firstPdf(outcome))).getPageCount()).toBe(1);
  });

  it('Word: the DOCX body becomes selectable text, and the layout loss is stated', async () => {
    const outcome = await run('word-to-pdf', {}, [fileFrom(await docxBytes(), 'report.docx')]);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('Quarterly numbers in the body text');
    expect(outcome.message).toMatch(/mammoth/);
    expect(outcome.warnings.join(' ')).toMatch(/pagination, headers, footers, footnotes, comments and text boxes/);
    expect(outcome.warnings.join(' ')).toMatch(/Merged cells, cell shading and column widths/);
  });

  it('Excel: values print as saved and the formatting loss is stated', async () => {
    const outcome = await run('excel-to-pdf', {}, [fileFrom(await workbookBytes(), 'sales.xlsx')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('Widget');
    expect(text).toContain('Gizmo');
    expect(outcome.message).toMatch(/1 worksheet/);
    expect(outcome.warnings.join(' ')).toMatch(/formulas are not re-evaluated/);
    expect(outcome.warnings.join(' ')).toMatch(/Merged cells, number and date formats/);
    expect(outcome.warnings.join(' ')).toMatch(/Sheet "Empty" in "sales\.xlsx" is empty/);
  });

  it('PowerPoint: text order survives, geometry does not', async () => {
    const outcome = await run('powerpoint-to-pdf', {}, [
      fileFrom(await pptxBytes(['Quarterly review', 'Revenue up 12 percent']), 'deck.pptx'),
    ]);
    const bytes = await firstPdf(outcome);
    const text = squash(await extractText(bytes));
    expect(text).toContain('Quarterly review');
    expect(text).toContain('Revenue up 12 percent');
    expect(outcome.warnings.join(' ')).toMatch(/Slide geometry is approximate/);
    expect(outcome.warnings.join(' ')).toMatch(/Speaker notes were left out/);
    const { width, height } = (await PDFDocument.load(bytes)).getPages()[0]!.getSize();
    expect(Math.round(width / height)).toBe(2);
  });

  it('PowerPoint: a deck whose text is not readable is refused, not blanked', async () => {
    const noText = await zipBytes([
      {
        name: 'ppt/slides/slide1.xml',
        data: `${XML}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>`,
      },
    ]);
    const error = await run('powerpoint-to-pdf', {}, [fileFrom(noText, 'images.pptx')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/no text frames this reader can see/);
  });

  it('EPUB: chapters are re-flowed and the book styling loss is stated', async () => {
    const outcome = await run('epub-to-pdf', {}, [
      fileFrom(await epubBytes(['The door opened.', 'Nothing was behind it.']), 'book.epub'),
    ]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('The door opened.');
    expect(text).toContain('Nothing was behind it.');
    expect(outcome.warnings.join(' ')).toMatch(/Images, CSS, embedded fonts and footnotes/);
  });

  it('Email: headers and body print, attachments are listed only', async () => {
    const eml = [
      'From: sender@example.com',
      'To: someone@example.com',
      'Subject: Quarterly figures',
      'Date: Tue, 4 Nov 2025 09:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'The numbers are in the table, café receipt attached.',
    ].join('\r\n');
    const outcome = await run('email-to-pdf', {}, [fileFrom(eml, 'mail.eml')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('Quarterly figures');
    expect(text).toContain('sender@example.com');
    expect(text).toContain('The numbers are in the table');
    expect(outcome.warnings.join(' ')).toMatch(/Attachments are listed, not extracted/);
  });

  it('Digitize: the optional white-point pass is described as such', async () => {
    OCR.words = [{ text: 'hello', x: 50, y: 100, width: 40, height: 10 }];
    const outcome = await run('digitize-document', { enhance: true }, [fileFrom(PNG_1PX, 'p.png', 'image/png')]);
    expect(outcome.warnings.join(' ')).toMatch(/skew and perspective are not corrected/i);
  });
});

/* ------------------------------------------------------------------ *
 * Office family: same guard, same honesty                            *
 * ------------------------------------------------------------------ */

describe('OpenDocument and XPS routes', () => {
  it('converts an ODT to selectable text', async () => {
    const outcome = await run('odt-to-pdf', {}, [
      fileFrom(await odtBytes(['OpenDocument body paragraph café']), 'letter.odt'),
    ]);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('OpenDocument body paragraph café');
    expect(outcome.warnings.join(' ')).toMatch(/not preserved/i);
  });

  it('converts an ODS to a table and says nothing was recalculated', async () => {
    const outcome = await run('ods-to-pdf', {}, [
      fileFrom(await odsBytes([['Region', 'Total'], ['North', '1200']]), 'ledger.ods'),
    ]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('Region');
    expect(text).toContain('1200');
    expect(outcome.warnings.join(' ')).toMatch(/no recalculation/);
  });

  it('converts an ODP into one page per slide at the chosen aspect', async () => {
    const outcome = await run('odp-to-pdf', { slideSize: '4:3' }, [
      fileFrom(await odpBytes([{ title: 'Open slide', body: 'Bullet content here' }]), 'talk.odp'),
    ]);
    const bytes = await firstPdf(outcome);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const { width, height } = doc.getPages()[0]!.getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([720, 540]);
    expect(squash(await extractText(bytes))).toContain('Open slide');
  });

  it('refuses an ODP whose text frames the reader cannot see, instead of blank pages', async () => {
    const frameOnly = await zipBytes([
      {
        name: 'content.xml',
        data:
          `${XML}<office:document-content ${ODF_NS}><office:body><office:presentation><draw:page>` +
          '<draw:frame><draw:text-box><text:p>Real LibreOffice text</text:p></draw:text-box></draw:frame>' +
          '</draw:page></office:presentation></office:body></office:document-content>',
      },
    ]);
    const error = await run('odp-to-pdf', {}, [fileFrom(frameOnly, 'libreoffice.odp')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/no text frames this reader can see/);
  });

  it('recovers XPS text runs and admits the artwork loss', async () => {
    const outcome = await run('xps-to-pdf', {}, [fileFrom(await xpsBytes(['XPS page one text']), 'print.xps')]);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('XPS page one text');
    expect(outcome.warnings.join(' ')).toMatch(/strokes, gradients, images/i);
  });

  it('converts an FB2 book and states what the reader skips', async () => {
    const fb2 =
      `${XML}<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">` +
      '<description><title-info><book-title>Дом с призраками</book-title></title-info></description>' +
      '<body><section><p>The house had éléven windows.</p></section></body></FictionBook>';
    const outcome = await run('fb2-to-pdf', {}, [fileFrom(fb2, 'novel.fb2')]);
    const text = squash(await extractText(await firstPdf(outcome)));
    expect(text).toContain('The house had éléven windows.');
    expect(outcome.warnings.join(' ')).toMatch(/Cover art, footnotes/);
  });
});

/* ------------------------------------------------------------------ *
 * E20 — containers that need LibreOffice                             *
 * ------------------------------------------------------------------ */

describe('legacy containers keep an honest reason and an alternative (E20)', () => {
  it('registers every LibreOffice-only tool with an actionable reason', () => {
    expect(legacyOfficeTools.length).toBeGreaterThan(0);
    for (const tool of legacyOfficeTools) {
      expect(tool.run, `${tool.id} must not pretend to run`).toBeUndefined();
      expect(tool.unavailable, tool.id).toBeTruthy();
      expect(tool.unavailable!, tool.id).toMatch(/LibreOffice/);
      expect(tool.unavailable!.length, tool.id).toBeGreaterThan(60);
      expect(tool.notes?.join(' '), tool.id).toMatch(/decoder|Export|save|Re-save|Re-export/i);
      expect(tool.promise, tool.id).toMatch(/not converted offline|not available/i);
    }
  });

  it('refuses the run with the reason instead of a page that merely looks right', async () => {
    const error = await run('mobi-to-pdf', {}, [fileFrom(palmBytes(), 'book.mobi')]).catch((err) => err);
    expect(error).toBeInstanceOf(ToolInputError);
    expect((error as ToolInputError).message).toMatch(/not available offline/);
    expect((error as ToolInputError).message).toMatch(/MOBI/);
    // The alternative travels in the same sentence, not only in the notes.
    expect((error as ToolInputError).message).toMatch(/EPUB|Calibre/i);
    expect((error as ToolInputError).hint).toMatch(/notes|export/i);
  });

  it('names DOC and the alternative when a legacy Word file arrives', async () => {
    const error = await run('word-to-pdf', {}, [fileFrom(OLE_BYTES, 'legacy.doc')]).catch((err) => err);
    expect((error as ToolInputError).code).toBe('NEEDS_ENGINE');
    expect((error as ToolInputError).message).toMatch(/legacy DOC container/);
    expect((error as ToolInputError).message).toMatch(/LibreOffice/);
    expect((error as ToolInputError).hint).toMatch(/DOCX, XLSX or PPTX/);
  });

  it('names PPT the same way for a legacy deck', async () => {
    const error = await run('powerpoint-to-pdf', {}, [fileFrom(OLE_BYTES, 'deck.ppt')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/legacy PPT container/);
  });

  it('refuses an Outlook MSG and points at EML', async () => {
    const error = await run('email-to-pdf', {}, [fileFrom(OLE_BYTES, 'inbox.msg')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/is an Outlook MSG .* not an EML file/);
    expect((error as ToolInputError).hint).toMatch(/\.eml/);
  });

  it('refuses a MOBI dropped on EPUB to PDF and names the container', async () => {
    const error = await run('epub-to-pdf', {}, [fileFrom(palmBytes(), 'book.mobi')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/PalmDB ebook \(MOBI or AZW\), not an EPUB or FB2 ebook/);
    expect((error as ToolInputError).hint).toMatch(/EPUB/);
  });
});

/* ------------------------------------------------------------------ *
 * E15 — nonsense numbers are corrected, not obeyed                   *
 * ------------------------------------------------------------------ */

describe('out-of-range settings are clamped with a reason (E15)', () => {
  it('clamps a margin of 9999 pt and says so', async () => {
    const outcome = await run('txt-to-pdf', { margin: 9999 }, [fileFrom('some body text for the page', 'notes.txt')]);
    expect(outcome.warnings.join(' ')).toMatch(/Margin must be between 0 and 144 pt: 9999 became 144/);
    expect(squash(await extractText(await firstPdf(outcome)))).toContain('some body text for the page');
  });

  it('survives a negative margin handed straight to the tool', async () => {
    const tool = getPdfTool('txt-to-pdf');
    const result = await tool!.run!(contextFor({ source: 'paste', paste: 'negative margin text', margin: -60, fontSize: 2 }));
    expect(result.kind).toBe('pdf');
  });

  it('rejects a font size that is not a number at all', async () => {
    const error = await run('txt-to-pdf', { fontSize: 'huge' }, [fileFrom('text', 'notes.txt')]).catch((err) => err);
    expect((error as ToolInputError).message).toMatch(/Font size must be a number/);
  });
});

/* ------------------------------------------------------------------ *
 * The capability statement each tool owes the user                   *
 * ------------------------------------------------------------------ */

describe('every convert-to tool states what it keeps and what it loses', () => {
  const mine = [...convertToTools, ...officeTools, ...legacyOfficeTools];

  it('covers the whole convert-to category it owns', () => {
    const ids = new Set(mine.map((tool) => tool.id));
    expect(ids.size, 'duplicate ids in the convert-to modules').toBe(mine.length);
    expect(mine.filter((tool) => tool.category !== 'convert-to').map((tool) => tool.id)).toEqual([]);
    for (const tool of mine) {
      expect(getPdfTool(tool.id), `${tool.id} is not registered`).toBeTruthy();
    }
  });

  it('gives every tool a one-line promise a user can act on', () => {
    const thin = mine
      .filter((tool) => (tool.promise ?? '').trim().split(/\s+/).length < 6)
      .map((tool) => tool.id);
    expect(thin).toEqual([]);
  });

  it('gives every tool notes that admit a limitation, not only a boast', () => {
    const boastful = mine
      .filter((tool) => {
        const notes = tool.notes ?? [];
        return (
          notes.length === 0
          || !notes.some((note) => /\bnot\b|no |never|dropped|lost|only|approximate|instead|skipped|needs/i.test(note))
        );
      })
      .map((tool) => tool.id);
    expect(boastful).toEqual([]);
  });

  it('keeps running tools runnable and unavailable ones honest', () => {
    const contradictory = mine
      .filter((tool) => (tool.unavailable && tool.run) || (!tool.run && !tool.unavailable))
      .map((tool) => tool.id);
    expect(contradictory).toEqual([]);
  });
});
