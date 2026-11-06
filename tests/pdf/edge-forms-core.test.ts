/**
 * Edge cases for the core modules that read *names* out of a document:
 * `core/forms` (field labels), `core/layers` (optional content group names) and
 * `core/images` (the size of a decoded TIFF page).
 *
 * All three were broken in the same way — the value the module reached for is
 * not the value the file (or the library) actually carries:
 *
 * * `listFormFields` asked the field dict for `/TU` **by class**, which throws
 *   when the key is absent, and most real forms never write one (E13).
 * * `core/layers` read `/Name` with `String(...)`, so a name written as a PDF
 *   name came back escaped (`Revision#20B`), a hex string came back as its own
 *   hex digits (`<FEFF0052…>`), and a byte the encoding could not name came
 *   back as U+FFFD.
 * * `core/images` read `ifd.w` / `ifd.h`, which UTIF never sets — it publishes
 *   `width` / `height` — so every imported TIFF decoded to a 0 × 0 canvas (E12).
 *
 * What is real: documents are built with `@maxwbh/pdf-lib`, saved and reloaded
 * from bytes, and read back through the modules under test. TIFF fixtures are
 * written by hand in this file (baseline RGB, uncompressed strips) so the
 * expectations do not depend on the app's own encoder.
 *
 * What is stubbed: jsdom has no 2-D raster, so `getContext('2d')` is backed by
 * a pixel buffer of the canvas's own size — enough to prove the size and the
 * colour that reached the canvas.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from '@maxwbh/pdf-lib';
import UTIF from 'utif';
import { createFormField, fillForm, listFormFields } from '@/lib/pdf/core/forms';
import {
  addLayer,
  deleteLayer,
  listLayers,
  renameLayer,
  setLayerVisibility,
} from '@/lib/pdf/core/layers';
import { decodeImage, decodeImagePages, tiffPageDimensions } from '@/lib/pdf/core/images';

const FIELD_RECT = { x: 40, y: 700, width: 120, height: 20 };

/**
 * What `listFormFields` reports for `FIELD_RECT`: `createFormField` strokes a
 * 0.5 pt border, and pdf-lib folds that border into the widget rectangle.
 */
const WIDGET_RECT = { x: 39.75, y: 699.75, width: 120.5, height: 20.5 };

async function onePageDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 700]);
  return doc;
}

/** Save and re-open, so the assertions run against real bytes. */
async function reload(doc: PDFDocument): Promise<PDFDocument> {
  const bytes = await doc.save({ useObjectStreams: false });
  return PDFDocument.load(bytes, { updateMetadata: false });
}

// ── forms ────────────────────────────────────────────────────────────────────

