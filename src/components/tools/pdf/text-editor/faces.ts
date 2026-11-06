/**
 * Font resolution for the in-place text editor.
 *
 * The engine contract in `docs/PDF-ENGINE-CONTRACT.md` gives three tiers, and
 * the editor uses all of them in order of cost:
 *
 * 1. **Standard 14** (`Helvetica`, `Times`, `Courier` + variants). Zero bytes in
 *    the output, works offline, but WinAnsi only — a run the family cannot
 *    encode falls back to tier 2 rather than throwing.
 * 2. **Bundled Noto Sans** (`public/fonts/`, via `core/fonts.getFont`). Covers
 *    Latin/Greek/Cyrillic and anything else that is not WinAnsi-safe, still
 *    offline.
 * 3. **Lazy script faces** (`core/fonts.SCRIPT_FONTS`) and **local system fonts**
 *    (Local Font Access API, `queryLocalFonts`). Both are fetched read once,
 *    then embedded as a subset, so the exported file stays portable.
 *
 * A `fontFamily` id is always one of: `''` (auto), `noto`, `std:<name>`,
 * `script:<id>`, `local:<fullName>`. The editor stores ids, never display labels,
 * so a renamed label cannot orphan an existing object.
 */
import { StandardFonts, rgb } from '@/lib/pdf/core/doc';
import type { PDFDocument, PDFFont } from '@/lib/pdf/core/doc';
import { SCRIPT_FONTS, detectScript, getFont, isWinAnsiSafe } from '@/lib/pdf/core/fonts';
import type { InlineStyle } from './model';

export interface FontFamilyOption {
  id: string;
  label: string;
  group: 'auto' | 'standard' | 'bundled' | 'script' | 'local';
  /** CSS stack used by the on-screen editor box, so the preview looks close. */
  preview: string;
}

export const AUTO_FAMILY: FontFamilyOption = {
  id: '',
  label: 'Automatic (match the page)',
  group: 'auto',
  preview: 'system-ui, sans-serif',
};

export const BUNDLED_FAMILY: FontFamilyOption = {
  id: 'noto',
  label: 'Noto Sans (bundled)',
  group: 'bundled',
  preview: '"Noto Sans", system-ui, sans-serif',
};

const STANDARD_ENTRIES: { id: string; label: string; preview: string; faces: [StandardFonts, StandardFonts, StandardFonts, StandardFonts] }[] = [
  {
    id: 'std:helvetica',
    label: 'Helvetica / Arial',
    preview: 'Helvetica, Arial, sans-serif',
    faces: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  {
    id: 'std:times',
    label: 'Times New Roman',
    preview: '"Times New Roman", Times, serif',
    faces: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  },
  {
    id: 'std:courier',
    label: 'Courier New (monospace)',
    preview: '"Courier New", Courier, monospace',
    faces: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  },
];

export const STANDARD_FAMILIES: FontFamilyOption[] = STANDARD_ENTRIES.map((entry) => ({
  id: entry.id,
  label: entry.label,
  group: 'standard' as const,
  preview: entry.preview,
}));

/** Script faces from `core/fonts`; fetched from a CDN the first time they are used. */
export const SCRIPT_FAMILIES: FontFamilyOption[] = SCRIPT_FONTS.map((font) => ({
  id: `script:${font.id}`,
  label: font.label,
  group: 'script' as const,
  preview: `"${font.label}", system-ui, sans-serif`,
}));

/** Everything that works with no permission prompt and no system font probe. */
export const BUILT_IN_FAMILIES: FontFamilyOption[] = [
  AUTO_FAMILY,
  ...STANDARD_FAMILIES,
  BUNDLED_FAMILY,
  ...SCRIPT_FAMILIES,
];

export function familyPreview(familyId: string): string {
  const found =
    BUILT_IN_FAMILIES.find((option) => option.id === familyId)?.preview ??
    (familyId.startsWith('local:')
      ? `"${familyId.slice('local:'.length)}", system-ui, sans-serif`
      : AUTO_FAMILY.preview);
  return found;
}

/** `familyId` as it should be shown in a select. */
export function familyLabel(familyId: string, local: FontFamilyOption[] = []): string {
  const option = [...BUILT_IN_FAMILIES, ...local].find((candidate) => candidate.id === familyId);
  if (option) return option.label;
  if (familyId.startsWith('local:')) return familyId.slice('local:'.length);
  return AUTO_FAMILY.label;
}

// ── Local Font Access API ───────────────────────────────────────────────────

/** The slice of the Local Font Access API this module uses. */
interface LocalFontFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  /** Chrome returns the font file itself, so it can be embedded. */
  data: () => Promise<Blob>;
}

