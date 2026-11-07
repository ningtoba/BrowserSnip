/**
 * Office, ebook and email readers.
 *
 * BentoPDF leans on a ~100 MB LibreOffice WASM build for these. That is not
 * bundled, so the formats that are genuinely "a zip of XML" — ODT, ODS, ODP,
 * PPTX, EPUB, CBZ — plus plain EML are parsed in the tab instead. Legacy binary
 * formats (DOC/XLS/PPT/MSG) report what is missing rather than producing junk.
 */
import type { Block, Inline } from './layout';
import { tableBlock } from './layout';
import { readZip } from './archive';

export interface OfficeReadOptions {
  notes?: boolean;
  attachments?: boolean;
  maxChapters?: number;
}

const BLOCK_LIMIT = 4000;

// ── OpenDocument (ODT / ODS / ODP) ──────────────────────────────────────────

/** OpenDocument Text. */
export async function odtToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const document = await openDocumentXml(bytes, 'content.xml');
  const blocks: Block[] = [];
  const body = byLocalName(document, 'body')[0];
  if (body) walkOdt(body, blocks);
  if (blocks.length === 0) throw new Error('That ODT had no readable paragraphs.');
  return blocks;
}

/** The elements `walkOdt` reads as a block of their own. */
const ODF_BLOCK_NAMES = new Set(['h', 'p', 'list', 'table', 'frame', 'section', 'soft-page-break']);

/**
 * The OpenDocument name of an element, from either side of the colon.
 *
 * `<text:h>` is a heading. A document that writes the pair the other way round,
 * or binds the prefix to nothing at all, still means the same thing; dropping
 * the words inside it over a spelling is how a conversion comes back shorter
 * than the file it read.
 */
function odfName(element: Element): string {
  const local = localName(element);
  if (ODF_BLOCK_NAMES.has(local)) return local;
  const [prefix] = (element.nodeName ?? '').split(':');
  return ODF_BLOCK_NAMES.has(prefix) ? prefix : local;
}

function walkOdt(element: Element, blocks: Block[], depth = 0): void {
  for (const child of Array.from(element.children ?? [])) {
    if (blocks.length > BLOCK_LIMIT) return;
    const name = odfName(child);
    if (name === 'h') {
      const outline = Number(child.getAttribute('text:outline-level') ?? '1');
      blocks.push({ kind: 'heading', level: clampLevel(outline), inlines: inlineRuns(child) });
      continue;
    }
    if (name === 'p') {
      const text = plainText(child);
      if (!text) continue;
      const bullet = child.getAttribute('text:style-name') ?? '';
      if (/ListNumber|Number/i.test(bullet)) {
        blocks.push(listBlock([{ text, level: depth, marker: 'ordered' }]));
      } else if (/ListBullet|Bullet/i.test(bullet)) {
        blocks.push(listBlock([{ text, level: depth, marker: 'bullet' }]));
      } else {
        blocks.push({ kind: 'paragraph', inlines: inlineRuns(child) });
      }
      continue;
    }
    if (name === 'list') {
      const ordered = /number/i.test(child.getAttribute('text:style-name') ?? '');
      blocks.push(listBlock(listItems(child), ordered));
      continue;
    }
    if (name === 'table') {
      blocks.push(odtTableBlock(child));
      continue;
    }
    if (name === 'frame' || name === 'section' || name === 'soft-page-break') continue;
    walkOdt(child, blocks, name === 'list' ? depth + 1 : depth);
  }
}

function listItems(element: Element): { text: string; level: number; marker: 'bullet' | 'ordered' }[] {
  const out: { text: string; level: number; marker: 'bullet' | 'ordered' }[] = [];
  const visit = (node: Element, level: number) => {
    for (const child of Array.from(node.children ?? [])) {
      if (localName(child) === 'list-item') {
        const text = Array.from(child.children ?? [])
          .map(plainText)
          .filter(Boolean)
          .join(' ');
        if (text) out.push({ text, level, marker: 'bullet' });
        else visit(child, level);
      } else if (localName(child) === 'list') {
        visit(child, level + 1);
      } else {
        visit(child, level);
      }
    }
  };
  visit(element, 0);
  return out;
}

