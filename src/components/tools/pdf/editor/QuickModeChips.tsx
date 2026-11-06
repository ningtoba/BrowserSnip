/**
 * Quick-mode chips for the empty editor surfaces.
 *
 * `edit-pdf`, `edit-pdf-text` and `sign` are three tools that answer one
 * question — "I want to change this page" — and until now the user had to know
 * which one they were standing in. The chips state the three intents and move
 * the user to the right one, carrying the open document so a chip never means
 * "pick the file again".
 */
import { QUICK_MODES, requestQuickMode, type QuickMode, type QuickModeId } from './quickModes';

export interface QuickModeChipsProps {
  /** Route id of the surface rendering the chips, so a chip can stay put. */
  currentToolId: string | null;
  /** Document to carry to the target tool. Metadata only, never contents. */
  file: File | null;
  /** A chip that lands on this same surface arms it locally instead of routing. */
  onLocal: (mode: QuickMode) => void;
  /** Lets a parent track the choice (focus, notices). */
  onPick?: (mode: QuickMode) => void;
}

export function QuickModeChips({ currentToolId, file, onLocal, onPick }: QuickModeChipsProps): JSX.Element {
  const choose = (mode: QuickMode): void => {
    const plan = requestQuickMode(mode, { currentToolId, file });
    if (!plan.navigate) onLocal(mode);
    onPick?.(mode);
  };
  return (
    <div className="space-y-1.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        Or start with a job
      </p>
      <div role="group" aria-label="Editor quick modes" className="flex flex-wrap justify-center gap-1.5">
        {QUICK_MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            data-quick-mode={mode.id}
            title={mode.blurb}
            onClick={() => choose(mode)}
            className="doodle-chip doodle-chip-inactive flex max-w-full items-center gap-1.5 px-2.5 py-1.5 text-[11px]"
          >
            <span aria-hidden className="text-[13px] leading-none">
              {mode.icon}
            </span>
            <span className="font-medium">{mode.label}</span>
            <span className="hidden truncate text-[10px] text-ink-muted sm:inline">— {mode.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export type { QuickModeId };

/** The three reassurance lines every editor drop card shows. */
export function DropReassurance({ lines }: { lines: readonly string[] }): JSX.Element {
  return (
    <ul className="mx-auto max-w-sm space-y-1 text-left">
      {lines.map((line) => (
        <li key={line} className="flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-muted">
          <span aria-hidden className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-success" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
