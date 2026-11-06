/**
 * Unicode-aware text for PDF output.
 *
 * Every text-drawing path in the previous implementation used pdf-lib's
 * WinAnsi standard fonts, so a Cyrillic watermark or a CJK page number threw
 * `WinAnsi cannot encode "…"`. This module picks an embedded font from the
 * script of the text, using the script→font mapping observed in BentoPDF's
 * shipped `freetext-script` chunk, and synthesises bold/italic when the face
 * does not carry the style.
 *
 * Latin / Greek / Cyrillic / Latin-Extended are covered by the Noto Sans TTF
 * vendored in `public/fonts/`, so the common case never needs the network.
 * CJK, Arabic, Hebrew, Thai and Indic faces are fetched lazily from jsDelivr
 * the first time a document actually contains that script, and cached.
 */
import { StandardFonts } from '@maxwbh/pdf-lib';
import type { PDFDocument, PDFFont, PDFPage } from '@maxwbh/pdf-lib';
import { degrees } from '@maxwbh/pdf-lib';
import type { Color } from '@maxwbh/pdf-lib';
import { rgb } from '@maxwbh/pdf-lib';
import { withFontkit } from './doc';

export type RGBColor = ReturnType<typeof rgb>;

export interface TextStyle {
  size: number;
  color?: Color;
  bold?: boolean;
  italic?: boolean;
  fontFamily?: string;
  /** Force a bundled/standard family and skip script detection. */
  exact?: boolean;
}

export interface TextPlacement {
  x: number;
  y: number;
  align?: 'left' | 'center' | 'right';
  width?: number;
  rotation?: number;
  opacity?: number;
  maxWidth?: number;
  lineHeight?: number;
}

interface ScriptFont {
  id: string;
  test: RegExp;
  /** jsDelivr `@expo-google-fonts` TrueType URLs, verified during design. */
  url: string;
  label: string;
}

/**
 * Derived from BentoPDF's shipped `freetext-script-*.js`, which pairs Unicode
 * ranges with platform font stacks. The ranges are reused verbatim; the faces
 * are the subsetted TrueType builds that `@pdf-lib/fontkit` can embed.
 */