describe('core/forms — listFormFields on forms that barely describe themselves (E13)', () => {
  it('lists a field that has no /TU instead of throwing', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q1', rect: FIELD_RECT });

    const fields = listFormFields(doc);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      name: 'q1',
      alternateName: 'q1',
      type: 'text',
      page: 0,
      rect: WIDGET_RECT,
    });
  });

  it('still lists it after a save/reload round trip, with no /TU in the file', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q1', rect: FIELD_RECT });
    const again = await reload(doc);
    const dict = again.getForm().getFields()[0].acroField.dict;

    expect(dict.has(PDFName.of('TU'))).toBe(false);
    expect(listFormFields(again).map((field) => [field.name, field.alternateName])).toEqual([
      ['q1', 'q1'],
    ]);
  });

  it('prefers /TU when the form does carry one, including non-Latin labels', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q2', label: '名前 / Nombre', rect: FIELD_RECT });
    const again = await reload(doc);

    const [field] = listFormFields(again);
    expect(field.name).toBe('q2');
    expect(field.alternateName).toBe('名前 / Nombre');
  });

  it('lists a field that has neither /TU nor /T, rather than losing it', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'checkbox', name: 'anon', rect: FIELD_RECT });
    const dict = doc.getForm().getFields()[0].acroField.dict;
    dict.delete(PDFName.of('T'));
    dict.delete(PDFName.of('TU'));

    const fields = listFormFields(doc);

    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('');
    expect(fields[0].alternateName).toBeUndefined();
    // The geometry and the toggle state are still worth showing.
    expect(fields[0]).toMatchObject({ type: 'checkbox', page: 0, rect: WIDGET_RECT });
  });

  it('survives a /TU that is not a text string (the lookup-by-class trap)', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q3', rect: FIELD_RECT });
    const dict = doc.getForm().getFields()[0].acroField.dict;
    dict.set(PDFName.of('TU'), PDFName.of('Not_A_Text_String'));
    dict.set(PDFName.of('Da'), PDFNumber.of(7));

    const [field] = listFormFields(doc);
    expect(field.name).toBe('q3');
    expect(field.alternateName).toBe('q3');
  });

  it('resolves an indirect /TU instead of reporting the reference', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q4', rect: FIELD_RECT });
    const field = doc.getForm().getFields()[0];
    const tip = doc.context.register(PDFHexString.fromText('Your answer'));
    field.acroField.dict.set(PDFName.of('TU'), tip);

    expect(listFormFields(doc)[0].alternateName).toBe('Your answer');
  });

  it('lists every field of a nested form and names them from the /T tree', async () => {
    const doc = await onePageDoc();
    addNestedTextField(doc);

    const fields = listFormFields(doc);
    const child = fields.find((field) => field.name === 'Contact.Name');

    // The `Contact` node has no /FT, so pdf-lib hands back only the fillable
    // leaf — but the leaf must not be lost, and it must be findable by name.
    expect(fields.map((field) => field.name)).toEqual(['Contact.Name']);
    expect(child).toBeDefined();
    // No /TU anywhere: the label comes from the /T tree, and the widget still
    // says which page and rectangle the field lives on.
    expect(child?.alternateName).toBe('Contact.Name');
    expect(child?.page).toBe(0);
    expect(child?.rect).toEqual({ x: 40, y: 640, width: 120, height: 20 });
  });

  it('keeps addressing fields by their /T name when filling', async () => {
    const doc = await onePageDoc();
    createFormField(doc, 0, { type: 'text', name: 'q5', rect: FIELD_RECT });

    expect(fillForm(doc, { q5: 'still works' })).toEqual({ filled: 1, missing: [] });
    expect(listFormFields(doc)[0].value).toBe('still works');
  });
});

/** Hand-built `Contact` → `Contact.Name` text field with one widget. */
function addNestedTextField(doc: PDFDocument): void {
  const context = doc.context;
  const page = doc.getPage(0);
  const parent = context.obj({ T: PDFHexString.fromText('Contact') }) as PDFDict;
  const parentRef = context.register(parent);
  const child = context.obj({
    T: PDFHexString.fromText('Name'),
    FT: PDFName.of('Tx'),
    Parent: parentRef,
  }) as PDFDict;
  const childRef = context.register(child);
  const widget = context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: context.obj([40, 640, 160, 660]),
    Parent: childRef,
  }) as PDFDict;
  const widgetRef = context.register(widget);
  parent.set(PDFName.of('Kids'), context.obj([childRef]) as PDFArray);
  child.set(PDFName.of('Kids'), context.obj([widgetRef]) as PDFArray);
  page.node.addAnnot(widgetRef);

  const fields = doc.getForm().acroForm.dict.get(PDFName.of('Fields'));
  expect(fields).toBeInstanceOf(PDFArray);
  (fields as PDFArray).push(parentRef);
}

// ── layers ───────────────────────────────────────────────────────────────────

