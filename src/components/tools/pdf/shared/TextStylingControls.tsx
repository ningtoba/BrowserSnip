/**
 * The one set of text-styling controls.
 *
 * Every surface that sets type mounts this: the annotation editor's inspector
 * (text box, stamp) and the in-place text editor's format panel. It renders a
 * control only where two things are true — the surface's writer can put the value
 * into the file (`faceSurfaceSupport`), and the chosen family holds the posture as
 * a real face (`carriesPosture`). A disabled button with the reason on it is what
 * replaces the version of this where italic looked fine on screen and exported
 * upright.
 *
 * Tokens only: `doodle-input` / `doodle-chip` and the `text-ink-*` family, so dark
 * mode comes along for free.
 */
import {
  carriesPosture,
  faceSurfaceSupport,
  familyLabel,
  type FaceFamilySpec,
  type FaceStyle,
  type FaceStylePatch,
  type FaceSurfaceId,
  type TextAlignment,
} from '@/lib/pdf/core/text-style';

export interface TextStylingControlsProps {
  /** Which surface is styling this text; decides alignment and line-height. */
  surface: FaceSurfaceId;
  style: FaceStyle;
  /** The text being styled — a Latin-only family loses italic past WinAnsi. */
  text: string;
  families: FaceFamilySpec[];
  onChange: (patch: FaceStylePatch) => void;
  /** Keys the selection disagrees about; shown as `mixed` instead of a value. */
  mixed?: readonly (keyof FaceStyle)[];
  disabled?: boolean;
  /** Present when the browser can enumerate installed fonts. */
  onScanLocalFonts?: () => void;
  localFontsSupported?: boolean;
  localFontsLoaded?: boolean;
}

const ALIGN_LABELS: Record<TextAlignment, { label: string; title: string }> = {
  left: { label: '⬅', title: 'Align left' },
  center: { label: '⬌', title: 'Centre' },
  right: { label: '➡', title: 'Align right' },
  justify: { label: '☰', title: 'Justify' },
};

/** The number the control shows when the set disagrees about that key. */
const MIXED = 'mixed';

/**
 * Why a family is not offering a posture, in the words the control carries.
 *
 * `(no italic)` is not decoration: it is the answer to "why is the button not
 * there", printed where the user would otherwise guess the app is broken.
 */
function familyTitle(spec: FaceFamilySpec): string {
  const missing = [spec.bold ? '' : 'bold', spec.italic ? '' : 'italic'].filter(Boolean);
  const claim = spec.claim ?? '';
  return missing.length > 0 ? `${claim} No real ${missing.join(' or ')} face to embed.` : claim;
}

