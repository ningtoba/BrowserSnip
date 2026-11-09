/**
 * The one text style model, read as data.
 *
 * Every surface that sets type — the annotation editor's text box, stamp and
 * in-place editor, and the four rail tools that draw text — now takes its family
 * list, its posture capability, its ranges and its storage from this module. These
 * tests pin the parts that decide whether a control is honest:
 *
 * * a family offers bold/italic **only** when a real face exists for it, because a
 *   synthetic slant on screen and an upright glyph in the file is the exact defect
 *   the campaign refuses;
 * * which face answers depends on the *text* (a Latin-only family substitutes, and
 *   a substitution cannot keep a posture the substituting face lacks);
 * * a patch changes the keys it carries and nothing else — "set the size" must not
 *   reset the colour;
 * * every surface keeps its own starting style, and the stored choice survives a
 *   reload — including a stored posture the family cannot carry, which is dropped
 *   rather than exported as a lie;
 * * a control only appears where the surface's writer can put it in bytes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_FAMILY_ID,
  BUNDLED_FAMILY_ID,
  DEFAULT_FACE_STYLE,
  FACE_FAMILIES,
  STANDARD_FAMILY_IDS,
  carriesPosture,
  clampFaceNumber,
  clearFaceStyle,
  defaultFaceStyle,
  deviceFamily,
  deviceFamilyId,
  faceSurfaceSupport,
  faceTier,
  familyIdFrom,
  familyLabel,
  familyPreview,
  familySpec,
  loadFaceStyle,
  mergeFaceStyle,
  sanitizeFaceStyle,
  saveFaceStyle,
  type FaceFamilySpec,
  type FaceStyle,
} from '@/lib/pdf/core/text-style';

const LATIN = 'Re-measured café 1/4';
/** Hanara — characters no standard-14 face encodes. */
const CJK = '\u306f\u306a\u3089';

describe('the family registry', () => {
  it('lists every family once, with the ids the writers accept', () => {
    const ids = FACE_FAMILIES.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(AUTO_FAMILY_ID);
    expect(ids).toContain(BUNDLED_FAMILY_ID);
    expect(STANDARD_FAMILY_IDS.every((id) => ids.includes(id))).toBe(true);
    // A `script:<id>` entry exists for every face `core/fonts` can fetch.
    for (const spec of FACE_FAMILIES.filter((entry) => entry.group === 'script')) {
      expect(familySpec(spec.id)?.id).toBe(spec.id);
    }
  });

  it('names the four real faces of each standard family and one weight for the rest', () => {
    for (const id of STANDARD_FAMILY_IDS) {
      expect(carriesPosture(id, 'bold'), id).toBe(true);
      expect(carriesPosture(id, 'italic'), id).toBe(true);
    }
    // The bundled family ships `NotoSans-Regular.ttf` and `NotoSans-Bold.ttf`.
    // There is no italic file, so there is no italic button.
    expect(carriesPosture(BUNDLED_FAMILY_ID, 'bold')).toBe(true);
    expect(carriesPosture(BUNDLED_FAMILY_ID, 'italic')).toBe(false);
    // Each fetched script face is one weight.
    for (const spec of FACE_FAMILIES.filter((entry) => entry.group === 'script')) {
      expect(carriesPosture(spec.id, 'bold'), spec.id).toBe(false);
      expect(carriesPosture(spec.id, 'italic'), spec.id).toBe(false);
    }
  });

  it('answers a posture for the family that will really write the text', () => {
    // A Latin-only family keeps its own faces inside WinAnsi and is substituted
    // past it; a substitution cannot carry a slant the substitute does not hold.
    expect(faceTier('std:times', LATIN)).toBe('standard');
    expect(faceTier('std:times', CJK)).toBe('bundled');
    expect(carriesPosture('std:times', 'italic', LATIN)).toBe(true);
    expect(carriesPosture('std:times', 'italic', CJK)).toBe(false);
    expect(carriesPosture('std:times', 'bold', CJK)).toBe(true);
    // Auto answers with a face it cannot promise is slanted, whatever the script.
    expect(carriesPosture(AUTO_FAMILY_ID, 'italic', LATIN)).toBe(false);
    expect(carriesPosture(AUTO_FAMILY_ID, 'bold', LATIN)).toBe(true);
    expect(faceTier(AUTO_FAMILY_ID, CJK)).toBe('script');
  });

  it('treats a device family as embeddable and per-face in posture', () => {
    const installed: FaceFamilySpec[] = [
      deviceFamily(deviceFamilyId('Roboto Condensed'), 'Roboto Condensed', { bold: true, italic: false }),
    ];
    const id = deviceFamilyId('Roboto Condensed');
    expect(faceTier(id)).toBe('device');
    expect(carriesPosture(id, 'bold', LATIN, installed)).toBe(true);
    // No italic face is installed for the family, so no italic is claimed.
    expect(carriesPosture(id, 'italic', LATIN, installed)).toBe(false);
    // A family the scan never returned carries nothing.
    expect(carriesPosture('local:Not There', 'bold', LATIN, installed)).toBe(false);
  });

  it('reads the ids the rail tools wrote before this registry existed', () => {
    expect(familyIdFrom('helvetica')).toBe('std:helvetica');
    expect(familyIdFrom('times')).toBe('std:times');
    expect(familyIdFrom('courier')).toBe('std:courier');
    expect(familyIdFrom('auto')).toBe(AUTO_FAMILY_ID);
    expect(familyIdFrom('noto')).toBe(BUNDLED_FAMILY_ID);
    expect(familyIdFrom('script:jp')).toBe('script:jp');
    expect(familyIdFrom('local:Roboto Condensed')).toBe('local:Roboto Condensed');
    // An id nothing resolves is auto, which every writer can spell.
    expect(familyIdFrom('Comic Shelves')).toBe(AUTO_FAMILY_ID);
    // And a stored style reads the legacy spelling as the family it meant.
    localStorage.setItem('browsersnip:text-style:v1', JSON.stringify({ watermark: { fontFamily: 'times' } }));
    expect(loadFaceStyle('watermark').fontFamily).toBe('std:times');
    localStorage.removeItem('browsersnip:text-style:v1');
  });

  it('labels and previews an unknown id as auto rather than inventing a face', () => {
    expect(familyLabel('std:garamond')).toBe(familyLabel(AUTO_FAMILY_ID));
    expect(familyPreview('std:garamond')).toBe(familyPreview(AUTO_FAMILY_ID));
    expect(familyPreview('local:Roboto Condensed')).toContain('Roboto Condensed');
  });
});

