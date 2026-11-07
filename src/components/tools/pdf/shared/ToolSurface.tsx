/**
 * The tool page's shape, as one state machine.
 *
 * A tool page used to show a settings rail and a large empty pane at the same
 * time, so the first thing a visitor met was a form for a file they had not
 * chosen yet. This module reorders the page around the one question that
 * actually comes first:
 *
 * ```text
 * intake   no file         →  title, promise, one oversized drop button
 * ready    file(s) chosen  →  file cards, options in the bar, CTA bottom-right
 * running  a job in flight →  centred progress, the file name, cancel
 * result   work finished   →  success screen with the download
 * error    work stopped    →  the reason, the file it is about, Retry
 * ```
 *
 * Options and previews never appear before a file exists, and a finished run
 * never leaves the user back on the drop zone wondering whether it worked.
 */
import { motion } from 'framer-motion';
import { fadeUp, staggerParent, tapDown } from '@/lib/motion';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore, type ToolPhase } from '@/stores/process-store';
import { useUIStore } from '@/stores/ui-store';
import { MemoryWarning } from '@/components/ui/MemoryWarning';
import type { EngineId } from '@/lib/pdf/engines/provider';
import type { UsePdfTool } from '@/hooks/usePdfTool';
import { ErrorPanel } from './ErrorPanel';
import { FileCards } from './FileCards';
import { FileIntake, intakeCopy, intakeFootNote, useIntake, type IntakeControls, type IntakeCopy } from './FileIntake';
import { GroupHeading, OptionsPanel, useTouchedFields } from './FieldControls';
import { ProgressBar } from './ProgressBar';
import { ResultCard, type ResultItem } from './ResultCard';
import { runStatusText } from './toolForm';
import { FOCUS_RING } from './focusRing';

/** The one line explaining a disabled primary action, pointed at by the button. */
export const RUN_REASON_ID = 'tool-run-reason';

export type SurfaceState = 'intake' | 'ready' | 'running' | 'result' | 'error';

export interface SurfaceInput {
  /** At least one file is chosen. This alone decides `intake`. */
  hasFiles: boolean;
  phase: ToolPhase;
  isProcessing: boolean;
  /** Files the finished run produced. */
  outputs: number;
  /** A report counts as a result: the tool answered rather than emitted. */
  hasReport?: boolean;
}

/**
 * Which page the user is looking at, from state they can act on.
 *
 * `running` outranks everything because the cancel must stay reachable, and a
 * result outranks the file list because the download must not be missed. A run
 * that produced neither a file nor a report is not a result screen: it goes back
 * to the cards with its status line rather than a page claiming success with
 * nothing to show (E13).
 */
export function surfaceState(input: SurfaceInput): SurfaceState {
  if (input.isProcessing || input.phase === 'running') return 'running';
  if (!input.hasFiles) return 'intake';
  if (input.phase === 'error') return 'error';
  if (input.phase === 'done' && (input.outputs > 0 || input.hasReport)) return 'result';
  return 'ready';
}

export interface ToolSurfaceProps {
  api: UsePdfTool;
  /** Extra controls rendered above the generated options (editor state, etc.). */
  before?: React.ReactNode;
  /** The run's structured answer, for tools that report rather than emit. */
  report?: React.ReactNode;
  /** Called after a successful run with the produced outputs. */
  onDone?: () => void;
}

