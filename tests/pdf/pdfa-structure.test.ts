/**
 * `pdf-to-pdfa` — the structures PDF/A names, checked in bytes.
 *
 * Two findings from `docs/research/pdfa-attribution-recheck.md` §2, both measured
 * on the engine the tab downloads:
 *
 *   1. `-dPDFA=2` on its own makes `pdfwrite` *identify* a file (its XMP carries
 *      `pdfaid:part`) and write nothing else: the engine's catalogue had no
 *      `/OutputIntents` and no `/MarkInfo`, while the local fallback had both. The
 *      path that reported success shipped the less conformant file.
 *   2. `auditFonts` looked for a font program on the font dictionary instead of on
 *      its `/FontDescriptor`, so Ghostscript's embedded `/FontFile3` subset was
 *      announced to the user as "0 of 1 embedded" — a false statement about their
 *      file, printed with confidence.
 *
 * What this file pins, in that order:
 *
 *   * the invocation: the prefix prolog and the ICC profile `convertToPdfA` hands
 *     the engine, and the argument order the WASM build requires — measured, a
 *     prolog ahead of `-sOutputFile` dies with *"Device 'pdfwrite' requires an
 *     output file"*, because the pdfmark opens the device;
 *   * that the other two Ghostscript verbs are untouched by that change;
 *   * the font audit, against a document whose five faces carry their programs in
 *     the three legal places, one of them under a subset tag and one with nothing;
 *   * what each path's catalogue actually contains, read from the bytes: an
 *     `/OutputIntents` entry with `/S /GTS_PDFA1` and a `/DestOutputProfile` stream
 *     whose `/N` is its component count, `/MarkInfo << /Marked true >>`, and the
 *     `pdfaid` identification the card claims;
 *   * that transparency a chosen part forbids is looked for and spoken about.
 *
 * **What this is not.** No PDF/A validator exists in this sandbox, and none can run
 * in a browser tab: `verapdf` is not installed (no jar on the box, and `pip install
 * pyverapdf` finds no distribution here — measured, `docs/research/pdfa-invocation-
 * fix.md`), `qpdf` and `mutool` are absent, and a JVM alone validates nothing. Every
 * assertion below is therefore about *structure visible in the bytes* — "the
 * dictionary entries are present" — which is a weaker claim than "this file
 * conforms". The last block runs the published `@bentopdf/gs-wasm` build (GPL
 * Ghostscript 10.06.0) when it is cached, so finding 1 is pinned against the real
 * engine and not only against a double.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts } from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream, openPDF } from '@/lib/pdf/core/doc';
import { readXmp, srgbIccProfile, writeXmp } from '@/lib/pdf/core/metadata';
import { convertToPdfA, rebuildWithGhostscript, textToOutlines } from '@/lib/pdf/core/engine-ops';
import { resetEngines } from '@/lib/pdf/engines/auto';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';

/* ── the Ghostscript edge: the real seam, a recorded invocation ───────────── */

const gs = vi.hoisted(() => ({
  dir: `${process.cwd()}/node_modules/.browsersnip-gs`,
  /** Every call: the vector, the sandbox files written for it, the outputs asked for. */
  calls: [] as Array<{ args: string[]; files: Record<string, Uint8Array>; outputs: string[] }>,
  /** Bytes the stand-in hands back as `/tmp/output.pdf`. */
  reply: null as Uint8Array | null,
  /** Set to fail provisioning the way an offline tab does. */
  unreachable: null as string | null,
  /** Force the stand-in while the real build is on disk. */
  stub: true,
  live: false,
  skipped: '',
}));

vi.mock('@/lib/pdf/engines/ghostscript', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/ghostscript')>();
  return {
    ...real,
    ghostscript: async () => {
      if (gs.unreachable) throw new Error(gs.unreachable);
      return gs.live && !gs.stub
        ? real.ghostscript()
        : ({} as Awaited<ReturnType<typeof real.ghostscript>>);
    },
    run: async (
      args: string[],
      files: Record<string, Uint8Array>,
      options: { outputs?: string[] } = {},
    ) => {
      // Copy before delegating: Emscripten's `callMain` prepends its own program
      // name to the array it is handed, and the recorded vector must be the app's.
      gs.calls.push({ args: args.slice(), files: { ...files }, outputs: options.outputs ?? [] });
      if (gs.unreachable) throw new Error(gs.unreachable);
      if (gs.live && !gs.stub) return real.run(args, files, options);
      const out = options.outputs?.[0] ?? '/tmp/output.pdf';
      return {
        exitCode: 0,
        outputs: { [out]: gs.reply ?? files[Object.keys(files)[0]] },
        log: [] as string[],
      };
    },
  };
});

