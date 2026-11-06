/**
 * Bookmarks, page labels, generated contents pages and Bates numbering.
 *
 * The outline tree this module hand-writes is verified by real files: build →
 * `savePDF` → `openPDF` → `readOutline`, because a `/Next` chain or a `/Count`
 * that only looks right in memory is worthless. Text-drawing assertions read
 * the content streams back out of the saved bytes.
 */
import { describe, expect, it } from 'vitest';
import type { PDFPage } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  degrees,
  newPDF,
  openPDF,
  savePDF,
} from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/metadata';
import {
  addBatesNumbers,
  addPageLabels,
  generateTocPage,
  outlineFromJson,
  outlineToJson,
  readOutline,
  readPageLabels,
  writeOutline,
  type OutlineNode,
} from '@/lib/pdf/core/bookmarks';

const reload = (bytes: Uint8Array) =>
  openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });

async function blankDoc(pages: number) {
  const doc = await newPDF();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc;
}

/** The visible text of a page: every hex string shown with `Tj`. */
function pageText(page: PDFPage): string {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFArray
      ? contents.asArray().map((_, i) => contents.lookup(i))
      : [contents];
  let raw = '';
  for (const item of streams) {
    const stream = item as never;
    raw += new TextDecoder('latin1').decode(streamBytes(stream));
  }
  const out: string[] = [];
  for (const match of raw.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) {
    const bytes = (match[1].match(/../g) ?? []).map((hex) => Number.parseInt(hex, 16));
    out.push(new TextDecoder('latin1').decode(Uint8Array.from(bytes)));
  }
  return out.join('\n');
}

function rawContent(page: PDFPage): string {
  const contents = page.node.Contents();
  const first = contents instanceof PDFArray ? contents.get(0) : contents;
  return new TextDecoder('latin1').decode(streamBytes(first as never));
}

