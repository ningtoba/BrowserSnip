/**
 * The rail form's half of the shared text style model.
 *
 * Four tools draw a single run of text into a page — header/footer, page numbers,
 * watermark and add-stamps — and each declared its own partial idea of style: a
 * size and colour here, a bold toggle there, a typeface list (`auto`/`noto`/
 * `helvetica`/…) spelled differently again from the editor's `std:helvetica` ids.
 * This module builds those fields from `core/text-style`'s registry instead, so the
 * rail, the annotation inspector and the in-place text editor offer the same
 * families with the same claims, and a value chosen in one means the same in the
 * others.
 *
 * What is deliberately **not** here is as load-bearing as what is:
 *
 * * **Alignment.** These marks are placed by an anchor (`bottom-centre`, `top-right`,
 *   a rotation, a tiling), and the anchor already *is* the alignment. A second
 *   control writing the same byte is how a form ends up with two answers.
 * * **Line height.** Line height is the distance between lines, and each of these
 *   tools writes exactly one run per placement. `faceSurfaceSupport` reports
 *   `lineSpacing: false` for them, and the control is not rendered.
 * * **Italic for a family with no italic face.** `carriesPosture` answers per
 *   family, so the field disappears for Noto Sans and every fetched script face
 *   rather than setting a value no writer would honour.
 */
import {
  carriesPosture,
  familyIdFrom,
  familyOptions,
  faceSurfaceSupport,
  loadFaceStyle,
  mergeFaceStyle,
  sanitizeFaceStyle,
  saveFaceStyle,
  type FaceStyle,
  type FaceSurfaceId,
} from '../core/text-style';
import { rgb } from '../core/doc';
import type { ToolField, ToolValues } from './types';
import { booleanValue, numberValue, stringValue } from './types';

/** One style field, in the words the rail uses. */
export interface TextStyleField extends ToolField {
  key: 'font' | 'bold' | 'italic' | 'fontSize' | 'color';
}

export interface TextStyleFieldOptions {
  /** The surface's own starting values, so a watermark still opens at 64 pt bold. */
  surface: FaceSurfaceId;
  /** Rail section the fields land in. */
  group: string;
  /** Overrides the tool's declared defaults (size range, colour, half-width layout). */
  size?: { default?: number; min?: number; max?: number; step?: number; half?: boolean; help?: string };
  color?: { default?: string; help?: string };
  boldDefault?: boolean;
  /** Include the typeface picker. On by default; the tools that never had one gain it. */
  family?: boolean;
  /**
   * A tool-level gate, and-ed with the posture gates: a watermark's type fields are
   * irrelevant to an image mark, so the whole set disappears with the text box.
   */
  when?: (values: ToolValues) => boolean;
}

/** The rail's typeface picker: every family the registry can honestly name. */
export function textStyleFamilyOptions(): { value: string; label: string; hint?: string }[] {
  return familyOptions().map((spec) => {
    const missing = [spec.bold ? '' : 'no bold face', spec.italic ? '' : 'no italic face'].filter(Boolean);
    return {
      value: spec.id,
      label: `${spec.label}${missing.length > 0 ? ` (${missing.join(', ')})` : ''}`,
      hint: spec.claim,
    };
  });
}

/**
 * The style fields for one text-drawing tool.
 *
 * Order matters for the rail: `parity-definitions` refuses to bury a `select` under
 * the collapsing bar, so the picker comes first and the two toggles next.
 */
