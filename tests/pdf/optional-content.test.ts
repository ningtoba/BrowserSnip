/**
 * Hidden layer content, measured on the bytes.
 *
 * `sanitize-pdf` used to be able to say "12 optional content groups are still in
 * the file" and nothing else could take them out; `pdf-layers` edits which
 * layers are visible and deletes group *definitions*, leaving the drawing
 * operators behind (where they fall back to visible). This file tests the opt-in
 * that closes that gap — `sanitize-pdf` → "Remove hidden layer content" — and it
 * is written to catch **over**-removal, not just deletion:
 *
 * | claim                                                            | measured by                                       |
 * |------------------------------------------------------------------|---------------------------------------------------|
 * | with the toggle off, nothing about the page content changes       | the decoded `/Contents` bytes, before and after    |
 * | the warning still names what is in the file                      | `warnings`, plus the hidden text still extractable |
 * | with it on, the off layer's operators are gone                   | `/OC` guards, `Do` calls, pdf.js text extraction   |
 * | the on layer's operators survive                                 | the same three reads                               |
 * | a layer the file never lists is **visible**, so its ink survives | pdf.js's own group state + the raster below        |
 * | the visible page renders identical pixels                        | a raster built from pdf.js's operator list         |
 * | content another view or usage leaves visible is kept and named   | the raster with that group forced on               |
 * | an unresolvable `OCProperties` is refused, not guessed            | zero content change + the refusal sentence         |
 * | the printed sizes are the two byte lengths                       | `describeSize` of both, re-measured                |
 *
 * The raster is not a screenshot: `visibleInk` walks the operator list pdf.js
 * produces for a page, applies the visibility the *file's* optional-content
 * configuration gives each layer (read out of pdf.js, not out of this repo), and
 * paints the rectangles and text runs that survive. Forced-on rendering then
 * proves the deleted ink really was only hidden before — the difference between
 * "hidden" and "gone" is the whole point of the toggle.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRef,
  StandardFonts,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { RunOutcome } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { listLayers, removeHiddenLayerContent } from '@/lib/pdf/core/layers';
import { describeSize } from '@/lib/pdf/core/guard';

const latin1 = new TextDecoder('latin1');

/* ── harness ──────────────────────────────────────────────────────────────── */

function pdfFile(bytes: Uint8Array, name = 'drawing.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function runTool(bytes: Uint8Array, values: Record<string, unknown>): Promise<RunOutcome> {
  expect(getPdfTool('sanitize-pdf'), 'sanitize-pdf is not registered').toBeTruthy();
  const outcome = await runPdfTool({
    toolId: 'sanitize-pdf',
    files: [pdfFile(bytes)],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  expect(outcome, 'sanitize-pdf produced no outcome').toBeTruthy();
  return outcome!;
}

async function outputBytes(outcome: RunOutcome): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'expected a downloadable output').toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0]!.blob.arrayBuffer());
}

/* ── the fixture: a CAD-style export, written by hand ─────────────────────── */

/** One optional-content layer of the fixture, and the ink it draws. */
interface GroupSpec {
  name: string;
  /** Where the default configuration lists it. */
  state: 'on' | 'off' | 'unlisted' | 'both';
  /** A token only this layer's content shows, so text proves who drew it. */
  token: string;
  /** Fill colour of the rectangle this layer paints, 0..255 per channel. */
  color: [number, number, number];
  /** Extra entries written into the OCG dictionary itself. */
  ocg?: (context: PDFDocument['context'], dict: PDFDict) => void;
}

/** A rectangle of the fixture, in points, bottom-left origin. */
interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Fixture {
  bytes: Uint8Array;
  /** `xref` of each group by name, for the reader-side assertions. */
  xrefs: Map<string, number>;
  /** The ink each group paints: its rectangle and the text row under it. */
  ink: Map<string, InkBox[]>;
  /** Ink that belongs to no layer at all. */
  baseline: InkBox[];
}

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

/** Rows the fixture paints, bottom-up: baseline first, then one per layer. */
function rowFor(index: number): number {
  return 620 - index * 90;
}

/** The box a text run occupies, matching what `visibleInk` paints for one. */
function textBox(x: number, y: number, token: string, size = 14): InkBox {
  return { x, y: y - size, width: token.length * size * 0.5, height: size };
}

/** A rectangle's box in the same coordinates the raster uses (top-left rows). */
function deviceBox(box: InkBox): InkBox {
  return { x: box.x, y: PAGE_HEIGHT - box.y - box.height, width: box.width, height: box.height };
}

