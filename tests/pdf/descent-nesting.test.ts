/**
 * The nesting the two reader-sweep tickets were made of, pinned shape by shape.
 *
 * `docs/research/reader-sweep-reconciliation.md` recorded two defects that turned out to
 * be one bug: a walk that stops where it should descend. `listFonts` / `listImages` read
 * the page's `/Resources` and never entered a `/Subtype /Form` XObject; `inspectScript` /
 * `stripScript` read a JavaScript name tree's own `/Names` array and never entered its
 * `/Kids`. Both now run on **one** descent — `core/tree.descend`, reached through
 * `resourceScopes` for a resource graph and `collectTreePairs` for a name tree.
 *
 * This file is the half of the proof the foreign fixtures cannot carry:
 *
 * - **the kernel's own rules** — pre-order, one visit per dictionary, a cycle that
 *   terminates, a bound that stops the walk rather than the tab;
 * - **the spellings no producer on this box wrote** — a form with no `/Resources`
 *   (whose names come from the scope that draws it), a form that declares its
 *   sub-forms outside `/Resources`, an action stored inline in a nested `/Kids` leaf;
 * - **the claims that follow from a fixed walk** — the `view-metadata` card's font,
 *   image and attachment rows, and what survives `stripScript` in the saved bytes.
 *
 * The documents are built with this repo's writer, because the point is the walk and not
 * the bytes: `readers-sweep-foreign.test.ts` judges the same two readers against MuPDF,
 * poppler and libqpdf on files this repo did not write, including the foreign twins of
 * several shapes here (`resources-xobject.pdf`, `resources-form-in-form.pdf`,
 * `resources-inherited.pdf`, `script-names-kids-nested.pdf` and
 * `tests/fixtures/attachments/kids-tree.pdf`).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from '@maxwbh/pdf-lib';
import { context, openPDF, savePDF } from '@/lib/pdf/core/doc';
import { resourceScopes } from '@/lib/pdf/core/content';
import { asDict, collectTreePairs, descend, dictAt, followRef } from '@/lib/pdf/core/tree';
import type { DescentEdge, DescentNode } from '@/lib/pdf/core/tree';
import { listFonts, listImages, metadataReport } from '@/lib/pdf/core/metadata';
import { inspectScript, stripScript } from '@/lib/pdf/core/sanitize';

/** A foreign attachment fixture, as the bytes the generator recorded. */
const attachmentBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures/attachments', name)));

/** One page whose `/Resources` is exactly what `build` returns, drawn with `content`. */
async function onePageDoc(
  build: (doc: PDFDocument) => Record<string, unknown>,
  content = 'q Q\n',
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = context(doc);
  page.node.set(PDFName.of('Resources'), ctx.obj(build(doc)));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(content, {})));
  return doc;
}

/** Every `/Resources` dictionary of this document's first page, in walk order. */
const scopesOfFirstPage = (doc: PDFDocument): string[] =>
  resourceScopes(doc, doc.getPages()[0]).map((scope) => scope.via);

/** A `/Subtype /Form` stream, indirect, with `resources` as its `/Resources` (`null` = none). */
function form(
  doc: PDFDocument,
  resources: Record<string, unknown> | PDFDict | null,
  content = 'q Q\n',
) {
  const ctx = context(doc);
  const dict: Record<string, unknown> = { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200] };
  if (resources) dict.Resources = resources instanceof PDFDict ? resources : ctx.obj(resources);
  return ctx.register(ctx.stream(content, dict));
}

/** A font dictionary carrying only what `listFonts` reports. */
function face(doc: PDFDocument, base: string): PDFDict {
  return context(doc).obj({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: PDFName.of(base),
  }) as PDFDict;
}

/** An indirect image XObject, stored under its own payload so rows can be read back. */
function raster(doc: PDFDocument, payload: string) {
  const ctx = context(doc);
  return ctx.register(ctx.flateStream(payload, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 2,
    Height: 2,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
  }));
}