describe('core/layers — layer names the user can read (E11, E13)', () => {
  it('reports the name it was given, in memory and from the saved bytes', async () => {
    const doc = await onePageDoc();
    addLayer(doc, 'Revision B');
    addLayer(doc, 'Dimension #7');

    const typed = listLayers(doc).map((layer) => layer.name);
    expect(typed).toEqual(['Revision B', 'Dimension #7']);

    const again = await reload(doc);
    expect(listLayers(again).map((layer) => layer.name)).toEqual(['Revision B', 'Dimension #7']);
  });

  it('matches show / hide / rename / delete on the typed name', async () => {
    const doc = await onePageDoc();
    addLayer(doc, 'Revision B');
    addLayer(doc, 'Ghost layer', { on: false });

    expect(setLayerVisibility(doc, 'revision b', false)).toBe(true);
    expect(setLayerVisibility(doc, 'Ghost layer', true)).toBe(true);
    expect(renameLayer(doc, 'Ghost layer', 'Ghost Town')).toBe(true);
    expect(deleteLayer(doc, 'Revision B')).toBe(true);

    const again = await reload(doc);
    expect(listLayers(again).map((layer) => [layer.name, layer.on])).toEqual([['Ghost Town', true]]);
  });

  it('decodes a name stored as a PDF name (the legacy escape form)', async () => {
    const doc = await onePageDoc();
    const ocg = doc.context.obj({ Type: 'OCG', Name: PDFName.of('Revision B #5') });
    attachOcg(doc, ocg);

    const [layer] = listLayers(doc);
    expect(layer.name).toBe('Revision B #5');
    expect(layer.name).not.toContain('#20');
  });

  it('decodes PDFDocEncoding and UTF-16 text strings, with no BOM left over', async () => {
    const doc = await onePageDoc();
    attachOcg(doc, doc.context.obj({ Type: 'OCG', Name: PDFString.of('Caf\xe9 Layer') }));
    attachOcg(doc, doc.context.obj({ Type: 'OCG', Name: PDFHexString.fromText('图层 Rev') }));
    attachOcg(doc, doc.context.obj({ Type: 'OCG', Name: PDFHexString.fromText('Текст') }));

    expect(listLayers(doc).map((layer) => layer.name)).toEqual(['Café Layer', '图层 Rev', 'Текст']);
    for (const layer of listLayers(doc)) {
      expect(layer.name).not.toContain('\uFEFF');
      expect(layer.name).not.toContain('\uFFFD');
    }
  });

  it('never shows the U+FFFD sentinel: a name nothing can be made of falls back', async () => {
    const doc = await onePageDoc();
    // UTF-16BE: a BOM then one lone high surrogate — nothing to decode.
    attachOcg(doc, doc.context.obj({ Type: 'OCG', Name: PDFHexString.of('FEFFD800') }));
    attachOcg(doc, doc.context.obj({ Type: 'OCG', Name: PDFString.of('') }));

    const names = listLayers(doc).map((layer) => layer.name);
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toMatch(/^Layer \d+$/);
    }
  });

  it('reads a layers dictionary whose lists are indirect objects', async () => {
    const doc = await onePageDoc();
    const context = doc.context;
    const ocg = context.obj({ Type: 'OCG', Name: PDFHexString.fromText('Site plan') });
    const ocgRef = context.register(ocg);
    const config = context.register(
      context.obj({ ON: context.obj([ocgRef]), OFF: context.obj([]), Order: context.obj([ocgRef]) }),
    );
    const properties = context.register(
      context.obj({ OCGs: context.obj([ocgRef]), D: config }),
    );
    doc.catalog.set(PDFName.of('OCProperties'), properties);

    expect(listLayers(doc)).toEqual([
      { name: 'Site plan', xref: ocgRef.objectNumber, on: true, intent: undefined, usage: undefined, parentXref: undefined },
    ]);
  });

  it('reports no layers at all for a document without optional content (E13)', async () => {
    const doc = await onePageDoc();
    expect(listLayers(doc)).toEqual([]);
    expect(setLayerVisibility(doc, 'Anything', false)).toBe(false);
    expect(deleteLayer(doc, 'Anything')).toBe(false);
  });
});

