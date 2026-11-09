/**
 * The invariant: a style control either changes a byte, or it does not exist.
 *
 * This is the general form of a hunt that has been done by hand four times — a
 * highlighter bowtie, an image compression ratio that measured nothing, a link mark
 * with `area=0` under 1,400 green tests, and a sticky note whose "Text size" slider
 * reached no mark, no spec and no byte. Each was found by reading three files
 * closely, which does not scale and does not stay found. So the property is asserted
 * instead of the instance:
 *
 * 1. **A declared field is read.** Every field a rail tool declares must be named by
 *    that tool's own `run`/`validate`, or be consumed by the shared reader it calls.
 *    A field nothing reads is a control wired to a form.
 * 2. **A style field changes the file.** For the tools that draw text, each style
 *    field is flipped and the produced PDF is re-read: the face, the size, the colour
 *    or the position has to come back different. "It was passed to `run`" is not the
 *    claim — "the bytes differ" is.
 * 3. **The model's keys are honoured, and only where the writer can draw them.** Each
 *    of the seven properties must reach an export on the surface that offers it, and a
 *    surface must not offer what it cannot keep (`lineSpacing` on a one-line mark,
 *    `justify` on a mark with no measure, italic on a family with no italic file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render } from '@testing-library/react';
import { TextStylingControls } from '@/components/tools/pdf/shared/TextStylingControls';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { PDF_TOOLS } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { StandardFonts } from '@/lib/pdf/core/doc';
import {
  DEFAULT_FACE_STYLE,
  FACE_FAMILIES,
  carriesPosture,
  defaultFaceStyle,
  faceSurfaceSupport,
  type FaceStyle,
  type FaceSurfaceId,
} from '@/lib/pdf/core/text-style';
import { TEXT_STYLE_SURFACE, TEXT_TOOLS, defaultStyleFor } from '@/components/tools/pdf/editor/tools';
import { annotationToSpec, styleMarks } from '@/components/tools/pdf/editor/specs';
import type { EditorAnnotation, ToolStyle } from '@/components/tools/pdf/editor/types';

/**
 * Serve the vendored faces for any URL `core/fonts` asks for.
 *
 * Without this a run in jsdom resolves `/fonts/NotoSans-Regular.ttf` against the
 * test host and fails on a connection nobody owns — which reads like a broken tool
 * rather than a missing face.
 */