vi.mock('@/lib/pdf/engines/provider', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/provider')>();
  return {
    ...real,
    engines: {
      ...real.engines,
      // A directory, not a URL: the live block loads `gs.js` through the fetch stub
      // below and `gs.wasm` through Emscripten's own read (the same trick as
      // `font-outline.test.ts`). The stand-in cases never touch it.
      getUrl: () => `${gs.dir}${path.sep}`,
    },
  };
});

/* ── readers the assertions are built from ────────────────────────────────── */

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

function dictOf(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function streamOf(doc: PDFDocument, value: unknown): PDFRawStream | undefined {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFRawStream ? resolved : undefined;
}

/** The catalogue's output intent, as an outside reader would find it. */
function readIntent(doc: PDFDocument): {
  present: boolean;
  subtype: string;
  components: number | null;
  profileBytes: number;
  profileSpace: string;
} {
  const none = { present: false, subtype: '', components: null, profileBytes: 0, profileSpace: '' };
  const raw = doc.catalog.get(PDFName.of('OutputIntents'));
  if (raw === undefined) return none;
  const list = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  if (!(list instanceof PDFArray) || list.size() === 0) return none;
  const entry = dictOf(doc, list.get(0));
  if (!entry) return none;
  const profile = streamOf(doc, entry.get(PDFName.of('DestOutputProfile')));
  // Decoded: both paths store the profile as a Flate stream, and the claim under
  // test is the size of the ICC data, not of its compression.
  const bytes = profile ? decodePDFRawStream(profile).decode() : new Uint8Array(0);
  const declared = profile?.dict.get(PDFName.of('N'));
  return {
    present: true,
    subtype: `${entry.get(PDFName.of('S')) ?? ''}`.replace(/^\//, ''),
    components: declared instanceof PDFNumber ? declared.asNumber() : null,
    profileBytes: bytes.byteLength,
    // Bytes 16..20 of an ICC profile name its data colour space.
    profileSpace: bytes.byteLength >= 20 ? latin1(bytes.subarray(16, 20)) : '',
  };
}

/** `/MarkInfo << /Marked true >>`, as the catalogue states it. */
function readMarked(doc: PDFDocument): boolean {
  return `${dictOf(doc, doc.catalog.get(PDFName.of('MarkInfo')))?.get(PDFName.of('Marked')) ?? ''}` === 'true';
}

/**
 * Every distinct face in the page resources, and which key carries its program.
 *
 * Deduped by `/BaseFont`, the way the tool's own audit is: a shared resource dict
 * on two pages is one font, not two.
 */
function readFonts(doc: PDFDocument): Array<{ name: string; program: string | null }> {
  const found = new Map<string, string | null>();
  const programOn = (dict?: PDFDict): string | null =>
    (dict
      ? (['FontFile', 'FontFile2', 'FontFile3'].find((key) => dict.get(PDFName.of(key)) !== undefined) ?? null)
      : null);
  for (const page of doc.getPages()) {
    const fonts = dictOf(doc, dictOf(doc, page.node.Resources())?.get(PDFName.of('Font')));
    if (!fonts) continue;
    for (const [, value] of fonts.entries()) {
      const dict = dictOf(doc, value);
      if (!dict) continue;
      const rawDescendants = dict.get(PDFName.of('DescendantFonts'));
      const descendants = rawDescendants instanceof PDFRef
        ? doc.context.lookup(rawDescendants)
        : rawDescendants;
      const child = descendants instanceof PDFArray ? dictOf(doc, descendants.get(0)) : undefined;
      const program = programOn(dict)
        ?? programOn(dictOf(doc, dict.get(PDFName.of('FontDescriptor'))))
        ?? programOn(dictOf(doc, child?.get(PDFName.of('FontDescriptor'))));
      const name = `${dict.get(PDFName.of('BaseFont')) ?? ''}`.replace(/^\//, '');
      if (!found.has(name)) found.set(name, program);
    }
  }
  return [...found.entries()].map(([name, program]) => ({ name, program }));
}

/** Image soft masks and graphic states with alpha: the transparency part 1 forbids. */
function readTransparency(doc: PDFDocument): { softMasks: number; alphaStates: number } {
  let softMasks = 0;
  let alphaStates = 0;
  const look = (dict: PDFDict | PDFRawStream | undefined) => {
    const target = dict instanceof PDFRawStream ? dict.dict : dict;
    if (!target) return;
    if (target.get(PDFName.of('SMask')) !== undefined) softMasks += 1;
    if (`${target.get(PDFName.of('Type'))}` !== '/ExtGState') return;
    for (const key of ['ca', 'CA']) {
      const value = target.get(PDFName.of(key));
      if (value instanceof PDFNumber && value.asNumber() < 1) {
        alphaStates += 1;
        break;
      }
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict || object instanceof PDFRawStream) look(object);
  }
  // pdf-lib keeps an inline graphic state in the page's own resource dictionary.
  for (const page of doc.getPages()) {
    const resources = dictOf(doc, page.node.Resources());
    const states = dictOf(doc, resources?.get(PDFName.of('ExtGState')));
    if (!states) continue;
    for (const [, value] of states.entries()) look(dictOf(doc, value));
  }
  return { softMasks, alphaStates };
}

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** Five bytes of `%PDF-` are enough for an argv pin: the double runs no converter. */
const SAMPLE = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

const pdfFileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

/** Two pages of drawn Helvetica at two page sizes — the campaign fixture's shape. */
async function textPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const size of [[595.28, 841.89], [612, 792]] as Array<[number, number]>) {
    const page = doc.addPage(size);
    page.drawText('PDASTRUCTURE probe line', { x: 54, y: size[1] - 110, size: 14, font });
  }
  doc.setProducer('fixture');
  return doc.save({ useObjectStreams: false });
}

/**
 * A face with its program in each legal place, one subset, one bare reference.
 *
 * The shapes are the ones real producers write — the third is exactly what
 * Ghostscript emits and what the old audit called missing — and they are built
 * with plain `save()` so that reading them back needs no object-stream decoding.
 */
async function fiveFontsPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Two pages, so an engine reply in this shape survives the tool's own page
  // count check; the audit dedupes by `/BaseFont`, so five faces stay five.
  const pages = [doc.addPage([595.28, 841.89]), doc.addPage([612, 792])];
  const ctx = doc.context;
  const program = () => ctx.register(ctx.flateStream(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {}));
  // Each face goes straight into the resource dictionary: `ctx.obj` picks its
  // literal overload from the argument's own type, which a collected array loses.
  const fontDict = ctx.obj({});

  // 1. A producer that puts the program on the font dictionary itself.
  fontDict.set(PDFName.of('F1'), ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: PDFName.of('LegacyNoTag'),
    FontFile2: program(), FirstChar: 32, LastChar: 126, Widths: [500],
  })));
  // 2. The common shape: a TrueType program on the descriptor.
  fontDict.set(PDFName.of('F2'), ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'TrueType', BaseFont: PDFName.of('DescriptorTT'),
    FontDescriptor: ctx.register(ctx.obj({
      Type: 'FontDescriptor', FontName: PDFName.of('DescriptorTT'), Flags: 32, FontFile2: program(),
    })),
    FirstChar: 32, LastChar: 126, Widths: [500],
  })));
  // 3. Ghostscript's shape: CFF in `/FontFile3` on the descriptor, subset tag on the
  //    name. Finding 2 is this face being called "0 of 1 embedded".
  fontDict.set(PDFName.of('F3'), ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type1', BaseFont: PDFName.of('NBLSWY+Helvetica'),
    FontDescriptor: ctx.register(ctx.obj({
      Type: 'FontDescriptor', FontName: PDFName.of('NBLSWY+Helvetica'), Flags: 32, FontFile3: program(),
    })),
    FirstChar: 32, LastChar: 126, Widths: [500],
  })));
  // 4. A composite: the program hangs off the *descendant's* descriptor.
  fontDict.set(PDFName.of('F4'), ctx.register(ctx.obj({
    Type: 'Font', Subtype: 'Type0', BaseFont: PDFName.of('AAAAAA+SubsetCID'),
    Encoding: PDFName.of('Identity-H'),
    DescendantFonts: [ctx.register(ctx.obj({
      Type: 'Font', Subtype: 'CIDFontType2', BaseFont: PDFName.of('AAAAAA+SubsetCID'),
      CIDSystemInfo: { Registry: 'Adobe', Ordering: 'Identity', Supplement: 0 },
      FontDescriptor: ctx.register(ctx.obj({
        Type: 'FontDescriptor', FontName: PDFName.of('AAAAAA+SubsetCID'), Flags: 4, FontFile2: program(),
      })),
      DW: 1000,
    }))],
  })));
  // 5. A standard-14 reference with no program anywhere: genuinely not embedded.
  fontDict.set(PDFName.of('F5'), ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: PDFName.of('Helvetica') })));

  const resources = ctx.obj({});
  resources.set(PDFName.of('Font'), fontDict);
  resources.set(PDFName.of('ExtGState'), ctx.obj({
    GS1: ctx.obj({ Type: 'ExtGState', ca: 0.5, CA: 0.5 }),
  }));
  const registered = ctx.register(resources);
  for (const page of pages) page.node.set(PDFName.of('Resources'), registered);
  return doc.save({ useObjectStreams: false });
}

