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
 * `script:<id>`, `local:<family>`. The editor stores ids, never display labels,
 * so a renamed label cannot orphan an existing object. The ids and the postures
 * each family really holds come from `core/text-style`, which the rail tools and
 * the annotation editor read too — one registry, not three.
 */
import { StandardFonts, rgb } from '@/lib/pdf/core/doc';
import type { PDFDocument, PDFFont } from '@/lib/pdf/core/doc';
import type { SourceFont } from '@/lib/pdf/core/content';
import { SCRIPT_FONTS, detectScript, getFont, isWinAnsiSafe, embedUnicodeFace } from '@/lib/pdf/core/fonts';
import {
  AUTO_FAMILY_ID,
  BUNDLED_FAMILY_ID,
  FACE_FAMILIES,
  carriesPosture,
  deviceFamily,
  deviceFamilyId,
  familyLabel as familyLabelOf,
  familyPreview as coreFamilyPreview,
  familySpec,
  type FaceFamilySpec,
} from '@/lib/pdf/core/text-style';
import type { InlineStyle } from './model';

/* ------------------------------------------------------------------ *
 * The face a run is written in                                        *
 * ------------------------------------------------------------------ */

/**
 * A face the editor can draw with — either **the document's own font**, reused
 * from the file being edited, or one the editor embeds.
 *
 * In-place editing runs on the open document, so the producer's font dictionary
 * is reachable: keeping it is what makes an edited heading look like the heading
 * it replaced. Reuse is only honest when the face can really spell the new text,
 * which `missingFor` answers from the font's own encoding, widths and embedded
 * (possibly subsetted) file — see `SourceFont` in `core/content`.
 */
export interface EditFace {
  /** `/BaseFont` for a source face, the family id otherwise: what a report names. */
  label: string;
  /** True when this is the font the page already used. */
  fromSource: boolean;
  /** Advance of `text` at `size`, in points, from this face's own metrics. */
  widthOfText(text: string, size: number): number;
  /** The bytes to show, or `null` when the face cannot spell `text`. */
  codes(text: string): Uint8Array | null;
  /** The characters of `text` this face cannot draw, in order. */
  missingFor(text: string): string[];
  /** Set for a face pdf-lib draws with (standard 14, bundled, script, local). */
  pdf?: PDFFont;
  /** Set for the document's own font dictionary. */
  source?: SourceFont;
}

/** The document's own font, spelled through its own codes. */
export function sourceFace(source: SourceFont): EditFace {
  const width = new Map<string, number>();
  return {
    label: source.baseFont || source.subtype,
    fromSource: true,
    source,
    widthOfText(text: string, size: number): number {
      const known = width.get(`${text}|${size}`);
      if (known !== undefined) return known;
      let total = 0;
      for (const character of text) {
        const code = source.codeOf(character.codePointAt(0) as number);
        total += ((code === undefined ? 0 : source.widthOf(code)) / 1000) * size;
      }
      width.set(`${text}|${size}`, total);
      return total;
    },
    codes(text: string): Uint8Array | null {
      const out: number[] = [];
      for (const character of text) {
        const code = source.codeOf(character.codePointAt(0) as number);
        if (code === undefined) return null;
        for (let shift = (source.codeSize - 1) * 8; shift >= 0; shift -= 8) out.push((code >> shift) & 0xff);
      }
      return new Uint8Array(out);
    },
    missingFor: (text: string) => source.missingFor(text),
  };
}

/** A face pdf-lib embeds: its own encoder and metrics do the work. */
export function pdfFace(label: string, font: PDFFont): EditFace {
  return {
    label,
    fromSource: false,
    pdf: font,
    widthOfText: (text: string, size: number) => font.widthOfTextAtSize(text, size),
    codes: (text: string) => {
      try {
        const encoded = font.encodeText(text);
        const hex = encoded.toString();
        const clean = hex.startsWith('<') ? hex.slice(1, -1) : '';
        if (!/^[0-9A-Fa-f]*$/.test(clean)) return null;
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        return out;
      } catch {
        return null;
      }
    },
    missingFor(text: string): string[] {
      const missing: string[] = [];
      for (const character of text) {
        try {
          font.encodeText(character);
        } catch {
          missing.push(character);
        }
      }
      return missing;
    },
  };
}