/** One inspector control set for family, weight, slant, size, colour, alignment and line height. */
export function TextStylingControls({
  surface,
  style,
  text,
  families,
  onChange,
  mixed = [],
  disabled = false,
  onScanLocalFonts,
  localFontsSupported = false,
  localFontsLoaded = false,
}: TextStylingControlsProps): JSX.Element {
  const support = faceSurfaceSupport(surface);
  const isMixed = (key: keyof FaceStyle) => mixed.includes(key);
  const boldOn = carriesPosture(style.fontFamily, 'bold', text, families);
  const italicOn = carriesPosture(style.fontFamily, 'italic', text, families);
  const spec = families.find((family) => family.id === style.fontFamily);
  const alignments = support.aligns;

  return (
    <div
      className={`space-y-2 ${disabled ? 'opacity-50' : ''}`}
      data-text-styling={surface}
      data-family={style.fontFamily || 'auto'}
    >
      <label className="block space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Family</span>
        <span className="flex items-center gap-1">
          <select
            value={style.fontFamily}
            disabled={disabled}
            onChange={(event) => onChange({ fontFamily: event.target.value })}
            className="doodle-input !px-2 !py-1 !text-[11px]"
            aria-label="Font family"
            title={spec ? familyTitle(spec) : undefined}
          >
            {families.map((family) => (
              <option key={family.id || 'auto'} value={family.id} title={familyTitle(family)}>
                {familyLabel(family.id, families)}
                {family.italic ? '' : ' (no italic)'}
              </option>
            ))}
          </select>
          {localFontsSupported && !localFontsLoaded && onScanLocalFonts ? (
            <button
              type="button"
              disabled={disabled}
              onClick={onScanLocalFonts}
              className="doodle-chip doodle-chip-inactive shrink-0 px-2 py-1 text-[10px]"
              title="List the fonts installed on this device, so their real bytes can be embedded"
            >
              Scan
            </button>
          ) : null}
        </span>
      </label>

      <p className="text-[10px] leading-relaxed text-ink-muted" data-family-claim={style.fontFamily || 'auto'}>
        {spec?.claim ??
          'The face named here is the face the file carries: embedded, or named for a reader that owns it.'}
      </p>

      <div className="flex flex-wrap items-end gap-1">
        <FaceButton
          label="B"
          title={boldOn ? 'Bold — a real bold face is written into the file' : 'No bold face to embed for this family'}
          active={style.bold}
          offerable={boldOn}
          disabled={disabled}
          onClick={() => onChange({ bold: !style.bold })}
        />
        <FaceButton
          label="I"
          title={
            italicOn
              ? 'Italic — a real italic or oblique face is written into the file'
              : 'No italic face to embed for this family; the export would be upright'
          }
          active={style.italic}
          offerable={italicOn}
          disabled={disabled}
          onClick={() => onChange({ italic: !style.italic })}
        />
        <span className="ml-auto block w-20">
          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Size</span>
            <input
              type="number"
              min={1}
              max={400}
              step={0.5}
              value={isMixed('size') ? '' : style.size}
              placeholder={isMixed('size') ? MIXED : undefined}
              disabled={disabled}
              onChange={(event) => onChange({ size: event.target.valueAsNumber })}
              className="doodle-input !px-2 !py-1 !text-[11px]"
              aria-label="Text size in points"
            />
          </label>
        </span>
        <span className="block w-12">
          <label className="block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Colour</span>
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#000000'}
              disabled={disabled}
              onChange={(event) => onChange({ color: event.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-cream-border bg-white"
              aria-label="Text colour"
            />
          </label>
        </span>
      </div>

      <div className="space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Align</span>
        <span className="flex gap-1" role="group" aria-label="Alignment">
          {alignments.map((align) => (
            <button
              key={align}
              type="button"
              disabled={disabled}
              aria-pressed={style.align === align}
              title={ALIGN_LABELS[align].title}
              onClick={() => onChange({ align })}
              className={`doodle-chip px-2 py-1 text-[11px] ${
                style.align === align ? 'doodle-chip-active' : 'doodle-chip-inactive'
              }`}
            >
              {ALIGN_LABELS[align].label}
            </button>
          ))}
        </span>
      </div>

      {support.lineSpacing ? (
        <label className="block space-y-1">
          <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            <span>Line height</span>
            <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
              {isMixed('lineSpacing') ? MIXED : `${style.lineSpacing.toFixed(2)}×`}
            </span>
          </span>
          <input
            type="range"
            min={0.5}
            max={4}
            step={0.05}
            value={style.lineSpacing}
            disabled={disabled}
            onChange={(event) => onChange({ lineSpacing: event.target.valueAsNumber })}
            className="w-full"
            aria-label="Line height as a multiple of the text size"
          />
        </label>
      ) : null}
    </div>
  );
}

/**
 * A posture button, or the reason it is not there.
 *
 * A posture the family cannot carry renders as a static, titled dash rather than a
 * live button: a control that changes a value no writer honours is the thing this
 * campaign keeps finding, so the value cannot even be set.
 */
function FaceButton({
  label,
  title,
  active,
  offerable,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  offerable: boolean;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  if (!offerable) {
    return (
      <button
        type="button"
        disabled
        title={title}
        aria-label={title}
        className="h-7 w-7 shrink-0 rounded-doodle-md border border-dashed border-cream-border font-display text-[12px] leading-none text-ink-muted/60"
      >
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`h-7 w-7 shrink-0 rounded-doodle-md border font-display text-[12px] leading-none ${
        active ? 'border-[var(--accent-line)] bg-[var(--accent-tint)] text-[var(--accent)]' : 'border-cream-border text-ink-soft'
      } ${label === 'I' ? 'italic' : 'font-bold'}`}
    >
      {label}
    </button>
  );
}