function odtTableBlock(table: Element): Extract<Block, { kind: 'table' }> {
  const rows: Inline[][][] = [];
  for (const row of childrenNamed(table, 'table-row')) {
    const cells: Inline[][] = [];
    for (const cell of childrenNamed(row, 'table-cell')) {
      const repeat = Math.min(Number(cell.getAttribute('table:number-columns-repeated') ?? '1'), 32);
      const text = Array.from(cell.children ?? []).map(plainText).filter(Boolean).join(' ');
      for (let i = 0; i < repeat; i++) cells.push([{ text }]);
    }
    if (cells.some((cell) => (cell[0]?.text ?? '') !== '')) rows.push(cells);
    if (rows.length > 2000) break;
  }
  const [head, ...body] = rows;
  return { kind: 'table', header: head ?? [], rows: body };
}

/** OpenDocument Spreadsheet. */
export async function odsToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const document = await openDocumentXml(bytes, 'content.xml');
  const blocks: Block[] = [];
  for (const table of byLocalName(document, 'table')) {
    const name = table.getAttribute('table:name') ?? `Sheet ${blocks.length + 1}`;
    blocks.push({ kind: 'heading', level: 2, inlines: [{ text: name }] });
    const block = odtTableBlock(table);
    if (block.kind === 'table' && (block.rows?.length ?? 0) > 0) blocks.push(block);
  }
  if (blocks.length === 0) throw new Error('That ODS had no readable sheets.');
  return blocks;
}

/** OpenDocument Presentation — one page per draw page. */
export async function odpToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const document = await openDocumentXml(bytes, 'content.xml');
  const blocks: Block[] = [];
  for (const page of byLocalName(document, 'page')) {
    blocks.push({ kind: 'pagebreak' });
    for (const shape of byLocalName(page, 'shape')) {
      const isTitle = (shape.getAttribute('draw:presentationclass') ?? '') === 'title';
      for (const text of textsIn(shape)) {
        blocks.push(
          isTitle
            ? { kind: 'heading', level: 2, inlines: [{ text }] }
            : { kind: 'paragraph', inlines: [{ text }] },
        );
      }
    }
    if (blocks.length > BLOCK_LIMIT) break;
  }
  if (blocks.length === 0) throw new Error('That ODP had no readable slides.');
  return blocks;
}

// ── OOXML ───────────────────────────────────────────────────────────────────

/** PPTX: slides in numeric order, first text frame as the heading. */
export async function pptxToBlocks(
  bytes: Uint8Array,
  options: OfficeReadOptions = {},
): Promise<Block[]> {
  const byName = await zipTexts(bytes, ['xml']);
  const slides = [...byName.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => indexIn(a) - indexIn(b));
  if (slides.length === 0) throw new Error('That PPTX has no slides.');
  const blocks: Block[] = [];
  for (const slide of slides) {
    blocks.push({ kind: 'pagebreak' });
    const texts = textsOf(parseXml(byName.get(slide)!, 'That slide is not readable XML.'));
    texts.forEach((text, index) => {
      blocks.push(
        index === 0
          ? { kind: 'heading', level: 2, inlines: [{ text }] }
          : { kind: 'paragraph', inlines: [{ text }] },
      );
    });
    if (options.notes) {
      const notes = byName.get(`ppt/notesSlides/notesSlide${indexIn(slide)}.xml`);
      if (notes) {
        const note = textsOf(parseXml(notes, 'notes')).filter((text) => text.length > 1).join(' ');
        if (note) blocks.push({ kind: 'quote', inlines: [{ text: `Notes: ${note}`, italic: true }] });
      }
    }
    if (blocks.length > BLOCK_LIMIT) break;
  }
  return blocks;
}

