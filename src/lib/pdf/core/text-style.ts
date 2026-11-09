/**
 * The one text style model every surface that draws words shares.
 *
 * The app has grown seven surfaces that set type into a page — the annotation
 * editor's text box, its stamps and its in-place text editor, and the four rail
 * tools that draw text (header/footer, page numbers, watermark, add-stamps) — and
 * each one used to carry its own partial idea of what "styled" means: a size
 * here, a bold toggle there, a typeface list that existed in two spellings. This
 * module is the single definition of the seven properties a user can set, of
 * which families can honestly be *kept* in the file, and of what each surface's
 * writer is actually able to draw.
 *
 * The constraint that decides the shape of all of it is the one the campaign
 * works under: **this app is 100 % client-side, and a font whose bytes the tab
 * cannot get is a font the user cannot ship.** A browser will display any family
 * installed on the device, but `@pdf-lib/fontkit` needs the file itself to embed
 * it, and a web page cannot generally read a system font file. So families are
 * described by *how the face reaches the file* (`carrier`), and a control the
 * chosen writer cannot honour is not offered at all — see `faceSurfaceSupport`.
 *
 * Nothing in here touches a PDF or the DOM: it is the vocabulary the writers and
 * the inspector both speak.
 */
import { SCRIPT_FONTS, isWinAnsiSafe, detectScript } from './fonts';

/** How a run is lined up inside its box. */
export type TextAlignment = 'left' | 'center' | 'right' | 'justify';

/** The two postures a family either carries as a real face or does not. */
export type TextPosture = 'bold' | 'italic';

/**
 * The shared style model: family, weight, style, size, colour, alignment, line
 * height. `model.ts` builds its `InlineStyle` / `EditorStyle` on these seven
 * fields, and every other surface stores this shape directly, so a style can be
 * moved between surfaces without a translation layer inventing its own defaults.
 */
export interface FaceStyle {
  /**
   * A family id from this module's registry. `''` means auto: keep the page's own
   * face when there is one, else the smallest tier that can spell the text.
   */
  fontFamily: string;
  /** Points. */
  size: number;
  /** `#rrggbb`, the colour the writer paints the glyphs with. */
  color: string;
  /** True when a real **bold face** is wanted — never a stroke-fattened regular. */
  bold: boolean;
  /** True when a real **italic/oblique face** is wanted — never a synthetic slant. */
  italic: boolean;
  align: TextAlignment;
  /** Line height as a multiple of the size, so it follows the size when it changes. */
  lineSpacing: number;
}

/** A partial patch: what one control changes. Merging never resets the rest. */
export type FaceStylePatch = Partial<FaceStyle>;

/**
 * How the face behind a family reaches the exported file.
 *
 * - `named` — a standard-14 font: written by name, no bytes, every conforming
 *   reader owns the real face (and it only spells WinAnsi).
 * - `embedded` — a file this app ships in `public/fonts`, fetched and subsetted.
 * - `fetched` — a script face from the same CDN the PDF engine already uses;
 *   embedded once the download succeeds, refused with a sentence when it does not.
 * - `device` — bytes the *browser* can hand over through the Local Font Access
 *   API (Chromium only). Where that API is missing the family is not offered.
 */
export type FaceCarrier = 'named' | 'embedded' | 'fetched' | 'device';

export type FaceFamilyGroup = 'auto' | 'standard' | 'bundled' | 'script' | 'device';

/** One family the style model can name, and the truth about what it can carry. */
export interface FaceFamilySpec {
  id: string;
  label: string;
  group: FaceFamilyGroup;
  carrier: FaceCarrier;
  /**
   * Postures the family holds as **real faces**. A `false` here is not a choice
   * the inspector offers: the button is absent or refused, because an italic the
   * file cannot carry is a preview that lies about the export.
   */
  bold: boolean;
  italic: boolean;
  /** CSS stack for the on-screen surface. Display only — never an export claim. */
  preview: string;
  /** The sentence the UI shows beside this family, when one is owed. */
  claim?: string;
}