interface FixtureOptions {
  groups: GroupSpec[];
  /** Draw one form XObject whose `/OC` is the first `off` layer. */
  guardedForm?: boolean;
  /** Draw a span guarded by an OCMD over the first `off` and first `on` layer. */
  conditionalSpan?: boolean;
  /** Write the given named configurations into `/OCProperties /Configs`. */
  configs?: { name: string; on: string[]; off: string[] }[];
  /** Set `/BaseState` on the default configuration. */
  baseState?: 'ON' | 'OFF';
  /** Omit `/OCProperties /D` entirely. */
  noDefault?: boolean;
  /** Write a junk entry into `/ON` instead of a group reference. */
  junkOnList?: boolean;
  /** Make page 2 itself the content of the first `off` layer. */
  optionalPage?: boolean;
  /** Leave an annotation on page 1 whose `/OC` is the first `off` layer. */
  hiddenAnnotation?: boolean;
  /**
   * How the guard is written: `/OC /P0 BDC` with a `/Properties` resource map
   * (what Acrobat and CAD writers emit), `<< /OC 5 0 R >> /MC0 BDC` with the
   * property list inline, or the name form with no map to resolve it through.
   */
  guardStyle?: GuardStyle;
}

/** How the fixture writes a marked-content guard. */
type GuardStyle = 'properties' | 'inline' | 'unmapped';

/**
 * Two pages of vector ink: ungrouped, then one marked-content span per layer,
 * then (optionally) a form XObject and an OCMD span. Every guard is written the
 * way Acrobat and CAD writers emit them — `/OC /P0 BDC` with the property list
 * resolved through the page's `/Properties` resources.
 */