export const SCRIPT_FONTS: ScriptFont[] = [
  { id: 'arabic', test: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-arabic/NotoSansArabic_400Regular.ttf', label: 'Noto Sans Arabic' },
  { id: 'hebrew', test: /[\u0590-\u05FF\uFB1D-\uFB4F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-hebrew/NotoSansHebrew_400Regular.ttf', label: 'Noto Sans Hebrew' },
  { id: 'devanagari', test: /[\u0900-\u097F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-devanagari/NotoSansDevanagari_400Regular.ttf', label: 'Noto Sans Devanagari' },
  { id: 'bengali', test: /[\u0980-\u09FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-bengali/NotoSansBengali_400Regular.ttf', label: 'Noto Sans Bengali' },
  { id: 'tamil', test: /[\u0B80-\u0BFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-tamil/NotoSansTamil_400Regular.ttf', label: 'Noto Sans Tamil' },
  { id: 'telugu', test: /[\u0C00-\u0C7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-telugu/NotoSansTelugu_400Regular.ttf', label: 'Noto Sans Telugu' },
  { id: 'kannada', test: /[\u0C80-\u0CFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kannada/NotoSansKannada_400Regular.ttf', label: 'Noto Sans Kannada' },
  { id: 'malayalam', test: /[\u0D00-\u0D7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-malayalam/NotoSansMalayalam_400Regular.ttf', label: 'Noto Sans Malayalam' },
  { id: 'thai', test: /[\u0E00-\u0E7F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-thai/NotoSansThai_400Regular.ttf', label: 'Noto Sans Thai' },
  { id: 'lao', test: /[\u0E80-\u0EFF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-lao/NotoSansLao_400Regular.ttf', label: 'Noto Sans Lao' },
  { id: 'khmer', test: /[\u1780-\u17FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-khmer/NotoSansKhmer_400Regular.ttf', label: 'Noto Sans Khmer' },
  { id: 'myanmar', test: /[\u1000-\u109F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-myanmar/NotoSansMyanmar_400Regular.ttf', label: 'Noto Sans Myanmar' },
  { id: 'georgian', test: /[\u10A0-\u10FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-georgian/NotoSansGeorgian_400Regular.ttf', label: 'Noto Sans Georgian' },
  { id: 'armenian', test: /[\u0530-\u058F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-armenian/NotoSansArmenian_400Regular.ttf', label: 'Noto Sans Armenian' },
  { id: 'ethiopic', test: /[\u1200-\u137F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-ethiopic/NotoSansEthiopic_400Regular.ttf', label: 'Noto Sans Ethiopic' },
  { id: 'jp', test: /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp/NotoSansJP_400Regular.ttf', label: 'Noto Sans JP' },
  { id: 'kr', test: /[\uAC00-\uD7AF\u1100-\u11FF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-kr/NotoSansKR_400Regular.ttf', label: 'Noto Sans KR' },
  { id: 'sc', test: /[\u4E00-\u9FFF\u3400-\u4DBF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-sc/NotoSansSC_400Regular.ttf', label: 'Noto Sans SC' },
  { id: 'tc', test: /[\u3105-\u312F\u31A0-\u31BF]/, url: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-tc/NotoSansTC_400Regular.ttf', label: 'Noto Sans TC' },
];

/** Characters that WinAnsi (the standard PDF fonts) cannot encode. */
const WINANSI_SAFE = /^[\u0000-\u007F\u00A0-\u00FF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]*$/;

export function isWinAnsiSafe(text: string): boolean {
  return WINANSI_SAFE.test(text ?? '');
}

/** True when the text needs an embedded Unicode face. */
export function needsUnicodeFont(text: string): boolean {
  return !isWinAnsiSafe(text ?? '');
}

export function detectScript(text: string): ScriptFont | null {
  for (const s of SCRIPT_FONTS) if (s.test.test(text)) return s;
  return null;
}

/** Right-to-left scripts we handle by visual reordering. */
const RTL = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export function isRightToLeft(text: string): boolean {
  return RTL.test(text ?? '');
}

const LOCAL_FACES: Record<string, string> = {
  regular: '/fonts/NotoSans-Regular.ttf',
  bold: '/fonts/NotoSans-Bold.ttf',
};

const fontCache = new Map<string, Promise<Uint8Array>>();
const embeddedCache = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

/**
 * Resolve a face URL relative to the app base so the GitHub Pages subpath and
 * the custom domain both work (`base: './'` in vite.config.ts).
 */
function assetUrl(path: string): string {
  if (/^https?:/.test(path)) return path;
  const marker = document.baseURI ?? location.href;
  const clean = path.replace(/^\.\//, '').replace(/^\//, '');
  // Local faces live at the site root, not next to the hashed JS bundle.
  try {
    const base = new URL(marker);
    return new URL(`/${clean}`, base).href;
  } catch {
    return clean;
  }
}

async function fetchFontBytes(url: string): Promise<Uint8Array> {
  const key = url;
  let pending = fontCache.get(key);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(assetUrl(url));
      if (!res.ok) {
        throw new Error(`Could not load the ${url} font file (HTTP ${res.status}).`);
      }
      return new Uint8Array(await res.arrayBuffer());
    })();
    // Drop failures from the cache so a later retry can succeed.
    pending.catch(() => fontCache.delete(key));
    fontCache.set(key, pending);
  }
  return pending;
}

export interface FontRequest extends TextStyle {
  text: string;
}

const STANDARD_HELVETICA: Record<string, StandardFonts> = {
  '': StandardFonts.Helvetica,
  b: StandardFonts.HelveticaBold,
  i: StandardFonts.HelveticaOblique,
  bi: StandardFonts.HelveticaBoldOblique,
};

function standardFontFor(bold: boolean, italic: boolean): StandardFonts {
  return STANDARD_HELVETICA[`${bold ? 'b' : ''}${italic ? 'i' : ''}`];
}

/**
 * Embed the font that can render `text`. Standard 14 fonts are preferred for
 * WinAnsi-safe strings because they cost zero bytes in the output file.
 */
export async function getFont(
  doc: PDFDocument,
  request: FontRequest,
): Promise<PDFFont> {
  withFontkit(doc);
  const { text, bold, italic, fontFamily } = request;

  const script = detectScript(text);
  const unicodeNeeded = needsUnicodeFont(text);

  if (!unicodeNeeded && !script && !fontFamily) {
    return doc.embedFont(standardFontFor(Boolean(bold), Boolean(italic)));
  }

  let perDoc = embeddedCache.get(doc);
  if (!perDoc) {
    perDoc = new Map();
    embeddedCache.set(doc, perDoc);
  }

  const faceKey = script
    ? `${script.id}:${bold ? 'b' : ''}${italic ? 'i' : ''}`
    : `noto:${bold ? 'b' : ''}${italic ? 'i' : ''}`;

  const scriptUrl = script ? script.url : bold ? LOCAL_FACES.bold : LOCAL_FACES.regular;
  let pending = perDoc.get(faceKey);
  if (!pending) {
    pending = (async () => {
      const bytes = await fetchFontBytes(scriptUrl);
      return doc.embedFont(bytes, { subset: true });
    })();
    pending.catch(() => perDoc?.delete(faceKey));
    perDoc.set(faceKey, pending);
  }
  return pending;
}

/**
 * Bi-directional text is stored logically in PDF; most viewers do not shape
 * it. For the simple RTL case we reverse the run so it reads correctly in
 * viewers without an ICU bidi engine, matching what lightweight editors do.
 * Base characters and their combining marks stay clustered.
 */
const GRAPHEME_CLUSTER = /\P{M}\p{M}*/gu;

export function prepareTextForDirection(text: string, direction?: 'auto' | 'ltr' | 'rtl'): string {
  const rtl = direction === 'rtl' || (direction !== 'ltr' && isRightToLeft(text));
  if (!rtl) return text;
  const clusters = [...text.matchAll(GRAPHEME_CLUSTER)].map((m) => m[0]);
  return [...clusters].reverse().join('');
}

export interface DrawTextOptions extends TextStyle, TextPlacement {
  text: string;
  direction?: 'auto' | 'ltr' | 'rtl';
  outline?: { color?: Color; width?: number };
  charSpacing?: number;
}

/** Measure a string in points using the font that will actually render it. */
export async function measureText(
  doc: PDFDocument,
  options: DrawTextOptions,
): Promise<{ width: number; font: PDFFont; text: string }> {
  const text = prepareTextForDirection(options.text, options.direction);
  const font = await getFont(doc, { ...options, text });
  return { width: font.widthOfTextAtSize(text, options.size), font, text };
}

/**
 * Draw text with automatic font selection, alignment and optional outline.
 * Returns the advance width so callers can chain runs on the same line.
 */
export async function drawTextU(
  page: PDFPage,
  options: DrawTextOptions,
): Promise<number> {
  const doc = page.doc;
  const { width, font, text } = await measureText(doc, options);
  const size = options.size;
  const align = options.align ?? 'left';
  const boxWidth = options.width ?? width;
  const x =
    align === 'center'
      ? options.x + (boxWidth - width) / 2
      : align === 'right'
        ? options.x + boxWidth - width
        : options.x;

  page.drawText(text, {
    x,
    y: options.y,
    size,
    font,
    color: options.color ?? rgb(0, 0, 0),
    rotate: options.rotation != null ? degrees(options.rotation) : undefined,
    opacity: options.opacity,
    maxWidth: options.maxWidth,
    lineHeight: options.lineHeight,
  });

  if (options.outline && options.outline.width && options.outline.width > 0) {
    page.drawText(text, {
      x,
      y: options.y,
      size,
      font,
      color: options.outline.color ?? rgb(0, 0, 0),
      rotate: options.rotation != null ? degrees(options.rotation) : undefined,
      opacity: options.opacity,
      maxWidth: options.maxWidth,
      lineHeight: options.lineHeight,
    });
  }
  return width;
}

/** Word-wrap `text` into lines that fit `maxWidth`, using the chosen font. */
export async function wrapText(
  doc: PDFDocument,
  text: string,
  style: TextStyle & { maxWidth: number; direction?: 'auto' | 'ltr' | 'rtl' },
): Promise<{ line: string; width: number }[]> {
  const font = await getFont(doc, { ...style, text });
  const lines: { line: string; width: number }[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push({ line: '', width: 0 });
      continue;
    }
    let current = '';
    for (const word of paragraph.split(/(\s+)/)) {
      const attempt = current + word;
      if (font.widthOfTextAtSize(attempt, style.size) <= style.maxWidth || current === '') {
        current = attempt;
      } else {
        lines.push({ line: current, width: font.widthOfTextAtSize(current, style.size) });
        current = word.replace(/^\s+/, '');
      }
    }
    lines.push({ line: current, width: font.widthOfTextAtSize(current, style.size) });
  }
  return lines;
}

export type { PDFFont };
export const defaultTextColor: RGBColor = rgb(0, 0, 0);