export function textStyleFields(options: TextStyleFieldOptions): TextStyleField[] {
  const support = faceSurfaceSupport(options.surface);
  // The tool's own gate, when it has one: `when: (v) => v.type === 'text'`.
  const gate = (extra?: (values: ToolValues) => boolean) =>
    extra && options.when
      ? (values: ToolValues) => options.when!(values) && extra(values)
      : extra ?? options.when;
  const fields: TextStyleField[] = [];
  if (options.family !== false) {
    fields.push({
      key: 'font',
      label: 'Typeface',
      type: 'select',
      // Auto is the honest default: it keeps the run in the smallest face that can
      // spell it, which is a named face for Latin and an embedded subset past that.
      default: '',
      options: textStyleFamilyOptions(),
      when: options.when,
      group: options.group,
      help:
        'Each entry says what it can carry: the standard faces are written by name, Noto Sans ships with the app, and a family with no real bold or italic face has no bold or italic in the file either.',
    });
  }
  fields.push({
    key: 'bold',
    label: 'Bold',
    type: 'toggle',
    default: options.boldDefault ?? false,
    group: options.group,
    when: gate((values) => carriesPosture(familyIdFrom(values.font), 'bold')),
    help: 'A real bold face is written — Helvetica-Bold, Times-Bold, Courier-Bold or Noto Sans Bold — never a stroke run twice over the regular.',
  });
  fields.push({
    key: 'italic',
    label: 'Italic',
    type: 'toggle',
    default: false,
    group: options.group,
    // The field is not rendered for a family with no slanted face, so there is no
    // way to set a value the export would drop.
    when: gate((values) => carriesPosture(familyIdFrom(values.font), 'italic')),
    help: 'A real italic or oblique face. Not offered for Noto Sans or the script faces: this app ships no italic file for them, and a slant the file cannot carry is a preview that lies.',
  });
  fields.push({
    key: 'fontSize',
    label: 'Font size',
    type: 'number',
    default: options.size?.default ?? 12,
    min: options.size?.min ?? 1,
    max: options.size?.max ?? 400,
    step: options.size?.step ?? 1,
    unit: 'pt',
    half: options.size?.half ?? true,
    group: options.group,
    when: options.when,
    help:
      options.size?.help
      ?? 'Points, measured against the page as it is displayed.',
  });
  fields.push({
    key: 'color',
    label: 'Colour',
    type: 'color',
    default: options.color?.default ?? '#1B1B18',
    group: options.group,
    when: options.when,
    help: options.color?.help ?? 'Applied to the drawn glyphs.',
  });
  // `support.lineSpacing` is false for every rail tool: one run, no lines between
  // which to space. The check is here so the claim stays a fact, not a comment.
  void support;
  return fields;
}

/**
 * The style a rail run should write, from the tool's values.
 *
 * `fontSize`/`color`/`bold`/`font` are read with the same clamp the guard used on
 * them, and the result passes through `sanitizeFaceStyle` so a value that cannot be
 * drawn (a size of 0, an alignment a single-run mark cannot show) never reaches a
 * content stream.
 */
export function readTextStyle(values: ToolValues, surface: FaceSurfaceId): FaceStyle {
  const stored = loadFaceStyle(surface);
  const merged = mergeFaceStyle(stored, {
    fontFamily: familyIdFrom(values.font ?? ''),
    size: numberValue(values, 'fontSize', stored.size),
    color: sanitizeColor(stringValue(values, 'color', stored.color), stored.color),
    bold: booleanValue(values, 'bold'),
    italic: booleanValue(values, 'italic'),
  });
  return sanitizeFaceStyle(merged, surface);
}

/** Remember a rail tool's style so the next run of it opens the same way. */
export function rememberTextStyle(surface: FaceSurfaceId, style: FaceStyle): void {
  saveFaceStyle(surface, style);
}

function sanitizeColor(value: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim() : fallback;
}

/**
 * The posture a style asks for that the answering face cannot carry, in a sentence.
 *
 * A Latin-only family substituted into Noto past WinAnsi loses a slant, and the run
 * is upright in the file while the form said italic. The tool prints this rather than
 * letting the user find it in the export.
 */
export function postureLoss(style: FaceStyle, text: string): string | null {
  if (!style.italic) return null;
  if (carriesPosture(style.fontFamily, 'italic', text)) return null;
  return `${familyShort(style.fontFamily)} has no italic face this app can embed for “${[...text].slice(0, 12).join('')}”, so the run is written upright.`;
}

function familyShort(id: string): string {
  return id.replace(/^std:/, '');
}

/** pdf-lib colour for the model's `#rrggbb`, for the tools that draw a run. */
export function faceColor(hex: string) {
  return rgb(...rgbParts(hex));
}

/**
 * The colour the model carries, as three numbers.
 *
 * The appearance writers want the components rather than a pdf-lib colour, so the
 * parse lives next to the model that produced the string.
 */
export function rgbParts(hex: string): [number, number, number] {
  const clean = hex.trim().replace('#', '');
  const int = /^([0-9a-fA-F]{3})$/.test(clean)
    ? Number.parseInt(clean.split('').map((c) => c + c).join(''), 16)
    : Number.parseInt(clean.slice(0, 6) || '0', 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}