async function layeredFixture(options: FixtureOptions): Promise<Fixture> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const context = doc.context;
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ink = new Map<string, InkBox[]>();
  const xrefs = new Map<string, number>();

  const refs = new Map<string, PDFRef>();
  for (const group of options.groups) {
    const dict = context.obj({ Type: 'OCG', Name: PDFHexString.fromText(group.name) }) as PDFDict;
    group.ocg?.(context, dict);
    const ref = context.register(dict);
    refs.set(group.name, ref);
    xrefs.set(group.name, ref.objectNumber);
  }

  const onList = context.obj([]) as PDFArray;
  const offList = context.obj([]) as PDFArray;
  for (const group of options.groups) {
    const ref = refs.get(group.name)!;
    if (group.state === 'on' || group.state === 'both') onList.push(ref);
    if (group.state === 'off' || group.state === 'both') offList.push(ref);
  }
  if (options.junkOnList) onList.push(PDFName.of('NotALayer'));

  const defaultConfig = context.obj({
    ON: onList,
    OFF: offList,
    Order: context.obj([...refs.values()]),
    Intent: context.obj([PDFName.of('View')]),
    ...(options.baseState ? { BaseState: PDFName.of(options.baseState) } : {}),
  }) as PDFDict;
  const properties = context.obj({
    OCGs: context.obj([...refs.values()]),
    ...(options.noDefault ? {} : { D: defaultConfig }),
    ...(options.configs
      ? {
        Configs: context.obj(
          options.configs.map((config) =>
            context.obj({
              Name: PDFHexString.fromText(config.name),
              ON: context.obj(config.on.map((name) => refs.get(name)!)),
              OFF: context.obj(config.off.map((name) => refs.get(name)!)),
            }),
          ),
        ),
      }
      : {}),
  }) as PDFDict;
  doc.catalog.set(PDFName.of('OCProperties'), properties);

  // Ungrouped ink: this must survive every option of every test. The page is
  // drawn from one hand-written stream rather than `drawText`, so the fixture
  // knows exactly which operator belongs to which layer.
  const baseline: InkBox[] = [
    { x: 60, y: rowFor(0), width: 120, height: 30 },
    textBox(60, rowFor(0) + 40, 'PLAIN-NO-LAYER'),
  ];
  const fontRef = font.ref;
  page.node.Resources()!.set(PDFName.of('Font'), context.obj({ F1: fontRef }));
  const fontName = '/F1';
  const ops: string[] = [
    'q 0 0 0 rg 60 ' + rowFor(0) + ' 120 30 re f Q',
    `BT ${fontName} 14 Tf 60 ${rowFor(0) + 40} Td (PLAIN-NO-LAYER) Tj ET`,
  ];
  const style = options.guardStyle ?? 'properties';
  const propertiesMap = context.obj({}) as PDFDict;
  if (style !== 'unmapped') page.node.Resources()!.set(PDFName.of('Properties'), propertiesMap);
  /** The guard operator for one layer, in the shape under test. */
  const guard = (index: number, ref: PDFRef, key: string) =>
    style === 'inline' ? `<< /OC ${ref.toString()} >> /MC${index} BDC` : `/OC /${key} BDC`;

  options.groups.forEach((group, index) => {
    const row = rowFor(index + 1);
    const rect: InkBox = { x: 60, y: row, width: 120, height: 30 };
    const text: InkBox = textBox(60, row - 20, group.token);
    ink.set(group.name, [rect, text]);
    const key = `P${index}`;
    propertiesMap.set(PDFName.of(key), refs.get(group.name)!);
    ops.push(
      guard(index, refs.get(group.name)!, key),
      `q ${group.color[0]} ${group.color[1]} ${group.color[2]} rg 60 ${row} 120 30 re f Q`,
      `BT ${fontName} 14 Tf 60 ${row - 20} Td (${group.token}) Tj ET`,
      'EMC',
    );
  });

  const guarded = options.groups.find((group) => group.state === 'off');
  if (options.conditionalSpan && guarded) {
    // An OCMD over two layers: neither layer's own state decides this span.
    const other = options.groups.find((group) => group.state === 'on') ?? options.groups[0]!;
    const condition = context.register(
      context.obj({
        Type: 'OCMD',
        OCGs: context.obj([refs.get(guarded.name)!, refs.get(other.name)!]),
        P: PDFName.of('AllOn'),
      }),
    );
    propertiesMap.set(PDFName.of('PC'), condition);
    ops.push(
      '/OC /PC BDC',
      `q 0.5 0.5 0.5 rg 300 ${rowFor(1)} 100 30 re f Q`,
      `BT ${fontName} 14 Tf 300 ${rowFor(1) - 20} Td (CONDITION-SPAN) Tj ET`,
      'EMC',
    );
    ink.set(`${guarded.name}:condition`, [
      { x: 300, y: rowFor(1), width: 100, height: 30 },
      textBox(300, rowFor(1) - 20, 'CONDITION-SPAN'),
    ]);
  }

  if (options.guardedForm && guarded) {
    // A whole form XObject that only the hidden layer draws, CAD-style.
    const formRow = 120;
    const formOps = [
      'q 0 1 1 rg 300 ' + formRow + ' 80 30 re f Q',
      `BT ${fontName} 14 Tf 300 ${formRow - 20} Td (FORM-OF-HIDDEN-LAYER) Tj ET`,
    ].join('\n');
    const form = context.flateStream(formOps, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, PAGE_WIDTH, PAGE_HEIGHT],
      OC: refs.get(guarded.name)!,
      Resources: context.obj({ Font: context.obj({ F1: fontRef }) }),
    });
    const formRef = context.register(form);
    page.node
      .Resources()!
      .set(PDFName.of('XObject'), context.obj({ HiddenLayerForm: formRef }));
    ops.push('q 1 0 0 1 0 0 cm /HiddenLayerForm Do Q');
    ink.set(`${guarded.name}:form`, [
      { x: 300, y: formRow, width: 80, height: 30 },
      textBox(300, formRow - 20, 'FORM-OF-HIDDEN-LAYER'),
    ]);
  }

  if (options.hiddenAnnotation && guarded) {
    // Not drawing operators: a comment that belongs to the hidden layer. Its
    // ink goes from the page, but the group has to stay defined for the note.
    const note = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [400, 700, 420, 720],
        Contents: PDFHexString.fromText('a note filed under the hidden layer'),
        OC: refs.get(guarded.name)!,
      }),
    );
    page.node.set(PDFName.of('Annots'), context.obj([note]));
  }

  page.node.set(PDFName.of('Contents'), context.register(context.flateStream(ops.join('\n'), {})));
  ink.set('baseline', baseline);

  // A second page, so "every page was walked" and "the page count is unchanged"
  // both have something behind them.
  const second = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  second.node.Resources()!.set(PDFName.of('Font'), context.obj({ F1: fontRef }));
  const secondOps = [`BT ${fontName} 14 Tf 60 700 Td (SECOND-PAGE-BODY) Tj ET`];
  if (guarded) {
    const key = `P${options.groups.length}`;
    if (style !== 'unmapped') second.node.Resources()!.set(PDFName.of('Properties'), context.obj({ [key]: refs.get(guarded.name)! }));
    secondOps.push(
      guard(options.groups.length, refs.get(guarded.name)!, key),
      'q 0 1 0 rg 60 300 120 30 re f Q',
      `BT ${fontName} 14 Tf 60 280 Td (REVISION-B-ON-PAGE-TWO) Tj ET`,
      'EMC',
    );
    ink.set(`${guarded.name}:page2`, [{ x: 60, y: 300, width: 120, height: 30 }, textBox(60, 280, 'REVISION-B-ON-PAGE-TWO')]);
  }
  second.node.set(PDFName.of('Contents'), context.register(context.flateStream(secondOps.join('\n'), {})));

  if (options.optionalPage && guarded) {
    // Page 3 is one layer's content: removing the ink would leave a blank page.
    const third = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    third.node.Resources()!.set(PDFName.of('Font'), context.obj({ F1: fontRef }));
    third.node.set(PDFName.of('OC'), refs.get(guarded.name)!);
    third.node.set(
      PDFName.of('Contents'),
      context.register(context.flateStream(`BT ${fontName} 14 Tf 60 500 Td (OPTIONAL-PAGE-ONLY) Tj ET`, {})),
    );
  }

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, xrefs, ink, baseline };
}

