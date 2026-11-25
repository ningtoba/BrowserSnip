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
  if (body) walkOdt(body, blocks, 0, listStyleKinds(document));
  if (blocks.length === 0) throw new Error('That ODT had no readable paragraphs.');
  return blocks;
}

/**
 * Which named list styles order, from `text:list-level-style-number`.
 *
 * An ODT list says only `text:style-name="L1"`; whether its items are numbered
 * lives in the automatic styles, on the level's rule element. Reading the name
 * for the word "number" instead — which is what used to happen — printed real
 * Word-97-style ordered lists (names like "ListNumber…") and silently turned
 * LibreOffice's "L1/L2" ones into bullets.
 */
function listStyleKinds(document: Document): Map<string, boolean> {
  const kinds = new Map<string, boolean>();
  for (const style of byLocalName(document as unknown as Element, 'list-style')) {
    const name = style.getAttribute('style:name');
    if (!name) continue;
    const ordered = byLocalName(style, 'list-level-style-number').length > 0;
    kinds.set(name, ordered);
  }
  return kinds;
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

function walkOdt(element: Element, blocks: Block[], depth = 0, listKinds: Map<string, boolean> = new Map()): void {
  for (const child of Array.from(element.children ?? [])) {
    if (blocks.length > BLOCK_LIMIT) return;
    const name = odfName(child);
    if (name === 'h') {
      const outline = Number(child.getAttribute('text:outline-level') ?? '1');
      blocks.push({ kind: 'heading', level: clampLevel(outline), inlines: inlineRuns(child) });
      continue;
    }
    if (name === 'p') {
      const text = bodyText(child);
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
      const style = child.getAttribute('text:style-name') ?? '';
      const ordered = listKinds.get(style) ?? /number/i.test(style);
      blocks.push(listBlock(listItems(child), ordered));
      continue;
    }
    if (name === 'table') {
      blocks.push(odtTableBlock(child));
      continue;
    }
    // A section is a container inside the text body — its paragraphs are the
    // document's own words, not page furniture — while frames carry the
    // drawings this reader does not reproduce (and the card says so).
    if (name === 'frame' || name === 'soft-page-break') continue;
    walkOdt(child, blocks, name === 'list' ? depth + 1 : depth, listKinds);
  }
}

/**
 * The paragraph's own text: markup flattened, review comments excluded.
 *
 * An `office:annotation` is a sticky note anchored in the sentence — its words
 * are not the sentence. `plainText` reads it like any other child, which printed
 * "Reviewer said this" into the converted body while the card promised comments
 * were not preserved; every reader of the document body goes through here.
 */
function bodyText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const note of Array.from(clone.querySelectorAll('*'))) {
    if (localName(note) === 'annotation') note.remove();
  }
  return plainText(clone);
}