function linkTargets(page: PDFPage, doc: Awaited<ReturnType<typeof newPDF>>): number[] {
  const pages = doc.getPages();
  const indexByRef = new Map<string, number>();
  pages.forEach((candidate, i) => {
    indexByRef.set(candidate.ref.toString(), i);
  });
  const annots = page.node.Annots();
  if (!annots) return [];
  const targets: number[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const annot = annots.lookupMaybe(i, PDFDict);
    if (!annot) continue;
    if (annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Link') continue;
    const dest = annot.lookupMaybe(PDFName.of('Dest'), PDFArray);
    const first = dest?.get(0);
    if (first instanceof PDFRef) targets.push(indexByRef.get(first.toString()) ?? -1);
  }
  return targets;
}

describe('readOutline / writeOutline', () => {
  it('returns nothing when the document has no outline', async () => {
    const doc = await blankDoc(2);
    expect(readOutline(doc)).toEqual([]);
  });

  it('writes a tree that reads back after save + load', async () => {
    const doc = await blankDoc(6);
    const nodes: OutlineNode[] = [
      {
        title: 'Chapter One',
        page: 0,
        color: '#ff0000',
        bold: true,
        children: [
          { title: 'Background', page: 1 },
          { title: 'Method', page: 2, italic: true, color: '#00ff00' },
        ],
      },
      {
        title: 'Chapter Two',
        page: 3,
        destination: { kind: 'xyz', x: 20, y: 700, zoom: 1.5 },
      },
      { title: 'Annexes', page: null, children: [{ title: 'Glossary', page: 5 }] },
    ];
    writeOutline(doc, nodes);

    const loaded = await reload(await savePDF(doc));
    const read = readOutline(loaded);
    expect(read).toHaveLength(3);
    expect(read[0].title).toBe('Chapter One');
    expect(read[0].page).toBe(0);
    expect(read[0].bold).toBe(true);
    expect(read[0].italic).toBeUndefined();
    expect(read[0].color).toBe('#ff0000');
    expect(read[0].children?.map((child) => child.title)).toEqual(['Background', 'Method']);
    expect(read[0].children?.[1].italic).toBe(true);
    expect(read[0].children?.[1].color).toBe('#00ff00');
    expect(read[1].destination).toEqual({ kind: 'xyz', x: 20, y: 700, zoom: 1.5 });
    expect(read[2].page).toBeNull();
    expect(read[2].children?.[0].page).toBe(5);

    // /Count is what the panels use to size the tree: all 6 items.
    const root = loaded.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    expect(root?.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber()).toBe(6);
  });

  it('carries Unicode titles through the round trip', async () => {
    const doc = await blankDoc(2);
    writeOutline(doc, [{ title: 'Привет 語 🥚', page: 0 }]);
    const loaded = await reload(await savePDF(doc));
    expect(readOutline(loaded)[0].title).toBe('Привет 語 🥚');
  });

  it('replaces the previous tree instead of appending to it', async () => {
    const doc = await blankDoc(3);
    writeOutline(doc, [{ title: 'Old', page: 0 }, { title: 'Gone', page: 1 }]);
    writeOutline(doc, [{ title: 'New', page: 2 }]);
    const loaded = await reload(await savePDF(doc));
    const read = readOutline(loaded);
    expect(read.map((node) => node.title)).toEqual(['New']);
    const objects = loaded.context.enumerateIndirectObjects().length;
    expect(objects).toBeLessThan(40);
  });

  it('deletes the outline when handed an empty list', async () => {
    const doc = await blankDoc(2);
    writeOutline(doc, [{ title: 'Temp', page: 0 }]);
    writeOutline(doc, []);
    const loaded = await reload(await savePDF(doc));
    expect(loaded.catalog.has(PDFName.of('Outlines'))).toBe(false);
    expect(readOutline(loaded)).toEqual([]);
  });

  it('refuses a bookmark pointing outside the document', async () => {
    const doc = await blankDoc(3);
    expect(() => writeOutline(doc, [{ title: 'Nowhere', page: 9 }])).toThrow(
      /points at page 10, but this document has 3 pages/,
    );
  });

  it('skips malformed entries instead of throwing', async () => {
    const doc = await blankDoc(3);
    const ctx = doc.context;
    // A hand-built tree: item 1 is fine, item 2 has a `/Dest` that points at a
    // non-page object, item 3 links back to item 2 so `/Next` would loop, and
    // item 4 has no title at all.
    const rootRef = ctx.nextRef();
    const fineRef = ctx.nextRef();
    const brokenRef = ctx.nextRef();
    const loopRef = ctx.nextRef();
    const emptyRef = ctx.nextRef();

    ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: fineRef, Count: 99 }));
    ctx.assign(
      fineRef,
      ctx.obj({
        Title: PDFHexString.fromText('Fine'),
        Parent: rootRef,
        Dest: ctx.obj([doc.getPage(1).ref, 'Fit']),
        Next: brokenRef,
      }),
    );
    ctx.assign(
      brokenRef,
      ctx.obj({ Title: PDFHexString.fromText('Broken'), Parent: rootRef, Dest: rootRef, Next: loopRef }),
    );
    ctx.assign(loopRef, ctx.obj({ Title: PDFHexString.fromText('Looping'), Next: brokenRef }));
    ctx.assign(emptyRef, ctx.obj({ Parent: rootRef }));
    doc.catalog.set(PDFName.of('Outlines'), rootRef);

    const loaded = await reload(await savePDF(doc));
    const read = readOutline(loaded);
    // `Looping` is reachable, but its `/Next` back to `Broken` must not spin.
    expect(read.map((node) => node.title)).toEqual(['Fine', 'Broken', 'Looping']);
    expect(read[0].page).toBe(1);
    expect(read[1].page).toBeNull();
  });

  it('resolves named destinations through the catalog /Dests tree', async () => {
    const doc = await blankDoc(4);
    const ctx = doc.context;
    const root = ctx.obj({ Type: 'Outlines' });
    const rootRef = ctx.register(root);
    const item = ctx.obj({});
    const itemRef = ctx.register(item);
    item.set(PDFName.of('Title'), PDFHexString.fromText('By name'));
    item.set(PDFName.of('Parent'), rootRef);
    item.set(PDFName.of('Dest'), PDFName.of('target3'));
    root.set(PDFName.of('First'), itemRef);
    root.set(PDFName.of('Last'), itemRef);
    root.set(PDFName.of('Count'), PDFNumber.of(1));
    doc.catalog.set(PDFName.of('Outlines'), rootRef);

    const dests = ctx.obj({});
    dests.set(
      PDFName.of('Names'),
      ctx.obj([PDFHexString.fromText('target3'), ctx.obj([doc.getPage(2).ref, 'XYZ', null, null, null])]),
    );
    doc.catalog.set(PDFName.of('Dests'), ctx.register(dests));

    const loaded = await reload(await savePDF(doc));
    const read = readOutline(loaded);
    expect(read[0].page).toBe(2);
    expect(read[0].destination).toEqual({ kind: 'xyz' });
  });
});

