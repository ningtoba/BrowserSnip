/**
 * Presentational controls for the in-place text editor.
 *
 * Every control here is dumb: it takes values and callbacks, holds no state, and
 * knows nothing about pdf.js or `pdf-lib`. The decisions live in `model.ts`, the
 * bytes in `draw.ts`, and the wiring in `TextEditor.tsx`. Styling reuses the
 * app's existing vocabulary (`doodle-*`, `cream`, `ink`, category accents).
 */
import {
  SWATCH_COLORS,
  ZOOM_PRESETS,
  rulerTicks,
  type AlignMode,
  type BulletMarker,
  type DistributeAxis,
  type EditObject,
  type EditScope,
  type EditorStyle,
  type FitMode,
  type ListKind,
  type NumberMarker,
  type TextDirection,
} from './model';
import type { FontFamilyOption } from './faces';

// ── primitives ──────────────────────────────────────────────────────────────

interface ButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  active?: boolean;
  className?: string;
}

export function ToolButton({ label, onClick, disabled, title, kind = 'secondary', active, className = '' }: ButtonProps) {
  const base =
    kind === 'primary'
      ? 'doodle-btn !w-auto !px-3 !py-1.5 !text-[11px]'
      : kind === 'danger'
        ? 'doodle-btn-danger !px-2.5 !py-1 !text-[11px]'
        : active
          ? 'doodle-chip doodle-chip-active !px-2.5 !py-1 !text-[11px] !flex-none'
          : 'doodle-chip doodle-chip-inactive !px-2.5 !py-1 !text-[11px] !flex-none';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={`${base} ${className}`}
    >
      {label}
    </button>
  );
}

export function PanelHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{children}</p>
  );
}

export function Labeled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
      {children}
      {hint && <span className="block text-[10px] leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 100) / 100 : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="doodle-input !px-2 !py-1 !text-[11px]"
      />
      {suffix && <span className="font-mono text-[9px] text-ink-muted">{suffix}</span>}
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        <span>{label}</span>
        <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
          {Math.round(value * 100) / 100}
          {suffix ?? ''}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
        className="w-full accent-[#2563EB]"
      />
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  hint?: string;
}) {
  return (
    <Labeled label={label} hint={hint}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        className="doodle-input !px-2 !py-1 !text-[11px]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Labeled>
  );
}

export function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="space-y-1">
      {label && <PanelHeading>{label}</PanelHeading>}
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <ToolButton
            key={option.value}
            label={option.label}
            title={option.title ?? option.label}
            active={value === option.value}
            onClick={() => onChange(option.value)}
          />
        ))}
      </div>
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  title?: string;
}) {
  return (
    <label
      title={title}
      className="flex cursor-pointer items-center justify-between gap-2 py-0.5 text-[11px] text-ink-soft"
    >
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-[#2563EB]"
      />
    </label>
  );
}

/** Swatch row plus the browser's own picker, for any colour in the model. */
export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const safe = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : '#000000';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <PanelHeading>{label}</PanelHeading>
        <input
          type="color"
          value={safe}
          onChange={(event) => onChange(event.target.value)}
          className="ml-auto h-6 w-8 cursor-pointer rounded border border-cream-border bg-white"
          aria-label={`${label} picker`}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {SWATCH_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={`${label} ${color}`}
            onClick={() => onChange(color)}
            className={`h-4 w-4 rounded border ${value.toLowerCase() === color.toLowerCase() ? 'border-accent ring-1 ring-accent/40' : 'border-cream-border'}`}
            style={{ background: color }}
          />
        ))}
      </div>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="doodle-input !px-2 !py-1 font-mono !text-[10px]"
        aria-label={`${label} hex value`}
      />
    </div>
  );
}

// ── toolbar ─────────────────────────────────────────────────────────────────

export interface ToolbarProps {
  hasDocument: boolean;
  dirty: number;
  page: number;
  numPages: number;
  zoom: number;
  showRulers: boolean;
  barsHidden: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onBack: () => void;
  onOpenAnother: () => void;
  onExport: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onJumpPage: (page: number) => void;
  onZoom: (scale: number) => void;
  onFit: (mode: FitMode) => void;
  onToggleRulers: () => void;
  onToggleBars: () => void;
  onCopyPageText: () => void;
  onReloadPreview: () => void;
}