/** An alpha image (an `/SMask` on its stream) plus one inline alpha graphic state. */
async function alphaPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const image = await doc.embedPng(await rgbaPngBytes());
  page.drawImage(image, { x: 54, y: 600, width: 120, height: 120 });
  page.drawRectangle({ x: 54, y: 400, width: 120, height: 100, opacity: 0.5 });
  // No object streams: the assertions read these dictionaries straight back.
  return doc.save({ useObjectStreams: false });
}

/** The smallest honest RGBA PNG, written here so the test owns its bytes. */
async function rgbaPngBytes(): Promise<Uint8Array> {
  const zlib = await import('node:zlib');
  const width = 2;
  const height = 2;
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw.set([200, 30, 30, (x + y) % 2 === 0 ? 255 : 90], y * (1 + width * 4) + 1 + x * 4);
    }
  }
  const chunks: Buffer[] = [];
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((zlib as unknown as { crc32(buf: Buffer, seed?: number): number }).crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]), 0) >>> 0, 0);
    chunks.push(length, Buffer.from(type, 'latin1'), data, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  chunk('IHDR', ihdr);
  chunk('IDAT', zlib.deflateSync(raw));
  chunk('IEND', Buffer.alloc(0));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
  ]));
}

/* ── 1. the invocation ────────────────────────────────────────────────────── */