/** The auto family: the writer picks the face from the text and the page. */
export const AUTO_FAMILY_ID = '';
/** The bundled Unicode family: the only non-WinAnsi face shipped with the app. */
export const BUNDLED_FAMILY_ID = 'noto';

/**
 * The families the model knows, with the postures each one really carries.
 *
 * The standard-14 entries carry all four postures because the faces are *named*,
 * not synthesised: `Helvetica-Bold` and `Helvetica-Oblique` are separate fonts a
 * reader owns outright. The bundled Noto Sans ships regular and bold only — there
 * is no italic file in `public/fonts`, so `italic: false` and the inspector does
 * not offer slanted Noto, in this app or in the file. The script faces ship one
 * weight each, which is why neither posture is offered for them.
 */
export const FACE_FAMILIES: FaceFamilySpec[] = [
  {
    id: AUTO_FAMILY_ID,
    label: 'Automatic (match the page)',
    group: 'auto',
    carrier: 'named',
    bold: true,
    // Auto answers a run this app cannot spell with the page's own face or the
    // bundled Noto, and neither is guaranteed an italic — so no italic is offered.
    italic: false,
    preview: 'system-ui, sans-serif',
    claim:
      'Keeps the page’s own face when the file can spell the text; otherwise the embedded Unicode face, and a fetched script face for CJK, Arabic, Hebrew, Thai or Indic. Italic is not offered: the faces auto can answer with do not all carry one — pick Helvetica, Times or Courier for a real slant.',
  },
  {
    id: BUNDLED_FAMILY_ID,
    label: 'Noto Sans (bundled)',
    group: 'bundled',
    carrier: 'embedded',
    bold: true,
    italic: false,
    preview: '"Noto Sans", system-ui, sans-serif',
    claim:
      'Ships with this app and is subsetted into the file, so the export carries the same face the screen shows. Italic is not offered: the bundled family has no italic face to embed.',
  },
  {
    id: 'std:helvetica',
    label: 'Helvetica / Arial',
    group: 'standard',
    carrier: 'named',
    bold: true,
    italic: true,
    preview: 'Helvetica, Arial, sans-serif',
    claim:
      'Written by name, so the file stays small and every reader owns the face. Latin-script characters only: a run this cannot spell is written in an embedded Unicode face instead, and the tool says so.',
  },
  {
    id: 'std:times',
    label: 'Times New Roman',
    group: 'standard',
    carrier: 'named',
    bold: true,
    italic: true,
    preview: '"Times New Roman", Times, serif',
    claim:
      'Written by name, so the file stays small and every reader owns the face. Latin-script characters only: a run this cannot spell is written in an embedded Unicode face instead, and the tool says so.',
  },
  {
    id: 'std:courier',
    label: 'Courier New (monospace)',
    group: 'standard',
    carrier: 'named',
    bold: true,
    italic: true,
    preview: '"Courier New", Courier, monospace',
    claim:
      'Written by name, so the file stays small and every reader owns the face. Latin-script characters only: a run this cannot spell is written in an embedded Unicode face instead, and the tool says so.',
  },
  ...SCRIPT_FONTS.map<FaceFamilySpec>((script) => ({
    id: `script:${script.id}`,
    label: `${script.label} (fetched)`,
    group: 'script',
    carrier: 'fetched',
    bold: false,
    italic: false,
    preview: `"${script.label.replace(/^Noto Sans /, 'Noto Sans ')}, system-ui, sans-serif`,
    claim: `${script.label} ships one weight, so bold and italic are not offered for it. The face is downloaded once and subsetted into the file; offline, the run is refused by name.`,
  })),
];

/** The standard-14 ids, for callers that map a rail `font` value onto a family. */
export const STANDARD_FAMILY_IDS: readonly string[] = ['std:helvetica', 'std:times', 'std:courier'];

const BY_ID = new Map(FACE_FAMILIES.map((spec) => [spec.id, spec]));