/** The whole page for one schema-driven tool. */
export function ToolSurface({ api, before, report, onDone }: ToolSurfaceProps) {
  const files = useFileStore((s) => s.files);
  const isProcessing = useProcessStore((s) => s.isProcessing);
  const outputs = useProcessStore((s) => s.outputBlobs);

  const multiple = Boolean(api.tool?.multiFile);
  const copy = intakeCopy(api.tool?.accept, multiple);
  // Which fields the user has actually moved. Owned here, not in the bar, because
  // the bar unmounts every time the page changes state and a deliberate choice
  // has to survive a trip back to the drop zone.
  const touched = useTouchedFields(api.tool?.id, api.values);
  const state = surfaceState({
    hasFiles: files.length > 0,
    phase: api.phase,
    isProcessing,
    outputs: outputs.length,
    hasReport: Boolean(report),
  });

  const intake = useIntake({
    accept: api.tool?.accept,
    multiple,
    onFiles: (list) => acceptFiles(list, multiple),
  });

  const startOver = () => {
    useProcessStore.getState().reset();
    useFileStore.getState().clearCurrent();
  };

  const body =
    state === 'intake' ? (
      <FileIntake
        title={api.tool?.name ?? 'Choose a file'}
        promise={api.promise || 'Pick a file and the options appear.'}
        copy={copy}
        controls={intake}
        footNote={intakeFootNote(api.tool?.accept, multiple, api.tool?.notes)}
      />
    ) : state === 'running' ? (
      <RunningPane files={files.map((file) => file.name)} onCancel={api.cancel} />
    ) : state === 'result' ? (
      <ResultPane
        toolName={api.tool?.name}
        pagesIn={api.pagesIn}
        engines={api.tool?.engines ?? []}
        onDoAnother={startOver}
        report={report}
      />
    ) : (
      <ReadyPane
        api={api}
        before={before}
        copy={copy}
        onDone={onDone}
        intake={intake}
        state={state}
        touched={touched}
      />
    );

  return (
    <motion.div
      variants={staggerParent}
      initial="hidden"
      animate="visible"
      data-surface={state}
      data-dragging={intake.dragging || undefined}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-cream"
    >
      {body}
      {intake.dragging && state !== 'intake' && (
        // The whole tab is the drop target, so mid-drag it has to say so — the
        // cards are not the only place a file can land.
        <div
          data-drop-overlay="true"
          className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-doodle-lg border-2 border-dashed border-accent/70 bg-accent/5"
        >
          <p className="rounded-doodle border border-accent/30 bg-cream-light px-3 py-1.5 text-[12px] font-semibold text-accent shadow-doodle-card">
            Drop {copy.many} to add {files.length === 1 ? 'another' : 'more'}
          </p>
        </div>
      )}
      <input {...intake.inputProps} />
    </motion.div>
  );
}

/**
 * Put the chosen files in the store.
 *
 * A multi-document tool adds to what is already there — that is how a second
 * drop becomes a longer merge. A single-document tool replaces, and says so when
 * it took one file out of three rather than dropping the rest in silence. Too
 * many files for `maxFiles` is left in place: the runner's own reason names the
 * limit rather than the page quietly throwing the extras away.
 */
function acceptFiles(list: File[], multiple: boolean): void {
  const store = useFileStore.getState();
  useProcessStore.getState().reset();
  if (multiple) {
    store.setFiles([...store.files, ...list]);
    return;
  }
  const [first] = list;
  if (!first) return;
  store.setFiles([first]);
  if (list.length > 1) {
    useProcessStore
      .getState()
      .setNotice(`This tool works on one file at a time, so it is using "${first.name}".`);
  }
}

// ── ready / error: cards, options, one big verb ─────────────────────────────

interface ReadyPaneProps {
  api: UsePdfTool;
  intake: IntakeControls;
  copy: IntakeCopy;
  state: SurfaceState;
  touched: ReadonlySet<string>;
  before?: React.ReactNode;
  onDone?: () => void;
}