describe('outline JSON and outline text', () => {
  const nodes: OutlineNode[] = [
    { title: 'Top', page: 0, children: [{ title: 'Child', page: 1, bold: true }] },
    { title: 'Group', page: null, children: [{ title: 'Leaf', page: 2, color: '#123456' }] },
  ];

  it('round-trips through JSON', () => {
    const json = outlineToJson(nodes);
    expect(outlineFromJson(json)).toEqual(nodes);
  });

  it('accepts nested tuple arrays and plain strings', () => {
    const parsed = outlineFromJson(`[["Cover", 1], ["Intro", [["Deep", 3]]], "Notes"]`);
    expect(parsed[0]).toEqual({ title: 'Cover', page: 0 });
    expect(parsed[1].children?.[0].title).toBe('Deep');
    expect(parsed[1].children?.[0].page).toBe(2);
    expect(parsed[2]).toEqual({ title: 'Notes', page: null });
  });

  it('accepts FreeMind/OPML-style objects', () => {
    const parsed = outlineFromJson(
      JSON.stringify([{ text: 'Node', page: 2, node: [{ text: 'Nested' }] }]),
    );
    expect(parsed[0].title).toBe('Node');
    expect(parsed[0].page).toBe(2);
    expect(parsed[0].children?.[0].title).toBe('Nested');
  });

  it('parses indentation-based outline text with 1-based page numbers', () => {
    const text = `
# imported from the printed manual
Chapter 1 ......... 3
  1.1 Background | 4
  1.2 Method : 5
    Detail #6
Chapter 2 page 7
`;
    const parsed = outlineFromJson(text);
    expect(parsed.map((node) => node.title)).toEqual(['Chapter 1', 'Chapter 2']);
    expect(parsed[0].page).toBe(2);
    expect(parsed[0].children?.map((child) => [child.title, child.page])).toEqual([
      ['1.1 Background', 3],
      ['1.2 Method', 4],
    ]);
    expect(parsed[0].children?.[1].children?.[0]).toEqual({ title: 'Detail', page: 5 });
    expect(parsed[1].page).toBe(6);
  });

  it('parses FreeMind XML and OPML-lite XML', () => {
    const mind = `
<map version="1.0.1">
  <node TEXT="Root" page="2" STYLE="bold" COLOR="#ff8800">
    <node TEXT="Branch A" page="3"/>
    <node TEXT="Branch B"><node TEXT="Leaf" page="9"/></node>
  </node>
</map>`;
    const parsed = outlineFromJson(mind);
    expect(parsed[0]).toMatchObject({ title: 'Root', page: 1, bold: true, color: '#ff8800' });
    expect(parsed[0].children?.[1].children?.[0].page).toBe(8);

    const opml = `<opml version="2.0"><body><outline text="One" page="1"/><outline text="Two" page="2"/></body></opml>`;
    expect(outlineFromJson(opml).map((node) => node.title)).toEqual(['One', 'Two']);
  });

  it('returns nothing for empty or whitespace input', () => {
    expect(outlineFromJson('')).toEqual([]);
    expect(outlineFromJson('   \n ')).toEqual([]);
    expect(outlineFromJson('[]')).toEqual([]);
  });
});

describe('page labels', () => {
  it('writes /PageLabels and expands them back per page', async () => {
    const doc = await blankDoc(8);
    addPageLabels(doc, [
      { start: 0, style: 'r', prefix: 'Front ' },
      { start: 2, style: 'D', prefix: '', firstPageNumber: 100 },
      { start: 5, style: 'A' },
    ]);
    const loaded = await reload(await savePDF(doc));
    const labels = readPageLabels(loaded);
    // `/P` is per-range: the 100-based range asked for no prefix, and the
    // lettered range defines none.
    expect(labels.map((entry) => entry.label)).toEqual([
      'Front i',
      'Front ii',
      '100',
      '101',
      '102',
      'A',
      'B',
      'C',
    ]);
  });

  it('falls back to plain decimal numbering', async () => {
    const doc = await blankDoc(3);
    expect(readPageLabels(doc).map((entry) => entry.label)).toEqual(['1', '2', '3']);
  });

  it('rejects duplicate starts and unknown styles', async () => {
    const doc = await blankDoc(3);
    expect(() =>
      addPageLabels(doc, [
        { start: 0, style: 'D' },
        { start: 0, style: 'R' },
      ]),
    ).toThrow(/Two page-label ranges start at page 1/);
    expect(() => addPageLabels(doc, [{ start: 0, style: 'X' as 'D' }])).toThrow(
      /is not a page-number style/,
    );
  });

  it('clears the dictionary when handed an empty range list', async () => {
    const doc = await blankDoc(2);
    addPageLabels(doc, [{ start: 0, style: 'R' }]);
    addPageLabels(doc, []);
    const loaded = await reload(await savePDF(doc));
    expect(loaded.catalog.has(PDFName.of('PageLabels'))).toBe(false);
    expect(readPageLabels(loaded).map((entry) => entry.label)).toEqual(['1', '2']);
  });
});