function listItems(element: Element): { text: string; level: number; marker: 'bullet' | 'ordered' }[] {
  const out: { text: string; level: number; marker: 'bullet' | 'ordered' }[] = [];
  const visit = (node: Element, level: number) => {
    for (const child of Array.from(node.children ?? [])) {
      if (localName(child) === 'list-item') {
        // The item's own paragraphs first — joined the way ODF means them, one
        // item per entry — then any list nested *inside* the item, at the next
        // level. Reading the nested list only when the parent had no text lost
        // every sub-item of a real outline: "step two" kept its own words and
        // swallowed "sub of two" into them.
        const text = Array.from(child.children ?? [])
          .filter((part) => localName(part) !== 'list')
          .map(bodyText)
          .filter(Boolean)
          .join(' ');
        if (text) out.push({ text, level, marker: 'bullet' });
        // Always descend: a nested list hangs inside the item that owns it,
        // whether or not that item has words of its own.
        visit(child, level);
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
  // `byLocalName`, not direct children: LibreOffice wraps heading rows in
  // `text:table-header-rows`, and a direct-children walk silently dropped every
  // row so wrapped — tables lost their header while the card promised tables.
  for (const row of byLocalName(table, 'table-row')) {
    const cells: Inline[][] = [];
    for (const cell of Array.from(row.children ?? [])) {
      const name = localName(cell);
      if (name === 'table-cell') {
        const repeat = Math.min(Number(cell.getAttribute('table:number-columns-repeated') ?? '1'), 32);
        const text = Array.from(cell.children ?? []).map(bodyText).filter(Boolean).join(' ');
        for (let i = 0; i < repeat; i++) cells.push([{ text }]);
      } else if (name === 'covered-table-cell') {
        // The columns a merge swallowed still occupy their grid slots: dropping
        // the covered cell slid every later value one column left, so `4` from
        // the fourth column landed under the first column's header.
        const span = Math.min(Number(cell.getAttribute('table:number-columns-covered') ?? '1'), 32);
        for (let i = 0; i < span; i++) cells.push([{ text: '' }]);
      }
    }
    if (cells.some((cell) => (cell[0]?.text ?? '') !== '')) rows.push(cells);
    if (rows.length > 2000) break;
  }
  const [head, ...body] = rows;
  return { kind: 'table', header: head ?? [], rows: body };
}

/** OpenDocument Spreadsheet. */
export async function odsToBlocks(bytes: Uint8Array): Promise<{ blocks: Block[]; emptySheets: string[] }> {
  const document = await openDocumentXml(bytes, 'content.xml');
  const blocks: Block[] = [];
  const emptySheets: string[] = [];
  for (const table of byLocalName(document, 'table')) {
    const name = table.getAttribute('table:name') ?? `Sheet ${blocks.length + 1}`;
    const block = odtTableBlock(table);
    // A sheet whose every cell is blank used to print its name under a heading
    // with no table — the receipt counted a worksheet the file never showed.
    // The caller owns the sentence; it knows the file's name.
    if ((block.header?.length ?? 0) === 0 && block.rows.length === 0) {
      emptySheets.push(name);
      continue;
    }
    blocks.push({ kind: 'heading', level: 2, inlines: [{ text: name }] });
    blocks.push(block);
  }
  // Never throws: both callers refuse an empty workbook in their own words —
  // one names the file, the other counts what a batch still converted.
  return { blocks, emptySheets };
}

/**
 * OpenDocument Presentation — one page per draw page, blanks included.
 *
 * LibreOffice writes slide text inside `draw:frame > draw:text-box`, marking
 * the title frame with `presentation:class`; the reader used to walk only
 * `draw:shape`, an element real suites put inside frames or not at all, so a
 * deck saved by Impress converted to zero text and was refused — the harness
 * fixture with its `draw:shape` nesting was the only deck that ever worked.
 * Both spellings are read now. Frames under `presentation:notes` are the
 * speaker's notes, not slide content: never printed unless asked, exactly like
 * the PPTX route's notes.
 *
 * A slide with no text still owns a page: "one page per slide" counts blank
 * cards too. An empty slide therefore places an invisible paragraph, which
 * survives the callers' stray-break trim; a deck with no text anywhere returns
 * no blocks at all, so the calling tools keep their refusal naming the format
 * and the alternative.
 */
export async function odpToBlocks(bytes: Uint8Array, options: OfficeReadOptions = {}): Promise<Block[]> {
  const document = await openDocumentXml(bytes, 'content.xml');
  const slides: Block[][] = [];
  for (const page of byLocalName(document, 'page')) {
    const blocks: Block[] = [];
    const carriers = [...byLocalName(page, 'frame'), ...byLocalName(page, 'shape')];
    for (const carrier of carriers) {
      // A frame that wraps a shape carrier is the old fixture's container — the
      // shape pass reads it; reading both would print the words twice.
      if (localName(carrier) === 'frame' && carriers.some((other) => other !== carrier && carrier.contains(other))) continue;
      const inNotes = byLocalName(page, 'notes').some((note) => note.contains(carrier));
      const isTitle = ['presentation:class', 'presentation:presentationclass', 'draw:presentationclass']
        .some((attribute) => carrier.getAttribute(attribute) === 'title');
      const texts = textsIn(carrier);
      if (texts.length === 0) continue;
      if (inNotes) {
        // One quote for the note frame, as the PPTX route shapes its notes —
        // and only when the reader was asked for notes at all.
        if (options.notes) blocks.push({ kind: 'quote', inlines: [{ text: `Notes: ${texts.join(' ')}`, italic: true }] });
        continue;
      }
      for (const text of texts) {
        blocks.push(
          isTitle
            ? { kind: 'heading', level: 2, inlines: [{ text }] }
            : { kind: 'paragraph', inlines: [{ text }] },
        );
      }
    }
    slides.push(blocks);
  }
  if (!slides.some((blocks) => blocks.length > 0)) return [];
  const blocks: Block[] = [];
  const blankSlide: Block = { kind: 'paragraph', inlines: [{ text: '' }] };
  for (const slide of slides) {
    if (blocks.length > 0) blocks.push({ kind: 'pagebreak' });
    blocks.push(...(slide.length > 0 ? slide : [blankSlide]));
    if (blocks.length > BLOCK_LIMIT) break;
  }
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
  // A deck with zero slide parts — PowerPoint saves one after “delete every
  // slide” — used to abort the whole run (a batch too) with a raw
  // `Error('That PPTX has no slides.')`: no file named, no hint, not even the
  // tool’s own refusal sentence. It is the same nothing-to-print case as an
  // all-blank deck, so it returns the same empty answer and the caller owns
  // the sentence.
  const slideBlocks = slides.map((slide) => {
    const perSlide: Block[] = [];
    const texts = textsOf(parseXml(byName.get(slide)!, 'That slide is not readable XML.'));
    texts.forEach((text, index) => {
      perSlide.push(
        index === 0
          ? { kind: 'heading', level: 2, inlines: [{ text }] }
          : { kind: 'paragraph', inlines: [{ text }] },
      );
    });
    if (options.notes) {
      const notes = byName.get(`ppt/notesSlides/notesSlide${indexIn(slide)}.xml`);
      if (notes) {
        const note = textsOf(parseXml(notes, 'notes')).filter((text) => text.length > 1).join(' ');
        if (note) perSlide.push({ kind: 'quote', inlines: [{ text: `Notes: ${note}`, italic: true }] });
      }
    }
    return perSlide;
  });
  if (!slideBlocks.some((blocks) => blocks.length > 0)) return [];
  // Turn per slide, as `odpToBlocks` does. The old “break before every slide
  // after the first” spine lost a blank FIRST slide outright — it contributed
  // no block and no break, so slide 2 opened the document and the deck printed
  // N−1 pages for N slides. A blank slide is a beat in the deck (the pause
  // before the point), which is what the middle-blank pin already says.
  const blocks: Block[] = [];
  const blankSlide: Block = { kind: 'paragraph', inlines: [{ text: '' }] };
  for (const perSlide of slideBlocks) {
    if (blocks.length > 0) blocks.push({ kind: 'pagebreak' });
    blocks.push(...(perSlide.length > 0 ? perSlide : [blankSlide]));
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
  // `iterateAttributes` yields `[tag, id, href|idref]`: the reference is the
  // *third* slot, and an `itemref` usually has no `id` of its own, so reading it
  // from the second slot emptied the spine and the reader fell back to manifest
  // order — a book whose manifest is not in reading order came out backwards.
  for (const [, , idref] of iterateAttributes(opf, 'itemref')) {
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
    // See `odpToBlocks`: a leading break buys a blank first sheet.
    if (blocks.length > 0) blocks.push({ kind: 'pagebreak' });
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
  const decoded = decodeMimeBody(body, headers['content-type'] ?? 'text/plain', headers);
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

/**
 * Keep bold/italic emphasis, drop the rest — OOXML has no inline styling.
 *
 * Children are walked as `childNodes`, in order, because the words between the
 * styled parts are the sentence: an element-only walk handed `<text:span>` its
 * style and left every bare text node unread, so “Body with *emphasis*.”
 * converted to “emphasis” — the card promised the document's text.
 */
function inlineRuns(element: Element): Inline[] {
  const runs: Inline[] = [];
  const push = (text: string, style: Partial<Inline>) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && last.bold === style.bold && last.italic === style.italic) last.text += text;
    else runs.push({ ...style, text });
  };
  const visit = (node: Element, style: Partial<Inline>) => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child.nodeType === 3) {
        push((child.textContent ?? '').replace(/\s+/g, ' '), style);
        continue;
      }
      if (child.nodeType !== 1) continue;
      const name = localName(child as Element);
      // A review comment is anchored in the sentence, not part of it.
      if (name === 'annotation') continue;
      const el = child as Element;
      const bold = name === 'b' || (el.getAttribute('fo:font-weight') ?? '') === 'bold';
      const italic = name === 'i' || (el.getAttribute('fo:font-style') ?? '') === 'italic';
      if (el.children && el.children.length > 0 && !['span', 's', 'tab', 'number', 'metric', 'c'].includes(name)) {
        visit(el, { ...style, bold: bold || style.bold, italic: italic || style.italic });
      } else {
        push(plainText(el), { ...style, bold: bold || style.bold, italic: italic || style.italic });
      }
    }
  };
  visit(element, {});
  const text = runs.map((run) => run.text).join('').trim();
  if (!text) return [];
  runs[0]!.text = runs[0]!.text.replace(/^\s+/, '');
  runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.replace(/\s+$/, '');
  return runs;
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
    // `=XX` is a byte here too: `=?UTF-8?Q?caf=E9?=` is “café”, not “cafÃ©”.
    const literal = new TextEncoder().encode(String(text).replace(/_/g, ' '));
    const bytes: number[] = [];
    for (let i = 0; i < literal.length; i++) {
      const hex = literal[i] === 0x3d ? /^[0-9A-Fa-f]{2}$/.exec(String.fromCharCode(literal[i + 1], literal[i + 2])) : null;
      if (hex) {
        bytes.push(Number.parseInt(hex[0], 16));
        i += 2;
        continue;
      }
      bytes.push(literal[i]);
    }
    return decodeBytes(new Uint8Array(bytes), String(charset));
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
  headers: Record<string, string> = {},
): { text: string; html?: string; attachments: { filename?: string; mimeType: string; size: number }[] } {
  const boundary = /boundary\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  if (!boundary) {
    const text = transfer(decodeHeader(body), contentType, headers['content-transfer-encoding']);
    return { ...splitTextHtml(text, contentType), attachments: [] };
  }
  const parts = splitMultipart(body, boundary[1]);
  let text = '';
  let html: string | undefined;
  const attachments: { filename?: string; mimeType: string; size: number }[] = [];
  for (const part of parts) {
    const type = part.headers['content-type'] ?? 'text/plain';
    const disposition = part.headers['content-disposition'] ?? '';
    // The value ends at the closing quote or the end of the header line: a
    // quoted `filename="deck.pdf"` is `deck.pdf`, and the CR that follows it in
    // a CRLF message must not ride along — a drawn `\r` is not encodable in a
    // Latin-1 face, so the listing used to fail the whole message.
    const filename = /filename\s*=\s*("?)([^";\r\n]+)\1/i.exec(disposition)?.[2];
    if (filename) {
      attachments.push({ filename, mimeType: type, size: part.body.length });
      continue;
    }
    const decoded = transfer(decodeHeader(part.body), type, part.headers['content-transfer-encoding']);
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

function transfer(value: string, type: string, encoding?: string): string {
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(type)?.[1] ?? 'utf-8';
  if (/quoted-printable/i.test(encoding ?? '')) return quotedPrintable(value, charset);
  if (/base64/i.test(encoding ?? '')) {
    try {
      return decodeBytes(base64Bytes(value), charset);
    } catch {
      /* the part said base64 and was not */
    }
  }
  if (encoding) return newlines(value);
  // A `Content-Transfer-Encoding` header is not universal; guess for the bodies
  // that arrive without one, but never let the guess keep a `\r`.
  const collapsed = value.replace(/\r?\n/g, '');
  if (/^[\sA-Za-z0-9+/=]+$/.test(collapsed) && collapsed.length % 4 === 0 && collapsed.length > 32) {
    try {
      return decodeBytes(base64Bytes(collapsed), charset);
    } catch {
      /* not base64 after all */
    }
  }
  return newlines(quotedPrintable(value, charset));
}

/** CRLF and a lone CR both mean “end of line”; a bare `\r` cannot be drawn. */
function newlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Quoted-printable: `=XX` names ONE BYTE, not one character.
 *
 * Turning each pair straight into a code point decoded `=C3=A9` as the two
 * letters “Ã©” instead of the one the part’s charset means, so every accented
 * word in a plain-text message arrived as mojibake.
 */
function quotedPrintable(value: string, charset = 'utf-8'): string {
  const text = newlines(value).replace(/=\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === '=' ? /^([0-9A-Fa-f]{2})/.exec(text.slice(i + 1, i + 3)) : null;
    if (hex) {
      bytes.push(Number.parseInt(hex[1], 16));
      i += 2;
      continue;
    }
    for (const byte of new TextEncoder().encode(text[i])) bytes.push(byte);
  }
  return decodeBytes(new Uint8Array(bytes), charset);
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
