/**
 * Small presentation shells for the editor rails.
 *
 * Both editors had the same two problems: every option rendered at the same
 * weight, so the rail read as a wall of controls, and the keyboard bindings only
 * existed in the source. `InspectorSection` gives the rail a hierarchy a person
 * can scan (and the quick-mode chips a section to preselect); `ShortcutList`
 * prints the real table from `shortcuts.ts`, so the list cannot claim keys the
 * handler does not implement.
 */
import {
  EDITOR_SHORTCUTS,
  SHORTCUT_GROUP_LABELS,
  formatShortcutKeys,
  groupsIn,
  shortcutsIn,
  type Shortcut,
} from './shortcuts';

export interface InspectorSectionProps {
  id: string;
  title: string;
  /** Right-aligned status text: a count, "off", "3 marks". */
  meta?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /**
   * Controlled variant, used by the palette so a quick-mode chip can expand the
   * section it just armed.
   */
  open?: boolean;
  onToggle?: (next: boolean) => void;
}

/** A collapsible block of the inspector. Open by default: hidden options are
 *  the ones a user concludes do not exist. */
export function InspectorSection({
  id,
  title,
  meta,
  children,
  defaultOpen = true,
  open,
  onToggle,
}: InspectorSectionProps): JSX.Element {
  return (
    <details
      open={open ?? defaultOpen}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      data-inspector-section={id}
      className="group rounded-doodle-md border border-cream-border bg-white"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted marker:content-none">
        <span aria-hidden className="text-[9px] transition-transform group-open:rotate-90">
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta && <span className="shrink-0 font-display normal-case tracking-normal tabular-nums">{meta}</span>}
      </summary>
      <div className="space-y-2 border-t border-cream-border px-2.5 py-2">{children}</div>
    </details>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }): JSX.Element {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft"
        title={formatShortcutKeys(shortcut)}
      >
        {shortcut.keys.map((key) => (
          <kbd
            key={key}
            className="mr-0.5 rounded border border-cream-border bg-cream px-1 py-[1px] text-[9px] text-ink-soft"
          >
            {key}
          </kbd>
        ))}
      </span>
      <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-ink-muted">{shortcut.label}</span>
    </li>
  );
}

/**
 * Every bound key, grouped. `rows` defaults to the annotation editor's table so
 * the text editor can print its own without a second component; `compact` drops
 * the headings for narrow rails.
 */
export function ShortcutList({
  compact = false,
  rows = EDITOR_SHORTCUTS,
}: {
  compact?: boolean;
  rows?: readonly Shortcut[];
}): JSX.Element {
  return (
    <div className="space-y-2" data-shortcut-rows={rows.length}>
      {groupsIn(rows).map((group) => {
        const groupRows = shortcutsIn(rows, group);
        if (groupRows.length === 0) return null;
        return (
          <div key={group} className="space-y-1" data-shortcut-group={group}>
            {!compact && (
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-ink-muted/80">
                {SHORTCUT_GROUP_LABELS[group]}
              </p>
            )}
            <ul className="space-y-1">
              {groupRows.map((shortcut) => (
                <ShortcutRow key={`${shortcut.group}:${formatShortcutKeys(shortcut)}`} shortcut={shortcut} />
              ))}
            </ul>
          </div>
        );
      })}
      <p className="text-[9px] leading-relaxed text-ink-muted/80">
        Keys are ignored while a field has the caret, so typing never changes the pen.
      </p>
    </div>
  );
}

/** Count of documented keys — used by the section meta line. */
export const SHORTCUT_COUNT = EDITOR_SHORTCUTS.length;