/** Every printable string in a file, with each Flate stream inflated first. */
const visibleText = (input: Uint8Array): string => {
  const latin = new TextDecoder('latin1').decode(input);
  let all = new TextDecoder('utf-8', { fatal: false }).decode(input);
  const pattern = /stream\r?\n?/g;
  let match: RegExpExecArray | null = pattern.exec(latin);
  while (match) {
    const from = match.index + match[0].length;
    const to = latin.indexOf('endstream', from);
    try {
      all += `\n${new TextDecoder().decode(inflateSync(input.subarray(from, to === -1 ? undefined : to)))}`;
    } catch {
      // Not a deflate stream: its bytes are already inside `all`.
    }
    match = pattern.exec(latin);
  }
  return all;
};

/** Follow one `next`/`Links` dictionary, the way a reader follows a tree's `/Kids`. */
const linksOf = (doc: PDFDocument, key: string) => (node: DescentNode): DescentEdge[] => {
  const held = asDict(followRef(doc, node.dict.get(PDFName.of(key))));
  if (!held) return [];
  return [...held.entries()].map(([name, value]) => ({
    name: `${key}/${name.asString().slice(1)}`,
    value,
  }));
};

describe('the descent both readers share', () => {
  it('is pre-order, visits each dictionary once, and ends a cycle', async () => {
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const child = ctx.obj({ tag: 'child' }) as PDFDict;
    const shared = ctx.obj({ tag: 'shared' }) as PDFDict;
    const root = ctx.obj({ tag: 'root' }) as PDFDict;
    // `root → child → root` is the cycle; `shared` hangs on two names at once, which
    // is a form drawn twice and a logo named twice and one dictionary either way.
    child.set(PDFName.of('Links'), ctx.obj({ up: root }));
    root.set(PDFName.of('Links'), ctx.obj({ a: child, b: shared, c: shared }));

    const nodes = descend(doc, root, linksOf(doc, 'Links'));
    expect(nodes.map((node) => node.via)).toEqual(['', 'Links/a', 'Links/b']);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 1]);
    expect(nodes[2].dict).toBe(shared);
  });

  it('stops at the bound instead of following an unbounded graph', async () => {
    // Five dictionaries deep, a bound of two: the walk reports the three it may read
    // and nothing about the two below, which is what makes the card's silence honest.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const chain = [1, 2, 3, 4, 5].map(() => ctx.obj({}) as PDFDict);
    chain.forEach((node, index) => {
      if (index + 1 < chain.length) node.set(PDFName.of('next'), ctx.obj({ on: chain[index + 1] }));
    });
    const nodes = descend(doc, chain[0], linksOf(doc, 'next'), 2);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 2]);
    expect(nodes.map((node) => node.via)).toEqual(['', 'next/on', 'next/on/next/on']);
  });

  it('walks a name tree whose kid points back at its parent', async () => {
    // The shape that hung the first `/PageLabels` fix: a kid naming its own parent.
    // Each pair is reported once, in document order, and the walk returns.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const root = ctx.obj({}) as PDFDict;
    const entries = ctx.obj([
      PDFString.of('Fold'), ctx.obj({ S: 'JavaScript' }),
      PDFString.of('Startup'), ctx.obj({ S: 'JavaScript' }),
    ]);
    const leaf = ctx.obj({
      Limits: ctx.obj([PDFString.of('Fold'), PDFString.of('Startup')]),
      Names: entries,
    }) as PDFDict;
    root.set(PDFName.of('Kids'), ctx.obj([leaf]));
    leaf.set(PDFName.of('Kids'), ctx.obj([root]));
    const pairs = collectTreePairs(doc, root);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((pair) => (pair.key as PDFString).decodeText())).toEqual(['Fold', 'Startup']);
    // Both pairs come from the same array, which is what lets a removal splice exactly
    // one entry out of the tree it came from.
    expect(pairs[0].host).toBe(pairs[1].host);
  });
});