/** Add one OCG dict to a fresh `/OCProperties`, visible by default. */
function attachOcg(doc: PDFDocument, ocg: PDFDict): void {
  const context = doc.context;
  const ref = context.register(ocg);
  const existing = context.lookup(doc.catalog.get(PDFName.of('OCProperties')));
  let properties = existing instanceof PDFDict ? existing : undefined;
  if (!properties) {
    properties = context.obj({}) as PDFDict;
    doc.catalog.set(PDFName.of('OCProperties'), context.register(properties));
  }
  let groups = context.lookup(properties.get(PDFName.of('OCGs')));
  if (!(groups instanceof PDFArray)) {
    groups = context.obj([]) as PDFArray;
    properties.set(PDFName.of('OCGs'), groups);
  }
  groups.push(ref);
  let config = context.lookup(properties.get(PDFName.of('D')));
  if (!(config instanceof PDFDict)) {
    config = context.obj({}) as PDFDict;
    properties.set(PDFName.of('D'), config);
  }
  let on = context.lookup(config.get(PDFName.of('ON')));
  if (!(on instanceof PDFArray)) {
    on = context.obj([]) as PDFArray;
    config.set(PDFName.of('ON'), on);
  }
  on.push(ref);
}

// ── images ───────────────────────────────────────────────────────────────────

describe('core/images — the size a decoded TIFF really has (E12, E15)', () => {
  it('reads the dimensions UTIF publishes, not the ones it never sets', () => {
    const bytes = buildTiff([{ width: 4, height: 2, pixel: [10, 200, 30] }]);
    const [ifd] = UTIF.decode(toArrayBuffer(bytes));

    // The ambient `UtifIFD` type claims `w` / `h`; the library has never set them.
    expect((ifd as { w?: unknown }).w).toBeUndefined();
    expect((ifd as { h?: unknown }).h).toBeUndefined();
    // Raw tags are enough before the pixels are touched, so a size can be
    // reported without decoding a huge image (E12).
    expect(tiffPageDimensions(ifd)).toEqual({ width: 4, height: 2 });

    UTIF.decodeImage(toArrayBuffer(bytes), ifd);
    expect(tiffPageDimensions(ifd)).toEqual({ width: 4, height: 2 });
  });

  it('reports an unstated size as null rather than 0 (E15)', () => {
    expect(tiffPageDimensions({})).toEqual({ width: null, height: null });
    expect(tiffPageDimensions(null)).toEqual({ width: null, height: null });
    expect(tiffPageDimensions({ width: 0, height: 7 })).toEqual({ width: null, height: 7 });
    expect(tiffPageDimensions({ t256: [8], t257: [] })).toEqual({ width: 8, height: null });
    expect(tiffPageDimensions({ width: '12', height: Number.NaN })).toEqual({ width: 12, height: null });
  });

  it('decodes a TIFF at its real size and paints its real pixels', async () => {
    const decoded = await decodeImage(buildTiff([{ width: 4, height: 2, pixel: [10, 200, 30] }]));

    expect([decoded.width, decoded.height]).toEqual([4, 2]);
    expect([decoded.canvas.width, decoded.canvas.height]).toEqual([4, 2]);
    expect(pixelOf(decoded.canvas, 0, 0)).toEqual([10, 200, 30, 255]);
  });

  it('decodes every page of a multi-page TIFF at its own size', async () => {
    const pages = await decodeImagePages(
      buildTiff([
        { width: 4, height: 2, pixel: [10, 200, 30] },
        { width: 3, height: 5, pixel: [200, 10, 30] },
      ]),
    );

    expect(pages.map((page) => [page.width, page.height])).toEqual([[4, 2], [3, 5]]);
    expect(pixelOf(pages[1].canvas, 2, 4)).toEqual([200, 10, 30, 255]);
  });

  it('refuses a page that records no size instead of returning a 0 × 0 canvas', async () => {
    const bytes = buildTiff([{ width: null, height: null, pixel: [1, 2, 3] }]);
    await expect(decodeImage(bytes)).rejects.toThrow(/does not record a width and height/i);
    await expect(decodeImagePages(buildTiff([
      { width: 2, height: 2, pixel: [1, 2, 3] },
      { width: null, height: null, pixel: [1, 2, 3] },
    ]))).rejects.toThrow(/page 2/i);
  });

  it('clamps an out-of-range maxSide to "keep the real size" (E15)', async () => {
    const bytes = () => buildTiff([{ width: 4, height: 2, pixel: [10, 200, 30] }]);

    expect(sizeOf(await decodeImage(bytes(), { maxSide: 2 }))).toEqual([2, 1]);
    expect(sizeOf(await decodeImage(bytes(), { maxSide: 0 }))).toEqual([4, 2]);
    expect(sizeOf(await decodeImage(bytes(), { maxSide: -10 }))).toEqual([4, 2]);
    expect(sizeOf(await decodeImage(bytes(), { maxSide: Number.NaN }))).toEqual([4, 2]);
    expect(sizeOf(await decodeImage(bytes(), { maxSide: 4000 }))).toEqual([4, 2]);
  });
});