export function TopToolbar(props: ToolbarProps) {
  const percent = Math.round(props.zoom * 100);
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-cream-border bg-cream-light px-2 py-1.5">
      <ToolButton label="‹ Back to upload" onClick={props.onBack} title="Close this PDF and return to the file drop" />
      <ToolButton label="Open another PDF" onClick={props.onOpenAnother} />
      <ToolButton label="Export" kind="primary" onClick={props.onExport} disabled={!props.hasDocument} title="Save the edited PDF (Ctrl+S)" />
      <span className="mx-1 h-4 w-px bg-cream-border" />
      <ToolButton label="Undo" onClick={props.onUndo} disabled={!props.canUndo} title="Undo (Ctrl+Z)" />
      <ToolButton label="Redo" onClick={props.onRedo} disabled={!props.canRedo} title="Redo (Ctrl+Shift+Z)" />
      <span className="mx-1 h-4 w-px bg-cream-border" />
      <ToolButton label="◂" onClick={props.onPrevPage} disabled={props.page <= 1} title="Previous page" />
      <span className="min-w-[4.5rem] text-center font-mono text-[10px] tabular-nums text-ink-muted">
        page
        <input
          type="number"
          value={props.page}
          min={1}
          max={Math.max(1, props.numPages)}
          onChange={(event) => props.onJumpPage(event.target.valueAsNumber)}
          className="mx-1 w-12 rounded border border-cream-border bg-white px-1 py-0.5 text-center text-[11px] text-ink"
          aria-label="Jump to page"
        />
        of {props.numPages || '—'}
      </span>
      <ToolButton label="▸" onClick={props.onNextPage} disabled={props.page >= props.numPages} title="Next page" />
      <span className="mx-1 h-4 w-px bg-cream-border" />
      <select
        value={String(percent)}
        onChange={(event) => props.onZoom(Number(event.target.value) / 100)}
        className="doodle-input !w-auto !px-2 !py-1 !text-[11px]"
        aria-label="Zoom"
      >
        {ZOOM_PRESETS.map((preset) => (
          <option key={preset} value={String(Math.round(preset * 100))}>
            {Math.round(preset * 100)}%
          </option>
        ))}
      </select>
      <ToolButton label="Fit page" onClick={() => props.onFit('page')} />
      <ToolButton label="Fit width" onClick={() => props.onFit('width')} />
      <span className="mx-1 h-4 w-px bg-cream-border" />
      <ToolButton label={props.showRulers ? 'Hide rulers' : 'Rulers'} active={props.showRulers} onClick={props.onToggleRulers} />
      <ToolButton label={props.barsHidden ? 'Show bars' : 'Hide bars'} onClick={props.onToggleBars} />
      <ToolButton label="Copy page text" onClick={props.onCopyPageText} disabled={!props.hasDocument} title="Copy this page's text in reading order" />
      <ToolButton label="Reload preview" onClick={props.onReloadPreview} disabled={!props.hasDocument} title="Re-render the page from the edited bytes" />
      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        {props.dirty > 0 ? `${props.dirty} block(s) waiting for export` : 'nothing to export'}
      </span>
    </div>
  );
}

// ── mode + scope ────────────────────────────────────────────────────────────

export interface ModePanelProps {
  mode: 'edit' | 'add-text' | 'add-image';
  scope: EditScope;
  onMode: (mode: 'edit' | 'add-text' | 'add-image') => void;
  onScope: (scope: EditScope) => void;
  onPickImage: () => void;
}

export function ModePanel({ mode, scope, onMode, onScope, onPickImage }: ModePanelProps) {
  return (
    <div className="space-y-2">
      <SegmentedField
        label="Tool"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'edit', label: 'Edit', title: 'Click a paragraph and retype it' },
          { value: 'add-text', label: 'Add text box', title: 'Drag on the page to place new text' },
          { value: 'add-image', label: 'Add image', title: 'Choose an image, then click where it goes' },
        ]}
      />
      {mode === 'edit' && (
        <SelectField
          label="Edit scope"
          value={scope}
          onChange={onScope}
          options={[
            { value: 'text', label: 'Text' },
            { value: 'image', label: 'Images' },
            { value: 'shape', label: 'Shapes' },
            { value: 'all', label: 'All' },
          ]}
          hint="Which objects a click may grab. Words you have not edited yet are always text."
        />
      )}
      {mode === 'add-image' && <ToolButton label="Choose image…" onClick={onPickImage} className="w-full" />}
    </div>
  );
}

// ── format inspector ────────────────────────────────────────────────────────