interface LocalFontWindow {
  queryLocalFonts?: () => Promise<LocalFontFace[]>;
}

/** Feature detection: Chromium behind a flag/permission, absent everywhere else. */
export function supportsLocalFonts(): boolean {
  // SAFETY: `queryLocalFonts` is not in the DOM lib this project compiles
  // against; the read only ever happens through the narrow `LocalFontWindow`
  // shape declared above and is guarded by the `typeof` check itself.
  return typeof (window as unknown as LocalFontWindow).queryLocalFonts === 'function';
}

/** True when the browser has the API but the page still needs permission. */
export function localFontsNeedPermission(): boolean {
  // SAFETY: `navigator.permissions` is optional in the DOM lib and the probe
  // only needs the `query` signature it calls.
  const permissions = (navigator as unknown as { permissions?: { query: (d: { name: string }) => Promise<{ state: string }> } }).permissions;
  return typeof permissions?.query === 'function';
}

let localFaces: LocalFontFace[] | null = null;

/**
 * Enumerate installed fonts. Must run inside a user gesture in Chromium; a
 * rejection is reported to the caller and simply leaves the list short.
 */
export async function loadLocalFamilies(): Promise<FontFamilyOption[]> {
  if (!supportsLocalFonts()) return [];
  if (!localFaces) {
    // SAFETY: guarded by `supportsLocalFonts()` above, and the result is only
    // read through the `LocalFontFace` fields the API documents.
    localFaces = await (window as unknown as LocalFontWindow).queryLocalFonts?.() ?? [];
  }
  const seen = new Set<string>();
  const options: FontFamilyOption[] = [];
  for (const face of localFaces) {
    if (seen.has(face.fullName)) continue;
    seen.add(face.fullName);
    options.push({
      id: `local:${face.fullName}`,
      label: `${face.family} ${face.style}`.trim(),
      group: 'local',
      preview: `"${face.family}", "${face.fullName}", system-ui, sans-serif`,
    });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

function findLocalFace(fullName: string): LocalFontFace | undefined {
  if (!localFaces) return undefined;
  return localFaces.find((face) => face.fullName === fullName);
}

// ── resolution ──────────────────────────────────────────────────────────────

const fetchedBytes = new Map<string, Promise<Uint8Array>>();
const perDocFonts = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

async function fetchBytes(url: string): Promise<Uint8Array> {
  let pending = fetchedBytes.get(url);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `Could not download the ${url.split('/').pop()} font file (HTTP ${response.status}). Open the tool again while online, or pick a bundled font.`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    })();
    pending.catch(() => fetchedBytes.delete(url));
    fetchedBytes.set(url, pending);
  }
  return pending;
}

function standardFace(entry: (typeof STANDARD_ENTRIES)[number], bold: boolean, italic: boolean): StandardFonts {
  const index = (bold ? 1 : 0) + (italic ? 2 : 0);
  return entry.faces[index];
}

/** Cache key: the face the writer needs, not the label it shows under. */
function faceKey(style: InlineStyle): string {
  return [
    style.fontFamily || 'auto',
    style.bold ? 'b' : '',
    style.italic ? 'i' : '',
  ].join('|');
}

/**
 * Cache key for the face a run needs: the requested family and posture, plus —
 * for `auto` — the script of the run's own text, because that is what decides
 * between the standard 14, Noto and a script face. Two runs that share a style
 * but not a script must not share a face.
 */
export function faceCacheKey(style: InlineStyle, text: string): string {
  const family = style.fontFamily || '';
  const script =
    family === ''
      ? detectScript(text)?.id ?? (isWinAnsiSafe(text) ? 'winansi' : 'unicode')
      : 'fixed';
  return `${faceKey(style)}#${script}`;
}