/** A device family the browser can hand bytes for, added after a font scan. */
export function deviceFamily(
  id: string,
  label: string,
  postures: { bold: boolean; italic: boolean },
): FaceFamilySpec {
  return {
    id,
    label,
    group: 'device',
    carrier: 'device',
    bold: postures.bold,
    italic: postures.italic,
    preview: `"${label}", system-ui, sans-serif`,
    claim:
      'Installed on this device and read through the browser’s font API, so its real bytes go into the file.',
  };
}

/** `local:<family>` — the id shape the Local Font Access tier writes into a style. */
export function deviceFamilyId(family: string): string {
  return `local:${family}`;
}

/** The spec for a family id, counting device families the caller has scanned. */
export function familySpec(id: string, devices: FaceFamilySpec[] = []): FaceFamilySpec | undefined {
  const wanted = id || AUTO_FAMILY_ID;
  return BY_ID.get(wanted) ?? devices.find((spec) => spec.id === wanted);
}

/**
 * Which face answers a (family, text) pair — the fact every posture claim rests on.
 *
 * `core/fonts.getFont` picks by the text's own script: a WinAnsi-safe run in the
 * auto tier goes to a standard-14 face, a run past that goes to the bundled Noto,
 * and a cursive/CJK script goes to the fetched script face. A run is therefore not
 * styled by the family the user named but by the tier that family falls through to,
 * and a posture only exists when *that* face holds it.
 */
export type FaceTier = 'standard' | 'bundled' | 'script' | 'device';

/**
 * The tier that will really write `text` under `familyId`.
 *
 * A standard-14 family that cannot encode the run does not fail — it is
 * *substituted* into the bundled Unicode face (and the tool says so), so the tier
 * follows the substitution rather than the request.
 *
 * `auto` is read at its **weakest** honest answer. The block editor's auto path
 * embeds the bundled Noto for a Latin run (`faces.notoFace`), while the annotation
 * and rail paths may answer the same run with a standard-14 face; a capability
 * table built on the weaker of the two can only ever under-promise, which is the
 * direction a style model is allowed to be wrong in.
 */
export function faceTier(familyId: string, text = ''): FaceTier {
  const id = familyId || AUTO_FAMILY_ID;
  if (id.startsWith('local:')) return 'device';
  if (id.startsWith('script:')) return 'script';
  if (id === BUNDLED_FAMILY_ID) return 'bundled';
  // Auto answers a cursive or CJK script with the fetched face for it, and
  // everything else with the bundled Unicode face.
  if (id === AUTO_FAMILY_ID) return detectScript(text) ? 'script' : 'bundled';
  // A named Latin family keeps its own faces while the text stays inside WinAnsi;
  // past that it is substituted into the bundled Unicode face (`faces.resolveFace`),
  // which is a different face but still one this app holds the bytes for.
  return isWinAnsiSafe(text) && !detectScript(text) ? 'standard' : 'bundled';
}

/** The postures the face behind a tier really holds. */
const TIER_POSTURES: Record<FaceTier, Record<TextPosture, boolean>> = {
  // Helvetica-Bold/-Oblique/-BoldOblique, Times-Bold/-Italic, Courier-Bold/-Oblique.
  standard: { bold: true, italic: true },
  // `NotoSans-Regular.ttf` + `NotoSans-Bold.ttf`; there is no italic file.
  bundled: { bold: true, italic: false },
  // Every fetched script face ships one weight.
  script: { bold: false, italic: false },
  // Decided by the installed faces the device offers, so not answerable here.
  device: { bold: true, italic: true },
};

/**
 * True when this family can carry `posture` **for this text**.
 *
 * The inspector's bold/italic buttons are claims about the bytes, not about CSS:
 * a button appears exactly where the face that will write the run holds the
 * posture, and is absent exactly where the file would drop it. That is what keeps
 * a slanted preview from exporting upright.
 *
 * A device family answers from the faces the browser actually enumerated, which is
 * why `spec` is consulted for that tier and the answer is per family, not per text.
 */