const call = () => gs.calls[gs.calls.length - 1];
const written = (record: Record<string, Uint8Array>) => Object.keys(record).sort();

describe('convertToPdfA’s command line', () => {
  beforeEach(() => {
    gs.calls.length = 0;
    gs.reply = null;
    gs.unreachable = null;
    gs.stub = true;
    resetEngines();
  });
  afterEach(() => {
    gs.unreachable = null;
  });

  it('sends a prefix prolog and an ICC profile into the sandbox with the document', async () => {
    await convertToPdfA(SAMPLE, '2b', {});
    const { args, files } = call();
    const dump = process.env.BROWSERSNIP_PDFA_DUMP;
    if (dump) {
      // `docs/research/pdfa-invocation.mjs` replays exactly this vector, files and
      // all, through the published WASM build — so the proof quotes what the source
      // built rather than a command line retyped into a shell.
      fs.mkdirSync(dump, { recursive: true });
      fs.writeFileSync(`${dump}/argv.json`, `${JSON.stringify({ tool: 'convertToPdfA (pdf-to-pdfa)', args }, null, 2)}\n`);
      for (const [name, bytes] of Object.entries(files)) {
        if (name === '/tmp/input.pdf') continue;
        fs.writeFileSync(`${dump}/${path.basename(name)}`, Buffer.from(bytes));
      }
    }
    const names = written(files);
    const prolog = names.find((name) => name.endsWith('.ps'));
    const profile = names.find((name) => /\.(icc|icm)$/.test(name));
    expect(prolog, `no prolog among ${names.join(', ')} — ${JSON.stringify(args)}`).toBeTruthy();
    expect(profile, `no ICC file among ${names.join(', ')}`).toBeTruthy();
    // The document itself is the only other thing the run is given.
    expect(names).toEqual(['/tmp/input.pdf', profile!, prolog!].sort());

    const text = latin1(files[prolog!]);
    // What PDF/A §6.2.11.4 and §6.2.11 ask for, spelled in the pdfmarks that ask.
    expect(text).toMatch(/\/Type\s+\/OutputIntent/);
    expect(text).toMatch(/\/S\s+\/GTS_PDFA1/);
    expect(text).toMatch(/\/DestOutputProfile\s+\{icc_PDFA\}/);
    expect(text).toMatch(/\/N\s+3/);
    expect(text).toMatch(/\/MarkInfo\s+<<\s*\/Marked\s+true\s*>>/);
    expect(text).toMatch(/\/OutputConditionIdentifier\s+\(sRGB IEC61966-2\.1\)/);
    // The profile the prolog names is the one written next to it, byte for byte.
    expect(text).toContain(profile!);
    expect(latin1(files[profile!])).toBe(latin1(srgbIccProfile()));
  });

  it('names the output file before the prolog, because the prolog opens the device', async () => {
    await convertToPdfA(SAMPLE, '2b', {});
    const { args, files } = call();
    const prolog = Object.keys(files).find((name) => name.endsWith('.ps'))!;
    const profile = Object.keys(files).find((name) => /\.(icc|icm)$/.test(name))!;
    const output = args.findIndex((arg) => arg.startsWith('-sOutputFile='));
    expect(output).toBeGreaterThanOrEqual(0);
    expect(args.indexOf(prolog), `prolog at ${args.indexOf(prolog)}, -sOutputFile at ${output}`)
      .toBeGreaterThan(output);
    // The profile is data for the prolog to open, not a job for the interpreter:
    // naming it on the command line makes Ghostscript read ICC bytes as PostScript
    // and the run dies before it converts anything.
    expect(args, JSON.stringify(args)).not.toContain(profile);
    expect(args.filter((arg) => !arg.startsWith('-'))).toEqual([prolog, '/tmp/input.pdf']);
    expect(args[args.length - 1]).toBe('/tmp/input.pdf');
    // The class rule from `4ad2be3` still holds after the change.
    expect(args.filter((arg) => /^-s[^=]+$/.test(arg))).toEqual([]);
    expect(args).toContain('-dPDFA=2');
    // `/N 3` is only honest while the device space is RGB.
    expect(args).toContain('-sColorConversionStrategy=RGB');
    expect(args).toContain('-dPDFACompatibilityPolicy=1');
  });

  it('hands out a 476-byte sRGB profile whose own header agrees with its length', () => {
    const icc = srgbIccProfile();
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    expect(icc.byteLength).toBe(476);
    expect(view.getUint32(0)).toBe(icc.byteLength);
    expect(latin1(icc.subarray(16, 20))).toBe('RGB ');
    expect(latin1(icc.subarray(36, 40))).toBe('acsp');
  });

  it('asks each part for its own number and compatibility level', async () => {
    for (const [part, number, level] of [['1b', 1, '1.4'], ['2b', 2, '1.7'], ['3b', 3, '1.7']] as const) {
      gs.calls.length = 0;
      await convertToPdfA(SAMPLE, part, {});
      expect(call().args).toContain(`-dPDFA=${number}`);
      expect(call().args).toContain(`-dCompatibilityLevel=${level}`);
    }
  });

  it('leaves the outline and repair vectors alone', async () => {
    const seen: Array<[string, string[]]> = [];
    for (const [name, invoke] of [
      ['textToOutlines', () => textToOutlines(SAMPLE, {})],
      ['rebuildWithGhostscript', () => rebuildWithGhostscript(SAMPLE, {})],
    ] as Array<[string, () => Promise<unknown>]>) {
      gs.calls.length = 0;
      await invoke();
      const { args, files } = call();
      seen.push([name, args]);
      expect(written(files), name).toEqual(['/tmp/input.pdf']);
      expect(args.filter((arg) => arg.startsWith('-dPDFA')), name).toEqual([]);
      // No colour strategy is pinned, and none is needed: only the PDF/A verb has
      // an output intent whose `/N` has to agree with the device space.
      expect(args.filter((arg) => arg.startsWith('-sColorConversionStrategy')), name).toEqual([]);
      expect(args.indexOf('-sOutputFile=/tmp/output.pdf'), name).toBe(args.length - 2);
      expect(args[args.length - 1], name).toBe('/tmp/input.pdf');
    }
    expect(seen[0][1]).toContain('-dNoOutputFonts');
    expect(seen[1][1]).toContain('-dAutoFixDirtyXrefTables=true');
  });
});