function ReadyPane({ api, intake, copy, before, onDone, state, touched }: ReadyPaneProps) {
  const files = useFileStore((s) => s.files);
  const states = useProcessStore((s) => s.fileStates);
  const removeFile = useFileStore((s) => s.removeFile);
  const reorderFiles = useFileStore((s) => s.reorderFiles);
  const error = useProcessStore((s) => s.error);
  const hint = useProcessStore((s) => s.errorHint);
  const isLargeFile = useFileStore((s) => s.isLargeFile);
  const multiple = Boolean(api.tool?.multiFile);

  return (
    // The bar is the last thing in the scroller and sticks to its bottom edge.
    // Pinned to the page instead, it sat 314-401 px below a queue that never
    // scrolls (measured at 1440x1000), which split the page into a list at the
    // top and a verb at the bottom with a band of bare background between them.
    // In flow, the CTA lands under the files it acts on and the empty space
    // collects once, below it; sticky keeps it in reach when the page is tall
    // enough to scroll.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        <SurfaceHeading title={api.tool?.name ?? ''} promise={api.promise} />

        {isLargeFile && <MemoryWarning />}

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <GroupHeading title={files.length > 1 ? 'Your files' : 'Your file'} />
            {multiple && files.length > 1 && (
              <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted tabular-nums">
                {api.phase === 'inspecting' ? 'reading pages…' : `${files.length} in this job`}
              </span>
            )}
          </div>
          <FileCards
            files={files}
            states={states}
            reorderable={multiple && files.length > 1}
            imageInput={api.tool?.inputKind === 'image'}
            errorShown={state === 'error' && Boolean(error)}
            onRemove={(index) => removeFile(index)}
            onReorder={(from, to) => reorderFiles(from, to)}
            onAddMore={intake.open}
            addMoreLabel={multiple ? 'Add more' : 'Use another file'}
          />
        </section>

        {multiple && (
          // The space under the cards is the same drop target the page is, and
          // saying so is what makes a short queue look like a queue rather than
          // an empty room. It stays a strip, not a second drop zone: the cards
          // are the thing with the visual weight here.
          <button
            type="button"
            data-drop-more="true"
            onClick={intake.open}
            className={`flex min-h-[96px] w-full flex-col items-center justify-center gap-1 rounded-doodle-lg border border-dashed border-cream-border bg-cream-soft/40 text-center transition-colors hover:border-accent hover:bg-accent/5 ${FOCUS_RING}`}
          >
            <span aria-hidden className="text-[20px] text-ink-muted">
              ⬆
            </span>
            <span className="text-[13px] font-semibold text-ink-soft">
              Drop more {copy.many} here
            </span>
            <span className="text-[11px] text-ink-muted">
              or click to browse — they join this job in order
            </span>
          </button>
        )}

        {api.advisories.length > 0 && (
          <p className="rounded-doodle-md border border-warn/25 bg-warn/5 px-3 py-2 text-[11px] leading-relaxed text-warn">
            {api.advisories[0]}
          </p>
        )}

        {state === 'error' && error && (
          <ErrorPanel
            message={error}
            hint={hint ?? undefined}
            fileName={errorFile(files, error)}
            onRetry={() => void api.run()}
          />
        )}
      </div>

      <RunBar api={api} before={before} onDone={onDone} touched={touched} />
    </div>
  );
}

/** The file at fault: whichever name the message quotes, else the only input. */
function errorFile(files: File[], message: string): string | null {
  const named = files.find((candidate) => message.includes(candidate.name));
  if (named) return named.name;
  return files.length === 1 ? files[0].name : null;
}

/**
 * The run bar: the options the tool owns, and one verb at its right edge.
 *
 * The bar is a strip, not a second page. Its height is the collapsed options row
 * plus the button, so the file cards above it keep the visual weight.
 */