/** Why the page's own face could not be kept, in one clause the user can read. */
export type SubstitutionReason =
  | { kind: 'missing'; characters: string }
  | { kind: 'bold' }
  | { kind: 'italic' }
  | { kind: 'type3' };

export interface FaceChoice {
  face: EditFace;
  /** The document's own face the block was set in, when there was one. */
  kept?: SourceFont;
  /** Set when the source face could not be used, with the reason to show. */
  substitution?: { from: string; to: string; reason: SubstitutionReason };
}

/** A face's posture, read off the name the producer gave it. */
function postureOf(baseFont: string): { bold: boolean; italic: boolean } {
  const name = baseFont.toLowerCase();
  return {
    bold: /bold|black|heavy|semibold|demibold|extrabold|ultrabold/.test(name),
    italic: /italic|oblique/.test(name),
  };
}

/**
 * The face to write `text` with: the block's own font whenever it can do the job.
 *
 * A source face is kept when it spells every character the user typed (its
 * encoding, its widths and — the case that really bites — its **subsubset** of
 * embedded glyphs), and when it already carries the weight and slant the block is
 * showing. Otherwise the editor's normal tiers answer, and the caller reports the
 * swap by name and reason rather than making it silently.
 */
export function chooseFace(
  doc: PDFDocument,
  style: InlineStyle,
  text: string,
  sources: SourceFont[],
): Promise<FaceChoice> {
  const wantedBold = Boolean(style.bold);
  const wantedItalic = Boolean(style.italic);
  for (const source of sources) {
    if (source.subtype === '/Type3') continue;
    if (style.fontFamily) break; // the user named a family; that is their choice
    const missing = source.missingFor(text);
    const posture = postureOf(source.baseFont);
    if (missing.length === 0) {
      if (wantedBold && !posture.bold) {
        return substitute(doc, style, text, source, { kind: 'bold' });
      }
      if (wantedItalic && !posture.italic) {
        return substitute(doc, style, text, source, { kind: 'italic' });
      }
      return Promise.resolve({ face: sourceFace(source), kept: source });
    }
    return substitute(doc, style, text, source, {
      kind: 'missing',
      characters: [...new Set(missing)].slice(0, 8).join(' '),
    });
  }
  const type3 = sources.find((source) => source.subtype === '/Type3');
  if (type3 && !style.fontFamily) {
    return substitute(doc, style, text, type3, { kind: 'type3' });
  }
  return embeddedFace(doc, style, text);
}

function substitute(
  doc: PDFDocument,
  style: InlineStyle,
  text: string,
  source: SourceFont,
  reason: SubstitutionReason,
): Promise<FaceChoice> {
  return embeddedFace(doc, style, text).then((choice) => ({
    ...choice,
    substitution: { from: source.baseFont || source.subtype, to: choice.face.label, reason },
  }));
}

/** The tiers this module already implements: standard 14, Noto, script, local. */
async function embeddedFace(doc: PDFDocument, style: InlineStyle, text: string): Promise<FaceChoice> {
  const { font, familyUsed } = await resolveFace(doc, style, text);
  return { face: pdfFace(familyUsed, font) };
}

/**
 * The four real faces behind each standard-14 family: regular, bold, oblique,
 * bold-oblique. `italic` here is never a synthesised slant — the named face is a
 * different font, which is why the inspector can offer italic for these families
 * and not for the bundled one.
 */