/* ── 2. the “N of M embedded” figure, against the bytes it counts ─────────── */

async function pdfaRun(
  source: Uint8Array,
  name: string,
  values: Record<string, string>,
): Promise<{ outcome: RunOutcome; bytes: Uint8Array; doc: PDFDocument }> {
  const outcome = await runPdfTool({
    toolId: 'pdf-to-pdfa',
    files: [pdfFileOf(source, name)],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
  const bytes = await bytesOf(outcome.outputs[0].blob);
  return { outcome, bytes, doc: await openPDF(bytes, { ignoreEncryption: true, updateMetadata: false }) };
}

describe('the font audit behind “N of M embedded”', () => {
  beforeEach(() => {
    gs.calls.length = 0;
    gs.reply = null;
    gs.unreachable = 'Failed to load Ghostscript: no address answered';
    gs.stub = true;
    resetEngines();
  });
  afterEach(() => {
    gs.unreachable = null;
  });

  it('finds a program on the font dict, the descriptor and a descendant', async () => {
    const source = await fiveFontsPdf();
    const faces = readFonts(await openPDF(source, { ignoreEncryption: true, updateMetadata: false }));
    // The fixture is only worth having if the three places really differ.
    expect(faces.map((face) => face.program).sort()).toEqual(
      ['FontFile2', 'FontFile2', 'FontFile2', 'FontFile3', null].sort(),
    );

    const { outcome } = await pdfaRun(source, 'faces.pdf', { part: '2b' });
    const said = outcome.warnings.join(' ');
    // Four carry a program, one is a bare standard-14 reference.
    expect(said).toMatch(/1 of 5 font\(s\) are not embedded/);
    expect(said).not.toMatch(/2 of 5 font\(s\) are not embedded/);
    expect(said).not.toMatch(/5 of 5 font\(s\) are not embedded/);
  });

  it('counts a /FontFile3 subset through its descriptor, as the engine writes it', async () => {
    // Finding 2 in one case. The old audit read `/FontFile*` off the font
    // dictionary, so this face — program on the descriptor, subset tag on the
    // name — was reported to the user as not embedded.
    gs.unreachable = null;
    gs.reply = await fiveFontsPdf();
    const { outcome } = await pdfaRun(await textPdf(), 'type.pdf', { part: '2b' });
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    expect(outcome.message).toMatch(/4 of 5 font\(s\) embedded/);
    expect(outcome.message).not.toMatch(/0 of 5 font\(s\) embedded|1 of 5 font\(s\) embedded/);
    expect(outcome.warnings.join(' ')).toMatch(/1 of 5 font\(s\) in the output are still not embedded/);
  });
});

/* ── 3. what each path's catalogue carries ────────────────────────────────── */

describe('the structures PDF/A names, in the file each path writes', () => {
  beforeEach(() => {
    gs.calls.length = 0;
    gs.reply = null;
    gs.unreachable = 'Failed to load Ghostscript: no address answered';
    gs.stub = true;
    resetEngines();
  });
  afterEach(() => {
    gs.unreachable = null;
  });

  it('are all present on the local path, and the card names each one', async () => {
    const source = await textPdf();
    const { outcome, doc, bytes } = await pdfaRun(source, 'type.pdf', { part: '2b' });
    fs.writeFileSync('/tmp/pdfa-structure-fallback.pdf', Buffer.from(bytes));
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });

    const intent = readIntent(doc);
    expect(intent.present).toBe(true);
    expect(intent.subtype).toBe('GTS_PDFA1');
    expect(intent.components).toBe(3);
    expect(intent.profileBytes).toBe(476);
    expect(intent.profileSpace.trim()).toBe('RGB');
    expect(readMarked(doc)).toBe(true);
    expect(readXmp(doc)?.pdfaPart).toBe(2);
    expect(readXmp(doc)?.pdfaConformance).toBe('B');

    // The sentence and the catalogue agree — and neither says "valid".
    expect(outcome.message).toMatch(/an output intent in the catalogue \(GTS_PDFA1, 476 B RGB profile, \/N 3\)/);
    // Measured on this engine's own bytes: `pdfaid:part='2'`, single quotes. The
    // first version of the read-back matched only `pdfaid:part="2"`, the form this
    // app writes, so a Ghostscript run warned about an identification that was there.
    expect(outcome.warnings.join(' ')).not.toMatch(/no pdfaid:part in its XMP/);
    expect(outcome.message).toMatch(/the tagging flag/);
    expect(outcome.message).toMatch(/no validator ran, so conformance to ISO 19005 is not claimed/);
    expect(outcome.message).not.toMatch(/valid PDF\/A|conformant|passes ISO/i);
    expect(outcome.message).toContain('pdfaid:part=2, conformance=B');
  });

  it('name the part that was asked for, not the default one', async () => {
    const source = await textPdf();
    for (const [part, number] of [['1b', 1], ['3b', 3]] as const) {
      const { outcome, doc } = await pdfaRun(source, 'type.pdf', { part });
      expect(readXmp(doc)?.pdfaPart).toBe(number);
      expect(outcome.message).toContain(`pdfaid:part=${number}`);
    }
  });

  it('report transparency a part-1 run forbids, and stay quiet about it at 2b', async () => {
    const source = await alphaPdf();
    const before = readTransparency(await openPDF(source, { ignoreEncryption: true, updateMetadata: false }));
    expect(before.softMasks).toBeGreaterThan(0);
    expect(before.alphaStates).toBeGreaterThan(0);

    const one = await pdfaRun(source, 'alpha.pdf', { part: '1b' });
    expect(one.outcome.warnings.join(' '))
      .toMatch(/PDF\/A-1b does not allow transparency.*still carries \d+ image soft mask\(s\) and \d+ graphic state/);
    // …because the local path removes nothing: the same two entries the input had
    // are still in the file it hands over, and the sentence is about these bytes.
    expect(readTransparency(one.doc)).toEqual({ softMasks: 1, alphaStates: 1 });
    fs.writeFileSync('/tmp/pdfa-structure-fallback-alpha.pdf', Buffer.from(one.bytes));

    const two = await pdfaRun(source, 'alpha.pdf', { part: '2b' });
    expect(two.outcome.warnings.join(' ')).not.toMatch(/does not allow transparency/);
  });

  it('reads an identification quoted the way Ghostscript quotes it', async () => {
    // BrowserSnip writes `pdfaid:part="2"`; Ghostscript writes `pdfaid:part='2'`,
    // with single quotes through the whole packet. A hand-rolled pattern that
    // allowed only the double-quoted form told the user their Ghostscript file
    // carried no identification at all — which is how this case came to exist.
    const carrier = await openPDF(await textPdf(), { ignoreEncryption: true, updateMetadata: false });
    writeXmp(carrier, [
      '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>",
      '<rdf:Description rdf:about="" xmlns:pdfaid=\'http://www.aiim.org/pdfa/ns/id/\'',
      " pdfaid:part='3' pdfaid:conformance='B'/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>",
    ].join(''));
    gs.unreachable = null;
    gs.reply = await carrier.save({ useObjectStreams: false });
    const { outcome, doc } = await pdfaRun(await textPdf(), 'type.pdf', { part: '3b' });
    expect(readXmp(doc)?.pdfaPart).toBe(3);
    expect(outcome.warnings.join(' ')).not.toMatch(/no pdfaid:part in its XMP/);
    expect(outcome.message).toMatch(/no output intent in the catalogue/);
  });

  it('refuse to claim an intent that is not in the file they hand over', async () => {
    // Finding 1, kept honest for any future build: an engine reply whose
    // catalogue has no intent must be reported as having none.
    const reply = await textPdf();
    const opened = await openPDF(reply, { ignoreEncryption: true, updateMetadata: false });
    opened.catalog.delete(PDFName.of('Metadata'));
    opened.catalog.delete(PDFName.of('OutputIntents'));
    opened.catalog.delete(PDFName.of('MarkInfo'));
    gs.unreachable = null;
    gs.reply = await opened.save({ useObjectStreams: false });
    const { outcome } = await pdfaRun(await textPdf(), 'type.pdf', { part: '2b' });
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    expect(outcome.message).toMatch(/no output intent in the catalogue/);
    expect(outcome.message).toMatch(/no \/MarkInfo/);
    expect(outcome.warnings.join(' ')).toMatch(/No \/OutputIntents entry is in the catalogue/);
    expect(outcome.warnings.join(' ')).toMatch(/no pdfaid:part in its XMP/);
  });
});