export function carriesPosture(
  familyId: string,
  posture: TextPosture,
  text = '',
  devices: FaceFamilySpec[] = [],
): boolean {
  const tier = faceTier(familyId, text);
  if (tier === 'device') return familySpec(familyId, devices)?.[posture] ?? false;
  return TIER_POSTURES[tier][posture];
}

/** Every family, auto/standard/bundled/script first and device families after. */
export function familyOptions(devices: FaceFamilySpec[] = []): FaceFamilySpec[] {
  return [...FACE_FAMILIES, ...devices];
}

/** The label a style shows under, or the auto label for an id this app does not know. */
export function familyLabel(id: string, devices: FaceFamilySpec[] = []): string {
  const spec = familySpec(id, devices);
  if (spec) return spec.label;
  // A device family the scan has not described yet is still named by its id: the
  // browser can *display* an installed font without the font API being granted.
  if (id.startsWith('local:')) return id.slice('local:'.length);
  return familySpec(AUTO_FAMILY_ID)!.label;
}

/**
 * The CSS stack the surface paints with.
 *
 * A device family renders in its own installed face, which is the honest preview
 * of what the file will carry *because* the same bytes are embedded. For every
 * other family the stack is a display approximation of a face the reader picks;
 * the geometry never comes from CSS — `prepareTextObject` lays the block out.
 */
export function familyPreview(id: string, devices: FaceFamilySpec[] = []): string {
  const spec = familySpec(id, devices);
  if (spec) return spec.preview;
  if (id.startsWith('local:')) return `"${id.slice('local:'.length)}", system-ui, sans-serif`;
  return familySpec(AUTO_FAMILY_ID)!.preview;
}

/* ------------------------------------------------------------------ *
 * Ranges, defaults, merging                                           *
 * ------------------------------------------------------------------ *

   The ranges are the ones the *writers* can render, not the ones a slider likes:
   `clampStyle` in the text editor and `core/guard` both lean on the same numbers,
   so a value that reaches a writer is a value the writer can draw. */

export const FACE_SIZE_RANGE: [number, number] = [1, 400];
export const FACE_LINE_SPACING_RANGE: [number, number] = [0.5, 6];

/** The seven fields, at the values a surface starts from when nothing is stored. */
export const DEFAULT_FACE_STYLE: FaceStyle = {
  fontFamily: AUTO_FAMILY_ID,
  size: 12,
  color: '#000000',
  bold: false,
  italic: false,
  align: 'left',
  lineSpacing: 1.2,
};

/**
 * The surfaces that set type, in the words the UI uses for them.
 *
 * Each one keeps its own starting style — a folio is 11 pt, a watermark is 64 pt
 * bold, a header is 9 pt — because "per-tool defaults preserved" is the difference
 * between a shared model and a shared *value*. The persistence layer stores a
 * style per surface for exactly that reason.
 */
export type FaceSurfaceId =
  'text-editor' | 'freetext' | 'stamp' | 'header-footer' | 'page-numbers' | 'watermark' | 'add-stamps';

const SURFACE_DEFAULTS: Record<FaceSurfaceId, FaceStyle> = {
  'text-editor': DEFAULT_FACE_STYLE,
  freetext: { ...DEFAULT_FACE_STYLE, size: 12, color: '#1B1B18' },
  // A built-in stamp is drawn bold by the format's own convention, and the label
  // is sized to the box the reader shows it in.
  stamp: { ...DEFAULT_FACE_STYLE, size: 14, color: '#AA0000', bold: true },
  'header-footer': { ...DEFAULT_FACE_STYLE, size: 9, color: '#55554E' },
  'page-numbers': { ...DEFAULT_FACE_STYLE, size: 11, color: '#1B1B18' },
  watermark: { ...DEFAULT_FACE_STYLE, size: 64, color: '#888888', bold: true },
  'add-stamps': {
    ...DEFAULT_FACE_STYLE,
    size: 14,
    color: '#DC2626',
    bold: true,
  },
};