const STANDARD_ENTRIES: {
  id: string;
  label: string;
  faces: [StandardFonts, StandardFonts, StandardFonts, StandardFonts];
}[] = [
  {
    id: 'std:helvetica',
    label: 'Helvetica / Arial',
    faces: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  {
    id: 'std:times',
    label: 'Times New Roman',
    faces: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  },
  {
    id: 'std:courier',
    label: 'Courier New (monospace)',
    faces: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  },
];

/** A `FontFamilyOption` is the registry's family spec, named for this module's callers. */
export type FontFamilyOption = FaceFamilySpec;

/**
 * The families, read from the one registry (`core/text-style`).
 *
 * This module used to own its own list and `tools/edit.ts` another; a family id
 * that existed in one did not exist in the other, which is how a rail "Typeface"
 * pick and an inspector "Font" pick came to mean different things. The registry is
 * now the single source, and a `FontFamilyOption` *is* the registry's `FaceFamilySpec`.
 */
export const BUILT_IN_FAMILIES: FontFamilyOption[] = FACE_FAMILIES.map((spec) => ({ ...spec }));

/** The auto entry, for callers that need only its id or label. */
export const AUTO_FAMILY: FontFamilyOption = { ...familySpec(AUTO_FAMILY_ID)! };

/** The bundled Noto entry. */
export const BUNDLED_FAMILY: FontFamilyOption = { ...familySpec(BUNDLED_FAMILY_ID)! };

/** The standard-14 families, named by the ids the registry uses. */
export const STANDARD_FAMILIES: FontFamilyOption[] = BUILT_IN_FAMILIES.filter(
  (spec) => spec.group === 'standard',
);

/** The fetched single-weight faces. */
export const SCRIPT_FAMILIES: FontFamilyOption[] = BUILT_IN_FAMILIES.filter(
  (spec) => spec.group === 'script',
);

export function familyPreview(familyId: string): string {
  return coreFamilyPreview(familyId, deviceFamilies);
}

/** `familyId` as it should be shown in a select. */
export function familyLabel(familyId: string, local: FontFamilyOption[] = []): string {
  return familyLabelOf(familyId, [...deviceFamilies, ...local]);
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
 * The device families the last scan found, in registry shape.
 *
 * Held here because a family only exists once the user has agreed to the scan, and
 * because `resolveFace`/`familyPreview` must be able to answer for a stored
 * `local:…` id without the caller threading the list through every call.
 */
let deviceFamilies: FaceFamilySpec[] = [];

/** The face a device family holds for one posture, keyed `local:<family>|<postures>`. */
const deviceFaces = new Map<string, LocalFontFace>();

/**
 * A posture tag for the faces this module stores, so "Roboto Bold Italic" and the
 * request `{bold: true, italic: true}` meet at the same key.
 */
function postureKey(family: string, bold: boolean, italic: boolean): string {
  return `${deviceFamilyId(family)}|${bold ? 'b' : ''}${italic ? 'i' : ''}`;
}

/** The installed faces read once, in family order, with the postures each holds. */
export function scannedDeviceFamilies(): FaceFamilySpec[] {
  return deviceFamilies;
}

/**
 * Enumerate installed fonts. Must run inside a user gesture in Chromium; a
 * rejection is reported to the caller and simply leaves the list short.
 *
 * The list is grouped by **family**, not by face, because that is what a style
 * model stores: the posture buttons then choose between the family's installed
 * faces (`Roboto` vs `Roboto Bold`), which are real faces with real bytes. A family
 * with no italic face installed does not offer italic — the alternative is the
 * screen showing a slant the file cannot carry.
 */
export async function loadLocalFamilies(): Promise<FontFamilyOption[]> {
  if (!supportsLocalFonts()) return [];
  if (!localFaces) {
    // SAFETY: guarded by `supportsLocalFonts()` above, and the result is only
    // read through the `LocalFontFace` fields the API documents.
    localFaces = await (window as unknown as LocalFontWindow).queryLocalFonts?.() ?? [];
  }
  deviceFaces.clear();
  const byFamily = new Map<string, { bold: boolean; italic: boolean }>();
  for (const face of localFaces) {
    const posture = readPosture(face.style);
    deviceFaces.set(postureKey(face.family, posture.bold, posture.italic), face);
    // A family's "own" face is its roman one; a family that only ships styled
    // faces still gets listed, from whatever it has.
    if (!deviceFaces.has(postureKey(face.family, false, false))) {
      deviceFaces.set(postureKey(face.family, false, false), face);
    }
    const seen = byFamily.get(face.family) ?? { bold: false, italic: false };
    seen.bold = seen.bold || posture.bold;
    seen.italic = seen.italic || posture.italic;
    byFamily.set(face.family, seen);
  }
  deviceFamilies = [...byFamily.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([family, postures]) => deviceFamily(deviceFamilyId(family), family, postures));
  return deviceFamilies.map((spec) => ({ ...spec }));
}

/** Whether a face's own style string says bold / italic. */
function readPosture(style: string): { bold: boolean; italic: boolean } {
  const name = String(style ?? '').toLowerCase();
  return {
    bold: /bold|black|heavy|extrabold|ultrabold|semibold|demibold|medium/.test(name),
    italic: /italic|oblique/.test(name),
  };
}

/** The posture a style asked for, in the words a report uses. */
const POSTURE_WORDS: Record<string, string> = {
  b: 'bold',
  i: 'italic',
  bi: 'bold italic',
};

function postureAsked(style: InlineStyle): string {
  return POSTURE_WORDS[`${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}`] ?? 'italic';
}

/**
 * The installed face for a family at a posture, falling back to the lightest face
 * the family does hold. The fallback is *reported* by `resolveFace`, never silent.
 */
function findDeviceFace(
  family: string,
  bold: boolean,
  italic: boolean,
): { face: LocalFontFace; exact: boolean } | null {
  const exact = deviceFaces.get(postureKey(family, bold, italic));
  if (exact) return { face: exact, exact: true };
  const plain = deviceFaces.get(postureKey(family, false, false));
  return plain ? { face: plain, exact: false } : null;
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
 * The sentence a run gets when the face that will write it does not hold a
 * posture the style asks for.
 *
 * The control set normally refuses the posture before it can be set, so this fires
 * for a style that arrived from elsewhere — a block extracted under another family,
 * a value restored from storage, a document edited on a machine that had a
 * different font installed. Saying it beats writing upright text under a slanted
 * preview.
 */
function postureRefusalNote(style: InlineStyle, text: string): string | undefined {
  if (!style.italic) return undefined;
  if (carriesPosture(style.fontFamily || '', 'italic', text, deviceFamilies)) return undefined;
  const label = familyLabelOf(style.fontFamily, deviceFamilies);
  return `${label} carries no italic face this app can embed, so the run is written upright.`;
}

/**
 * The embedded face that can draw `text` in `style`.
 *
 * `familyUsed` is what was actually chosen and may be lower in the tier list
 * than the request — the editor surfaces that so a Cyrillic run in "Courier
 * New" does not silently come out looking like something else. A posture the
 * answering face does not hold is reported the same way (`note`).
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
    const slant = style.italic ? ', which carries no italic face: the run is written upright' : '';
    const note = `This run contains characters ${standard.label} cannot encode, so it is written in a bundled Unicode face${slant}.`;
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
      // `embedUnicodeFace` rather than `doc.embedFont`: pdf-lib reads a face's
      // flavour off a property this fontkit never sets, so a CFF face like Noto
      // Sans JP went out as a TrueType program and painted nothing in MuPDF.
      const font = await cacheGet(cache, key, async () =>
        embedUnicodeFace(doc, await fetchBytes(script.url)),
      );
      const note =
        style.bold || style.italic
          ? `${script.label} ships one weight, so bold and italic are not simulated.`
          : undefined;
      return { font, familyUsed: script.id, note };
    }
  }

  // A local system font: embed the bytes the OS hands back, at the posture asked
  // for. A family installed without that face is reported, not silently flattened.
  if (family.startsWith('local:')) {
    const name = family.slice('local:'.length);
    const picked = findDeviceFace(name, Boolean(style.bold), Boolean(style.italic))
      // An id written by an older build named a *face*, not a family.
      ?? (localFaces?.find((face) => face.fullName === name)
        ? { face: localFaces.find((face) => face.fullName === name)!, exact: true }
        : null);
    if (picked) {
      const postureKept =
        picked.exact || (!carriesPosture(family, 'bold', text, deviceFamilies) && !style.bold);
      try {
        const font = await cacheGet(cache, key, async () => {
          const blob = await picked.face.data();
          return embedUnicodeFace(doc, new Uint8Array(await blob.arrayBuffer()));
        });
        return {
          font,
          familyUsed: family,
          note: postureKept
            ? undefined
            : `${picked.face.family} has no ${postureAsked(style)} face installed here, so the run is written in ${picked.face.fullName}.`,
        };
      } catch {
        return {
          font: await notoFace(doc, cache, key, style, text),
          familyUsed: 'noto',
          note: `"${picked.face.family}" could not be read from this system, so the text was written in Noto Sans instead.`,
        };
      }
    }
    return {
      font: await notoFace(doc, cache, key, style, text),
      familyUsed: 'noto',
      note: `"${name}" is not installed here, so the text was written in Noto Sans instead.`,
    };
  }

  return {
    font: await notoFace(doc, cache, key, style, text),
    familyUsed: 'noto',
    note: postureRefusalNote(style, text),
  };
}

function notoFace(  doc: PDFDocument,
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