function RunBar({
  api,
  before,
  onDone,
  touched,
}: {
  api: UsePdfTool;
  before?: React.ReactNode;
  onDone?: () => void;
  touched: ReadonlySet<string>;
}) {
  const busy = api.isRunning;
  const reason = api.blockers[0] ?? null;
  const remaining = Math.max(0, api.blockers.length - 1);

  return (
    <div
      data-run-bar="true"
      className="sticky bottom-0 z-20 shrink-0 border-t border-cream-border bg-cream-light/95 px-4 py-2.5 backdrop-blur-subtle sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
        <OptionsPanel api={api} before={before} touched={touched} />

        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <StatusLine />

          <motion.button
            whileTap={api.canRun && !busy ? tapDown : undefined}
            id="tool-process-btn"
            type="button"
            // A stable hook for tests and browser automation: the run bar holds
            // more than one button once the options disclosure exists, so "the
            // primary action" cannot be found by position or by label text.
            data-run="true"
            disabled={!api.canRun || busy}
            aria-disabled={!api.canRun || busy}
            aria-describedby={!api.canRun && !busy ? RUN_REASON_ID : undefined}
            onClick={async () => {
              const outcome = await api.run();
              if (outcome) onDone?.();
            }}
            className={`doodle-btn ml-auto flex min-h-[56px] w-auto min-w-[200px] items-center justify-center gap-2 rounded-doodle-lg px-6 text-[15px] font-semibold ${FOCUS_RING}`}
          >
            {busy ? 'Working…' : api.verb}
          </motion.button>
        </div>

        {/* One reason, in the imperative, under the button it explains. */}
        {!api.canRun && !busy && reason && (
          <p
            id={RUN_REASON_ID}
            className="ml-auto max-w-[560px] rounded-doodle border border-cream-border bg-cream-soft px-2.5 py-1.5 text-right text-[10px] leading-relaxed text-ink-soft"
          >
            <span className="font-semibold text-ink">Still needed: </span>
            {reason}
            {remaining > 0 && (
              <span className="text-ink-muted"> · {remaining} more after that.</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/** The bar's spoken state, plus the only way back to the log pane. */
function StatusLine() {
  const showLogs = useUIStore((s) => s.showLogMonitor);
  const logs = useProcessStore((s) => s.logs.length);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <RunStatusText />
      {(showLogs || logs > 0) && (
        <button
          type="button"
          onClick={() => useUIStore.getState().toggleLogMonitor()}
          className={`rounded font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted transition-colors hover:text-ink ${FOCUS_RING}`}
        >
          {showLogs ? 'Hide log' : 'Log'}
        </button>
      )}
    </div>
  );
}

/**
 * The page's identity block.
 *
 * The intake shows it at reading size and everything after shows it small: the
 * title has to be there for a first visit, and must not shout over the file
 * cards once there is work on the page.
 */
function SurfaceHeading({ title, promise }: { title: string; promise: string }) {
  return (
    <header className="space-y-1 text-center">
      {title && (
        <h2 className="font-display text-[16px] font-semibold tracking-[-0.01em] text-ink sm:text-[18px]">
          {title}
        </h2>
      )}
      {promise && <p className="text-[11px] leading-relaxed text-ink-muted">{promise}</p>}
    </header>
  );
}

/**
 * The one live region of the surface: stage, share done, and the acknowledgement
 * of a cancel. Exactly one node exists per state, so assistive tech hears the
 * run rather than the layout.
 */
function RunStatusText() {
  const phase = useProcessStore((s) => s.phase);
  const label = useProcessStore((s) => s.label);
  const progress = useProcessStore((s) => s.progress);
  const statusMessage = useProcessStore((s) => s.statusMessage);
  const notice = useProcessStore((s) => s.notice);
  const outputs = useProcessStore((s) => s.outputBlobs.length);
  const text = runStatusText({
    phase,
    label,
    percent: progress,
    message: statusMessage,
    notice,
    outputs,
  });
  return (
    <p
      role="status"
      aria-live="polite"
      data-run-status={phase}
      className={`font-mono text-[10px] leading-relaxed tracking-[0.04em] ${
        phase === 'running' ? 'text-accent' : 'text-ink-muted'
      } ${text === '' ? 'sr-only' : ''}`}
    >
      {text}
    </p>
  );
}

// ── running ────────────────────────────────────────────────────────────────

export interface RunningPaneProps {
  /** Names of the inputs the job holds, so the screen can say what is busy. */
  files: string[];
  onCancel: () => void;
  /** Heading verb; defaults to "Working". */
  label?: string;
}

/** Centred progress that names the file it is holding and stops when asked. */
export function RunningPane({ files, onCancel, label }: RunningPaneProps) {
  const progress = useProcessStore((s) => s.progress);
  const statusMessage = useProcessStore((s) => s.statusMessage);
  const subject = files.length > 1 ? `${files.length} files` : (files[0] ?? 'your file');
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-10" data-running="true">
      <motion.div variants={fadeUp} initial="hidden" animate="visible" className="w-full max-w-md text-center">
        <span
          aria-hidden
          className="mx-auto flex h-14 w-14 animate-pulse items-center justify-center rounded-full border border-accent/30 bg-accent/5 text-[20px] text-accent"
        >
          ◌
        </span>
        <h2 className="mt-4 font-display text-[20px] font-semibold text-ink">
          {label ?? 'Working'} on <span className="break-all">{subject}</span>
        </h2>
        <div className="mt-4">
          <ProgressBar percent={progress} label="Working" indeterminate={progress <= 0} />
        </div>
        {statusMessage && (
          <p className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
            {statusMessage}
          </p>
        )}
        <div className="mt-4">
          <RunStatusText />
        </div>
        <button
          type="button"
          onClick={onCancel}
          title="Stop this run and discard whatever it produces"
          className={`doodle-btn doodle-btn-secondary mt-4 w-auto px-5 py-2 text-[12px] ${FOCUS_RING}`}
        >
          Cancel
        </button>
      </motion.div>
    </div>
  );
}

// ── result ─────────────────────────────────────────────────────────────────

export interface ResultPaneProps {
  /** Name of the tool that finished, for the line under the heading. */
  toolName?: string;
  /** Pages the run started with, so the card can report in → out (E6/E7). */
  pagesIn?: number | null;
  /** Engines the tool declared, so the card can name the one it used. */
  engines?: readonly EngineId[];
  /** Clears the inputs and the result: the page goes back to its drop zone. */
  onDoAnother: () => void;
  /** Anything the run answered besides a file (metadata, comparisons). */
  report?: React.ReactNode;
  /** Where "Back to all tools" goes; the PDF catalogue by default. */
  backHref?: string;
}

/**
 * The success screen.
 *
 * The complaint this replaces was "never leave the user on the drop zone
 * wondering if it worked", so nothing here is subtle: a checkmark, the output
 * name, the numbers that prove it happened, one dominant download, and two quiet
 * actions that say what can happen next.
 *
 * It reads the process store directly, so a bespoke editor's own save gets the
 * same screen as a schema-driven run without instantiating the tool hook — the
 * produced page count included, which the runner reports and the store holds.
 */
export function ResultPane({
  toolName,
  pagesIn,
  engines = [],
  onDoAnother,
  report,
  backHref = '#/pdf',
}: ResultPaneProps) {
  const blobs = useProcessStore((s) => s.outputBlobs);
  const names = useProcessStore((s) => s.outputNames);
  const pagesOut = useProcessStore((s) => s.pagesOut);
  const sizeBefore = useProcessStore((s) => s.sizeBefore);
  const warnings = useProcessStore((s) => s.warnings);
  const statusMessage = useProcessStore((s) => s.statusMessage);
  const file = useFileStore((s) => s.file);

  const outputs: ResultItem[] = blobs.map((blob, index) => ({
    name: names[index] ?? `output-${index + 1}`,
    blob,
  }));
  const degraded = warnings.some((warning) => /degrad/i.test(warning));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-6" data-result="true">
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="mx-auto w-full max-w-[640px] text-center"
      >
        <span
          aria-hidden
          data-checkmark="true"
          className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-success/40 bg-success/10 text-[22px] text-success"
        >
          ✓
        </span>
        <h1 className="mt-4 font-display text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[28px]">
          {outputs.length > 1 ? `${outputs.length} files are ready` : 'Your file is ready'}
        </h1>
        <p className="mt-1 text-[12px] text-ink-muted">
          {toolName ?? 'This run'} finished in this tab — nothing was uploaded.
        </p>
        <div className="mt-2 flex justify-center">
          <RunStatusText />
        </div>

        <ResultCard
          className="mt-5 text-left"
          hero
          outputs={outputs}
          sizeBefore={sizeBefore}
          pagesIn={pagesIn}
          pages={pagesOut}
          warnings={warnings}
          message={statusMessage || undefined}
          engine={engines[0] ?? null}
          degraded={degraded}
          original={file ? { name: file.name, blob: file } : null}
        />

        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={onDoAnother}
            className={`doodle-btn doodle-btn-secondary w-auto px-4 py-2 text-[12px] ${FOCUS_RING}`}
          >
            Do another
          </button>
          <a
            href={backHref}
            className={`inline-flex items-center rounded-doodle border border-cream-border bg-cream-light px-4 py-2 text-[12px] font-semibold text-ink-soft transition-colors hover:border-accent hover:text-accent ${FOCUS_RING}`}
          >
            Back to all tools
          </a>
        </div>

        {report && <div className="mt-6 text-left">{report}</div>}
      </motion.div>
    </div>
  );
}