/** The fixture every deletion test runs on. */
async function standardFixture(): Promise<Fixture> {
  return layeredFixture({
    groups: [
      { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
      { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      // Never listed anywhere: PDF says a layer the configuration does not
      // mention is on, so its ink must survive the toggle.
      { name: 'Survey notes', state: 'unlisted', token: 'SURVEY-NOTES-SHOWN', color: [0, 0, 1] },
    ],
    guardedForm: true,
  });
}

/* ── readers that are not the producer ────────────────────────────────────── */

beforeAll(() => {
  let path = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => path,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) path = value;
    },
  });
});

async function openPdfJs(bytes: Uint8Array) {
  return pdfjs.getDocument({
    // pdf.js transfers the buffer it is handed, so every call gets its own copy.
    data: new Uint8Array(bytes.slice()),
    isEvalSupported: false,
    standardFontDataUrl: undefined,
  }).promise;
}

/** Every string pdf.js can read out of one page — the user's select-all. */
async function extractText(bytes: Uint8Array): Promise<string[]> {
  const doc = await openPdfJs(bytes);
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await doc.destroy();
  return pages;
}

/** The decoded content streams of one page, concatenated in draw order. */
async function contentOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await openPDF(bytes);
  return pageContentStreams(doc.getPage(pageIndex))
    .map((stream) => latin1.decode(stream.bytes))
    .join('\n');
}

/** Every `/Contents` byte of every page, as one string. */
async function allContent(bytes: Uint8Array): Promise<string> {
  const doc = await openPDF(bytes);
  return doc
    .getPages()
    .map((page) => pageContentStreams(page).map((stream) => latin1.decode(stream.bytes)).join('\n'))
    .join('\n%%page%%\n');
}

/* ── a visible-ink raster, from pdf.js's own operator list ───────────────── */

interface Raster {
  width: number;
  height: number;
  /** RGBA, row-major, top row first. */
  data: Uint8Array;
  /** How many pixels carry ink at all. */
  inked: number;
}

const OPS = pdfjs.OPS as unknown as Record<string, number>;

/**
 * Paint what a reader shows for one page.
 *
 * Rectangles and text runs are drawn in the fill colour current at the time,
 * transformed by the CTM the operator list reached them under, and skipped
 * entirely when the marked content around them belongs to a layer the file
 * switches off — the same rule pdf.js applies while rasterising, read from
 * pdf.js's own optional-content configuration.
 */
