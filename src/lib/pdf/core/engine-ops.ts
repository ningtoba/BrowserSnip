/**
 * High-level operations built on the optional CDN engines.
 *
 * `src/lib/pdf/engines/*` types the raw module surfaces (PyMuPDF, Ghostscript,
 * CoherentPDF) and resolves their addresses; this module turns them into the
 * handful of verbs the tools need, and is the only place that knows which
 * capability requires which engine.
 *
 * There is no engine UI and nothing to enable. Every operation here calls
 * `requireEngine` first, which fetches the module from the resolved address —
 * the built-in jsDelivr default unless a trusted mirror is stored — on first
 * use and reuses it afterwards. Nothing is fetched at page load: these are
 * 0.5–54 MB downloads, so they only ever start behind a run the user asked
 * for. Pass `onStatus` so a run's log says what it is waiting on.
 *
 * When the fetch fails (offline, blocked CDN, dead mirror) `requireEngine`
 * throws `EngineUnavailable`, whose message names the engine, the host and the
 * reason. A caller with a degraded path catches it and reports one honest
 * sentence through `result.warnings`; a caller with no fallback lets it reach
 * the user as the error. Files never leave the device — the engine binary is
 * what is fetched.
 *
 * A caller also says which bytes it kept, on `ToolResult.producedBy`: the engine's
 * own (`{ via: 'engine' }`, handed back by the verb that ran) or its local path's
 * (`{ via: 'fallback' }`, including where the engine ran and its output was thrown
 * away). The result card prints that field and nothing else — it used to print
 * `tool.engines[0]`, which credited the engine for runs it never wrote.
 */
import {
  EngineUnavailable,
  ensureEngine,
  engines,
  run as gsRun,
} from '../engines';
import type { CpdfApi, CpdfDocument, EngineId, PyMuPDFInstance } from '../engines';
import { srgbIccProfile } from './metadata';
import type { ByteSource } from '../tools/types';

export type { EngineId };

/** Lets a long download explain itself instead of looking like a hang. */
export interface EngineHooks {
  onStatus?: (line: string) => void;
}

/** Is this engine fetchable at all, i.e. does it have an address? */
export function engineReady(id: EngineId): boolean {
  return engines.isConfigured(id);
}

/** A short, human explanation of what an engine buys the user. */
export function enginePurpose(id: EngineId): string {
  return (
    {
      pymupdf:
        'PyMuPDF — high-fidelity text, table and image extraction, plus advanced conversion.',
      ghostscript: 'Ghostscript — PDF/A conversion and turning fonts into vector outlines.',
      cpdf: 'CoherentPDF — conforming linearization, bookmark and permission editing.',
    } as Record<EngineId, string>
  )[id];
}

/**
 * Resolve and load an engine now, or throw with the reason it could not.
 *
 * This is the only place the loaders are called from, so a tool cannot start a
 * second download for a module the tab already has. The loaders memoise the
 * live instance; a *failure* is not memoised, so being offline once does not
 * poison the tab.
 */
async function provideEngine(id: EngineId, hooks: EngineHooks = {}): Promise<unknown> {
  const provision = await ensureEngine(id, hooks);
  if (!provision.ok) throw new EngineUnavailable(id, provision.reason);
  return provision.module;
}

async function requireEngine(id: EngineId, hooks: EngineHooks = {}): Promise<void> {
  await provideEngine(id, hooks);
}

// ── Ghostscript ─────────────────────────────────────────────────────────────

const GS_SANDBOX_IN = '/tmp/input.pdf';
const GS_SANDBOX_OUT = '/tmp/output.pdf';
/** The PDF/A prefix prolog and the profile it reads, both written per run. */
const GS_SANDBOX_PDFA_PS = '/tmp/pdfa_prefix.ps';
const GS_SANDBOX_PDFA_ICC = '/tmp/pdfa_profile.icc';

interface GsOutcome {
  bytes: Uint8Array;
  log: string[];
  /**
   * Handed back by the call that ran, so the caller credits the engine it *used*
   * rather than the one its definition declares — the latter is how a file written
   * by a local fallback came to carry a Ghostscript attribution.
   */
  producedBy: ByteSource;
}