describe('resourceScopes — the graph a page draws from', () => {
  it('enters a form and names the scope by the entry that reaches it', async () => {
    // The `resources-xobject.pdf` shape, built here so the chain is visible: the
    // outside walk records `form-xobject:/Fm0`, this one records `XObject/Fm0`.
    const doc = await onePageDoc((self) => ({
      Font: { F1: face(self, 'OnThePage') },
      XObject: { Fm0: form(self, { Font: { F1: face(self, 'InForm') } }) },
    }));
    expect(scopesOfFirstPage(doc)).toEqual(['page', 'XObject/Fm0']);
    expect(listFonts(doc).map((font) => font.name).sort()).toEqual(['InForm', 'OnThePage']);
  });

  it('descends a form inside a form', async () => {
    const doc = await onePageDoc((self) => ({
      XObject: {
        Fm0: form(self, {
          XObject: { Inner: form(self, { XObject: { Im0: raster(self, 'inner-pixels') } }) },
        }),
      },
    }));
    expect(scopesOfFirstPage(doc)).toEqual([
      'page', 'XObject/Fm0', 'XObject/Fm0/XObject/Inner',
    ]);
    expect(listImages(doc).map((image) => image.pages)).toEqual([[1]]);
  });

  it('takes the enclosing resources for a form that declares none — and lists them once', async () => {
    // §8.10.1: a form written without `/Resources` uses the names of the scope that
    // draws it, which this walk has already visited. Handing that dictionary back is
    // deliberate — walking it a second time would report the same face and raster
    // twice, and "2 images" over a file that holds one is a claim the bytes deny.
    const doc = await onePageDoc((self) => ({
      Font: { F1: face(self, 'InheritedByForm') },
      XObject: { Fm0: form(self, null) },
    }));
    expect(scopesOfFirstPage(doc)).toEqual(['page']);
    expect(listFonts(doc).map((font) => font.name)).toEqual(['InheritedByForm']);
  });

  it('does not inventory names a form keeps outside /Resources', async () => {
    // A form whose own stream dictionary declares `/XObject` is a producer error no
    // viewer resolves from there. `core/compress.ts` tolerates the spelling when it
    // re-encodes pixels — a rewrite cannot make the file wrong — but a card that
    // listed this raster would tell the user the page draws a picture it never draws.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const bareForm = ctx.register(ctx.stream('q /Im0 Do Q\n', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200],
    }));
    ctx.lookup(bareForm, PDFRawStream).dict.set(PDFName.of('XObject'), ctx.obj({
      Im0: raster(doc, 'unreachable'),
    }));
    const page = doc.addPage([200, 200]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Fm0: bareForm } }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q /Fm0 Do Q\n', {})));
    expect(scopesOfFirstPage(doc)).toEqual(['page']);
    expect(listImages(doc)).toEqual([]);
  });

  it('resolves resources inherited from the page tree, not just from the page', async () => {
    // §7.7.3.3, on the shape `resources-inherited.pdf` holds: the leaf names nothing
    // and its `/Parent` carries the dictionary.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const page = doc.addPage([200, 200]);
    dictAt(doc, doc.catalog, 'Pages')?.set(PDFName.of('Resources'),
      ctx.obj({ Font: { F1: face(doc, 'FromThePageTree') } }));
    // `addPage` gives a leaf its own empty `/Resources`; the shape here is one that
    // names no `/Resources` at all.
    page.node.delete(PDFName.of('Resources'));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q Q\n', {})));
    expect(page.node.get(PDFName.of('Resources'))).toBeUndefined();
    expect(resourceScopes(doc, page).map((scope) => scope.via)).toEqual(['page']);
    expect(listFonts(doc).map((font) => font.name)).toEqual(['FromThePageTree']);
  });

  it('lists one image named twice on a sheet as one image on that sheet', async () => {
    const doc = await onePageDoc((self) => {
      const shared = raster(self, 'one-picture');
      return { XObject: { A: shared, B: shared } };
    });
    expect(listImages(doc)).toHaveLength(1);
    expect(listImages(doc)[0].pages).toEqual([1]);
  });

  it('reports a form drawn by two pages once, against both sheets', async () => {
    // The descent is per page, so the object is deduplicated while the page list is
    // not — which is how `resources-shared.pdf` reads from outside.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const inner = form(doc, { XObject: { Im0: raster(doc, 'logo') } });
    const resources = ctx.obj({ XObject: { Fm0: inner } });
    for (let sheet = 0; sheet < 2; sheet++) {
      const page = doc.addPage([200, 200]);
      page.node.set(PDFName.of('Resources'), resources);
      page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('q /Fm0 Do Q\n', {})));
    }
    const images = listImages(doc);
    expect(images).toHaveLength(1);
    expect(images[0].pages).toEqual([1, 2]);
    expect(doc.getPages().map((page) => resourceScopes(doc, page).length)).toEqual([2, 2]);
  });
});