async function visibleInk(bytes: Uint8Array, pageNumber = 1, forceOn: string[] = []): Promise<Raster> {
  const doc = await openPdfJs(bytes);
  const config = await doc.getOptionalContentConfig();
  const groups = (config.getGroups() ?? {}) as Record<string, { name: string; visible: boolean }>;
  for (const id of Object.keys(groups)) {
    if (forceOn.includes(groups[id]!.name)) config.setVisibility(id, true);
  }
  const page = await doc.getPage(pageNumber);
  const list = await page.getOperatorList();
  await doc.destroy();

  const width = PAGE_WIDTH;
  const height = PAGE_HEIGHT;
  const data = new Uint8Array(width * height * 4);
  // Start from white, the way a page renders.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  type Matrix = [number, number, number, number, number, number];
  const identity: Matrix = [1, 0, 0, 1, 0, 0];
  const multiply = (a: Matrix, b: Matrix): Matrix => [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  let ctm: Matrix = identity;
  const ctmStack: Matrix[] = [];
  let colour: [number, number, number] = [0, 0, 0];
  let fontSize = 0;
  let pen: [number, number] = [0, 0];
  /** One frame per open marked content: hidden ink is never painted. */
  const marked: boolean[] = [];
  const visible = () => !marked.includes(false);

  const paint = (x: number, y: number, w: number, h: number) => {
    const [ax, by] = [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    const dx = ctm[0] * w;
    const dy = ctm[3] * h;
    const left = Math.round(ax);
    const bottom = Math.round(by);
    const top = Math.round(bottom + dy);
    const right = Math.round(left + dx);
    for (let row = Math.min(bottom, top); row < Math.max(bottom, top); row++) {
      for (let column = left; column < right; column++) {
        // The viewport flips y: PDF user space starts at the bottom left.
        if (column < 0 || row < 0 || column >= width || row >= height) continue;
        const deviceRow = height - 1 - row;
        const at = (deviceRow * width + column) * 4;
        data[at] = colour[0];
        data[at + 1] = colour[1];
        data[at + 2] = colour[2];
      }
    }
  };

  for (let index = 0; index < list.fnArray.length; index++) {
    const name = Object.keys(OPS).find((key) => OPS[key] === list.fnArray[index]);
    const args = list.argsArray[index] as unknown[] | undefined;
    switch (name) {
      case 'save':
        ctmStack.push(ctm);
        break;
      case 'restore':
        ctm = ctmStack.pop() ?? identity;
        break;
      case 'transform':
        ctm = multiply(ctm, (args ?? identity) as Matrix);
        break;
      case 'setFillRGBColor':
        colour = [(args?.[0] as number) ?? 0, (args?.[1] as number) ?? 0, (args?.[2] as number) ?? 0];
        break;
      case 'setFillGray':
        colour = [Math.round(((args?.[0] as number) ?? 0) * 255), Math.round(((args?.[0] as number) ?? 0) * 255), Math.round(((args?.[0] as number) ?? 0) * 255)];
        break;
      case 'beginMarkedContentProps': {
        const [tag, props] = (args ?? []) as [string, { type?: string; id?: string; ids?: string[] } | null];
        if (tag !== 'OC' || !props) {
          marked.push(true);
          break;
        }
        if (props.type === 'OCG' && props.id) marked.push(groups[props.id]?.visible ?? true);
        else if (props.type === 'OCMD' && props.ids) marked.push(props.ids.some((id) => groups[id]?.visible ?? true));
        else marked.push(true);
        break;
      }
      case 'endMarkedContent':
        marked.pop();
        break;
      case 'constructPath': {
        if (!visible()) break;
        const ops = (args?.[0] as number[]) ?? [];
        const points = (args?.[1] as number[]) ?? [];
        let at = 0;
        for (const op of ops) {
          // `OPS.rectangle` is the only path construction this fixture draws.
          if (op === OPS.rectangle) {
            const [x, y, w, h] = points.slice(at, at + 4);
            paint(x, y, w, h);
            at += 4;
          }
        }
        break;
      }
      case 'setFont':
        fontSize = (args?.[1] as number) ?? 0;
        break;
      case 'moveText':
        pen = [(args?.[0] as number) ?? 0, (args?.[1] as number) ?? 0];
        break;
      case 'setMatrix':
        pen = [(args?.[4] as number) ?? 0, (args?.[5] as number) ?? 0];
        break;
      case 'showText': {
        if (!visible() || !fontSize) break;
        const glyphs = (args?.[0] as { unicode?: string }[]) ?? [];
        const text = glyphs.map((glyph) => glyph.unicode ?? '').join('');
        paint(pen[0], pen[1] - fontSize, text.length * fontSize * 0.5, fontSize);
        break;
      }
      default:
        break;
    }
  }

  let inked = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) inked++;
  }
  return { width, height, data, inked };
}

/** Pixels that differ between two rasters, as boxes a caller can account for. */
function changedBoxes(a: Raster, b: Raster): InkBox[] {
  expect(b.width, 'the two pages are not the same size').toBe(a.width);
  expect(b.height).toBe(a.height);
  const boxes: InkBox[] = [];
  for (let row = 0; row < a.height; row++) {
    let column = 0;
    while (column < a.width) {
      const at = (row * a.width + column) * 4;
      const same = a.data[at] === b.data[at] && a.data[at + 1] === b.data[at + 1] && a.data[at + 2] === b.data[at + 2];
      if (same) {
        column++;
        continue;
      }
      const start = column;
      while (column < a.width) {
        const next = (row * a.width + column) * 4;
        if (a.data[next] !== b.data[next] || a.data[next + 1] !== b.data[next + 1] || a.data[next + 2] !== b.data[next + 2]) column++;
        else break;
      }
      boxes.push({ x: start, y: row, width: column - start, height: 1 });
    }
  }
  return boxes;
}