describe('merging a style patch', () => {
  it('changes only the keys the patch carries', () => {
    const base = defaultFaceStyle('freetext');
    const next = mergeFaceStyle(base, { size: 24 });
    expect(next.size).toBe(24);
    expect(next.color).toBe(base.color);
    expect(next.fontFamily).toBe(base.fontFamily);
    expect(next.bold).toBe(base.bold);
    expect(next.align).toBe(base.align);
    expect(next.lineSpacing).toBe(base.lineSpacing);
  });

  it('keeps a posture the family carries and accepts one change at a time', () => {
    const base = defaultFaceStyle('freetext');
    const next = mergeFaceStyle(base, { fontFamily: 'std:times', italic: true });
    expect(next.fontFamily).toBe('std:times');
    expect(next.italic).toBe(true);
    expect(next.bold).toBe(false);
    expect(next.color).toBe(base.color);
    expect(next.size).toBe(base.size);
  });

  it('clamps a number into the range the writers can render', () => {
    expect(clampFaceNumber('size', 0)).toBe(1);
    expect(clampFaceNumber('size', 5000)).toBe(400);
    expect(clampFaceNumber('size', Number.NaN)).toBe(DEFAULT_FACE_STYLE.size);
    expect(clampFaceNumber('lineSpacing', 0.1)).toBe(0.5);
    expect(clampFaceNumber('lineSpacing', 99)).toBe(6);
    expect(mergeFaceStyle(DEFAULT_FACE_STYLE, { size: 900 }).size).toBe(400);
  });

  it('refuses a colour that is not #rrggbb instead of writing a broken fill', () => {
    const base = defaultFaceStyle('freetext');
    expect(mergeFaceStyle(base, { color: 'red' }).color).toBe(base.color);
    expect(mergeFaceStyle(base, { color: '#0a1b2c' }).color).toBe('#0a1b2c');
  });
});