describe('generateTocPage', () => {
  const nodes: OutlineNode[] = [
    { title: 'Introduction', page: 1 },
    { title: 'Very long chapter title that has to be clipped to fit the page', page: 2 },
    { title: 'Sub', page: 3, children: [{ title: 'Deep', page: 4 }] },
  ];

  it('inserts real pages with leaders, numbers and working links', async () => {
    const doc = await blankDoc(6);
    const tocPages = await generateTocPage(doc, { nodes });
    expect(tocPages.length).toBeGreaterThan(0);
    expect(doc.getPageCount()).toBe(6 + tocPages.length);

    const loaded = await reload(await savePDF(doc));
    const toc = loaded.getPage(0);
    const text = pageText(toc);
    expect(text).toContain('Contents');
    expect(text).toContain('Introduction');
    expect(text).toContain('Deep');
    // Numbering counts the inserted pages: original page index 1 is now page 2+N.
    expect(text).toContain(String(2 + tocPages.length));
    expect(rawContent(toc)).toMatch(/\[\s*1\s+2\.5\]\s+0\s+d/); // dot leader dashes

    const targets = linkTargets(toc, loaded);
    expect(targets).toHaveLength(5);
    expect(targets.every((target) => target >= tocPages.length)).toBe(true);
    expect(targets).toEqual(
      nodes.length ? expect.arrayContaining([1 + tocPages.length]) : targets,
    );
  });

  it('honours startPage, a custom heading, no leader and pagesBefore', async () => {
    const doc = await blankDoc(5);
    const tocPages = await generateTocPage(doc, {
      nodes,
      title: 'Table of',
      startPage: 1,
      leader: 'none',
      pagesBefore: 10,
      rightAlignPageNumbers: true,
    });
    const loaded = await reload(await savePDF(doc));
    expect(loaded.getPageCount()).toBe(5 + tocPages.length);
    // Inserted after the original first page.
    const text = pageText(loaded.getPage(1));
    expect(text).toContain('Table of');
    expect(text).toContain('Introduction');
    expect(text).toContain(String(11 + tocPages.length));
    expect(rawContent(loaded.getPage(1))).not.toMatch(/\[\s*1\s+2\.5\]\s+0\s+d/);
  });

  it('omits the heading when the title is an empty string', async () => {
    const doc = await blankDoc(4);
    const [toc] = await generateTocPage(doc, { nodes, title: '' });
    const loaded = await reload(await savePDF(doc));
    const text = pageText(loaded.getPage(0));
    expect(text).not.toContain('Contents');
    expect(text).toContain('Introduction');
    expect(toc).toBeDefined();
  });

  it('spreads long outlines over several pages', async () => {
    const doc = await blankDoc(3);
    const many = Array.from({ length: 90 }, (_, i) => ({
      title: `Entry ${i + 1}`,
      page: i % 3,
    }));
    const pages = await generateTocPage(doc, { nodes: many });
    expect(pages.length).toBeGreaterThan(1);
    const loaded = await reload(await savePDF(doc));
    expect(loaded.getPageCount()).toBe(3 + pages.length);
    expect(pageText(loaded.getPage(pages.length - 1))).toContain('Entry 90');
  });

  it('still produces a page for an outline with no targets', async () => {
    const doc = await blankDoc(2);
    const pages = await generateTocPage(doc, { nodes: [{ title: 'Notes', page: null }] });
    const loaded = await reload(await savePDF(doc));
    expect(pageText(loaded.getPage(0))).toContain('Notes');
    expect(linkTargets(loaded.getPage(0), loaded)).toEqual([]);
    expect(pages.length).toBe(1);
  });
});