/** Every changed pixel of `after` sits inside one of these (top-left) boxes. */
function insideAny(box: InkBox, zones: InkBox[]): boolean {
  return zones.some(
    (zone) => box.x >= zone.x - 1 && box.y >= zone.y - 1 && box.x + box.width <= zone.x + zone.width + 1 && box.y + box.height <= zone.y + zone.height + 1,
  );
}

/* ── the toggle, off: the default must not surprise anybody ───────────────── */

describe('sanitize-pdf without the opt-in leaves the hidden ink exactly where it was', () => {
  it('changes nothing about the page content and still warns', async () => {
    const fixture = await standardFixture();
    const outcome = await runTool(fixture.bytes, {});

    expect((await allContent(fixture.bytes)).length).toBeGreaterThan(0);
    expect(await allContent(await outputBytes(outcome))).toEqual(await allContent(fixture.bytes));

    const note = outcome.warnings.find((line) => /optional content group/.test(line));
    expect(note, `no layer warning in ${JSON.stringify(outcome.warnings)}`).toBeDefined();
    expect(note).toContain('3 optional content group');
    expect(note).toMatch(/1 of them hidden in the default view/);
    expect(note).toMatch(/their content is still in the file/);

    const text = await extractText(await outputBytes(outcome));
    expect(text[0]).toContain('REVISION-B-HIDDEN');
    expect(text[0]).toContain('FORM-OF-HIDDEN-LAYER');
    expect((await listLayers(await openPDF(await outputBytes(outcome)))).map((layer) => layer.name))
      .toEqual(['Grid', 'Revision B', 'Survey notes']);
  }, 60_000);
});

/* ── the toggle, on: hidden ink goes, visible ink does not ────────────────── */

describe('sanitize-pdf with "Remove hidden layer content" on', () => {
  it('deletes the off layer’s operators and keeps every other one', async () => {
    const fixture = await standardFixture();
    const outcome = await runTool(fixture.bytes, { hiddenLayers: true });
    const bytes = await outputBytes(outcome);
    const content = await contentOf(bytes, 0);

    expect(content).toContain('/OC /P0 BDC');           // the layer that is on
    expect(content).toContain('GRID-LAYER-VISIBLE');
    expect(content).toContain('/OC /P2 BDC');           // unlisted, so visible
    expect(content).toContain('SURVEY-NOTES-SHOWN');
    expect(content).toContain('PLAIN-NO-LAYER');
    expect(content).not.toContain('REVISION-B-HIDDEN'); // the layer that is off
    expect(content).not.toContain('/OC /P1 BDC');
    expect(content).not.toContain('HiddenLayerForm');   // and its form XObject
    expect(content).not.toContain('FORM-OF-HIDDEN-LAYER');

    const text = await extractText(bytes);
    expect(text[0]).toContain('GRID-LAYER-VISIBLE');
    expect(text[0]).toContain('PLAIN-NO-LAYER');
    expect(text[0]).not.toContain('REVISION-B-HIDDEN');
    expect(text[1]).toContain('SECOND-PAGE-BODY');

    expect(outcome.message).toMatch(/"Revision B"/);
    expect(outcome.message).toContain(describeSize(fixture.bytes.byteLength));
    expect(outcome.message).toContain(describeSize(bytes.byteLength));
    expect(bytes.byteLength).toBeLessThan(fixture.bytes.byteLength);
  }, 60_000);

  it('leaves the page count, the page size and the visible pixels alone', async () => {
    const fixture = await standardFixture();
    const outcome = await runTool(fixture.bytes, { hiddenLayers: true });
    const bytes = await outputBytes(outcome);

    const before = await openPDF(fixture.bytes);
    const after = await openPDF(bytes);
    expect(after.getPageCount()).toBe(before.getPageCount());
    expect(outcome.pagesOut).toBe(before.getPageCount());
    before.getPages().forEach((page, index) => {
      const box = page.getMediaBox();
      const next = after.getPages()[index]!.getMediaBox();
      expect(next).toEqual(box);
    });

    const plain = await visibleInk(fixture.bytes);
    const cleaned = await visibleInk(bytes);
    expect(changedBoxes(plain, cleaned), 'the page a reader opens must look identical').toEqual([]);
    expect(plain.inked).toBeGreaterThan(500);

    // The ink that went was only *hidden* before: force the layer on and the
    // input paints it, while the output has nothing left to paint.
    const forced = await visibleInk(fixture.bytes, 1, ['Revision B']);
    const forcedAfter = await visibleInk(bytes, 1, ['Revision B']);
    const zones = [...(fixture.ink.get('Revision B') ?? []), ...(fixture.ink.get('Revision B:form') ?? [])].map(deviceBox);
    const changes = changedBoxes(forced, forcedAfter);
    expect(changes.length, 'nothing was removed even with the layer shown').toBeGreaterThan(0);
    for (const box of changes) {
      expect(insideAny(box, zones), `changed pixels at ${box.x},${box.y} are outside the hidden layer`).toBe(true);
    }
    // ... and the hidden layer really did paint something in the input.
    expect(changedBoxes(plain, forced).length, 'the off layer painted nothing to begin with').toBeGreaterThan(0);
  }, 60_000);

  it('deletes the group definition only once nothing refers to it', async () => {
    const fixture = await standardFixture();
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.removed.map((layer) => [layer.name, layer.spans, layer.forms])).toEqual([['Revision B', 2, 1]]);
    expect(report.definitions).toBe(1);
    expect(report.kept).toEqual([]);

    const remaining = listLayers(doc).map((layer) => layer.name);
    expect(remaining).toEqual(['Grid', 'Survey notes']);

    const properties = doc.catalog.get(PDFName.of('OCProperties'));
    const dict = doc.context.lookup(properties as PDFRef) as PDFDict;
    const groups = dict.get(PDFName.of('OCGs')) as PDFArray;
    expect(groups.size()).toBe(2);
    // The `/Properties` name that guarded the deleted span is gone too, so no
    // reader is left chasing a reference to an object that no longer exists.
    const page = doc.getPage(0);
    const map = (page.node.Resources()!.get(PDFName.of('Properties')) as PDFDict).entries().map(([key]) => String(key));
    expect(map).not.toContain('/P1');
  }, 60_000);
});