describe('per-surface defaults and support', () => {
  it('keeps each surface starting where it always did', () => {
    expect(defaultFaceStyle('watermark')).toMatchObject({ size: 64, bold: true });
    expect(defaultFaceStyle('page-numbers')).toMatchObject({ size: 11, bold: false });
    expect(defaultFaceStyle('header-footer')).toMatchObject({ size: 9 });
    expect(defaultFaceStyle('freetext')).toMatchObject({ size: 12, fontFamily: AUTO_FAMILY_ID });
    expect(defaultFaceStyle('stamp').bold).toBe(true);
    // The defaults are copies: a surface that mutates one cannot move another.
    const first = defaultFaceStyle('watermark');
    first.size = 1;
    expect(defaultFaceStyle('watermark').size).toBe(64);
  });

  it('offers an alignment or a line height only where the writer can draw it', () => {
    // Justify needs a measure to stretch across: only the block editor has one.
    expect(faceSurfaceSupport('text-editor').aligns).toContain('justify');
    for (const surface of ['freetext', 'stamp', 'header-footer', 'page-numbers', 'watermark', 'add-stamps'] as const) {
      expect(faceSurfaceSupport(surface).aligns, surface).toEqual(['left', 'center', 'right']);
    }
    // A single-run mark has no second line, so line height would do nothing.
    expect(faceSurfaceSupport('text-editor').lineSpacing).toBe(true);
    expect(faceSurfaceSupport('freetext').lineSpacing).toBe(true);
    for (const surface of ['stamp', 'header-footer', 'page-numbers', 'watermark', 'add-stamps'] as const) {
      expect(faceSurfaceSupport(surface).lineSpacing, surface).toBe(false);
    }
  });
});

describe('the stored choice', () => {
  afterEach(() => {
    localStorage.removeItem('browsersnip:text-style:v1');
  });

  it('round-trips a style per surface, so a tool switch and a reload keep it', () => {
    const chosen = mergeFaceStyle(defaultFaceStyle('watermark'), {
      fontFamily: 'std:times',
      italic: true,
      size: 88,
      color: '#059669',
      align: 'center',
    });
    saveFaceStyle('watermark', chosen);
    expect(loadFaceStyle('watermark')).toEqual(chosen);
    // The watermark's choice did not become the folio's default.
    expect(loadFaceStyle('page-numbers')).toEqual(defaultFaceStyle('page-numbers'));
  });

  it('forgets one surface without touching the others', () => {
    saveFaceStyle('freetext', mergeFaceStyle(defaultFaceStyle('freetext'), { size: 30 }));
    saveFaceStyle('stamp', mergeFaceStyle(defaultFaceStyle('stamp'), { size: 22 }));
    clearFaceStyle('freetext');
    expect(loadFaceStyle('freetext')).toEqual(defaultFaceStyle('freetext'));
    expect(loadFaceStyle('stamp').size).toBe(22);
  });

  it('drops a stored posture the family cannot carry, rather than shipping it', () => {
    localStorage.setItem(
      'browsersnip:text-style:v1',
      JSON.stringify({ freetext: { ...DEFAULT_FACE_STYLE, fontFamily: BUNDLED_FAMILY_ID, italic: true } }),
    );
    expect(loadFaceStyle('freetext').italic).toBe(false);
    expect(loadFaceStyle('freetext').fontFamily).toBe(BUNDLED_FAMILY_ID);
  });

  it('falls back to the surface default on junk, and refuses a value another surface owns', () => {
    localStorage.setItem('browsersnip:text-style:v1', '{not json');
    expect(loadFaceStyle('watermark')).toEqual(defaultFaceStyle('watermark'));
    // `justify` is not something a single-run mark can draw, and 900 pt is not a
    // size a writer can lay out: both come back as the surface's own values.
    const stored = {
      watermark: { ...DEFAULT_FACE_STYLE, align: 'justify', size: 900, color: 'rgb(1,2,3)', fontFamily: 'std:times' },
    };
    localStorage.setItem('browsersnip:text-style:v1', JSON.stringify(stored));
    const next = loadFaceStyle('watermark');
    expect(next.align).toBe(defaultFaceStyle('watermark').align);
    expect(next.size).toBe(400);
    expect(next.color).toBe(defaultFaceStyle('watermark').color);
    expect(next.fontFamily).toBe('std:times');
  });

  it('keeps a line height only for the surfaces that lay out more than one line', () => {
    const withLines: FaceStyle = { ...DEFAULT_FACE_STYLE, lineSpacing: 2.5 };
    localStorage.setItem(
      'browsersnip:text-style:v1',
      JSON.stringify({ freetext: withLines, 'page-numbers': withLines }),
    );
    expect(loadFaceStyle('freetext').lineSpacing).toBe(2.5);
    expect(loadFaceStyle('page-numbers').lineSpacing).toBe(defaultFaceStyle('page-numbers').lineSpacing);
    expect(sanitizeFaceStyle({ lineSpacing: 3 }, 'page-numbers').lineSpacing).toBe(1.2);
  });
});