/* ── 4. the published engine, when it is on disk ──────────────────────────── */

beforeAll(async () => {
  const wanted = process.env.BROWSERSNIP_GS === 'live'
    || (process.env.BROWSERSNIP_GS !== 'off' && !process.env.CI);
  if (!wanted) {
    gs.skipped = process.env.BROWSERSNIP_GS === 'off' ? 'BROWSERSNIP_GS=off' : 'this run keeps the suite offline';
    return;
  }
  for (const file of ['gs.js', 'gs.wasm']) {
    if (!fs.existsSync(path.join(gs.dir, file))) {
      gs.skipped = `${file} is not cached under ${gs.dir}`;
      return;
    }
  }
  URL.createObjectURL = (() => `file://${path.join(gs.dir, 'gs.js')}`) as typeof URL.createObjectURL;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const requested = String(input).replace(/^https?:\/\/[^/]+/, '');
    return new Response(fs.readFileSync(path.join(gs.dir, path.basename(requested))));
  });
  gs.live = true;
}, 240_000);

afterAll(() => {
  gs.live = false;
  gs.stub = true;
  vi.unstubAllGlobals();
});

describe('pdf-to-pdfa over the published Ghostscript build', () => {
  beforeEach(() => {
    gs.calls.length = 0;
    gs.reply = null;
    gs.unreachable = null;
    gs.stub = false;
    resetEngines();
  });

  it('writes the intent and the tagging flag that -dPDFA=2 alone did not', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the Ghostscript WASM build was not loaded');
    const source = await textPdf();
    fs.writeFileSync('/tmp/pdfa-structure-input.pdf', Buffer.from(source));
    const { outcome, bytes, doc } = await pdfaRun(source, 'type.pdf', { part: '2b' });

    // Whose file this is, and what it carries.
    expect(latin1(bytes)).toMatch(/GPL Ghostscript [0-9.]+/);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'ghostscript' });
    const intent = readIntent(doc);
    expect(intent.present, 'the engine wrote no /OutputIntents — finding 1 is back').toBe(true);
    expect(intent.subtype).toBe('GTS_PDFA1');
    expect(intent.components).toBe(3);
    expect(intent.profileBytes).toBe(476);
    expect(intent.profileSpace.trim()).toBe('RGB');
    expect(readMarked(doc)).toBe(true);
    expect(readXmp(doc)?.pdfaPart).toBe(2);
    expect(readXmp(doc)?.pdfaConformance).toBe('B');

    // Fonts: finding 2 on the engine's own bytes. Helvetica is substituted,
    // subset, and its program lands on the descriptor — never on the font dict.
    const faces = readFonts(doc);
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.map((face) => face.program)).toEqual(faces.map(() => 'FontFile3'));
    expect(faces.every((face) => /^[A-Z]{6}\+/.test(face.name))).toBe(true);
    expect(outcome.message).toMatch(/font\(s\) embedded, an output intent in the catalogue/);
    expect(outcome.warnings.join(' ')).not.toMatch(/not embedded/);

    // Same pages, same boxes: a conversion rewrites, it does not re-impose.
    expect(outcome.pagesOut).toBe(2);
    const before = await openPDF(source, { ignoreEncryption: true, updateMetadata: false });
    expect(doc.getPages().map((page) => [page.getWidth(), page.getHeight()]))
      .toEqual(before.getPages().map((page) => [page.getWidth(), page.getHeight()]));

    fs.writeFileSync('/tmp/pdfa-structure-engine.pdf', bytes);
    console.log(`[pdfa] card: ${outcome.message}`);
    console.log(`[pdfa] warnings: ${outcome.warnings.join(' | ') || 'none'}`);
    console.log(
      `[pdfa] engine ${bytes.byteLength} B from ${source.byteLength} B: GTS_PDFA1 intent, `
      + `${intent.profileBytes} B /N ${intent.components} profile, MarkInfo ${readMarked(doc)}, `
      + `fonts ${faces.map((face) => `${face.name}:${face.program}`).join(' ')}`,
    );
  }, 240_000);

  it('removes the transparency a part-1 run may not carry', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the Ghostscript WASM build was not loaded');
    const source = await alphaPdf();
    const { outcome, bytes, doc } = await pdfaRun(source, 'alpha.pdf', { part: '1b' });
    const after = readTransparency(doc);
    expect(outcome.warnings.join(' ')).not.toMatch(/does not allow transparency/);
    expect(after.softMasks, `the engine left soft masks behind: ${JSON.stringify(after)}`).toBe(0);
    expect(latin1(bytes)).toMatch(/GPL Ghostscript/);
    expect(readIntent(doc).present).toBe(true);
    console.log(
      `[pdfa] part 1b alpha fixture ${source.byteLength} B → ${bytes.byteLength} B, `
      + `transparency ${JSON.stringify(after)}`,
    );
  }, 240_000);

  it('still ships the same structures when the engine is refused', async (ctx) => {
    if (!gs.live) ctx.skip(gs.skipped || 'the Ghostscript WASM build was not loaded');
    gs.stub = true;
    gs.unreachable = 'Failed to load Ghostscript: the CDN is not contacted from this rig';
    resetEngines();
    const source = await textPdf();
    const { outcome, bytes, doc } = await pdfaRun(source, 'type.pdf', { part: '2b' });
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'ghostscript' });
    expect(latin1(bytes)).not.toMatch(/GPL Ghostscript/);
    expect(readIntent(doc).present).toBe(true);
    expect(readMarked(doc)).toBe(true);
    gs.unreachable = null;
  }, 240_000);
});