const realFetch = globalThis.fetch;
beforeAll(() => {
  const faces: Record<string, Uint8Array> = {
    Bold: new Uint8Array(readFileSync(join(process.cwd(), 'public/fonts/NotoSans-Bold.ttf'))),
    regular: new Uint8Array(readFileSync(join(process.cwd(), 'public/fonts/NotoSans-Regular.ttf'))),
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const bytes = /Bold/.test(String(input)) ? faces.Bold : faces.regular;
    return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * The tool layer's own source, read once.
 *
 * A field can be consumed through a shared constant (`CHUNK_SIZE`), a loop over
 * `HEADER_SLOTS`, or a pane that reads `context.values` wholesale, so a rule that
 * only greps one `run` function calls those dead and is ignored within a sprint. This
 * asks the question that survives indirection: does any code in the layer name the key
 * as a value, rather than only declaring it?
 */
const LAYER_FILES: { path: string; text: string }[] = (() => {
  const roots = ['src/lib/pdf', 'src/components/tools/pdf'];
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push({ path, text: readFileSync(path, 'utf8') });
    }
  };
  for (const root of roots) {
    if (existsSync(root)) walk(root);
  }
  return files;
})();

/** Where the layer names `key` as a value it reads, not as the field it declares. */
function readersOf(key: string): string[] {
  const declared = new RegExp(`key:\s*['"]${key}['"]`);
  const used = new RegExp(
    [`['"]${key}['"]\\s*,`, `values\\s*\[['"]${key}['"]\\]`, `['"]${key}['"]\\s*\\)`, `\\b${key}\\s*:`].join('|'),
  );
  const hits: string[] = [];
  for (const file of LAYER_FILES) {
    for (const line of file.text.split('\n')) {
      if (used.test(line) && !declared.test(line)) hits.push(`${file.path}: ${line.trim().slice(0, 90)}`);
    }
  }
  return hits;
}

/* ── 1. every declared field is read by the tool that declares it ───────── */

/**
 * Keys a tool's `run` does not name because a shared reader takes the whole value
 * bag. Each entry names the symbol that reads it, so the exemption stays checkable
 * rather than becoming a place to hide a dead control.
 */
const SHARED_READERS: Record<string, string> = {
  font: 'readTextStyle',
  bold: 'readTextStyle',
  italic: 'readTextStyle',
  fontSize: 'readTextStyle',
  color: 'readTextStyle',
  pages: 'resolvePages',
  password: 'the runner’s unlock round',
};

const ALL_FIELDS = PDF_TOOLS.flatMap((tool) =>
  (tool.fields ?? []).map((field) => ({ tool, field })),
);

describe('no rail field is wired to the form and not to the export', () => {
  /**
   * Both rules in this block walk every line of every tool-layer file once per
   * declared field — 511 fields × ~90 files — which measured 6.2 s on a loaded CI
   * runner against vitest's 5 s default. It failed two pushes in a row on commits
   * that changed no field at all (`42590325472`, `42591669587`), so the ceiling is
   * raised here rather than left to re-runs: the assertion is untouched.
   */
  const SCAN_TIMEOUT = 120_000;

  it('names every field it declares somewhere in the tool layer', () => {
    const unread: string[] = [];
    for (const { tool, field } of ALL_FIELDS) {
      if (SHARED_READERS[field.key]) continue;
      if (readersOf(field.key).length === 0) unread.push(`${tool.id}.${field.key} (${field.type})`);
    }
    expect(unread).toEqual([]);
  }, SCAN_TIMEOUT);

  it('reads every field inside the module that declares the tool', () => {
    // Per-tool, not per-layer: a field declared in the same file as the code that
    // reads it (a shared `CHUNK_SIZE` const, a loop over `HEADER_SLOTS`, a local
    // helper) is consumed. A field declared and then named nowhere else in that
    // module is the shape of the note's "Text size" slider.
    const unread: string[] = [];
    for (const { tool, field } of ALL_FIELDS) {
      if (SHARED_READERS[field.key]) continue;
      const home = LAYER_FILES.find((file) => file.text.includes(`id: '${tool.id}'`));
      if (!home) {
        unread.push(`${tool.id}.${field.key} (no declaring module found)`);
        continue;
      }
      const lines = home.text.split('\n');
      let named = 0;
      for (const line of lines) {
        if (new RegExp(`['"]${field.key}['"]`).test(line) && !new RegExp(`key:\s*['"]${field.key}['"]`).test(line)) {
          named += 1;
        }
      }
      const declared = lines.filter((line) => new RegExp(`key:\s*['"]${field.key}['"]`).test(line)).length;
      if (named === 0 && declared <= 1) unread.push(`${tool.id}.${field.key} (${field.type})`);
    }
    // Reported, not asserted: a field read by a helper in *another* module (the
    // office importers' shared `baseOpts`) fails this shape and passes the layer-wide
    // rule above, so the strict form here would be a list of false alarms. The count is
    // in `docs/research/wysiwyg-text-style-findings.md`.
    if (process.env.STYLE_CENSUS) {
      writeFileSync('/tmp/style-census.txt', `${unread.length}\n${unread.join('\n')}`);
    }
    expect(unread.length).toBeLessThanOrEqual(33);
  }, SCAN_TIMEOUT);

  it('reports the fields whose read lives in a shared reader, not in the run', () => {
    const shared = ALL_FIELDS.filter(({ field }) => SHARED_READERS[field.key]);
    // The exemption is bounded on purpose: today it is the five keys of the style
    // model plus the two the runner owns. A sixth style-ish key added to the map
    // without a reader behind it is what this counts.
    const keys = [...new Set(shared.map(({ field }) => field.key))].sort();
    expect(keys).toEqual(['bold', 'color', 'font', 'fontSize', 'italic', 'pages', 'password']);
  });

  it('keeps the exemption list honest about who reads what', () => {
    // The exemption list is the weak point of a rule like this: a key added to it
    // quietly stops being checked. So each named reader has to be a real symbol in
    // the module that owns it, or a step the runner takes.
    const shared = Object.entries(SHARED_READERS).filter(([, reader]) => reader === 'readTextStyle');
    expect(shared.map(([key]) => key).sort()).toEqual(['bold', 'color', 'font', 'fontSize', 'italic']);
    const source = PDF_TOOLS.find((tool) => tool.id === 'page-numbers')?.run?.toString() ?? '';
    expect(source).toMatch(/readTextStyle/);
  });
});

/* ── 2. each style field changes the produced file ──────────────────────── */

/** A plain A4 page with one line of text, built here so nothing reads a fixture. */
async function blankA4(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice 2026-11-08', { x: 60, y: 760, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

/**
 * Everything a saved file says about its type: the font each run is drawn in, its
 * size, its fill colour, where it was placed, and — for an annotation mark — the
 * operators of its appearance stream.
 *
 * It is deliberately a *string*, so the assertion is "the file says something
 * different", which is the property under test, not a guess about which operator a
 * given writer will emit.
 */
async function typeReport(bytes: Uint8Array): Promise<string> {
  const doc = await openPDF(bytes);
  const found: string[] = [];
  for (const page of doc.getPages() as PDFPage[]) {
    const resources = doc.context.lookupMaybe(page.node.get(PDFName.of('Resources')), PDFDict);
    const fontDict = resources && doc.context.lookupMaybe(resources.get(PDFName.of('Font')), PDFDict);
    const names = new Map<string, string>();
    if (fontDict) {
      for (const [name, value] of fontDict.entries()) {
        const dict = doc.context.lookupMaybe(value, PDFDict);
        const base = dict?.get(PDFName.of('BaseFont'));
        names.set(name.decodeText(), base instanceof PDFName ? base.decodeText() : '');
      }
    }
    for (const { bytes: stream } of pageContentStreams(page)) {
      const text = Buffer.from(stream).toString('latin1');
      for (const match of text.matchAll(/\/([\w.-]+) ([\d.]+) Tf/g)) {
        found.push(`font(${names.get(match[1] ?? '') ?? match[1]})@${match[2]}`);
      }
      for (const match of text.matchAll(/((?:[-\d.]+ ){2}[-\d.]+) rg/g)) {
        found.push(`fill(${match[1]})`);
      }
      for (const match of text.matchAll(/((?:[-\d.]+ ){5}[-\d.]+) Tm/g)) {
        found.push(`at(${match[1]})`);
      }
    }
    const annots = page.node.Annots();
    if (!annots) continue;
    for (const entry of annots.asArray()) {
      const dict = doc.context.lookupMaybe(entry, PDFDict);
      if (!dict) continue;
      const colour = dict.get(PDFName.of('C'));
      if (colour instanceof PDFArray) found.push(`annotC(${colour.asArray().map(String).join(',')})`);
      const ap = dict.get(PDFName.of('AP'));
      const apDict = ap instanceof PDFRef ? (doc.context.lookup(ap) as PDFDict | undefined) : ap;
      if (apDict instanceof PDFDict) {
        const normalRef = apDict.get(PDFName.of('N'));
        const normal = normalRef instanceof PDFRef ? doc.context.lookup(normalRef) : normalRef;
        if (normal instanceof PDFRawStream) {
          // The stream names its fonts `/F1`; what that resolves to is in its own
          // `/Resources`, so a family change is only visible in the report when the
          // resources are read too. Without this, `add-stamps.font` looked inert.
          const streamFonts = new Map<string, string>();
          const streamResources = normal.dict.get(PDFName.of('Resources'));
          const resourceDict =
            streamResources instanceof PDFRef
              ? (doc.context.lookup(streamResources) as PDFDict | undefined)
              : (streamResources as PDFDict | undefined);
          const fontGroup = resourceDict?.get(PDFName.of('Font'));
          const fontDict =
            fontGroup instanceof PDFRef ? (doc.context.lookup(fontGroup) as PDFDict | undefined) : (fontGroup as PDFDict | undefined);
          if (fontDict) {
            for (const [name, value] of fontDict.entries()) {
              const face = value instanceof PDFRef ? (doc.context.lookup(value) as PDFDict | undefined) : (value as PDFDict);
              const base = face?.get?.(PDFName.of('BaseFont'));
              streamFonts.set(name.decodeText(), base instanceof PDFName ? base.decodeText() : '');
            }
          }
          const ops = new TextDecoder().decode(decodePDFRawStream(normal).decode());
          for (const match of ops.matchAll(/\/([\w.-]+) ([\d.]+) Tf/g)) {
            found.push(`apfont(${streamFonts.get(match[1] ?? '') ?? match[1]})@${match[2]}`);
          }
          found.push(`ap(${ops.replace(/\s+/g, ' ')})`);
        }
      }
    }
  }
  return found.join('|');
}

async function runTool(toolId: string, values: Record<string, unknown>): Promise<string> {
  const file = new File([await blankA4()], 'fixture.pdf', { type: 'application/pdf' });
  const outcome = await runPdfTool({
    toolId,
    files: [file],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  const blob = outcome?.outputs?.[0]?.blob;
  expect(blob, `${toolId} produced no file`).toBeTruthy();
  return typeReport(new Uint8Array(await blob!.arrayBuffer()));
}

interface RailCase {
  tool: string;
  /** Values that leave a text-bearing mark, everything else at its default. */
  base: Record<string, unknown>;
  field: 'font' | 'bold' | 'italic' | 'fontSize' | 'color';
  flip: Record<string, unknown>;
}

const RAIL_CASES: RailCase[] = [
  {
    tool: 'page-numbers',
    base: { pages: '1', prefix: 'Page ', suffix: '' },
    field: 'font',
    flip: { font: 'std:times' },
  },
  {
    tool: 'page-numbers',
    base: { pages: '1', prefix: 'Page ', suffix: '' },
    field: 'bold',
    flip: { bold: true },
  },
  {
    tool: 'page-numbers',
    base: { pages: '1', prefix: 'Page ', suffix: '' },
    field: 'fontSize',
    flip: { fontSize: 33 },
  },
  {
    tool: 'page-numbers',
    base: { pages: '1', prefix: 'Page ', suffix: '' },
    field: 'color',
    flip: { color: '#ff0000' },
  },
  {
    // Italic is only offered for a family that has the face; the default pick does.
    tool: 'page-numbers',
    base: { pages: '1', prefix: 'Page ', suffix: '', font: 'std:times' },
    field: 'italic',
    flip: { italic: true },
  },
  { tool: 'watermark', base: { type: 'text', text: 'DRAFT', pages: '1' }, field: 'font', flip: { font: 'std:courier' } },
  {
    tool: 'watermark',
    base: { type: 'text', text: 'DRAFT', pages: '1', font: 'std:courier' },
    field: 'italic',
    flip: { italic: true },
  },
  { tool: 'watermark', base: { type: 'text', text: 'DRAFT', pages: '1' }, field: 'fontSize', flip: { fontSize: 96 } },
  { tool: 'watermark', base: { type: 'text', text: 'DRAFT', pages: '1' }, field: 'color', flip: { color: '#00ff00' } },
  {
    tool: 'header-footer',
    base: { pages: '1', headerLeft: 'Running head', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: '', footerRight: '' },
    field: 'font',
    flip: { font: 'std:times' },
  },
  {
    tool: 'header-footer',
    base: { pages: '1', headerLeft: 'Running head', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: '', footerRight: '' },
    field: 'bold',
    flip: { bold: true },
  },
  {
    tool: 'header-footer',
    base: { pages: '1', headerLeft: 'Running head', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: '', footerRight: '' },
    field: 'fontSize',
    flip: { fontSize: 22 },
  },
  {
    tool: 'header-footer',
    base: { pages: '1', headerLeft: 'Running head', headerCenter: '', headerRight: '', footerLeft: '', footerCenter: '', footerRight: '' },
    field: 'color',
    flip: { color: '#0000ff' },
  },
  { tool: 'add-stamps', base: { pages: '1', stamp: 'APPROVED' }, field: 'font', flip: { font: 'std:times' } },
  {
    tool: 'add-stamps',
    base: { pages: '1', stamp: 'APPROVED', font: 'std:times' },
    field: 'italic',
    flip: { italic: true },
  },
  { tool: 'add-stamps', base: { pages: '1', stamp: 'APPROVED' }, field: 'fontSize', flip: { fontSize: 9 } },
  { tool: 'add-stamps', base: { pages: '1', stamp: 'APPROVED' }, field: 'color', flip: { color: '#008000' } },
];

describe('every style field on a text-drawing rail tool changes the file', () => {
  for (const testCase of RAIL_CASES) {
    it(`${testCase.tool}.${testCase.field} reaches the bytes`, async () => {
      const before = await runTool(testCase.tool, testCase.base);
      const after = await runTool(testCase.tool, { ...testCase.base, ...testCase.flip });
      expect(after, `${testCase.tool}.${testCase.field} changed nothing in the file`).not.toBe(before);
    });
  }
});

/* ── 3. the model's keys, and what each surface may show ────────────────── */

const MODEL_KEYS: (keyof FaceStyle)[] = [
  'fontFamily',
  'size',
  'color',
  'bold',
  'italic',
  'align',
  'lineSpacing',
];

function freetextMark(pen: ToolStyle): EditorAnnotation {
  return {
    id: 'm1',
    kind: 'FreeText',
    tool: 'freetext',
    page: 0,
    rect: { x: 40, y: 700, width: 240, height: 90 },
    color: pen.text.color,
    borderWidth: 0.8,
    opacity: 1,
    text: 'Café 日本語',
    textStyle: pen.text,
    fontSize: pen.text.size,
    createdAt: 1,
  };
}

/** A different value for `key`, one the surface's writer must honour. */
function nextValue(key: keyof FaceStyle, current: FaceStyle): unknown {
  switch (key) {
    case 'fontFamily':
      return 'std:times';
    case 'size':
      return current.size + 6;
    case 'color':
      return '#FF0000';
    case 'bold':
      return !current.bold;
    case 'italic':
      return !current.italic;
    case 'align':
      return 'center';
    case 'lineSpacing':
      return current.lineSpacing + 0.5;
    default:
      return undefined;
  }
}

describe('the style model is honoured, not merely carried', () => {
  it('every property of the model reaches the annotation spec', () => {
    const pen = defaultStyleFor('freetext');
    const baseline = JSON.stringify(annotationToSpec(freetextMark(pen)));
    for (const key of MODEL_KEYS) {
      if (key === 'italic') continue; // refused for the default family; proved below
      const changed: ToolStyle = { ...pen, text: { ...pen.text, [key]: nextValue(key, pen.text) } };
      const spec = JSON.stringify(annotationToSpec(freetextMark(changed)));
      expect(spec, `changing ${key} did not change the annotation spec`).not.toBe(baseline);
    }
  });

  it('each text surface starts from the model’s own default for that surface', () => {
    for (const tool of TEXT_TOOLS) {
      const surface = TEXT_STYLE_SURFACE[tool];
      expect(surface, `${tool} styles text but names no surface`).toBeTruthy();
      expect(defaultStyleFor(tool).text, tool).toEqual(defaultFaceStyle(surface!));
    }
    // A sticky note is a text mark the format cannot style, so it has no surface,
    // no entry in the styled-tool list, and no style on its mark.
    expect(TEXT_STYLE_SURFACE.note).toBeUndefined();
    expect(TEXT_TOOLS).not.toContain('note');
    expect(defaultStyleFor('note').text).toEqual(DEFAULT_FACE_STYLE);
  });

  it('a surface only claims what its writer can draw', () => {
    // Justify needs a measure to stretch a line across: only the block editor has one.
    for (const surface of [
      'freetext',
      'stamp',
      'header-footer',
      'page-numbers',
      'watermark',
      'add-stamps',
    ] as FaceSurfaceId[]) {
      expect(faceSurfaceSupport(surface).aligns, surface).not.toContain('justify');
    }
    expect(faceSurfaceSupport('text-editor').aligns).toContain('justify');
    // Line height is a distance between lines; a single-run mark has none.
    expect(faceSurfaceSupport('freetext').lineSpacing).toBe(true);
    for (const surface of [
      'stamp',
      'header-footer',
      'page-numbers',
      'watermark',
      'add-stamps',
    ] as FaceSurfaceId[]) {
      expect(faceSurfaceSupport(surface).lineSpacing, surface).toBe(false);
    }
  });

  it('no family is offered a posture it cannot put in the file', () => {
    for (const family of FACE_FAMILIES) {
      // The registry's own claim has to match the answer given for plain Latin text,
      // except where the answering face depends on the run (auto, and a Latin-only
      // family past WinAnsi) — which is tested separately below.
      if (family.group === 'standard' || family.group === 'bundled' || family.group === 'script') {
        expect(carriesPosture(family.id, 'bold', 'café'), family.id).toBe(family.bold);
        expect(carriesPosture(family.id, 'italic', 'café'), family.id).toBe(family.italic);
      }
    }
    // The bundled family is the one a user most likely picks, and the one this app
    // has no italic file for: the refusal has to stay a refusal.
    expect(carriesPosture('noto', 'italic')).toBe(false);
    expect(carriesPosture('noto', 'bold')).toBe(true);
    expect(carriesPosture('script:jp', 'bold')).toBe(false);
    // A Latin-only family past WinAnsi is answered by the bundled face, so a slant
    // asked for there would be dropped, and is not offered.
    expect(carriesPosture('std:times', 'italic', 'café')).toBe(true);
    expect(carriesPosture('std:times', 'italic', '日本語')).toBe(false);
  });

  /**
   * The control set renders exactly what the writer honours.
   *
   * This is the shape the note's "Text size" slider was: a control on screen whose
   * value no writer consumed. Rather than trusting the component and the support
   * table to agree, the component is rendered and its controls are counted.
   */
  it('renders a control only where the surface can keep its value', () => {
    const renderFor = (surface: FaceSurfaceId, family: string, text = 'café') =>
      render(
        createElement(TextStylingControls, {
          surface,
          style: { ...DEFAULT_FACE_STYLE, fontFamily: family, italic: false },
          text,
          families: FACE_FAMILIES,
          onChange: () => {},
        }),
      ).container;

    // A stamp draws one line, so it has no line height to set.
    const stampCard = renderFor('stamp', 'std:times');
    expect(stampCard.textContent).not.toMatch(/Line height/);
    // The block editor and the text box both lay out more than one line.
    expect(renderFor('text-editor', 'std:times').textContent).toMatch(/Line height/);
    expect(renderFor('freetext', 'std:times').textContent).toMatch(/Line height/);

    // Justify needs a measure to stretch across; only the block editor has one.
    const pressed = (html: Element) =>
      [...html.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent?.trim());
    expect(pressed(renderFor('text-editor', 'std:times'))).toContain('☰');
    expect(pressed(renderFor('freetext', 'std:times'))).not.toContain('☰');
    expect(pressed(renderFor('page-numbers', 'std:times'))).not.toContain('☰');

    // A family with no italic file cannot be asked for one, and the reason is on
    // the control rather than hidden behind it.
    const noto = renderFor('freetext', 'noto');
    const slant = [...noto.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'I');
    expect(slant, 'italic must not be an active control for the bundled family').toBeTruthy();
    expect(slant!.disabled).toBe(true);
    expect(slant!.title).toMatch(/no italic face/i);
    const times = renderFor('freetext', 'std:times');
    const slanted = [...times.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'I');
    expect(slanted!.disabled).toBe(false);
    // …and a Latin-only family stops offering the slant for a run it cannot spell,
    // because the bundled face answers that run.
    const cjk = renderFor('freetext', 'std:times', '日本語');
    const cjkSlant = [...cjk.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'I');
    expect(cjkSlant!.disabled).toBe(true);
  });

  it('a style patch changes the key it carries and nothing else', () => {
    const pen = defaultStyleFor('freetext');
    const [styled] = styleMarks([freetextMark(pen)], ['m1'], { textStyle: { size: 28 } });
    expect(styled!.textStyle!.size).toBe(28);
    expect(styled!.fontSize, 'the derived size the overlay reads must move with it').toBe(28);
    for (const key of ['fontFamily', 'color', 'bold', 'italic', 'align', 'lineSpacing'] as const) {
      expect(styled!.textStyle![key], `${key} was reset by a size patch`).toBe(pen.text[key]);
    }
  });
});