/**
 * Finish a Ghostscript command line.
 *
 * Ghostscript reads a string parameter as ONE argument, `-sName=value`. Handing
 * it `-sOutputFile` in its own argument slot sets the parameter to the empty
 * string, so the device opens with nowhere to write and the run dies before it
 * reads a page:
 *
 *   GPL Ghostscript 10.06.0: Device 'pdfwrite' requires an output file but no
 *   file was specified. / **** Unable to open the initial device, quitting.
 *
 * The output path and the input path are therefore appended here, against the
 * same constants `runGhostscript` writes and reads back, so no call site can
 * split the switch from its value or point the device at a path the sandbox
 * never collects.
 *
 * A prefix file (`pdfaProlog`, below) is itself a job, so it goes *after*
 * `-sOutputFile` and *before* the input. Measured through the published WASM
 * build: the same vector with the prolog ahead of `-sOutputFile` dies with the
 * exact sentence above, because the pdfmark's `setpagedevice` opens the device
 * before any output file has been named.
 */
function gsCommandLine(switches: string[], prefixFiles: string[] = []): string[] {
  return [...switches, `-sOutputFile=${GS_SANDBOX_OUT}`, ...prefixFiles, GS_SANDBOX_IN];
}

/**
 * The pdfmark prefix that gives `-dPDFA=N` the half of PDF/A it does not write.
 *
 * `-dPDFA=N` alone makes `pdfwrite` *identify* a file — its XMP carries
 * `pdfaid:part`/`pdfaid:conformance` — and stop there: measured on the campaign's
 * `type.pdf`, the engine's catalogue had no `/OutputIntents` and no `/MarkInfo`, so
 * the path that reported success shipped the less conformant file of the two
 * (`docs/research/pdfa-attribution-recheck.md` §2). PDF/A-2 §6.2.11.4 wants an
 * output intent; §6.2.11 wants the document marked.
 *
 * Ghostscript's mechanism for that half is a pdfmark prefix file — `lib/PDFA_def.ps`
 * in a disk build. The WASM build has no such file to read: its `/tmp` starts empty
 * and every resource is compiled into the binary (checked with `FS.readdir` on the
 * cached `gs.wasm`: 17 entries, no `.ps` and no `.icc`). So the app writes its own
 * prolog and its own profile into the sandbox for the run — same pdfmarks, fewer of
 * them, and `/N 3` fixed to match `-sColorConversionStrategy=RGB` and
 * `srgbIccProfile()` rather than guessed from the device.
 *
 * If the profile cannot be opened the `stopped` branch prints and `cleartomark`s:
 * the run still produces a file, just without the intent, and the caller reads that
 * back off the catalogue instead of trusting this string.
 */
function pdfaProlog(): string {
  return [
    '%!',
    `% BrowserSnip PDF/A prefix: an sRGB output intent and the tagging flag.`,
    `/ICCProfile (${GS_SANDBOX_PDFA_ICC}) def`,
    '[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark',
    '[{icc_PDFA} <</N 3>> /PUT pdfmark',
    '[{icc_PDFA}',
    '{ICCProfile (r) file} stopped',
    '{ (BrowserSnip: the ICC profile could not be read) print cleartomark }',
    '{ /PUT pdfmark',
    '  [/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark',
    '  [{OutputIntent_PDFA} <<',
    '    /Type /OutputIntent',
    '    /S /GTS_PDFA1',
    '    /DestOutputProfile {icc_PDFA}',
    '    /OutputConditionIdentifier (sRGB IEC61966-2.1)',
    '    /RegistryName (http://www.color.org)',
    '    /Info (sRGB IEC61966-2.1 (minimal profile written by BrowserSnip))',
    '  >> /PUT pdfmark',
    '  [{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark',
    '  [{Catalog} <</MarkInfo << /Marked true >> >> /PUT pdfmark',
    '} ifelse',
    '',
  ].join('\n');
}

async function runGhostscript(
  switches: string[],
  input: Uint8Array,
  hooks: EngineHooks = {},
  prefix: { files: Record<string, Uint8Array>; jobs?: string[] } = { files: {} },
): Promise<GsOutcome> {
  await requireEngine('ghostscript', hooks);
  const result = await gsRun(
    gsCommandLine(switches, prefix.jobs ?? []),
    { [GS_SANDBOX_IN]: input, ...prefix.files },
    { outputs: [GS_SANDBOX_OUT] },
  );
  const output = result.outputs[GS_SANDBOX_OUT];
  const warnings = result.log.filter((line) => /error|cannot|failed|unable/i.test(line));
  if (!output || output.byteLength === 0) {
    throw new Error(
      `Ghostscript produced no output (exit ${result.exitCode}). ${warnings.slice(0, 3).join(' ')}`.trim(),
    );
  }
  return { bytes: output, log: warnings, producedBy: { via: 'engine', engine: 'ghostscript' } };
}