describe('what a fixed walk lets the app say', () => {
  it('the view-metadata card lists the faces and rasters a form carries', async () => {
    const doc = await onePageDoc((self) => ({
      XObject: {
        Fm0: form(self, {
          Font: { F1: face(self, 'CarriedByForm') },
          XObject: { Im0: raster(self, 'form-pixels') },
        }),
      },
    }));
    const sections = metadataReport(doc, await savePDF(doc));
    const fonts = sections.find((section) => section.title === 'Fonts');
    const images = sections.find((section) => section.title === 'Images');
    expect(fonts?.rows).toEqual([{
      label: 'CarriedByForm',
      value: 'Type1 · not embedded — substituted on screen',
    }]);
    // The two sentences this card printed before the descent existed, pinned absent.
    expect(images?.rows[0]?.label).toBe('2 × 2 px');
    expect(JSON.stringify(images)).not.toMatch(/no raster images are embedded/);
    expect(JSON.stringify(fonts)).not.toMatch(/no fonts in this PDF/);
  });

  it('the card counts embedded files that sit behind a /Kids tree', async () => {
    // `tests/fixtures/attachments/kids-tree.pdf`: two files, one per kid, written by
    // libqpdf. The card used to print "Attachments: 0" beside a listing of both.
    const doc = await openPDF(attachmentBytes('kids-tree.pdf'),
      { updateMetadata: false, ignoreEncryption: true });
    // `metadataReport` needs a `/Info` to read; this file has none, which is the open
    // seam `docs/research/reader-sweep-reconciliation.md` records rather than a defect
    // of the count, so the dictionary is supplied by hand.
    doc.context.trailerInfo.Info = doc.context.register(PDFDict.withContext(doc.context));
    const sections = metadataReport(doc, attachmentBytes('kids-tree.pdf'));
    const row = sections.find((section) => section.title === 'File')?.rows
      .find((entry) => entry.label === 'Attachments');
    expect(row).toEqual({ label: 'Attachments', value: '2' });
  });

  it('stripScript reaches an inline action in a nested /Kids leaf', async () => {
    // The byte that survived `stripScript` on `script-names-kids.pdf`: the action is
    // stored **inside** the leaf's `/Names` array, so it has no object number and the
    // indirect sweep never enumerates it. Only the tree walk can empty it.
    const doc = await PDFDocument.create();
    const ctx = context(doc);
    const inline = ctx.obj({ S: 'JavaScript', JS: PDFString.of('console.clear();') });
    const leaf = ctx.obj({
      Limits: ctx.obj([PDFString.of('Fold'), PDFString.of('Startup')]),
      Names: ctx.obj([PDFString.of('Fold'), inline]),
    });
    const middle = ctx.register(ctx.obj({ Kids: ctx.obj([leaf]) }));
    doc.catalog.set(PDFName.of('Names'),
      ctx.obj({ JavaScript: ctx.obj({ Kids: ctx.obj([middle]) }) }));

    const report = inspectScript(doc);
    expect(report.present).toBe(1);
    expect(report.places).toEqual(['the JavaScript name tree']);

    expect(stripScript(doc).removed).toBe(1);
    const saved = await savePDF(doc, { useObjectStreams: false });
    expect(visibleText(saved)).not.toContain('console.clear');
    const again = await openPDF(saved, { updateMetadata: false, ignoreEncryption: true });
    expect(inspectScript(again).present).toBe(0);
    // The pointer is gone, not merely the code it carried: `/Names » /JavaScript` is
    // what tells a viewer to look, and an emptied action behind a live pointer is the
    // half-measure this module's header names explicitly. The action's own `/JS` was
    // emptied in the same pass — pdf-lib writes every registered object, so a leaf
    // nobody reaches can still sit in the file; what must not sit there is the code.
    const names = asDict(followRef(again, again.catalog.get(PDFName.of('Names'))));
    expect(names?.get(PDFName.of('JavaScript'))).toBeUndefined();
  });
});