/**
 * The embedded face that can draw `text` in `style`.
 *
 * `familyUsed` is what was actually chosen and may be lower in the tier list
 * than the request — the editor surfaces that so a Cyrillic run in "Courier
 * New" does not silently come out looking like something else.
 */
export async function resolveFace(
  doc: PDFDocument,
  style: InlineStyle,
  text: string,
): Promise<{ font: PDFFont; familyUsed: string; note?: string }> {
  let cache = perDocFonts.get(doc);
  if (!cache) {
    cache = new Map();
    perDocFonts.set(doc, cache);
  }

  const family = style.fontFamily || '';
  const key = faceCacheKey(style, text);
  const encodeSafe = isWinAnsiSafe(text);

  // Standard 14: no bytes, but WinAnsi only.
  const standard = STANDARD_ENTRIES.find((entry) => entry.id === family);
  if (standard && encodeSafe && !detectScript(text)) {
    const font = await cacheGet(cache, key, () =>
      Promise.resolve(doc.embedFont(standardFace(standard, Boolean(style.bold), Boolean(style.italic)))),
    );
    return { font, familyUsed: standard.id };
  }
  if (standard) {
    const note = `This run contains characters ${standard.label} cannot encode, so it is written in a bundled Unicode face.`;
    const font = await cacheGet(cache, key, () =>
      getFont(doc, {
        text,
        size: style.size,
        bold: style.bold,
        italic: style.italic,
        fontFamily: 'noto',
      }),
    );
    return { font, familyUsed: 'noto', note };
  }

  // A named script face: fetch exactly that file, whatever the text says.
  if (family.startsWith('script:')) {
    const id = family.slice('script:'.length);
    const script = SCRIPT_FONTS.find((entry) => entry.id === id);
    if (script) {
      const font = await cacheGet(cache, key, async () =>
        doc.embedFont(await fetchBytes(script.url), { subset: true }),
      );
      const note =
        style.bold || style.italic
          ? `${script.label} ships one weight, so bold and italic are not simulated.`
          : undefined;
      return { font, familyUsed: script.id, note };
    }
  }

  // A local system font: embed the bytes the OS hands back.
  if (family.startsWith('local:')) {
    const fullName = family.slice('local:'.length);
    const face = findLocalFace(fullName);
    if (face) {
      try {
        const font = await cacheGet(cache, key, async () => {
          const blob = await face.data();
          return doc.embedFont(new Uint8Array(await blob.arrayBuffer()), { subset: true });
        });
        return { font, familyUsed: family };
      } catch {
        return {
          font: await notoFace(doc, cache, key, style, text),
          familyUsed: 'noto',
          note: `"${face.family}" could not be read from this system, so the text was written in Noto Sans instead.`,
        };
      }
    }
    return {
      font: await notoFace(doc, cache, key, style, text),
      familyUsed: 'noto',
      note: `"${fullName}" is not installed here, so the text was written in Noto Sans instead.`,
    };
  }

  return { font: await notoFace(doc, cache, key, style, text), familyUsed: 'noto' };
}

function notoFace(
  doc: PDFDocument,
  cache: Map<string, Promise<PDFFont>>,
  key: string,
  style: InlineStyle,
  text: string,
): Promise<PDFFont> {
  return cacheGet(cache, key, () =>
    getFont(doc, {
      text,
      size: style.size,
      bold: style.bold,
      italic: style.italic,
      // A forced family skips the standard-14 shortcut inside `getFont`, which
      // is what the auto path wants too: the editor's own fallback for auto is
      // Noto, so WinAnsi runs still get a standard face only when the caller
      // asked for one by name.
      fontFamily: style.fontFamily || 'noto',
    }),
  );
}

function cacheGet(
  cache: Map<string, Promise<PDFFont>>,
  key: string,
  make: () => Promise<PDFFont>,
): Promise<PDFFont> {
  let pending = cache.get(key);
  if (!pending) {
    pending = make();
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

/** pdf-lib colour for a `#rrggbb` string; bad input becomes black. */
export function colorOf(hex: string) {
  const clean = String(hex ?? '').trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return rgb(0, 0, 0);
  const int = Number.parseInt(full, 16);
  return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
}