/**
 * Convert to PDF/A.
 *
 * Three things make the difference between an identified file and one whose
 * catalogue says what PDF/A requires, and all three are measured through the
 * published WASM build rather than assumed from a manual page:
 *
 *   * `pdfaProlog()` — the pdfmark prefix that writes `/OutputIntents` (with the
 *     476-byte sRGB profile `srgbIccProfile()` generates) and `/MarkInfo`;
 *   * `-sColorConversionStrategy=RGB` — the output intent declares an RGB
 *     alternative, so the device space has to be RGB for `/N 3` to be true;
 *   * `-dPDFACompatibilityPolicy=1` — keep going and report the reasons instead
 *     of aborting on the first violation, which is what a user handing over their
 *     own file needs. It is not a validator: measured on these fixtures its log is
 *     empty, which is "nothing reported", not "passed".
 */
export async function convertToPdfA(
  bytes: Uint8Array,
  part: '1b' | '2b' | '3b' | string,
  hooks?: EngineHooks,
): Promise<GsOutcome> {
  const number = Number.parseInt(part, 10) || 2;
  const compatibility = number >= 2 ? '1.7' : '1.4';
  return runGhostscript([
    '-dQUIET',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-dPARANOIDSAFER',
    `-dPDFA=${number}`,
    '-dPDFACompatibilityPolicy=1',
    '-sDEVICE=pdfwrite',
    `-dCompatibilityLevel=${compatibility}`,
    '-dAutoRotatePages=/None',
    '-sColorConversionStrategy=RGB',
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageResolution=300',
    '-dGrayImageResolution=300',
    '-dMonoImageResolution=600',
    '-dEmbedAllFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
  ], bytes, hooks, {
    // Only the prolog is a job. Naming the profile on the command line as well —
    // which handing `Object.keys(files)` to `gsCommandLine` does — makes
    // Ghostscript try to *interpret* the ICC bytes as PostScript: measured, the run
    // dies at exit 1 with "Current allocation mode is local / Current file position
    // is 11" and the tool silently falls back.
    files: {
      [GS_SANDBOX_PDFA_PS]: new TextEncoder().encode(pdfaProlog()),
      [GS_SANDBOX_PDFA_ICC]: srgbIccProfile(),
    },
    jobs: [GS_SANDBOX_PDFA_PS],
  });
}

/**
 * Turn every glyph into a vector path with `-dNoOutputFonts`, so the file
 * renders identically without any font on the machine.
 */
export async function textToOutlines(
  bytes: Uint8Array,
  hooks?: EngineHooks,
): Promise<GsOutcome> {
  return runGhostscript([
    '-dQUIET',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dNoOutputFonts',
    '-dCompatibilityLevel=1.7',
    '-dAutoRotatePages=/None',
    '-dColorConversionStrategy=/LeaveColorUnchanged',
  ], bytes, hooks);
}

/** Ghostscript's own lossless rewrite, used as a repair last resort. */
export async function rebuildWithGhostscript(
  bytes: Uint8Array,
  hooks?: EngineHooks,
): Promise<GsOutcome> {
  return runGhostscript([
    '-dQUIET',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    '-dAutoFixDirtyXrefTables=true',
    '-dDoThumbnails=false',
  ], bytes, hooks);
}

// ── CoherentPDF ─────────────────────────────────────────────────────────────

/**
 * CoherentPDF's API is synchronous and manually managed, so every document
 * handle created here is released in the `finally` block — leaking one per run
 * grows the WASM heap for the rest of the session.
 */
async function withCpdf<T>(
  bytes: Uint8Array,
  password: string | undefined,
  body: (api: CpdfApi, pdf: CpdfDocument) => T,
  hooks: EngineHooks = {},
): Promise<T> {
  const api = (await provideEngine('cpdf', hooks)) as CpdfApi;
  let pdf: CpdfDocument | undefined;
  try {
    pdf = api.fromMemory(bytes, password ?? '');
    return body(api, pdf);
  } finally {
    if (pdf) api.deletePdf(pdf);
  }
}

/**
 * Conforming linearized ("Optimize for fast Web view") output.
 *
 * Returns raw bytes rather than a `GsOutcome`: the caller stamps the attribution on
 * the branch that keeps them, which is the branch that knows whether it did.
 */
export async function linearizeWithCpdf(
  bytes: Uint8Array,
  password?: string,
  hooks?: EngineHooks,
): Promise<Uint8Array> {
  return withCpdf(bytes, password, (api, pdf) => api.toMemory(pdf, true, false), hooks);
}

