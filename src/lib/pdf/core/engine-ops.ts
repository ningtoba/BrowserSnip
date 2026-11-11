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
 */
import {
  EngineUnavailable,
  ensureEngine,
  engines,
  run as gsRun,
} from '../engines';
import type { CpdfApi, CpdfDocument, EngineId, PyMuPDFInstance } from '../engines';

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

interface GsOutcome {
  bytes: Uint8Array;
  log: string[];
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
 */
function gsCommandLine(switches: string[]): string[] {
  return [...switches, `-sOutputFile=${GS_SANDBOX_OUT}`, GS_SANDBOX_IN];
}

async function runGhostscript(
  switches: string[],
  input: Uint8Array,
  hooks: EngineHooks = {},
): Promise<GsOutcome> {
  await requireEngine('ghostscript', hooks);
  const result = await gsRun(
    gsCommandLine(switches),
    { [GS_SANDBOX_IN]: input },
    { outputs: [GS_SANDBOX_OUT] },
  );
  const output = result.outputs[GS_SANDBOX_OUT];
  const warnings = result.log.filter((line) => /error|cannot|failed|unable/i.test(line));
  if (!output || output.byteLength === 0) {
    throw new Error(
      `Ghostscript produced no output (exit ${result.exitCode}). ${warnings.slice(0, 3).join(' ')}`.trim(),
    );
  }
  return { bytes: output, log: warnings };
}

/**
 * Convert to PDF/A. `-dPDFACompatibilityPolicy=1` keeps going and reports the
 * reasons instead of aborting on the first violation, which is what a user
 * uploading their own file needs.
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
    '-dColorImageDownsampleType=/Bicubic',
    '-dColorImageResolution=300',
    '-dGrayImageResolution=300',
    '-dMonoImageResolution=600',
    '-dEmbedAllFonts=true',
    '-dSubsetFonts=true',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
  ], bytes, hooks);
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

/** Conforming linearized ("Optimize for fast Web view") output. */
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