/** The style a surface starts from: its own default, overlaid with what is stored. */
export function defaultFaceStyle(surface: FaceSurfaceId): FaceStyle {
  return { ...SURFACE_DEFAULTS[surface] };
}

export interface FaceSurfaceSupport {
  /** Alignments this surface's writer can actually draw into the file. */
  aligns: TextAlignment[];
  /** Whether line height reaches the output. A single-run mark has no lines. */
  lineSpacing: boolean;
  /** Whether the surface can keep the page's own face (`''` = auto does that). */
  keepPageFace: boolean;
}

/**
 * What each surface's *writer* honours, so the control set never offers a claim
 * the bytes cannot keep.
 *
 * `justify` needs a layout engine that stretches a line across a measure: only
 * the block editor (`prepareTextObject` → `layoutBlock`) does that, so the
 * single-run marks — stamp labels, folios, headers, watermarks — do not show it.
 * Line height is the same story: it is the distance between *lines*, and a mark
 * that draws one run has none.
 */
const SURFACE_SUPPORT: Record<FaceSurfaceId, FaceSurfaceSupport> = {
  'text-editor': {
    aligns: ['left', 'center', 'right', 'justify'],
    lineSpacing: true,
    keepPageFace: true,
  },
  freetext: {
    aligns: ['left', 'center', 'right'],
    lineSpacing: true,
    keepPageFace: false,
  },
  stamp: {
    aligns: ['left', 'center', 'right'],
    lineSpacing: false,
    keepPageFace: false,
  },
  'header-footer': {
    aligns: ['left', 'center', 'right'],
    lineSpacing: false,
    keepPageFace: false,
  },
  'page-numbers': {
    aligns: ['left', 'center', 'right'],
    lineSpacing: false,
    keepPageFace: false,
  },
  watermark: {
    aligns: ['left', 'center', 'right'],
    lineSpacing: false,
    keepPageFace: false,
  },
  'add-stamps': {
    aligns: ['left', 'center', 'right'],
    lineSpacing: false,
    keepPageFace: false,
  },
};

export function faceSurfaceSupport(surface: FaceSurfaceId): FaceSurfaceSupport {
  return SURFACE_SUPPORT[surface];
}