/** Compress + remove duplicate objects, without touching the image pixels. */
export async function compressWithCpdf(
  bytes: Uint8Array,
  password?: string,
  hooks?: EngineHooks,
): Promise<Uint8Array> {
  return withCpdf(bytes, password, (api, pdf) => {
    api.compress(pdf);
    return api.toMemory(pdf, false, false);
  }, hooks);
}

export interface CpdfOutlineEntry {
  level: number;
  page: number;
  title: string;
  open: boolean;
}

/** Read the bookmark tree. CoherentPDF walks it with a start/end pair. */
export async function readBookmarksWithCpdf(
  bytes: Uint8Array,
  password?: string,
  hooks?: EngineHooks,
): Promise<CpdfOutlineEntry[]> {
  return withCpdf(bytes, password, (api, pdf) => {
    const entries: CpdfOutlineEntry[] = [];
    api.startGetBookmarkInfo(pdf);
    try {
      const count = api.numberBookmarks();
      for (let i = 0; i < count; i++) {
        entries.push({
          level: api.getBookmarkLevel(i),
          page: api.getBookmarkPage(pdf, i),
          title: api.getBookmarkText(i),
          open: api.getBookmarkOpenStatus(i),
        });
      }
    } finally {
      api.endGetBookmarkInfo();
    }
    return entries;
  }, hooks);
}

/** List the fonts CoherentPDF finds, used by the font and PDF/A reports. */
export async function listFontsWithCpdf(
  bytes: Uint8Array,
  password?: string,
  hooks?: EngineHooks,
): Promise<{ name: string; page: string; type: string; encoding: string }[]> {
  return withCpdf(bytes, password, (api, pdf) => {
    const fonts: { name: string; page: string; type: string; encoding: string }[] = [];
    const count = api.numberFonts(pdf);
    for (let i = 0; i < count; i++) {
      fonts.push({
        name: api.getFontName(i),
        page: api.getFontPage(i),
        type: api.getFontType(i),
        encoding: api.getFontEncoding(i),
      });
    }
    return fonts;
  }, hooks);
}

// ── PyMuPDF ─────────────────────────────────────────────────────────────────

/**
 * Open a document with PyMuPDF. It accepts a `Blob`, so the bytes are wrapped
 * rather than passed raw. The caller must `close()` the document.
 */
export async function openWithPyMuPDF(
  bytes: Uint8Array,
  password?: string,
  hooks?: EngineHooks,
) {
  const instance = (await provideEngine('pymupdf', hooks)) as PyMuPDFInstance;
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const doc = await instance.open(blob);
  if (doc.needsPass) {
    if (!password || !doc.authenticate(password)) {
      doc.close();
      throw new Error('This PDF needs a password before PyMuPDF can read it.');
    }
  }
  return { instance, doc };
}

export interface PyMuPdfSaveOptions {
  password?: string;
  clean?: boolean;
  deflate?: boolean;
  garbage?: number;
}

/** PyMuPDF's own lossy-free structural cleanup (garbage collect + deflate). */
export async function scrubWithPyMuPDF(
  bytes: Uint8Array,
  options: PyMuPdfSaveOptions & { onStatus?: (line: string) => void } = {},
): Promise<Uint8Array> {
  const { onStatus, ...save } = options;
  const { doc } = await openWithPyMuPDF(bytes, save.password, { onStatus });
  try {
    return doc.save({
      garbage: save.garbage ?? 3,
      deflate: save.deflate ?? true,
      clean: save.clean ?? true,
    });
  } finally {
    doc.close();
  }
}

/**
 * Straighten scanned pages with the engine's OpenCV-based deskew, which runs
 * on the whole document in one call and reports the angle it chose per page.
 */
export async function deskewWithPyMuPDF(
  bytes: Uint8Array,
  options: {
    password?: string;
    maxAngle?: number;
    threshold?: number;
    dpi?: number;
    pages?: number[];
    onStatus?: (line: string) => void;
  } = {},
): Promise<{ bytes: Uint8Array; angles: number[]; corrected: number[] }> {
  const { onStatus, ...deskew } = options;
  const instance = (await provideEngine('pymupdf', { onStatus })) as PyMuPDFInstance;
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const { pdf, result } = await instance.deskewPdf(blob, {
    maxAngle: deskew.maxAngle ?? 15,
    threshold: deskew.threshold,
    dpi: deskew.dpi,
    pages: deskew.pages,
  });
  const corrected = result.corrected
    .map((wasCorrected, index) => (wasCorrected ? index + 1 : 0))
    .filter((page) => page > 0);
  return {
    bytes: new Uint8Array(await pdf.arrayBuffer()),
    angles: result.angles,
    corrected,
  };
}

export { EngineUnavailable };