/** EPUB: chapters in spine order. XHTML bodies are turned into blocks. */
export async function epubToBlocks(
  bytes: Uint8Array,
  options: OfficeReadOptions = {},
): Promise<Block[]> {
  const byName = await zipTexts(bytes, ['opf', 'ncx', 'xhtml', 'html', 'htm', 'xml']);
  const container = byName.get('META-INF/container.xml');
  let opfPath = 'content.opf';
  if (container) {
    const found = /full-path\s*=\s*"([^"]+)"/.exec(container);
    if (found) opfPath = found[1];
  }
  const opf = byName.get(opfPath) ?? [...byName.entries()].find(([name]) => name.endsWith('.opf'))?.[1];
  if (opf === undefined) {
    throw new Error('That EPUB has no package document, so its chapters cannot be ordered.');
  }
  const prefix = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map<string, string>();
  for (const [, id, href] of iterateAttributes(opf, 'item')) {
    if (id) manifest.set(id, href ?? '');
  }
  const spine: string[] = [];
  for (const [, idref] of iterateAttributes(opf, 'itemref')) {
    const href = manifest.get(idref ?? '');
    if (href) spine.push(href);
  }
  const order = spine.length > 0 ? spine : [...manifest.values()];
  const { htmlToBlocks } = await import('./layout');
  const blocks: Block[] = [];
  for (const href of order.slice(0, options.maxChapters ?? 200)) {
    const path = decodeURIComponent(prefix + href.replace(/^\.?\//, ''));
    const source = byName.get(path) ?? byName.get(decodeURIComponent(href));
    if (source === undefined) continue;
    const chapter = await htmlToBlocks(source);
    if (chapter.length === 0) continue;
    if (blocks.length > 0) blocks.push({ kind: 'pagebreak' });
    blocks.push(...chapter);
    if (blocks.length > BLOCK_LIMIT) break;
  }
  if (blocks.length === 0) throw new Error('No readable chapters were found in that EPUB.');
  return blocks;
}

/** FB2 is plain XML; MOBI is a PalmDB container we do not decode. */
export async function ebookToBlocks(bytes: Uint8Array, name: string): Promise<Block[]> {
  if (!name.toLowerCase().endsWith('.fb2')) {
    throw new Error(
      `"${name}" needs a converter BrowserSnip does not bundle. Re-save it as EPUB, which is converted entirely in your browser.`,
    );
  }
  const document = parseXml(new TextDecoder().decode(bytes), 'That FB2 file is not well-formed XML.');
  const title = document.querySelector('book-title')?.textContent?.trim() || name.replace(/\.[^.]+$/, '');
  const blocks: Block[] = [{ kind: 'heading', level: 1, inlines: [{ text: title }] }];
  for (const paragraph of Array.from(document.getElementsByTagName('p'))) {
    const text = paragraph.textContent?.trim() ?? '';
    if (text) blocks.push({ kind: 'paragraph', inlines: [{ text }] });
    if (blocks.length > BLOCK_LIMIT) break;
  }
  return blocks;
}

/** XPS/OXPS: an OPC package of fixed pages; text runs are recoverable. */
export async function xpsToBlocks(bytes: Uint8Array): Promise<Block[]> {
  const byName = await zipTexts(bytes, ['fpage']);
  const pages = [...byName.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (pages.length === 0) throw new Error('That XPS package has no fixed pages. Re-save it as PDF first.');
  const blocks: Block[] = [];
  for (const page of pages) {
    blocks.push({ kind: 'pagebreak' });
    const document = parseXml(byName.get(page)!, 'That XPS page is not readable XML.');
    for (const glyph of Array.from(document.getElementsByTagName('*'))) {
      // The name is compared as written: `<t:Glyphs>` under a prefix this package
      // never binds, or `<Glyphs>` with a capital, is not the element this reader
      // recovers, and guessing from a similar spelling is how blank pages get
      // shipped with confident names.
      if (localName(glyph) !== 'glyphs') continue;
      const text = glyph.getAttribute('UnicodeString') ?? '';
      if (text.trim()) blocks.push({ kind: 'paragraph', inlines: [{ text: text.trim() }] });
    }
  }
  // A package whose only text is spelled `<t:Glyphs>` comes back as page breaks
  // and nothing else. `tools/office.ts` turns that into a refusal naming the
  // file, which is where the reader is told what to do instead.
  return blocks;
}

// ── email ───────────────────────────────────────────────────────────────────

export interface ParsedEmail {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string;
  text: string;
  html?: string;
  attachments: { filename?: string; mimeType: string; size: number }[];
}

/** A pragmatic RFC 822 reader: headers, then the text/html parts. */
export function parseEmail(source: string): ParsedEmail {
  const splitAt = firstBlankLine(source);
  const headerBlock = source.slice(0, splitAt);
  const body = source.slice(splitAt);
  const headers = readHeaders(headerBlock);
  const decoded = decodeMimeBody(body, headers['content-type'] ?? 'text/plain');
  return {
    subject: decodeHeader(headers.subject ?? '(no subject)'),
    from: decodeHeader(headers.from ?? 'unknown sender'),
    to: splitAddresses(decodeHeader(headers.to ?? '')),
    cc: splitAddresses(decodeHeader(headers.cc ?? '')),
    date: decodeHeader(headers.date ?? ''),
    ...decoded,
  };
}

async function emailToBlocks(
  bytes: Uint8Array,
  name: string,
  options: OfficeReadOptions = {},
): Promise<Block[]> {
  if (/\.msg$/i.test(name)) {
    throw new Error(
      'Outlook .msg is a compound-binary format that needs the optional LibreOffice module. Forward the message to yourself as .eml, which BrowserSnip reads entirely in the browser.',
    );
  }
  const message = parseEmail(new TextDecoder('utf-8').decode(bytes));
  const blocks: Block[] = [
    { kind: 'heading', level: 2, inlines: [{ text: message.subject }] },
    tableBlock([
      ['Header', 'Value'],
      ['From', message.from],
      ['To', message.to.join(', ') || '—'],
      ...(message.cc.length ? [['Cc', message.cc.join(', ')]] : []),
      ['Date', message.date || 'unknown'],
    ]),
    { kind: 'rule' },
  ];
  if (message.html) {
    const { htmlToBlocks } = await import('./layout');
    blocks.push(...(await htmlToBlocks(message.html)));
  } else {
    for (const paragraph of message.text.split(/\r?\n\s*\r?\n/)) {
      if (paragraph.trim()) blocks.push({ kind: 'paragraph', inlines: [{ text: paragraph.trim() }] });
    }
  }
  if (options.attachments && message.attachments.length > 0) {
    blocks.push({ kind: 'heading', level: 3, inlines: [{ text: 'Attachments' }] });
    blocks.push(
      tableBlock([
        ['File', 'Type', 'Size'],
        ...message.attachments.map((attachment) => [
          attachment.filename ?? 'unnamed',
          attachment.mimeType,
          `${Math.round(attachment.size / 1024)} KB`,
        ]),
      ]),
    );
  }
  return blocks;
}

export { emailToBlocks };

// ── helpers ─────────────────────────────────────────────────────────────────

async function openDocumentXml(bytes: Uint8Array, entry: string): Promise<Document> {
  const byName = await zipTexts(bytes, ['xml']);
  const source = byName.get(entry) ?? byName.get(`Oasis/${entry}`);
  if (source === undefined) throw new Error(`That OpenDocument file has no ${entry}.`);
  return parseXml(source, `That file's ${entry} is not readable XML.`);
}

async function zipTexts(bytes: Uint8Array, extensions: string[]): Promise<Map<string, string>> {
  const files = await readZip(bytes, { filterExtensions: extensions });
  return new Map(files.map((file) => [file.name, new TextDecoder('utf-8').decode(file.bytes)]));
}

function parseXml(xml: string, message: string): Document {
  const document = new DOMParser().parseFromString(declareMissingNamespaces(xml), 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) throw new Error(message);
  return document;
}

/** Namespaces invented for prefixes a document uses but never declares. */
const PLACEHOLDER_NAMESPACE = 'urn:browsersnip:undeclared:';

/** `xml` is bound by the spec itself; `xmlns` is the declaration keyword. */
const RESERVED_PREFIXES = new Set(['xml', 'xmlns']);

/**
 * Bind every prefix the document uses without declaring it.
 *
 * A strict XML parse stops at the first undeclared prefix, which turned real
 * files into "not readable XML" and named the wrong cause: a Windows XPS print
 * writes `<t:Glyphs>`, whose prefix is bound in a part a text reader never
 * looks at. Declaring the missing prefixes keeps every qualified name exactly as
 * the producer wrote it, so a reader that compares names still sees the truth.
 */
function declareMissingNamespaces(xml: string): string {
  const declared = new Set<string>();
  for (const match of xml.matchAll(/\bxmlns:([\w.-]+)\s*=/g)) declared.add(match[1]);
  const missing = new Set<string>();
  const note = (prefix: string | undefined): void => {
    if (!prefix || RESERVED_PREFIXES.has(prefix) || declared.has(prefix)) return;
    missing.add(prefix);
  };
  // Element names (`<h:text>`, `</h:text>`) and attribute names (`h:href="…"`).
  for (const match of xml.matchAll(/<\s*\/?\s*([\w.-]+):|[\s"']([\w.-]+):[\w.-]+\s*=/g)) {
    note(match[1] ?? match[2]);
  }
  if (missing.size === 0) return xml;
  // The first tag whose name starts with a letter: `<?xml`, `<!DOCTYPE` and
  // `<!--` are excluded by the character class, so this is the root element.
  const root = /<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)/.exec(xml);
  if (!root) return xml;
  const insert = [...missing]
    .map((prefix) => ` xmlns:${prefix}="${PLACEHOLDER_NAMESPACE}${prefix}"`)
    .join('');
  const at = root.index + root[0].length;
  return `${xml.slice(0, at)}${insert}${xml.slice(at)}`;
}

function localName(element: Element): string {
  return element.localName ?? element.nodeName.split(':').pop() ?? '';
}

function byLocalName(root: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const visit = (node: Element) => {
    if (localName(node) === name) out.push(node);
    for (const child of Array.from(node.children ?? [])) visit(child);
  };
  const top = (root as Document).documentElement ? [(root as Document).documentElement] : Array.from((root as Element).children ?? []);
  for (const element of top) visit(element);
  return out;
}

function childrenNamed(element: Element, name: string): Element[] {
  return Array.from(element.children ?? []).filter((child) => localName(child) === name);
}

function textsIn(element: Element): string[] {
  const out: string[] = [];
  const visit = (node: Element) => {
    if (localName(node) === 'p' || localName(node) === 'h' || localName(node) === 't') {
      const text = plainText(node);
      if (text) out.push(text);
      return;
    }
    for (const child of Array.from(node.children ?? [])) visit(child);
  };
  visit(element);
  return out;
}

function textsOf(document: Document): string[] {
  const out: string[] = [];
  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (localName(element) !== 't') continue;
    const text = element.textContent?.trim() ?? '';
    if (text) out.push(text);
  }
  return out;
}

function plainText(element: Element): string {
  let text = '';
  for (const node of Array.from(element.childNodes ?? [])) {
    if (node.nodeType === 3) text += node.textContent ?? '';
    else if (node.nodeType === 1) {
      const name = localName(node as Element);
      if (name === 's') text += ' '.repeat(Number((node as Element).getAttribute('text:c') ?? '1'));
      else if (name === 'tab') text += '\t';
      else if (name === 'line-break') text += '\n';
      else text += plainText(node as Element);
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Keep bold/italic emphasis, drop the rest — OOXML has no inline styling. */
function inlineRuns(element: Element): Inline[] {
  const runs: Inline[] = [];
  const push = (text: string, style: Partial<Inline>) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === style.bold && last.italic === style.italic) last.text += text;
    else runs.push({ ...style, text });
  };
  const visit = (node: Element, style: Partial<Inline>) => {
    for (const child of Array.from(node.children ?? [])) {
      const name = localName(child);
      const bold = name === 'b' || (child.getAttribute('fo:font-weight') ?? '') === 'bold';
      const italic = name === 'i' || (child.getAttribute('fo:font-style') ?? '') === 'italic';
      if (child.children && child.children.length > 0 && !['span', 's', 'tab', 'number', 'metric', 'c'].includes(name)) {
        visit(child, { ...style, bold: bold || style.bold, italic: italic || style.italic });
      } else {
        push(plainText(child), { ...style, bold: bold || style.bold, italic: italic || style.italic });
      }
    }
    if ((!node.children || node.children.length === 0) && node.textContent) {
      push(node.textContent.replace(/\s+/g, ' ').trim(), style);
    }
  };
  visit(element, {});
  return runs.length > 0 ? runs : [{ text: plainText(element) }].filter((run) => run.text);
}

function listBlock(
  items: { text: string; level: number; marker?: 'bullet' | 'ordered' }[],
  ordered = false,
): Block {
  return {
    kind: 'list',
    ordered,
    items: items.map((item) => ({
      inlines: [{ text: item.text }],
      level: item.level,
      checked: null,
    })),
  };
}

function clampLevel(value: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const level = Math.min(6, Math.max(1, Math.round(value) || 1));
  return level as 1 | 2 | 3 | 4 | 5 | 6;
}

function indexIn(path: string): number {
  return Number(/(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

function firstBlankLine(source: string): number {
  const match = /\r?\n\r?\n/.exec(source);
  return match ? match.index + match[0].length : 0;
}

function readHeaders(block: string): Record<string, string> {
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9-]+)\s*:\s*(.*)$/.exec(line);
    if (match) out[match[1].toLowerCase()] = match[2];
  }
  return out;
}

function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset, encoding, text) => {
    if (encoding.toLowerCase() === 'b') {
      try {
        return new TextDecoder(String(charset)).decode(base64Bytes(text));
      } catch {
        return text;
      }
    }
    return String(text).replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));
  });
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/,(?![^<]*>)/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