export interface FormatPanelProps {
  style: EditorStyle;
  hasSelection: boolean;
  families: FontFamilyOption[];
  localFontsSupported: boolean;
  localFontsLoaded: boolean;
  onScanLocalFonts: () => void;
  onStyle: (patch: Partial<EditorStyle>) => void;
  onInline: (patch: Partial<EditorStyle>) => void;
  onList: (kind: ListKind) => void;
  notes: string[];
}

export function FormatPanel({
  style,
  hasSelection,
  families,
  localFontsSupported,
  localFontsLoaded,
  onScanLocalFonts,
  onStyle,
  onInline,
  onList,
  notes,
}: FormatPanelProps) {
  const disabled = !hasSelection;
  return (
    <div className={`space-y-3 ${disabled ? 'opacity-50' : ''}`}>
      <PanelHeading>Format</PanelHeading>
      <Labeled
        label="Font"
        hint={
          localFontsSupported
            ? localFontsLoaded
              ? 'System fonts are embedded into the file, so the result looks the same everywhere.'
              : 'Local Font Access is available — scan to add your installed fonts.'
            : 'This browser has no Local Font Access, so the list is bundled and script faces.'
        }
      >
        <div className="flex items-center gap-1">
          <select
            value={style.fontFamily}
            disabled={disabled}
            onChange={(event) => onInline({ fontFamily: event.target.value })}
            className="doodle-input !px-2 !py-1 !text-[11px]"
          >
            {families.map((family) => (
              <option key={family.id} value={family.id}>
                {family.label}
              </option>
            ))}
          </select>
          {localFontsSupported && !localFontsLoaded && (
            <ToolButton label="Scan" onClick={onScanLocalFonts} title="List the fonts installed on this device" />
          )}
        </div>
      </Labeled>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Size">
          <NumberField
            value={style.size}
            min={1}
            max={400}
            step={0.5}
            onChange={(size) => onInline({ size })}
          />
        </Labeled>
        <Labeled label="Direction">
          <SelectField
            label=""
            value={style.direction}
            onChange={(direction: TextDirection) => onStyle({ direction })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'ltr', label: 'LTR' },
              { value: 'rtl', label: 'RTL' },
            ]}
          />
        </Labeled>
      </div>
      <ColorField label="Colour" value={style.color} onChange={(color) => onInline({ color })} />
      <SegmentedField
        label="Align"
        value={style.align}
        onChange={(align) => onStyle({ align })}
        options={[
          { value: 'left', label: '⬅', title: 'Left' },
          { value: 'center', label: '⬌', title: 'Centre' },
          { value: 'right', label: '➡', title: 'Right' },
          { value: 'justify', label: '☰', title: 'Justify' },
        ]}
      />
      <div className="space-y-1">
        <PanelHeading>Style</PanelHeading>
        <div className="flex flex-wrap gap-1">
          {(
            [
              ['bold', 'B', 'Bold'],
              ['italic', 'I', 'Italic'],
              ['underline', 'U̲', 'Underline'],
              ['strike', 'S̶', 'Strikethrough'],
              ['superscript', 'x²', 'Superscript'],
              ['subscript', 'x₂', 'Subscript'],
            ] as const
          ).map(([key, label, title]) => (
            <ToolButton
              key={key}
              label={label}
              title={title}
              active={Boolean(style[key])}
              disabled={disabled}
              onClick={() => onInline({ [key]: !style[key] } as Partial<EditorStyle>)}
            />
          ))}
        </div>
      </div>
      <div className="space-y-1.5">
        <PanelHeading>Lists</PanelHeading>
        <div className="flex flex-wrap gap-1">
          <ToolButton label="• Bullet" active={style.list === 'bullet'} disabled={disabled} onClick={() => onList('bullet')} />
          <ToolButton label="1. Number" active={style.list === 'number'} disabled={disabled} onClick={() => onList('number')} />
          <ToolButton label="None" active={style.list === 'none'} disabled={disabled} onClick={() => onList('none')} />
        </div>
        {style.list === 'bullet' && (
          <SelectField
            label="Marker"
            value={style.bulletMarker}
            onChange={(bulletMarker: BulletMarker) => onStyle({ bulletMarker })}
            options={[
              { value: 'dot', label: '• dot' },
              { value: 'circle', label: '◦ circle' },
              { value: 'square', label: '▪ square' },
              { value: 'dash', label: '– dash' },
              { value: 'arrow', label: '▸ arrow' },
            ]}
          />
        )}
        {style.list === 'number' && (
          <SelectField
            label="Marker"
            value={style.numberMarker}
            onChange={(numberMarker: NumberMarker) => onStyle({ numberMarker })}
            options={[
              { value: 'decimal', label: '1, 2, 3' },
              { value: 'lower-alpha', label: 'a, b, c' },
              { value: 'upper-alpha', label: 'A, B, C' },
              { value: 'lower-roman', label: 'i, ii, iii' },
              { value: 'upper-roman', label: 'I, II, III' },
            ]}
          />
        )}
      </div>
      <SliderField label="Line spacing" value={style.lineSpacing} min={0.5} max={4} step={0.05} suffix="×" onChange={(lineSpacing) => onStyle({ lineSpacing })} />
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Space before">
          <NumberField value={style.spaceBefore} min={0} max={200} step={0.5} suffix="pt" onChange={(spaceBefore) => onStyle({ spaceBefore })} />
        </Labeled>
        <Labeled label="Space after">
          <NumberField value={style.spaceAfter} min={0} max={200} step={0.5} suffix="pt" onChange={(spaceAfter) => onStyle({ spaceAfter })} />
        </Labeled>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Labeled label="Indent">
          <NumberField value={style.indent} min={-100} max={400} step={0.5} suffix="pt" onChange={(indent) => onStyle({ indent })} />
        </Labeled>
        <Labeled label="First line">
          <NumberField value={style.firstLineIndent} min={-100} max={400} step={0.5} suffix="pt" onChange={(firstLineIndent) => onStyle({ firstLineIndent })} />
        </Labeled>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SliderField label="Character spacing" value={style.charSpacing} min={-2} max={20} step={0.05} suffix="pt" onChange={(charSpacing) => onStyle({ charSpacing })} />
        <SliderField label="Word spacing" value={style.wordSpacing} min={-2} max={40} step={0.05} suffix="pt" onChange={(wordSpacing) => onStyle({ wordSpacing })} />
      </div>
      <SliderField label="Horizontal scale" value={style.horizontalScale} min={20} max={300} step={1} suffix="%" onChange={(horizontalScale) => onStyle({ horizontalScale })} />
      <div className="space-y-1.5 rounded-doodle-md border border-cream-border bg-cream-soft p-2">
        <PanelHeading>Text outline</PanelHeading>
        <div className="grid grid-cols-2 gap-2">
          <ColorField label="Colour" value={style.outlineColor} onChange={(outlineColor) => onStyle({ outlineColor })} />
          <Labeled label="Width">
            <NumberField value={style.outlineWidth} min={0} max={20} step={0.1} suffix="pt" onChange={(outlineWidth) => onStyle({ outlineWidth })} />
          </Labeled>
        </div>
      </div>
      <SliderField label="Opacity" value={style.opacity} min={0} max={1} step={0.05} onChange={(opacity) => onStyle({ opacity })} />
      {notes.map((note) => (
        <p key={note} className="rounded-doodle-md border border-warn/25 bg-warn/5 p-2 text-[10px] leading-relaxed text-warn">
          {note}
        </p>
      ))}
    </div>
  );
}