// ── fixtures: baseline RGB TIFF, written here so nothing is taken on trust ───

interface TiffPage {
  width: number | null;
  height: number | null;
  pixel: [number, number, number];
}

function buildTiff(pages: TiffPage[]): Uint8Array {
  interface Plan { strip: number; stripLength: number; bits: number; ifd: number; entries: number[][] }
  const plans: Plan[] = [];
  let cursor = 8;
  for (const page of pages) {
    const width = page.width ?? 0;
    const height = page.height ?? 0;
    const stripLength = width * height * 3;
    const plan: Plan = { strip: cursor, stripLength, bits: cursor + stripLength, ifd: 0, entries: [] };
    cursor += stripLength + 6;
    if (page.width !== null) plan.entries.push([256, 3, 1, page.width]);
    if (page.height !== null) plan.entries.push([257, 3, 1, page.height]);
    plan.entries.push(
      [258, 3, 3, plan.bits],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 3, 1, plan.strip],
      [277, 3, 1, 3],
      [278, 3, 1, Math.max(1, height)],
      [279, 4, 1, stripLength],
      [284, 3, 1, 1],
    );
    plan.entries.sort((a, b) => a[0] - b[0]);
    plan.ifd = cursor;
    cursor += 2 + plan.entries.length * 12 + 4;
    plans.push(plan);
  }

  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49;
  bytes[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, plans[0].ifd, true);
  plans.forEach((plan, index) => {
    for (let at = 0; at < plan.stripLength; at += 3) {
      bytes[plan.strip + at] = pages[index].pixel[0];
      bytes[plan.strip + at + 1] = pages[index].pixel[1];
      bytes[plan.strip + at + 2] = pages[index].pixel[2];
    }
    view.setUint16(plan.bits, 8, true);
    view.setUint16(plan.bits + 2, 8, true);
    view.setUint16(plan.bits + 4, 8, true);
    let off = plan.ifd;
    view.setUint16(off, plan.entries.length, true);
    off += 2;
    for (const [tag, type, count, value] of plan.entries) {
      view.setUint16(off, tag, true);
      view.setUint16(off + 2, type, true);
      view.setUint32(off + 4, count, true);
      // A value that fits the field is stored in it (little-endian).
      view.setUint32(off + 8, type === 3 ? value & 0xffff : value, true);
      off += 12;
    }
    view.setUint32(off, plans[index + 1]?.ifd ?? 0, true);
  });
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ── a canvas that holds real pixels ──────────────────────────────────────────

interface Surface { width: number; height: number; data: Uint8ClampedArray }

const surfaces = new WeakMap<HTMLCanvasElement, Surface>();