interface MimePart {
  headers: Record<string, string>;
  body: string;
}

/** Decode a (possibly multipart) body into text, html and attachment names. */
function decodeMimeBody(
  body: string,
  contentType: string,
): { text: string; html?: string; attachments: { filename?: string; mimeType: string; size: number }[] } {
  const boundary = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  if (!boundary) {
    const text = transfer(decodeHeader(body), contentType);
    return { ...splitTextHtml(text, contentType), attachments: [] };
  }
  const parts = splitMultipart(body, boundary[1]);
  let text = '';
  let html: string | undefined;
  const attachments: { filename?: string; mimeType: string; size: number }[] = [];
  for (const part of parts) {
    const type = part.headers['content-type'] ?? 'text/plain';
    const disposition = part.headers['content-disposition'] ?? '';
    const filename = /filename\s*=\s*"?([^";\n]+)"?/i.exec(disposition)?.[1];
    if (filename) {
      attachments.push({ filename, mimeType: type, size: part.body.length });
      continue;
    }
    const decoded = transfer(decodeHeader(part.body), type);
    if (/^text\/html/i.test(type) && !html) html = decoded;
    else if (/^text\/plain/i.test(type) && !text) text = decoded;
    else attachments.push({ filename: `part (${type})`, mimeType: type, size: part.body.length });
  }
  return { text, html, attachments };
}