/* ── what the tool refuses to delete, and says so ─────────────────────────── */

describe('content a reader may still have to show is kept', () => {
  it('keeps a layer no configuration switches off, because PDF says it is on', async () => {
    const fixture = await standardFixture();
    const doc = await openPDF(fixture.bytes);
    // `Survey notes` is in `/OCGs` and in neither list of the default view.
    expect(listLayers(doc).find((layer) => layer.name === 'Survey notes')?.on).toBe(true);
    const raster = await visibleInk(fixture.bytes);
    const shown = await visibleInk(fixture.bytes, 1, ['Survey notes']);
    expect(changedBoxes(raster, shown), 'an unlisted layer is not drawn by readers').toEqual([]);
  }, 60_000);

  it('keeps a layer another named configuration switches back on', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      configs: [{ name: 'Client view', on: ['Revision B'], off: [] }],
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.removed).toEqual([]);
    expect(report.kept.map((layer) => [layer.name, layer.reason])).toEqual([
      ['Revision B', 'the named view "Client view" switches it back on'],
    ]);
    expect(await contentOf(await doc.save({ useObjectStreams: false }), 0)).toContain('REVISION-B-HIDDEN');
  }, 60_000);

  it('keeps a layer whose /Usage /View entry does not say it is off', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        {
          name: 'Revision B',
          state: 'off',
          token: 'REVISION-B-HIDDEN',
          color: [0, 1, 0],
          ocg: (context, dict) => dict.set(PDFName.of('Usage'), context.obj({ View: context.obj({ ViewState: 'ON' }) })),
        },
      ],
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.kept.map((layer) => layer.reason)).toEqual(['its /Usage /View entry does not say the layer is off']);

    const outcome = await runTool(fixture.bytes, { hiddenLayers: true });
    expect(outcome.warnings.join(' ')).toMatch(/"Revision B" is off in the default view but its \/Usage \/View entry/);
    const bytes = await outputBytes(outcome);
    expect(await contentOf(bytes, 0)).toContain('REVISION-B-HIDDEN');
    expect(changedBoxes(await visibleInk(fixture.bytes), await visibleInk(bytes))).toEqual([]);
  }, 60_000);

  it('keeps a span an OCMD conditions on several layers', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      conditionalSpan: true,
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.conditional).toBe(1);
    // The layer's own span goes; the OCMD span — which Grid may switch back on —
    // stays, and so does the definition it references.
    const bytes = await doc.save({ useObjectStreams: false });
    const content = await contentOf(bytes, 0);
    expect(content).toContain('CONDITION-SPAN');
    expect(content).not.toContain('REVISION-B-HIDDEN');
    expect(report.removed[0]?.definitionRemoved).toBe(false);
  }, 60_000);

  it('keeps the layer defined while something outside the page still names it', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      hiddenAnnotation: true,
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.removed[0]?.spans, 'the hidden layer’s own spans should have gone').toBe(2);
    expect(report.removed[0]?.definitionRemoved, 'an annotation still uses the layer').toBe(false);
    expect(report.definitions).toBe(0);
    const bytes = await doc.save({ useObjectStreams: false });
    expect(await contentOf(bytes, 0)).not.toContain('REVISION-B-HIDDEN');
    expect(listLayers(await openPDF(bytes)).map((layer) => layer.name)).toEqual(['Grid', 'Revision B']);
    // The note itself is untouched: this tool removes ink, not comments.
    const annots = (await openPDF(bytes)).getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
  }, 60_000);

  it('reads a guard written as an inline property list', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      guardStyle: 'inline',
    });
    const content = await contentOf(fixture.bytes, 0);
    expect(content).toMatch(/<<\/OC \d+ 0 R>>|\/OC \d+ 0 R/);
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.unresolved, 'an inline property list is still one layer’s guard').toBe(0);
    expect(report.removed[0]?.spans).toBe(2);
    const bytes = await doc.save({ useObjectStreams: false });
    expect(await contentOf(bytes, 0)).not.toContain('REVISION-B-HIDDEN');
    expect(await contentOf(bytes, 0)).toContain('GRID-LAYER-VISIBLE');
  }, 60_000);

  it('deletes nothing when a guard names a property list it cannot resolve', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      guardStyle: 'unmapped',
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.unresolved).toBeGreaterThan(0);
    expect(report.spans).toBe(0);
    expect(report.definitions).toBe(0);
    // The whole file keeps its ink: half-read guards are a reason to stop, not
    // a reason to guess which side of the trade the user wanted.
    const bytes = await doc.save({ useObjectStreams: false });
    expect(await contentOf(bytes, 0)).toContain('REVISION-B-HIDDEN');
    expect(changedBoxes(await visibleInk(fixture.bytes), await visibleInk(bytes))).toEqual([]);

    // And the run says so, rather than printing "sanitized" over an untouched file.
    const outcome = await runTool(fixture.bytes, { hiddenLayers: true });
    expect(outcome.warnings.join(' ')).toMatch(/could not be tied to one layer/);
    expect(outcome.message).toMatch(/no hidden layer could be emptied without guessing/);
    expect(outcome.message, 'a no-op must not read like a result').not.toMatch(/0 hidden layer operator\(s\)/);
  }, 60_000);

  it('refuses when the default viewing configuration cannot be read', async () => {
    const missing = await layeredFixture({
      groups: [{ name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] }],
      noDefault: true,
    });
    const doc = await openPDF(missing.bytes);
    expect(removeHiddenLayerContent(doc).refused).toMatch(/no default viewing configuration/);

    const junk = await layeredFixture({
      groups: [{ name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] }],
      junkOnList: true,
    });
    const report = removeHiddenLayerContent(await openPDF(junk.bytes));
    expect(report.refused).toMatch(/\/ON.*not a layer/);

    const outcome = await runTool(junk.bytes, { hiddenLayers: true });
    expect(outcome.warnings.join(' ')).toMatch(/Hidden layer content was not removed/);
    expect(await contentOf(await outputBytes(outcome), 0)).toContain('REVISION-B-HIDDEN');
  }, 60_000);

  it('leaves a page that is itself optional content alone', async () => {
    const fixture = await layeredFixture({
      groups: [
        { name: 'Grid', state: 'on', token: 'GRID-LAYER-VISIBLE', color: [1, 0, 0] },
        { name: 'Revision B', state: 'off', token: 'REVISION-B-HIDDEN', color: [0, 1, 0] },
      ],
      optionalPage: true,
    });
    const doc = await openPDF(fixture.bytes);
    const report = removeHiddenLayerContent(doc);
    expect(report.hiddenPages).toBe(1);
    expect(report.removed[0]?.definitionRemoved).toBe(false);
    const bytes = await doc.save({ useObjectStreams: false });
    const text = await extractText(bytes);
    // The optional page keeps its own ink, and the group stays defined for it;
    // the spans the same layer drew on the readable pages still went.
    expect(text[2]).toContain('OPTIONAL-PAGE-ONLY');
    expect(text[0]).not.toContain('REVISION-B-HIDDEN');
    expect(text[1]).not.toContain('REVISION-B-ON-PAGE-TWO');
    expect(text[0]).toContain('GRID-LAYER-VISIBLE');
    expect(changedBoxes(await visibleInk(fixture.bytes), await visibleInk(bytes)), 'the visible page changed').toEqual([]);
    expect((await openPDF(bytes)).getPageCount()).toBe(3);
  }, 60_000);
});

