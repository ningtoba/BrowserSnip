/**
 * High-level operations built on the optional CDN engines.
 *
 * `src/lib/pdf/engines/*` types the raw module surfaces (PyMuPDF, Ghostscript,
 * CoherentPDF). This module turns them into the handful of verbs the tools
 * need, and is the only place that knows which capability requires which
 * engine, so a tool can say *why* it needs a download.
 *
 * Every function here is optional: callers must check `engineReady(id)` first
 * and provide a degraded path or a clear message. Files never leave the
 * device — the engine binary is what is fetched.
 */
import {
  EngineUnavailable,
  cpdf,
  cpdfConfigured,
  engines,
  ghostscript,
  ghostscriptConfigured,
  pymupdf,
  pymupdfConfigured,
  run as gsRun,
} from '../engines';
import type { CpdfDocument, EngineId } from '../engines';

export type { EngineId };

/** Is the engine reachable without the user opening settings? */
export function engineReady(id: EngineId): boolean {
  return engines.isConfigured(id);
}

export const ENGINE_IS_CONFIGURED: Record<EngineId, () => boolean> = {
  pymupdf: pymupdfConfigured,
  ghostscript: ghostscriptConfigured,
  cpdf: cpdfConfigured,
};

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

// ── Ghostscript ─────────────────────────────────────────────────────────────

const GS_SANDBOX_IN = '/tmp/input.pdf';
const GS_SANDBOX_OUT = '/tmp/output.pdf';

interface GsOutcome {
  bytes: Uint8Array;
  log: string[];
}

async function runGhostscript(args: string[], input: Uint8Array): Promise<GsOutcome> {
  const result = await gsRun(args, { [GS_SANDBOX_IN]: input }, { outputs: [GS_SANDBOX_OUT] });
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
    '-sOutputFile',
    GS_SANDBOX_OUT,
    GS_SANDBOX_IN,
  ], bytes);
}

/**
 * Turn every glyph into a vector path with `-dNoOutputFonts`, so the file
 * renders identically without any font on the machine.
 */
export async function textToOutlines(bytes: Uint8Array): Promise<GsOutcome> {
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
    '-sOutputFile',
    GS_SANDBOX_OUT,
    GS_SANDBOX_IN,
  ], bytes);
}

/** Ghostscript's own lossless rewrite, used as a repair last resort. */
export async function rebuildWithGhostscript(bytes: Uint8Array): Promise<GsOutcome> {
  return runGhostscript([
    '-dQUIET',
    '-dNOPAUSE',
    '-dBATCH',
    '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.7',
    '-dAutoFixDirtyXrefTables=true',
    '-dDoThumbnails=false',
    '-sOutputFile',
    GS_SANDBOX_OUT,
    GS_SANDBOX_IN,
  ], bytes);
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
  body: (api: Awaited<ReturnType<typeof cpdf>>, pdf: CpdfDocument) => T,
): Promise<T> {
  const api = await cpdf();
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
): Promise<Uint8Array> {
  return withCpdf(bytes, password, (api, pdf) => api.toMemory(pdf, true, false));
}

/** Compress + remove duplicate objects, without touching the image pixels. */
export async function compressWithCpdf(
  bytes: Uint8Array,
  password?: string,
): Promise<Uint8Array> {
  return withCpdf(bytes, password, (api, pdf) => {
    api.compress(pdf);
    return api.toMemory(pdf, false, false);
  });
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
  });
}

/** List the fonts CoherentPDF finds, used by the font and PDF/A reports. */
export async function listFontsWithCpdf(
  bytes: Uint8Array,
  password?: string,
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
  });
}

// ── PyMuPDF ─────────────────────────────────────────────────────────────────

/**
 * Open a document with PyMuPDF. It accepts a `Blob`, so the bytes are wrapped
 * rather than passed raw. The caller must `close()` the document.
 */
export async function openWithPyMuPDF(bytes: Uint8Array, password?: string) {
  const instance = await pymupdf();
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

/** PyMuPDF's own lossy-free structural cleanup (garbage collect + deflate). */
export async function scrubWithPyMuPDF(
  bytes: Uint8Array,
  options: { password?: string; clean?: boolean; deflate?: boolean; garbage?: number } = {},
): Promise<Uint8Array> {
  const { doc } = await openWithPyMuPDF(bytes, options.password);
  try {
    return doc.save({
      garbage: options.garbage ?? 3,
      deflate: options.deflate ?? true,
      clean: options.clean ?? true,
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
  options: { password?: string; maxAngle?: number; threshold?: number; dpi?: number; pages?: number[] } = {},
): Promise<{ bytes: Uint8Array; angles: number[]; corrected: number[] }> {
  const instance = await pymupdf();
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const { pdf, result } = await instance.deskewPdf(blob, {
    maxAngle: options.maxAngle ?? 15,
    threshold: options.threshold,
    dpi: options.dpi,
    pages: options.pages,
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