function surfaceOf(canvas: HTMLCanvasElement): Surface {
  const width = Math.max(1, canvas.width | 0);
  const height = Math.max(1, canvas.height | 0);
  let surface = surfaces.get(canvas);
  if (!surface || surface.width !== width || surface.height !== height) {
    surface = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    surfaces.set(canvas, surface);
  }
  return surface;
}

function sizeOf(decoded: { canvas: HTMLCanvasElement }): [number, number] {
  return [decoded.canvas.width, decoded.canvas.height];
}

function pixelOf(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const surface = surfaceOf(canvas);
  const at = (y * surface.width + x) * 4;
  return [surface.data[at], surface.data[at + 1], surface.data[at + 2], surface.data[at + 3]];
}

beforeAll(() => {
  if (typeof globalThis.ImageData === 'undefined') {
    class ShimImageData {
      width: number;

      height: number;

      data: Uint8ClampedArray;

      constructor(data: Uint8ClampedArray | number, width: number, height?: number) {
        if (typeof data === 'number') {
          this.width = data;
          this.height = width;
          this.data = new Uint8ClampedArray(data * width * 4);
        } else {
          this.data = data;
          this.width = width;
          this.height = height ?? Math.max(1, Math.floor(data.length / 4 / width));
        }
      }
    }
    Object.defineProperty(globalThis, 'ImageData', {
      value: ShimImageData,
      writable: true,
      configurable: true,
    });
  }

  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = function getContext(this: HTMLCanvasElement) {
    const owner = this;
    return {
      canvas: owner,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      globalAlpha: 1,
      fillRect: () => undefined,
      clearRect: () => undefined,
      getImageData: (x: number, y: number, width: number, height: number) => {
        const data = new Uint8ClampedArray(width * height * 4);
        const source = surfaceOf(owner);
        for (let row = 0; row < height; row++) {
          for (let column = 0; column < width; column++) {
            const from = ((y + row) * source.width + (x + column)) * 4;
            const to = (row * width + column) * 4;
            data[to] = source.data[from] ?? 0;
            data[to + 1] = source.data[from + 1] ?? 0;
            data[to + 2] = source.data[from + 2] ?? 0;
            data[to + 3] = source.data[from + 3] ?? 0;
          }
        }
        return { data, width, height };
      },
      putImageData: (
        image: { data: Uint8ClampedArray; width: number; height: number },
        dx: number,
        dy: number,
      ) => {
        const target = surfaceOf(owner);
        for (let row = 0; row < image.height; row++) {
          for (let column = 0; column < image.width; column++) {
            const x = dx + column;
            const y = dy + row;
            if (x < 0 || y < 0 || x >= target.width || y >= target.height) continue;
            const from = (row * image.width + column) * 4;
            const to = (y * target.width + x) * 4;
            target.data[to] = image.data[from];
            target.data[to + 1] = image.data[from + 1];
            target.data[to + 2] = image.data[from + 2];
            target.data[to + 3] = image.data[from + 3];
          }
        }
      },
      drawImage: (
        source: HTMLCanvasElement,
        dx = 0,
        dy = 0,
        dw?: number,
        dh?: number,
      ) => {
        const from = surfaces.get(source);
        if (!from) return;
        const target = surfaceOf(owner);
        const wide = dw ?? from.width;
        const high = dh ?? from.height;
        for (let row = 0; row < high; row++) {
          for (let column = 0; column < wide; column++) {
            const x = dx + column;
            const y = dy + row;
            if (x < 0 || y < 0 || x >= target.width || y >= target.height) continue;
            const sx = Math.min(from.width - 1, Math.floor((column * from.width) / wide));
            const sy = Math.min(from.height - 1, Math.floor((row * from.height) / high));
            const src = (sy * from.width + sx) * 4;
            const dst = (y * target.width + x) * 4;
            target.data[dst] = from.data[src];
            target.data[dst + 1] = from.data[src + 1];
            target.data[dst + 2] = from.data[src + 2];
            target.data[dst + 3] = from.data[src + 3];
          }
        }
      },
    };
  };
});