describe('addBatesNumbers', () => {
  const base = {
    format: 'ACME-{n}',
    start: 1000,
    increment: 10,
    sequenceDigits: 6,
    fontSize: 9,
    color: '#000000',
    position: 'bottom-right',
    pages: 'all',
  };

  it('stamps a padded, incrementing sequence on every page', async () => {
    const doc = await blankDoc(3);
    const result = await addBatesNumbers(doc, base);
    expect(result).toEqual({ stamped: 3, unknownTokens: [] });

    const loaded = await reload(await savePDF(doc));
    expect(pageText(loaded.getPage(0))).toContain('ACME-001000');
    expect(pageText(loaded.getPage(1))).toContain('ACME-001010');
    expect(pageText(loaded.getPage(2))).toContain('ACME-001020');
  });

  it('supports {org} {page} {total} {date} {time} and prefix/suffix', async () => {
    const doc = await blankDoc(2);
    doc.setAuthor('Ω ACME Ω');
    const result = await addBatesNumbers(doc, {
      ...base,
      format: '{org}/{n}-p{page}of{total} {date} {time} {foo}',
      prefix: 'BATES:',
      suffix: 'END',
    });
    expect(result.unknownTokens).toEqual(['{foo}']);
    const loaded = await reload(await savePDF(doc));
    const text = pageText(loaded.getPage(0));
    expect(text).toContain('BATES:');
    expect(text).toContain('-p1of2');
    expect(text).toContain('{foo}'); // typo preserved for the operator to see
    expect(text).toContain('END');
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).toMatch(/\d{2}:\d{2}/);
  });

  it('honours a page selection, unitOffset and crossDocument', async () => {
    const doc = await blankDoc(6);
    const selected = await addBatesNumbers(doc, { ...base, pages: '2,4-6' });
    expect(selected.stamped).toBe(4);
    const loaded = await reload(await savePDF(doc));
    expect(pageText(loaded.getPage(0))).toBe('');
    expect(pageText(loaded.getPage(1))).toContain('ACME-001000');
    expect(pageText(loaded.getPage(3))).toContain('ACME-001020');

    const units = await blankDoc(4);
    await addBatesNumbers(units, { ...base, unitOffset: 2 });
    const unitsLoaded = await reload(await savePDF(units));
    expect(pageText(unitsLoaded.getPage(0))).toContain('ACME-001000');
    expect(pageText(unitsLoaded.getPage(1))).toContain('ACME-001000');
    expect(pageText(unitsLoaded.getPage(2))).toContain('ACME-001010');

    const cross = await blankDoc(5);
    await addBatesNumbers(cross, { ...base, pages: '3-5', crossDocument: true });
    const crossLoaded = await reload(await savePDF(cross));
    expect(pageText(crossLoaded.getPage(2))).toContain('ACME-001020');
    expect(pageText(crossLoaded.getPage(3))).toContain('ACME-001030');
  });

  it('places the stamp from the named anchor, including rotated pages', async () => {
    const doc = await blankDoc(3);
    doc.getPage(0).setWidth(300);
    doc.getPage(0).setHeight(200);
    doc.getPage(1).setWidth(300);
    doc.getPage(1).setHeight(200);
    doc.getPage(1).setRotation(degrees(90));
    await addBatesNumbers(doc, { ...base, format: '{n}', position: 'top-left' });
    await addBatesNumbers(doc, { ...base, format: 'R{n}', position: 'bottom-right,72,48' });

    const loaded = await reload(await savePDF(doc));
    const topLeft = rawContent(loaded.getPage(0));
    // 72pt from the left, 200 - 48 - 9pt tall text from the bottom of the
    // display box → y = 143 in unrotated user space.
    expect(topLeft).toMatch(/1 0 0 1 72 143 Tm/);
    const rotated = rawContent(loaded.getPage(1));
    // A page rotated 90° clockwise needs the text rotated with it: the text
    // matrix is the 90° rotation `0 1 -1 0 ...` (cos/sin are written as
    // float pairs by pdf-lib).
    expect(rotated).toMatch(/0 1 -1 0/);
    expect(pageText(loaded.getPage(2))).toContain('R001000');
    expect(pageText(loaded.getPage(1))).toContain('R001010');
  });

  it('rejects an empty page selection with the shared page-spec error', async () => {
    const doc = await blankDoc(2);
    await expect(addBatesNumbers(doc, { ...base, pages: '9' })).rejects.toThrow(
      /this document has 2 pages/,
    );
  });
});