// ── object inspector ────────────────────────────────────────────────────────

export interface ObjectPanelProps {
  selection: EditObject[];
  onTransform: (patch: { rotation?: number; flipH?: boolean; flipV?: boolean }) => void;
  onRotate: (delta: number) => void;
  onZOrder: (order: 'front' | 'back' | 'forward' | 'backward') => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: DistributeAxis) => void;
  onAlt: (value: string) => void;
  onReplaceImage: () => void;
  onMove: (dx: number, dy: number) => void;
}

export function ObjectPanel(props: ObjectPanelProps) {
  const selected = props.selection;
  const first = selected[0];
  if (!first) {
    return (
      <div className="space-y-2">
        <PanelHeading>Objects</PanelHeading>
        <p className="text-[10px] leading-relaxed text-ink-muted">
          Click a paragraph to edit its words, or a placed object to move, rotate,
          restack or describe it. Shift-click to select several and align them.
        </p>
      </div>
    );
  }
  const image = first.kind === 'image' ? first : null;
  return (
    <div className="space-y-2.5">
      <PanelHeading>Object · {first.kind === 'text' ? 'text block' : 'image'} on page {first.page}</PanelHeading>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="⟲ −90°" onClick={() => props.onRotate(-90)} title="Rotate counter-clockwise" />
        <ToolButton label="⟳ +90°" onClick={() => props.onRotate(90)} title="Rotate clockwise" />
        <ToolButton label="Flip H" active={first.flipH} onClick={() => props.onTransform({ flipH: !first.flipH })} />
        <ToolButton label="Flip V" active={first.flipV} onClick={() => props.onTransform({ flipV: !first.flipV })} />
      </div>
      <div className="grid grid-cols-2 gap-1">
        {(['left', 'center', 'right', 'top', 'middle', 'bottom'] as AlignMode[]).map((mode) => (
          <ToolButton key={mode} label={mode} disabled={selected.length < 2} onClick={() => props.onAlign(mode)} title={`Align ${mode}`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="Distribute ↔" disabled={selected.length < 3} onClick={() => props.onDistribute('horizontal')} />
        <ToolButton label="Distribute ↕" disabled={selected.length < 3} onClick={() => props.onDistribute('vertical')} />
      </div>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="Bring to front" onClick={() => props.onZOrder('front')} />
        <ToolButton label="Send to back" onClick={() => props.onZOrder('back')} />
        <ToolButton label="Forward" onClick={() => props.onZOrder('forward')} />
        <ToolButton label="Backward" onClick={() => props.onZOrder('backward')} />
      </div>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="Duplicate" onClick={props.onDuplicate} />
        <ToolButton label="Delete" kind="danger" onClick={props.onDelete} />
        {image && <ToolButton label="Replace image" onClick={props.onReplaceImage} title="Swap the pixels, keep the placement" />}
      </div>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="←" onClick={() => props.onMove(-1, 0)} title="Nudge left" />
        <ToolButton label="→" onClick={() => props.onMove(1, 0)} title="Nudge right" />
        <ToolButton label="↑" onClick={() => props.onMove(0, -1)} title="Nudge up" />
        <ToolButton label="↓" onClick={() => props.onMove(0, 1)} title="Nudge down" />
      </div>
      <Labeled label="Alt text" hint="Written as a tag so screen readers and PDF/UA tools can describe this object.">
        <input
          value={first.alt}
          onChange={(event) => props.onAlt(event.target.value)}
          placeholder="Describe this object"
          className="doodle-input !px-2 !py-1 !text-[11px]"
        />
      </Labeled>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[10px] text-ink-muted">
        <div>x {Math.round(first.box.x)} pt</div>
        <div>y {Math.round(first.box.y)} pt</div>
        <div>w {Math.round(first.box.width)} pt</div>
        <div>h {Math.round(first.box.height)} pt</div>
      </dl>
    </div>
  );
}

// ── find & replace ──────────────────────────────────────────────────────────

export interface FindPanelProps {
  open: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  ignoreAccents: boolean;
  status: string;
  onQuery: (value: string) => void;
  onReplacement: (value: string) => void;
  onToggle: (key: 'caseSensitive' | 'wholeWord' | 'ignoreAccents', value: boolean) => void;
  onNext: () => void;
  onPrev: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

export function FindReplacePanel(props: FindPanelProps) {
  if (!props.open) return null;
  return (
    <div className="space-y-2 rounded-doodle-md border border-cream-border bg-white p-3 shadow-doodle-card">
      <div className="flex items-center gap-2">
        <PanelHeading>Find &amp; replace — every page</PanelHeading>
        <button type="button" onClick={props.onClose} className="ml-auto text-[11px] text-ink-muted hover:text-ink" aria-label="Close find and replace">
          ✕
        </button>
      </div>
      <input
        value={props.query}
        onChange={(event) => props.onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') props.onNext();
        }}
        placeholder="Find…"
        className="doodle-input !px-2 !py-1 !text-[11px]"
        aria-label="Text to find"
      />
      <input
        value={props.replacement}
        onChange={(event) => props.onReplacement(event.target.value)}
        placeholder="Replace with…"
        className="doodle-input !px-2 !py-1 !text-[11px]"
        aria-label="Replacement text"
      />
      <div className="flex flex-wrap gap-2">
        {(
          [
            ['caseSensitive', 'Match case'],
            ['wholeWord', 'Whole word'],
            ['ignoreAccents', 'Ignore accents'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex cursor-pointer items-center gap-1 text-[10px] text-ink-soft">
            <input
              type="checkbox"
              checked={props[key]}
              onChange={(event) => props.onToggle(key, event.target.checked)}
              className="h-3 w-3 accent-[#2563EB]"
            />
            {label}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <ToolButton label="Prev" onClick={props.onPrev} />
        <ToolButton label="Next" onClick={props.onNext} />
        <ToolButton label="Replace" onClick={props.onReplace} />
        <ToolButton label="Replace all" kind="primary" onClick={props.onReplaceAll} />
      </div>
      <p className="font-mono text-[10px] text-ink-muted" role="status">
        {props.status}
      </p>
    </div>
  );
}

// ── object list ─────────────────────────────────────────────────────────────

const STATE_LABEL: Record<EditObject['state'], string> = {
  draft: 'edited',
  queued: 'queued',
  written: 'written',
  'needs-engine': 'needs PyMuPDF',
  failed: 'skipped',
};

export function ObjectList({
  objects,
  selectedIds,
  onSelect,
}: {
  objects: EditObject[];
  selectedIds: string[];
  onSelect: (id: string) => void;
}) {
  if (objects.length === 0) {
    return (
      <p className="text-[10px] leading-relaxed text-ink-muted">
        No edits yet. Click a paragraph in the page to rewrite it.
      </p>
    );
  }
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
      {objects.map((object) => (
        <li key={object.id}>
          <button
            type="button"
            onClick={() => onSelect(object.id)}
            className={`flex w-full items-center gap-2 rounded border px-2 py-1 text-left text-[10px] ${
              selectedIds.includes(object.id)
                ? 'border-accent bg-accent/10 text-ink'
                : 'border-cream-border bg-white text-ink-soft hover:border-ink-muted'
            }`}
          >
            <span className="font-mono uppercase tracking-[0.08em] text-ink-muted">
              {object.kind === 'text' ? 'T' : 'I'}{object.page}
            </span>
            <span className="truncate">{object.alt || objectLabel(object)}</span>
            <span
              className={`ml-auto shrink-0 rounded px-1 font-mono text-[9px] uppercase ${
                object.state === 'needs-engine' || object.state === 'failed'
                  ? 'bg-warn/15 text-warn'
                  : object.state === 'written'
                    ? 'bg-success/15 text-success'
                    : 'bg-cream-soft text-ink-muted'
              }`}
            >
              {STATE_LABEL[object.state]}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function objectLabel(object: EditObject): string {
  if (object.kind === 'text') {
    const text = object.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join(' ').trim();
    return text.length > 0 ? text.slice(0, 40) : '(empty block)';
  }
  return 'Placed image';
}

// ── toasts ──────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

const TOAST_STYLE: Record<Toast['kind'], string> = {
  info: 'border-cream-border bg-white text-ink',
  success: 'border-success/30 bg-success/10 text-success',
  warn: 'border-warn/30 bg-warn/10 text-warn',
  error: 'border-danger/30 bg-danger/10 text-danger',
};

export function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-50 flex w-[min(28rem,90%)] -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 rounded-doodle-md border px-3 py-2 text-[11px] leading-relaxed shadow-doodle-hover ${TOAST_STYLE[toast.kind]}`}
        >
          <span className="flex-1">{toast.text}</span>
          <button type="button" onClick={() => onDismiss(toast.id)} className="text-[10px] opacity-60 hover:opacity-100" aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ── rulers ──────────────────────────────────────────────────────────────────

export function Ruler({
  orientation,
  lengthPoints,
  scale,
}: {
  orientation: 'horizontal' | 'vertical';
  lengthPoints: number;
  scale: number;
}) {
  const px = lengthPoints * scale;
  const ticks = rulerTicks(lengthPoints, scale, 40);
  const long = orientation === 'horizontal';
  return (
    <div
      className={long ? 'relative h-4 bg-cream-soft' : 'relative w-4 bg-cream-soft'}
      style={long ? { width: px } : { height: px }}
      aria-hidden
    >
      {ticks.map((tick) => (
        <span
          key={tick.label}
          className="absolute font-mono text-[7px] leading-none text-ink-muted"
          style={
            long
              ? { left: tick.position, top: 0, height: 8, borderLeft: '1px solid #BFBFB6', paddingLeft: 2 }
              : { top: tick.position, left: 0, width: 8, borderTop: '1px solid #BFBFB6', paddingTop: 1 }
          }
        >
          {Number(tick.label) % 100 === 0 ? tick.label : ''}
        </span>
      ))}
    </div>
  );
}