/** One number inside the range the writers can render; anything else is ignored. */
export function clampFaceNumber(key: 'size' | 'lineSpacing', value: number): number {
  const [min, max] = key === 'size' ? FACE_SIZE_RANGE : FACE_LINE_SPACING_RANGE;
  if (!Number.isFinite(value)) return DEFAULT_FACE_STYLE[key];
  return Math.min(max, Math.max(min, value));
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** True for the `#rrggbb` spelling every colour control and writer uses. */
export function isFaceColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

/**
 * `base` with `patch` applied: clamped, validated, and **only the keys the patch
 * carries**. A control that changes the size must not silently reset the colour —
 * the reason this is a merge instead of an assignment at the call sites.
 */
export function mergeFaceStyle(base: FaceStyle, patch: FaceStylePatch): FaceStyle {
  const next: FaceStyle = { ...base };
  if (patch.fontFamily !== undefined) next.fontFamily = patch.fontFamily;
  if (patch.size !== undefined) next.size = clampFaceNumber('size', patch.size);
  if (patch.color !== undefined && isFaceColor(patch.color)) next.color = patch.color;
  if (patch.bold !== undefined) next.bold = patch.bold;
  if (patch.italic !== undefined) next.italic = patch.italic;
  if (patch.align !== undefined) next.align = patch.align;
  if (patch.lineSpacing !== undefined) next.lineSpacing = clampFaceNumber('lineSpacing', patch.lineSpacing);
  return next;
}

/**
 * A stored/typed style, with anything the writers cannot render replaced by the
 * surface's own default. Reads from `localStorage` go through this: a hand-edited
 * or older-shaped value must not reach a PDF.
 */
export function sanitizeFaceStyle(value: unknown, surface: FaceSurfaceId): FaceStyle {
  const base = defaultFaceStyle(surface);
  if (!value || typeof value !== 'object') return base;
  const raw = value as Record<string, unknown>;
  const support = SURFACE_SUPPORT[surface];
  const next: FaceStyle = { ...base };
  if (typeof raw.fontFamily === 'string') {
    // Read through the legacy normaliser: a value stored by an older build said
    // `times`, and a style that cannot be resolved reads as auto rather than as a
    // family the writers would then have to invent.
    const id = familyIdFrom(raw.fontFamily);
    if (id === AUTO_FAMILY_ID || familySpec(id) || id.startsWith('local:')) next.fontFamily = id;
  }
  if (typeof raw.size === 'number') next.size = clampFaceNumber('size', raw.size);
  if (isFaceColor(raw.color)) next.color = raw.color;
  if (typeof raw.bold === 'boolean') next.bold = raw.bold;
  if (typeof raw.italic === 'boolean') next.italic = raw.italic && carriesPosture(next.fontFamily, 'italic');
  if (typeof raw.align === 'string' && support.aligns.includes(raw.align as TextAlignment)) {
    next.align = raw.align as TextAlignment;
  }
  if (support.lineSpacing && typeof raw.lineSpacing === 'number') {
    next.lineSpacing = clampFaceNumber('lineSpacing', raw.lineSpacing);
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Persistence                                                         *
 * ------------------------------------------------------------------ *
   Namespaced like every other piece of storage this app owns
   (`browsersnip:recent-files:v1`, `browsersnip:theme`), and stored per surface so
   a watermark's 64 pt bold does not become a folio's starting point. The style is
   small plain data — no document bytes, no font bytes. */

export const FACE_STYLE_STORAGE_KEY = 'browsersnip:text-style:v1';

type StoredStyles = Partial<Record<FaceSurfaceId, unknown>>;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Private mode / blocked storage: the editor still works, it just forgets.
    return null;
  }
}

function readAll(): StoredStyles {
  const raw = storage()?.getItem(FACE_STYLE_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StoredStyles) : {};
  } catch {
    return {};
  }
}

/** The style this surface should open with: stored when sane, its own default otherwise. */
export function loadFaceStyle(surface: FaceSurfaceId): FaceStyle {
  return sanitizeFaceStyle(readAll()[surface], surface);
}

/** Remember the choice, so it survives a tool switch, a reload and a new tab. */
export function saveFaceStyle(surface: FaceSurfaceId, style: FaceStyle): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(FACE_STYLE_STORAGE_KEY, JSON.stringify({ ...readAll(), [surface]: style }));
  } catch {
    // Quota or blocked write: a forgotten style is not worth an error banner.
  }
}

/** Stop remembering one surface's style — its default comes back. */
export function clearFaceStyle(surface: FaceSurfaceId): void {
  const store = storage();
  if (!store) return;
  const next = { ...readAll() };
  delete next[surface];
  try {
    store.setItem(FACE_STYLE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // As above: nothing the user asked for has broken.
  }
}

/**
 * A family id from a value written before this registry existed.
 *
 * The rail tools long spelled a typeface `helvetica`/`times`/`courier`/`noto`/`auto`
 * while the text editor spelled the same pick `std:helvetica`/…/`''`. Both spellings
 * are in saved parameters and in documents people still have open, so the rail reads
 * through here and every consumer downstream sees one id space.
 */
const LEGACY_FAMILY_IDS: Record<string, string> = {
  auto: AUTO_FAMILY_ID,
  '': AUTO_FAMILY_ID,
  noto: BUNDLED_FAMILY_ID,
  helvetica: 'std:helvetica',
  times: 'std:times',
  courier: 'std:courier',
};

export function familyIdFrom(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (LEGACY_FAMILY_IDS[raw.toLowerCase()] !== undefined) return LEGACY_FAMILY_IDS[raw.toLowerCase()];
  // `local:…` and `script:…` pass through; anything unknown reads as auto, which is
  // the only family that can always be spelled by *some* face.
  if (raw.startsWith('local:') || raw.startsWith('script:') || familySpec(raw)) return raw;
  return AUTO_FAMILY_ID;
}
