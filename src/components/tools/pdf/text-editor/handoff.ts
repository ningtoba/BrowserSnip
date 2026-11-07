/**
 * Moving the open document to the tool that can finish the job.
 *
 * A scanned page (E10) is not this editor's fight: OCR is. Routing there was
 * already possible, but `useFileStore` keeps one file slot per tool, so the jump
 * landed on an empty drop zone while the toast claimed the document was coming
 * along — the exact "plausible-looking lie" the brief bans. Seeding the target's
 * slot before the route changes is what makes the sentence true, and it is the
 * same mechanism the editor chooser's quick-mode chips use for the three editors.
 *
 * Nothing uploads: the `File` object is the one already held in this tab.
 */
import { useFileStore } from '@/stores/file-store';

/** The store's own "warn about a huge file" threshold (see `setFile`). */
const LARGE_FILE_BYTES = 500 * 1024 * 1024;

export interface Handoff {
  /** Whether the target tool opens with the document already loaded. */
  carried: boolean;
  /** One honest sentence about what just happened, for the status line. */
  line: string;
}

/**
 * Put `file` in `<toolId>`'s file slot so it survives the route change.
 *
 * `ToolWorkspace` calls `setActiveTool` on mount, which swaps the visible `file`
 * for whatever that tool's slot holds; writing the slot first is therefore the
 * only way a jump from one tool to another keeps the document.
 */
export function seedToolFile(toolId: string, file: File): void {
  useFileStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [toolId]: {
        file,
        files: [file],
        metadata: null,
        isLargeFile: file.size > LARGE_FILE_BYTES,
        params: {},
        codecWarning: null,
      },
    },
  }));
}

/**
 * Plan the trip to another tool: what to say, and whether to seed the slot.
 *
 * The copy names what happens next, because an OCR run produces a *new* file —
 * the editor cannot pretend the current page quietly became editable.
 */
export function planHandoff(toolId: string, label: string, file: File | null): Handoff {
  if (!file) {
    return {
      carried: false,
      line: `Opening ${label} — no document is loaded here, so pick the file again on that page.`,
    };
  }
  seedToolFile(toolId, file);
  return {
    carried: true,
    line: `${label} is open with ${file.name}. It exports a new PDF; reopen that here to edit the words.`,
  };
}