function splitMultipart(body: string, boundary: string): MimePart[] {
  const marker = `--${boundary}`;
  return body
    .split(marker)
    .map((chunk) => chunk.replace(/^(\r?\n)+|(\r?\n)+$/g, ''))
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith('--'))
    .map((chunk) => {
      const at = chunk.search(/\r?\n\r?\n/);
      const head = at === -1 ? chunk : chunk.slice(0, at);
      const rest = at === -1 ? '' : chunk.slice(at).replace(/^\r?\n\r?\n/, '');
      return { headers: readHeaders(head), body: rest };
    });
}

function transfer(value: string, type: string): string {
  if (!/base64/i.test(value) && /charset\s*=\s*utf-8/i.test(type)) return quotedPrintable(value);
  const collapsed = value.replace(/\r?\n/g, '');
  if (/^[\sA-Za-z0-9+/=]+$/.test(collapsed) && collapsed.length % 4 === 0 && collapsed.length > 32) {
    try {
      return new TextDecoder('utf-8').decode(base64Bytes(collapsed));
    } catch {
      /* not base64 after all */
    }
  }
  return quotedPrintable(value);
}

function quotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));
}

function splitTextHtml(text: string, contentType: string): { text: string; html?: string } {
  return /^text\/html/i.test(contentType) ? { text: '', html: text } : { text };
}

/** Yield [tagName, id, href] triples from an OPF without a namespace dance. */
function* iterateAttributes(xml: string, tag: string): Generator<[string, string | undefined, string | undefined]> {
  const pattern = new RegExp(`<[A-Za-z0-9_-]*:?${tag}\\b([^>]*)>`, 'gi');
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1] ?? '';
    const id = /\bid\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    const href = /\b(?:href|idref)\s*=\s*"([^"]*)"/.exec(attrs)?.[1];
    yield [tag, id, href];
  }
}

/**
 * LibreOffice WASM is the only faithful path for legacy binary Office files, and
 * it is deliberately not bundled (~100 MB). Tools call this to decide whether to
 * offer it rather than failing deep inside a conversion.
 */
export function officeReady(): boolean {
  return false;
}

export async function convertOffice(
  _bytes: Uint8Array,
  _name: string,
  _target: string,
  _progress?: (fraction: number, message?: string) => void,
): Promise<Uint8Array> {
  throw new Error(
    'This format needs the LibreOffice converter, which BrowserSnip does not bundle. Re-save the file as DOCX, XLSX, PPTX or EPUB — those are read entirely in your browser.',
  );
}
