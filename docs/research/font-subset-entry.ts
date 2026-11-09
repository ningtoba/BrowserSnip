/**
 * Probe body for the font-subset rig: draws one character per row through each
 * embedding path the app owns, and hands the bytes back to the host.
 *
 * Bundled by `font-subset-build.mjs` with esbuild so this file imports the real
 * `src/lib/pdf/core/fonts.ts` — the module under test, not a copy of it.
 */
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PDFFont } from '@maxwbh/pdf-lib';
import { fontkit, withFontkit } from '../../src/lib/pdf/core/doc';
import { clearFontCache, drawTextU, SCRIPT_FONTS } from '../../src/lib/pdf/core/fonts';

export type FaceFlavour = 'TTF' | 'CFF' | 'unknown';

export interface FaceJob {
  /** probe-local id, used for the file name and the table row */
  id: string;
  /** human label for the table */
  label: string;
  /** the face's URL, served by the host's fetch stub (local file or cached CDN) */
  url: string | null;
  /** which embedding path to exercise */
  via: 'app' | 'pdflib-subset' | 'pdflib-full' | 'standard14';
  /** force the bundled Noto path for text the standard 14 could also spell */
  forceNoto?: boolean;
  bold?: boolean;
  italic?: boolean;
  chars: string[];
}

export interface JobReport {
  id: string;
  label: string;
  via: string;
  url: string | null;
  /** the sfnt flavour of the source face, read off its version tag and tables */
  flavour: FaceFlavour;
  /** whether `core/fonts.ts`'s `face.cff` guard fires for that face */
  appSeesCff: boolean;
  faceName: string;
  /** the code points actually drawn, in the order the writer was asked */
  drawn: string[];
  /** code points the path refused, with the message it threw */
  refused: { char: string; error: string }[];
  pageWidth: number;
  pageHeight: number;
  rowsPerSide: number;
  baselineStep: number;
  fontSize: number;
  /** the file's bytes, as the writer saved them */
  pdf: Uint8Array;
  error?: string;
}

const MARGIN = 40;
const STEP = 26;
const SIZE = 20;
const WIDTH = 320;

/** The on-demand faces the app can fetch, for the host's download cache. */
export function faceUrls(): { id: string; url: string; label: string }[] {
  return SCRIPT_FONTS.map(({ id, url, label }) => ({ id, url, label }));
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The facts about a face that decide which code path it takes.
 *
 * `flavour` is the truth, read off the sfnt version tag and the tables fontkit
 * actually decoded. `appSeesCff` is what `core/fonts.ts` looks at (`face.cff`),
 * which is how a CFF face can end up on the TrueType path without anyone
 * deciding that it should.
 */
function describeFace(bytes: Uint8Array): { flavour: FaceFlavour; appSeesCff: boolean; name: string } {
  try {
    const tag = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    // SAFETY: the probe only reads `cff`, `'CFF '`, `postScriptName` and
    // `numGlyphs`, all present on every fontkit face; pdf-lib publishes no type
    // for them.
    const face = fontkit.create(bytes) as unknown as {
      cff?: unknown;
      'CFF '?: unknown;
      postScriptName?: string;
      numGlyphs?: number;
    };
    const cffTable = tag === '4f54544f' || Boolean(face['CFF ']);
    return {
      flavour: cffTable ? 'CFF' : tag === '00010000' || tag === '74727565' ? 'TTF' : 'unknown',
      appSeesCff: Boolean(face.cff),
      name: `${face.postScriptName ?? '?'} (${face.numGlyphs ?? '?'} glyphs)`,
    };
  } catch (error) {
    return { flavour: 'unknown', appSeesCff: false, name: String(error) };
  }
}

export async function runProbe(jobs: FaceJob[]): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  for (const job of jobs) {
    const report: JobReport = {
      id: job.id,
      label: job.label,
      via: job.via,
      url: job.url,
      flavour: 'unknown',
      appSeesCff: false,
      faceName: '',
      drawn: [],
      refused: [],
      pageWidth: WIDTH,
      pageHeight: MARGIN * 2 + job.chars.length * STEP,
      rowsPerSide: job.chars.length,
      baselineStep: STEP,
      fontSize: SIZE,
      pdf: new Uint8Array(),
    };
    try {
      const doc = await PDFDocument.create();
      withFontkit(doc);
      const page = doc.addPage([report.pageWidth, report.pageHeight]);
      const script = SCRIPT_FONTS.find((s) => job.url && s.url === job.url);
      if (typeof job.url === 'string') {
        const described = describeFace(await fetchBytes(job.url));
        report.faceName = described.name;
        report.flavour = described.flavour;
        report.appSeesCff = described.appSeesCff;
      }
      let drawn: PDFFont | null = null;
      if (job.via === 'standard14') {
        drawn = await doc.embedFont(StandardFonts.Helvetica);
      } else if (job.via === 'pdflib-subset' || job.via === 'pdflib-full') {
        const url = job.url;
        if (typeof url !== 'string') throw new Error(`${job.id}: no face url`);
        drawn = await doc.embedFont(await fetchBytes(url), {
          subset: job.via === 'pdflib-subset',
        });
      }
      for (let i = 0; i < job.chars.length; i += 1) {
        const ch = job.chars[i];
        const y = report.pageHeight - MARGIN - (i + 1) * STEP + 6;
        try {
          if (drawn) {
            page.drawText(ch, { x: MARGIN, y, size: SIZE, font: drawn, color: rgb(0, 0, 0) });
          } else {
            await drawTextU(page, {
              text: ch,
              x: MARGIN,
              y,
              size: SIZE,
              bold: job.bold,
              italic: job.italic,
              fontFamily: job.forceNoto ? (script ? script.label : 'noto-sans') : undefined,
            });
          }
          report.drawn.push(ch);
        } catch (error) {
          report.refused.push({ char: ch, error: String(error).slice(0, 120) });
        }
      }
      report.pdf = await doc.save({ useObjectStreams: false });
    } catch (error) {
      report.error = (error instanceof Error && error.stack ? error.stack : String(error)).slice(0, 700);
    }
    reports.push(report);
    clearFontCache();
  }
  return reports;
}
