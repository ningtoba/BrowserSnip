/**
 * TextEditor — BrowserSnip's in-place PDF text editor (BentoPDF's `/edit-pdf-text`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ENGINE MODEL, HONESTLY
 * ─────────────────────────────────────────────────────────────────────────────
 * Rewriting the glyph runs that are already in a page — keeping their font, their
 * kerning and their position, changing only the characters — needs a full content
 * streaming engine (PDFium, PyMuPDF). This editor is 100 % client-side on the MIT
 * core, so it does the thing that non-PDFium editors genuinely can do, and it does
 * not pretend otherwise:
 *
 *   1. **Identify.** `session.textItems(page)` gives the page's text runs in
 *      viewer space. `model.clusterParagraphs` groups them into paragraphs by
 *      baseline, then splits rows on column-width gaps — the same row-clustering
 *      idea `core/render.joinReadingOrder` and `core/tables.clusterRows` use.
 *   2. **Edit in place.** The clicked paragraph becomes a positioned, editable
 *      box over the rendered page with live re-wrap. Its initial size, alignment
 *      and colour come from the extraction plus a pixel sample of the page image
 *      (`model.samplePalette`), so an untouched commit looks like the original.
 *   3. **Delete, then redraw.** On commit the block is remembered as *deletion
 *      boxes plus new content*. At export `core/content.removeTextInRects` really
 *      removes the text-showing operators inside those boxes — the old words stop
 *      existing, stop being selectable and stop being found by Ctrl-F — and
 *      `model.layoutBlock` + `draw.ts` write the edited block back at the same
 *      origin with real, selectable PDF text (`BT/Tf/Tm/Tz/Tc/Tw/Tr/Ts/Tj`).
 *      Nothing is painted over the original to hide it: that is what makes this a
 *      rewrite and not an overlay.
 *   4. **Say when it is not enough.** `removeTextInRects` reports
 *      `needsRasterFallback` (Type3 glyphs, unembeddable widths, image-backed
 *      regions), and a block whose words live in a Form XObject cannot be removed
 *      at all. Those blocks are marked **needs the optional PyMuPDF engine** and
 *      the user is told, instead of silently getting doubled text. When PyMuPDF is
 *      reachable (`engine.ts`) it redacts and re-inserts exactly those blocks.
 *
 * What is a screen approximation: the on-canvas page still shows the original
 * bytes until you export or press “Reload preview”, which re-renders the edited
 * file. The overlay that covers an edited block is HTML/CSS — same text, same
 * size, browser font metrics — so line breaks can shift slightly from the PDF
 * output, which always re-breaks with the embedded font's own widths.
 *
 * Signed documents are exported as an appended revision (`snapshot()` +
 * `saveIncremental()`), which leaves the signed byte range intact. PDF/A
 * conformance can still break, and the editor says so before you commit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { joinReadingOrder, openRender } from '@/lib/pdf/core/render';
import type { ExtractedTextItem, PdfSession } from '@/lib/pdf/core/render';
import { looksEncrypted, openPDF, saveIncremental, savePDF, snapshot, PasswordRequiredError } from '@/lib/pdf/core/doc';
import { readSignatures } from '@/lib/pdf/core/signature';
import { readXmp } from '@/lib/pdf/core/metadata';
import { decodeImage } from '@/lib/pdf/core/images';
import type { TopLeftBox } from '@/lib/pdf/core/tables';
import { applyEdits, exportReport, prepareTextObject, type ExportReport } from './draw';
import {
  engineRepairAvailable,
  loadRepairEngine,
  repairEngineLine,
  repairEngineLoaded,
  repairEngineNote,
  repairEngineSize,
  repairWithPyMuPDF,
  type EngineLine,
} from './engine';
import { planHandoff } from './handoff';
import {
  BUILT_IN_FAMILIES,
  familyPreview,
  loadLocalFamilies,
  supportsLocalFonts,
  type FontFamilyOption,
} from './faces';
import {
  FindReplacePanel,
  FormatPanel,
  ModePanel,
  ObjectList,
  ObjectPanel,
  PanelHeading,
  Ruler,
  SizeBadge,
  ToastStack,
  TopToolbar,
  ToolButton,
  WarningList,
  type Toast,
} from './panels';
import {
  DEFAULT_STYLE,
  MIN_BLOCK_SIZE,
  RESIZE_HANDLES,
  amendHistory,
  canRedo,
  canUndo,
  clusterParagraphs,
  createHistory,
  deletionBoxes,
  detectPageObjects,
  editObjects,
  fitScale,
  historyReport,
  liveRanges,
  nextObjectId,
  objectAtPoint,
  objectsForPage,
  objectsSummary,
  paragraphsFromText,
  pruneSelection,
  pushHistory,
  redoHistory,
  replaceInText,
  retextBlock,
  resizeBox,
  samplePalette,
  searchableBlocks,
  searchBlocks,
  styleFromExtraction,
  textOfParagraphs,
  undoHistory,
  type EditObject,
  type EditScope,
  type EditorAction,
  type CommitState,
  type EditorStyle,
  type ExtractedParagraph,
  type FindOptions,
  type FitMode,
  type HistoryState,
  type ImageObject,
  type ListKind,
  type OperatorCodes,
  type PatchObject,
  type Point,
  type ResizeHandle,
  type SearchHit,
  type SearchableBlock,
  type TextObject,
  type ToolMode,
} from './model';
import { focusEditor, mountParagraphs, readParagraphs } from './editorDom';
import { FOCUS_RING } from '@/components/tools/pdf/shared/focusRing';
import { InspectorSection, ShortcutList } from '@/components/tools/pdf/editor/inspector';
import { DropReassurance, QuickModeChips } from '@/components/tools/pdf/editor/QuickModeChips';
import {
  DROP_REASSURANCE,
  adoptedFile,
  navigateToTool,
  takeEditorIntent,
  toolIdFromLocation,
} from '@/components/tools/pdf/editor/quickModes';
import { historyCommandForKey, isTypingTarget } from '@/components/tools/pdf/editor/shortcuts';
import {
  ESCAPE_STEP_REPORT,
  TEXT_EDITOR_SHORTCUTS,
  nextEscapeStep,
  stepsAside,
  textModeForKey,
  typingStartsEdit,
} from './keys';
import { adviceActionLabel, pageAdvice, type AdviceAction } from './pageAdvice';

/** Extra padding around a block when it is converted into an editable box. */
const BLOCK_PADDING = 2;
/**
 * Selection handle sizes, in CSS px: a 12 px dot inside a 20 px transparent hit
 * area. The checklist's floor is 8 px for the visible handle, and the hit slop is
 * what makes a 12 px target usable at 50 % zoom.
 */
const HANDLE_HIT = 20;
const HANDLE_DOT = 12;
/** How much of the page a freshly placed image may cover. */
const IMAGE_PLACE_FRACTION = 0.35;

/** Every text block in the document, plus the paragraph each one came from. */
interface SearchIndex {
  blocks: SearchableBlock[];
  paragraphs: Map<string, ExtractedParagraph>;
}

export function TextEditor() {
  const file = useFileStore((s) => s.file);
  const setFile = useFileStore((s) => s.setFile);
  const activeToolId = useFileStore((s) => s.activeTool);
  const process = useProcessStore();
  // ── document state ────────────────────────────────────────────────────────
  const [source, setSource] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [session, setSession] = useState<PdfSession | null>(null);
  const [editedSession, setEditedSession] = useState<PdfSession | null>(null);
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState(false);
  const [pdfa, setPdfa] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const [zoom, setZoom] = useState(1);
  const [showRulers, setShowRulers] = useState(false);
  const [barsHidden, setBarsHidden] = useState(false);

  const [mode, setMode] = useState<ToolMode>('edit');
  const [scope, setScope] = useState<EditScope>('text');

  const [history, setHistory] = useState<HistoryState<EditObject[]>>(() => createHistory<EditObject[]>([]));
  const [selection, setSelection] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Pinned placement tools stay armed after each drop (the brief's pin ruling). */
  const [pinned, setPinned] = useState(false);
  /** What assistive tech hears: undo depth, Esc steps, commits. */
  const [liveText, setLiveText] = useState('');
  /** The last export's honest result, kept on screen until the next one. */
  const [exportResult, setExportResult] = useState<{ headline: string; lines: string[] } | null>(null);
  const [searching, setSearching] = useState(false);
  /** Box whose dimensions are being read out while it is drawn or dragged. */
  const [liveSize, setLiveSize] = useState<TopLeftBox | null>(null);

  const [blocks, setBlocks] = useState<ExtractedParagraph[]>([]);
  const [pageObjects, setPageObjects] = useState<{ kind: 'image' | 'shape'; box: TopLeftBox; id: string }[]>([]);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [localFamilies, setLocalFamilies] = useState<FontFamilyOption[]>([]);
  const [localScanned, setLocalScanned] = useState(false);
  const [busy, setBusy] = useState(false);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplacement, setFindReplacement] = useState('');
  const [findOptions, setFindOptions] = useState<FindOptions>({ caseSensitive: false, wholeWord: false, ignoreAccents: true });
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [findStatus, setFindStatus] = useState('Type something to search every page.');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const searchIndexRef = useRef<SearchIndex | null>(null);
  const pendingImageRef = useRef<{ bytes: Uint8Array; mime: string; width: number; height: number } | null>(null);
  const [pendingImage, setPendingImage] = useState(false);
  /** Bumped when the optional engine finishes loading, so advice recomputes. */
  const [engineTick, setEngineTick] = useState(0);
  const dragRef = useRef<{ start: Point; origin: Map<string, TopLeftBox>; moved: boolean } | null>(null);
  const resizeRef = useRef<{ id: string; handle: ResizeHandle; start: Point; origin: TopLeftBox } | null>(null);
  const drawRef = useRef<{ from: Point; to: Point } | null>(null);
  const [draftRect, setDraftRect] = useState<TopLeftBox | null>(null);
  const toastSeq = useRef(0);
  /** The open block's id, readable synchronously from key/blur/export handlers. */
  const editingRef = useRef<string | null>(null);
  /** A character typed over a selected block, waiting to land inside it. */
  const pendingKeyRef = useRef<string | null>(null);
  /** True while a coalesced burst (drag, nudge run) is open. */
  const burstRef = useRef(false);
  const sealTimer = useRef<number | null>(null);

  const objects = history.present;
  const activeSession = editedSession ?? session;
  const numPages = activeSession?.numPages ?? 0;
  const dirty = objects.filter((object) => object.state !== 'written').length;

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 8000);
    // One sentence, said twice: visibly, and to assistive tech.
    setLiveText(text);
  }, []);

  /** Say something to assistive tech only — for keys that need no banner. */
  const announce = useCallback((text: string) => setLiveText(text), []);

  /**
   * One undo step per interaction, not per event.
   *
   * `coalesce: true` opens a burst: the first call records the before-state, the
   * rest rewrite the tip, and `sealHistory` closes it. The previous version pushed
   * the tip onto the stack when sealing, so a single drag needed two undos and the
   * first one visibly did nothing.
   */
  const applyAll = useCallback((actions: EditorAction[], coalesce = false) => {
    // Decided outside the updater: `main.tsx` runs in StrictMode, which calls the
    // updater twice, and a burst flag flipped inside it would lose its own step.
    const startsBurst = !coalesce || !burstRef.current;
    // A discrete edit ends any open burst, so the next drag starts its own step.
    burstRef.current = coalesce;
    setHistory((state) => {
      let next = state.present;
      for (const action of actions) next = editObjects(next, action);
      if (next === state.present) return state;
      return startsBurst ? pushHistory(state, next) : amendHistory(state, next);
    });
  }, []);

  const apply = useCallback((action: EditorAction, coalesce = false) => {
    applyAll([action], coalesce);
  }, [applyAll]);

  /** Finish a coalesced interaction: one undo step for the whole drag. */
  const sealHistory = useCallback(() => {
    burstRef.current = false;
  }, []);

  /** Arrow-key / button nudges: a run of them is one undo step, self-sealing. */
  const nudge = useCallback(
    (actions: EditorAction[]) => {
      applyAll(actions, true);
      if (sealTimer.current) window.clearTimeout(sealTimer.current);
      sealTimer.current = window.setTimeout(sealHistory, 700);
    },
    [applyAll, sealHistory],
  );

  // ── open a document ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!file) {
      setSource(null);
      return;
    }
    // A new document must not inherit the previous one's work (E19): blocks, hits
    // and the page number are cleared before the first `await`, not after the open
    // succeeds, or the old edits float over the new page while it loads — and stay
    // there for good if the open fails.
    setHistory(createHistory<EditObject[]>([]));
    setSelection([]);
    setEditingId(null);
    setBlocks([]);
    setItems([]);
    setPageObjects([]);
    setHits([]);
    setEditedSession(null);
    setPage(1);
    setExportResult(null);
    setLiveSize(null);
    searchIndexRef.current = null;
    editingRef.current = null;
    pendingKeyRef.current = null;
    burstRef.current = false;
    let disposed = false;
    let madeSession: PdfSession | null = null;
    (async () => {
      setOpening(true);
      setError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const opened = await openRender(bytes, { password: password || undefined });
        if (disposed) {
          await opened.destroy();
          return;
        }
        madeSession = opened;
        setSession(opened);
        setEditedSession(null);
        setSource({ bytes, name: file.name });
        setPage(1);
        setHistory(createHistory<EditObject[]>([]));
        setSelection([]);
        setEditingId(null);
        searchIndexRef.current = null;
        setHits([]);
        const size = await viewerSize(opened, 1);
        if (disposed) return;
        setPageSize(size);
        setNeedsPassword(false);
        // Signature and PDF/A metadata decide the export path before the user
        // commits to anything, so look at the bytes once, here.
        try {
          const signatures = await readSignatures(bytes);
          if (!disposed) setSigned(signatures.length > 0);
        } catch {
          if (!disposed) setSigned(false);
        }
        try {
          const doc = await openPDF(bytes, { password: password || undefined, ignoreEncryption: true });
          const xmp = readXmp(doc);
          if (!disposed) setPdfa(xmp?.pdfaPart ? `PDF/A-${xmp.pdfaPart}${xmp.pdfaConformance ?? ''}` : null);
        } catch {
          if (!disposed) setPdfa(null);
        }
      } catch (err) {
        if (disposed) return;
        if (err instanceof PasswordRequiredError || (looksEncrypted(new Uint8Array(0)) === false && /password/i.test(String(err)))) {
          setNeedsPassword(true);
          setError('This PDF is password protected. Enter its password to open it here.');
        } else {
          setError(err instanceof Error ? err.message : 'This PDF could not be opened.');
        }
      } finally {
        if (!disposed) setOpening(false);
      }
    })();
    return () => {
      disposed = true;
      void madeSession?.destroy();
      void session?.destroy();
    };
    // `session` is intentionally absent: destroying it here would close the
    // document the effect just opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, password]);

  useEffect(() => () => void editedSession?.destroy(), [editedSession]);

  async function viewerSize(handle: PdfSession, n: number): Promise<{ width: number; height: number }> {
    const proxy = await handle.page(n);
    const viewport = proxy.getViewport({ scale: 1 });
    return { width: viewport.width, height: viewport.height };
  }

  // ── page text + page objects ──────────────────────────────────────────────
  const [items, setItems] = useState<ExtractedTextItem[]>([]);
  useEffect(() => {
    if (!activeSession) {
      setItems([]);
      setBlocks([]);
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const pageItems = await activeSession.textItems(page);
        const detected = await detectObjects(activeSession, page);
        if (disposed) return;
        setItems(pageItems);
        setBlocks(clusterParagraphs(pageItems));
        setPageObjects(detected);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : 'This page could not be read.');
      }
    })();
    return () => {
      disposed = true;
    };
  }, [activeSession, page]);

  // ── render the page ───────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!activeSession || !canvas) return;
    let cancelled = false;
    void (async () => {
      try {
        await activeSession.renderToCanvas(page, canvas, zoom);
        if (cancelled) return;
        const size = await viewerSize(activeSession, page);
        setPageSize(size);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'This page could not be drawn.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeSession, page, zoom, objects]);

  useEffect(() => {
    if (!file) return;
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const selectedText = objects
        .filter((object) => selection.includes(object.id) && object.kind === 'text')
        .map((object) => object.id);
      // Ctrl/Cmd+S used to run *above* the typing guard, so saving while editing
      // wrote the previous text into the file and said "Saved". Both history and
      // save now commit the open block first, which is what pdf.js does too.
      if (meta && key === 's') {
        event.preventDefault();
        void exportPdf(commitEdit());
        return;
      }
      if (meta && key === 'f') {
        event.preventDefault();
        commitEdit();
        setFindOpen(true);
        return;
      }
      // One guard for every binding below: while a field or the in-place
      // paragraph owns the caret, keys belong to the text, not to the editor.
      const inText = isTypingTarget(event.target);
      const command = historyCommandForKey(event.key, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
      if (command && !inText) {
        event.preventDefault();
        stepHistory(command);
        return;
      }
      // `Esc` is the one key that still reaches the editor while typing: it
      // unwinds exactly one level (edit → Find → selection → pin → tool).
      if (key === 'escape') {
        event.preventDefault();
        unwind();
        return;
      }
      if (inText) return;
      if (meta && key === 'd' && selection.length > 0) {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      // Typing over a selected block edits it. Without this, pressing `t` while a
      // block is selected changes the tool instead of typing the letter.
      if (
        typingStartsEdit(event.key, {
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
        }, { textSelected: selectedText.length === 1 })
      ) {
        event.preventDefault();
        startEditing(selectedText[0], event.key);
        return;
      }
      if (key === 'enter' && selectedText.length > 0) {
        event.preventDefault();
        startEditing(selectedText[0]);
        return;
      }
      if (!meta && !event.altKey) {
        const armed = textModeForKey(event.key);
        if (armed) {
          event.preventDefault();
          armMode(armed);
          return;
        }
      }
      if ((key === 'delete' || key === 'backspace') && !meta && selection.length > 0) {
        event.preventDefault();
        const count = selection.length;
        apply({ type: 'remove', ids: selection });
        setSelection([]);
        announce(`Removed ${count} object${count === 1 ? '' : 's'}. Ctrl+Z brings them back.`);
        return;
      }
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && selection.length > 0) {
        event.preventDefault();
        const stepPx = event.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -stepPx : key === 'arrowright' ? stepPx : 0;
        const dy = key === 'arrowup' ? -stepPx : key === 'arrowdown' ? stepPx : 0;
        nudge([{ type: 'move', ids: selection, dx, dy }]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ── editing one paragraph ─────────────────────────────────────────────────
  const selected = objects.filter((object) => selection.includes(object.id));
  const editing = objects.find((object) => object.id === editingId);
  const styleTarget = selected.find((object) => object.kind === 'text') as TextObject | undefined;
  const currentStyle: EditorStyle = styleTarget?.style ?? DEFAULT_STYLE;

  /** Undo can delete the object a selection pointed at; never keep a dangling id. */
  useEffect(() => {
    if (selection.length === 0) return;
    const alive = pruneSelection(objects, selection);
    if (alive.length !== selection.length) setSelection(alive);
  }, [objects, selection]);

  /**
   * Open a block for typing, optionally with the key that opened it.
   *
   * A click that only *rendered* a contenteditable left the user staring at a
   * caret-less box: the first keystroke still went to the page and fired a
   * shortcut. `typed` is how "select a block, start typing" keeps its word.
   */
  const startEditing = useCallback((id: string | null, typed?: string) => {
    editingRef.current = id;
    pendingKeyRef.current = id ? (typed ?? null) : null;
    setEditingId(id);
  }, []);

  const openBlock = useCallback(
    (paragraph: ExtractedParagraph) => {
      if (paragraph.invisible) {
        toast(
          'warn',
          'This page’s words are an invisible OCR layer: they can be searched and copied, but rewriting them needs the optional PyMuPDF engine.',
        );
        return;
      }
      const existing = objects.find((object) => object.kind === 'text' && object.sourceId === paragraph.id);
      if (existing) {
        setSelection([existing.id]);
        startEditing(existing.id);
        return;
      }
      const palette = readPalette(canvasRef.current, paragraph.box, zoom);
      const style = styleFromExtraction(paragraph, { color: palette.color, pageWidth: pageSize.width });
      const object: TextObject = {
        id: nextObjectId('text'),
        page: paragraph.page,
        kind: 'text',
        box: {
          x: paragraph.box.x - BLOCK_PADDING,
          y: paragraph.box.y - BLOCK_PADDING,
          width: paragraph.box.width + BLOCK_PADDING * 2,
          height: paragraph.box.height + BLOCK_PADDING * 2,
        },
        rotation: 0,
        flipH: false,
        flipV: false,
        z: objects.length,
        alt: '',
        state: 'draft',
        paragraphs: paragraphsFromText(paragraph.text),
        style,
        deletion: deletionBoxes(paragraph),
        paperColor: palette.background,
        sourceId: paragraph.id,
        fromInvisibleLayer: false,
      };
      apply({ type: 'add', object });
      setSelection([object.id]);
      startEditing(object.id);
    },
    [apply, objects, startEditing, toast, zoom, pageSize.width],
  );

  /**
   * Finish the open block — one undo step, and the objects as they now are.
   *
   * Two `apply` calls (text, then the grown box) used to mean two undos for one
   * edit, and the export path could not see the text just typed because React had
   * not re-rendered yet. Returning the next object list is what lets Ctrl+S write
   * what the user actually sees.
   */
  const commitEdit = useCallback((): EditObject[] => {
    const id = editingRef.current;
    const node = editorRef.current;
    editingRef.current = null;
    pendingKeyRef.current = null;
    setEditingId(null);
    if (!id || !node) return objects;
    const current = objects.find((object) => object.id === id);
    if (!current || current.kind !== 'text') return objects;
    const paragraphs = readParagraphs(node);
    const text = textOfParagraphs(paragraphs).trim();
    // An emptied block is a deletion: the object stays, so the commit still removes
    // the original words and draws nothing back.
    const actions: EditorAction[] =
      text.length === 0
        ? [{ type: 'text', id, paragraphs: paragraphsFromText('') }]
        : [
            { type: 'text', id, paragraphs },
            { type: 'set-box', id, box: growBox(current, node, zoom) },
          ];
    applyAll(actions);
    // Find & replace indexes the page as it was read. After a rewrite its offsets
    // point at text that no longer exists, so the index goes with it.
    searchIndexRef.current = null;
    if (text.length === 0) {
      toast('info', 'Block cleared: the original words will be removed and nothing drawn back.');
    } else {
      toast(
        'success',
        `Block rewritten — ${text.length} characters, one undo step. Export to write it into the file.`,
      );
    }
    return actions.reduce<EditObject[]>((list, action) => editObjects(list, action), objects);
  }, [applyAll, objects, toast, zoom]);

  const stopEditing = useCallback(() => {
    commitEdit();
  }, [commitEdit]);

  /** `Esc`, one level at a time: edit → Find → selection → pin → tool. */
  const unwind = useCallback(() => {
    const step = nextEscapeStep({
      editing: Boolean(editingRef.current),
      findOpen,
      selected: selection.length,
      pinned,
      mode,
    });
    if (step === 'commit-edit') {
      commitEdit();
      return;
    }
    if (step === 'close-find') setFindOpen(false);
    if (step === 'clear-selection') setSelection([]);
    if (step === 'unpin') setPinned(false);
    if (step === 'disarm') setMode('edit');
    announce(ESCAPE_STEP_REPORT[step]);
  }, [announce, commitEdit, findOpen, mode, pinned, selection.length]);

  /** Undo / redo, through one door, announced either way. */
  const stepHistory = useCallback(
    (direction: 'undo' | 'redo') => {
      announce(historyReport(history, direction));
      if (direction === 'undo' ? !canUndo(history) : !canRedo(history)) return;
      // pdf.js commits whatever is in progress before an undo-affected operation.
      commitEdit();
      sealHistory();
      setHistory(direction === 'undo' ? undoHistory : redoHistory);
    },
    [announce, commitEdit, history, sealHistory],
  );

  /** Ctrl/Cmd+D: the copy lands selected, offset from the original. */
  const duplicateSelection = useCallback(() => {
    if (selected.length === 0) return;
    commitEdit();
    const copies = selected.map((object, index) => cloneObject(object, objects.length + index));
    apply({ type: 'add-many', objects: copies });
    setSelection(copies.map((object) => object.id));
    announce(`Duplicated ${copies.length} object${copies.length === 1 ? '' : 's'}.`);
  }, [announce, apply, commitEdit, objects.length, selected]);

  /**
   * Arm a mode. The panel, the V/T/I keys and a quick-mode chip all come through
   * here so that "Add image" never means three different things — committing the
   * open paragraph first, and asking for the picture immediately.
   */
  const armMode = useCallback(
    (next: ToolMode) => {
      if (editingRef.current) stopEditing();
      setMode(next);
      if (next === 'add-image' && !pendingImageRef.current) imageInputRef.current?.click();
    },
    [stopEditing],
  );

  /* ── arriving from a quick-mode chip (the editor chooser's "Edit text") ── */

  const routeToolId =
    typeof activeToolId === 'string' && activeToolId.length > 0 ? activeToolId : toolIdFromLocation();
  const intentChecked = useRef(false);

  useEffect(() => {
    if (intentChecked.current) return;
    intentChecked.current = true;
    const intent = routeToolId ? takeEditorIntent(routeToolId) : null;
    if (!intent) return;
    if (intent.panel === 'text' || intent.panel === 'blocks') armMode('edit');
    // `useFileStore` gives every tool its own slot, so the document only follows
    // the user here if this editor takes it from the hand-off.
    const carried = adoptedFile(intent, file ? [file] : []);
    if (carried) {
      setFile(carried);
      toast('info', `Brought ${carried.name} across from the editor chooser — it is still only in this tab.`);
    } else if (intent.note) {
      toast('info', intent.note);
    }
  }, [armMode, file, routeToolId, setFile, toast]);

  /* ── what this page can actually be edited into (E10, E11) ───────────── */

  const advice = useMemo(
    () =>
      pageAdvice({
        hasDocument: Boolean(source),
        opening,
        numPages,
        page,
        blocks: blocks.map((block) => ({
          invisible: block.invisible,
          direction: block.direction,
          text: block.text,
        })),
        imageCount: pageObjects.filter((entry) => entry.kind === 'image').length,
        // Three states, because "the engine is available" meant nothing while it
        // could also mean "a 54 MB download is about to start".
        engineLoaded: repairEngineLoaded(),
        engineFetchable: engineRepairAvailable(),
        engineSize: repairEngineSize(),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blocks, engineTick, numPages, opening, page, pageObjects, source],
  );

  const runAdviceAction = useCallback(
    (action: AdviceAction) => {
      if (action === 'run-ocr') {
        // The claim has to be true: the file store keeps a slot per tool, so the
        // document only follows the user across if it is seeded first.
        const handoff = planHandoff('ocr-pdf', 'the OCR tool', file ?? null);
        navigateToTool('ocr-pdf');
        toast('info', handoff.line);
        return;
      }
      if (action === 'open-engine') {
        setBusy(true);
        void (async () => {
          const outcome = await loadRepairEngine((line) => toast('info', line));
          setBusy(false);
          setEngineTick((tick) => tick + 1);
          if (outcome.ok) {
            toast('success', 'PyMuPDF is loaded in this tab. Blocks the built-in engine cannot delete will be repaired on export.');
          } else {
            toast(
              'warn',
              `The optional engine could not be fetched${outcome.reason ? `: ${outcome.reason}` : ''}. Rewriting an OCR layer would leave doubled text, so those blocks stay queued.`,
            );
          }
        })();
        return;
      }
      if (action === 'add-text') armMode('add-text');
      if (action === 'next-page') setPage((current) => Math.min(numPages, current + 1));
    },
    [armMode, file, numPages, toast],
  );

  /** The on-screen box grows with the typed text, so the overlay never clips. */
  function growBox(object: TextObject, node: HTMLElement, scale: number): TopLeftBox {
    const height = node.scrollHeight / Math.max(0.05, scale);
    return { ...object.box, height: Math.max(MIN_BLOCK_SIZE, height + BLOCK_PADDING * 2) };
  }

  // ── pointer handling on the page ──────────────────────────────────────────
  function toViewerPoint(event: React.MouseEvent): Point {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  function onPageMouseDown(event: React.MouseEvent) {
    if (!source) return;
    const point = toViewerPoint(event);
    if (mode === 'add-image') {
      placeImage(point);
      return;
    }
    if (mode === 'add-text') {
      drawRef.current = { from: point, to: point };
      setDraftRect({ x: point.x, y: point.y, width: 0, height: 0 });
      setLiveSize({ x: point.x, y: point.y, width: 0, height: 0 });
      return;
    }
    const hitObject = objectAtPoint(objects, page, point, scope);
    if (hitObject) {
      const next = event.shiftKey
        ? symmetricSelection(selection, hitObject.id)
        : selection.includes(hitObject.id) && selection.length > 1
          ? selection
          : [hitObject.id];
      setSelection(next);
      // One click selects; the caret arrives on double-click, Enter, or typing.
      if (editingRef.current && editingRef.current !== hitObject.id) stopEditing();
      if (next.length > 0) {
        dragRef.current = {
          start: point,
          origin: new Map(objects.filter((object) => next.includes(object.id)).map((object) => [object.id, object.box])),
          moved: false,
        };
      }
      return;
    }
    const paragraph = blocks.find((block) => boxHit(block.box, point, BLOCK_PADDING));
    if (paragraph && (scope === 'text' || scope === 'all')) {
      setSelection([]);
      openBlock(paragraph);
      return;
    }
    const detected = pageObjects.find((entry) => boxHit(entry.box, point, 0));
    if (detected && (scope === 'image' || scope === 'shape' || scope === 'all')) {
      selectPageObject(detected.id, detected.kind, detected.box);
      return;
    }
    if (editingRef.current) stopEditing();
    setSelection([]);
  }

  /** Double-click goes one level deeper: into the words, not another selection. */
  function onPageDoubleClick(event: React.MouseEvent) {
    if (!source || mode !== 'edit') return;
    const point = toViewerPoint(event);
    const hitObject = objectAtPoint(objects, page, point, 'text');
    if (hitObject && hitObject.kind === 'text') {
      setSelection([hitObject.id]);
      startEditing(hitObject.id);
      return;
    }
    const paragraph = blocks.find((block) => boxHit(block.box, point, BLOCK_PADDING));
    if (paragraph) openBlock(paragraph);
  }

  /** A handle drag resizes the box and re-wraps the text inside it live. */
  function onHandleMouseDown(event: React.MouseEvent, object: EditObject, handle: ResizeHandle) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const point = toViewerPoint(event);
    resizeRef.current = { id: object.id, handle, start: point, origin: object.box };
    setSelection([object.id]);
    if (editingRef.current && editingRef.current !== object.id) stopEditing();
    announce(`Resizing from the ${RESIZE_HANDLES.find((entry) => entry.id === handle)?.label ?? 'edge'}.`);
  }

  /** Keyboard route to the same resize, so dragging is never the only way. */
  function onHandleKeyDown(event: React.KeyboardEvent, object: EditObject, handle: ResizeHandle) {
    const keys: Record<string, [number, number]> = {
      arrowleft: [-1, 0],
      arrowright: [1, 0],
      arrowup: [0, -1],
      arrowdown: [0, 1],
    };
    const delta = keys[event.key.toLowerCase()];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const factor = event.shiftKey ? 10 : 1;
    nudge([{ type: 'set-box', id: object.id, box: resizeBox(object.box, handle, delta[0] * factor, delta[1] * factor) }]);
  }

  function onPageMouseMove(event: React.MouseEvent) {
    const resize = resizeRef.current;
    if (resize) {
      const point = toViewerPoint(event);
      const box = resizeBox(resize.origin, resize.handle, point.x - resize.start.x, point.y - resize.start.y);
      apply({ type: 'set-box', id: resize.id, box }, true);
      setLiveSize(box);
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      const point = toViewerPoint(event);
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) drag.moved = true;
      for (const [id, box] of drag.origin) {
        apply({ type: 'set-box', id, box: { ...box, x: box.x + dx, y: box.y + dy } }, true);
      }
      return;
    }
    if (drawRef.current) {
      const point = toViewerPoint(event);
      drawRef.current = { ...drawRef.current, to: point };
      const { from, to } = drawRef.current;
      setDraftRect({
        x: Math.min(from.x, to.x),
        y: Math.min(from.y, to.y),
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y),
      });
    }
  }

  function onPageMouseUp() {
    if (resizeRef.current) {
      // One undo step for the whole drag: the burst opened on the first move.
      sealHistory();
      resizeRef.current = null;
      setLiveSize(null);
      return;
    }
    if (dragRef.current?.moved) sealHistory();
    dragRef.current = null;
    const draft = drawRef.current;
    drawRef.current = null;
    setLiveSize(null);
    if (draft && mode === 'add-text') {
      const box = normalizeDraft(draft);
      setDraftRect(null);
      if (box) addTextBox(box);
    } else {
      setDraftRect(null);
    }
  }

  function addTextBox(box: TopLeftBox) {
    const object: TextObject = {
      id: nextObjectId('text'),
      page,
      kind: 'text',
      box,
      rotation: 0,
      flipH: false,
      flipV: false,
      z: objects.length,
      alt: '',
      state: 'draft',
      paragraphs: paragraphsFromText(''),
      style: { ...DEFAULT_STYLE, size: 12, color: '#000000' },
      deletion: [],
      paperColor: readPalette(canvasRef.current, box, zoom).background,
      sourceId: '',
      fromInvisibleLayer: false,
    };
    apply({ type: 'add', object });
    setSelection([object.id]);
    // One-shot unless pinned: the resting tool is Edit, so the next click on the
    // page moves or edits this box instead of dropping a fourth one under it.
    if (stepsAside('add-text', pinned)) setMode('edit');
    else announce('Pinned: another text box is ready to place.');
    startEditing(object.id);
  }

  function placeImage(point: Point) {
    const pending = pendingImageRef.current;
    if (!pending) {
      toast('info', 'Choose an image file first, then click where it should go.');
      imageInputRef.current?.click();
      return;
    }
    const scale = Math.min(
      (pageSize.width * IMAGE_PLACE_FRACTION) / pending.width,
      (pageSize.height * IMAGE_PLACE_FRACTION) / pending.height,
      1,
    );
    const width = pending.width * scale;
    const height = pending.height * scale;
    const object: ImageObject = {
      id: nextObjectId('image'),
      page,
      kind: 'image',
      box: { x: point.x - width / 2, y: point.y - height / 2, width, height },
      rotation: 0,
      flipH: false,
      flipV: false,
      z: objects.length,
      alt: '',
      state: 'draft',
      bytes: pending.bytes,
      mime: pending.mime,
      intrinsic: { width: pending.width, height: pending.height },
    };
    apply({ type: 'add', object });
    setSelection([object.id]);
    if (!stepsAside('add-image', pinned)) {
      // Pinned: the same picture stays loaded so the next click drops another one.
      announce(`Placed on page ${page}. Pinned, so the next click places another.`);
      toast('info', 'Click where the next copy should go — the tool stays armed until Esc.');
      return;
    }
    pendingImageRef.current = null;
    setPendingImage(false);
    setMode('edit');
  }

  async function onPickImageFile(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    try {
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      const decoded = await decodeImage(bytes, { mime: chosen.type });
      pendingImageRef.current = {
        bytes,
        mime: chosen.type || decoded.mime,
        width: decoded.canvas.width,
        height: decoded.canvas.height,
      };
      setPendingImage(true);
      setMode('add-image');
      toast('info', 'Click on the page where the image should be placed.');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'That image could not be read.');
    }
  }

  async function onReplaceImage() {
    const target = selected.find((object) => object.kind === 'image') ?? selected.find((object) => object.kind === 'shape');
    const chosen = imageInputRef.current;
    if (!chosen) return;
    chosen.onchange = async () => {
      const picked = chosen.files?.[0];
      chosen.onchange = null;
      if (!picked || !target) return;
      try {
        const bytes = new Uint8Array(await picked.arrayBuffer());
        const decoded = await decodeImage(bytes, { mime: picked.type });
        if (target.kind === 'image') {
          apply({
            type: 'replace-image',
            id: target.id,
            bytes,
            mime: picked.type || decoded.mime,
            intrinsic: { width: decoded.canvas.width, height: decoded.canvas.height },
          });
          toast('success', 'Image replaced; its placement is unchanged.');
        } else {
          apply({ type: 'remove', ids: [target.id] });
          const patch: PatchObject = { ...target, kind: 'shape', color: (target as PatchObject).color };
          const replacement: ImageObject = {
            id: nextObjectId('image'),
            page: target.page,
            kind: 'image',
            box: target.box,
            rotation: 0,
            flipH: false,
            flipV: false,
            z: objects.length,
            alt: target.alt,
            state: 'draft',
            bytes,
            mime: picked.type || decoded.mime,
            intrinsic: { width: decoded.canvas.width, height: decoded.canvas.height },
          };
          apply({ type: 'add-many', objects: [patch, replacement] });
          toast('success', 'Page image covered and the new one placed in the same spot.');
        }
      } catch (err) {
        toast('error', err instanceof Error ? err.message : 'That image could not be read.');
      }
    };
    chosen.click();
  }

  /** Page images and vector shapes are read-only pixels/paths: cover or annotate. */
  function selectPageObject(id: string, kind: 'image' | 'shape', box: TopLeftBox) {
    const existing = objects.find((object) => object.alt === id);
    if (existing) {
      setSelection([existing.id]);
      return;
    }
    const patch: PatchObject = {
      id: nextObjectId('image'),
      page,
      kind: 'shape',
      box,
      rotation: 0,
      flipH: false,
      flipV: false,
      z: objects.length,
      alt: id,
      state: 'draft',
      color: readPalette(canvasRef.current, box, zoom).background,
    };
    apply({ type: 'add', object: patch });
    setSelection([patch.id]);
    toast(
      'info',
      kind === 'image'
        ? 'Selected a page image. The built-in engine cannot remove pixels, so “cover” paints the page colour over it and keeps the file valid.'
        : 'Selected a vector shape. Covering it paints the page colour over the box; the path itself stays in the file.',
    );
  }

  // ── find & replace ────────────────────────────────────────────────────────
  async function ensureSearchIndex(): Promise<SearchIndex> {
    if (searchIndexRef.current) return searchIndexRef.current;
    if (!activeSession) return { blocks: [], paragraphs: new Map() };
    const paragraphs = new Map<string, ExtractedParagraph>();
    const all: SearchableBlock[] = [];
    process.startProcessing('Indexing text', '_edited.pdf');
    setSearching(true);
    for (let n = 1; n <= activeSession.numPages; n += 1) {
      const pageItems = await activeSession.textItems(n);
      const clustered = clusterParagraphs(pageItems);
      for (const paragraph of clustered) paragraphs.set(paragraph.id, paragraph);
      all.push(...searchableBlocks(clustered));
      process.setPercent(Math.round((n / activeSession.numPages) * 100), `Reading page ${n} of ${activeSession.numPages}`);
    }
    process.reset();
    setSearching(false);
    // What the page says *now* is what a search must match: a block the user has
    // retyped is re-pointed at its edited text, or Replace would rewrite the
    // original words and quietly undo the edit made a moment ago.
    const retyped = new Map<string, string>();
    for (const object of objects) {
      if (object.kind === 'text' && object.sourceId) retyped.set(object.sourceId, textOfParagraphs(object.paragraphs));
    }
    const index: SearchIndex = {
      blocks: all.map((block) => {
        const text = retyped.get(block.id);
        return text === undefined ? block : retextBlock(block, text);
      }),
      paragraphs,
    };
    searchIndexRef.current = index;
    return index;
  }

  const runSearch = useCallback(
    async (query = findQuery) => {
      if (!query) {
        setHits([]);
        setFindStatus('Type something to search every page.');
        return;
      }
      const index = await ensureSearchIndex();
      const found = searchBlocks(index.blocks, query, findOptions);
      setHits(found);
      setHitIndex(0);
      const pages = new Set(found.map((hit) => hit.page)).size;
      setFindStatus(
        index.blocks.length === 0
          ? 'This document has no text layer to search — its pages are pictures. Run OCR, then search the recognised text.'
          : found.length === 0
            ? `No match for “${query}” in ${index.blocks.length} text block${index.blocks.length === 1 ? '' : 's'}.`
            : `${found.length} match${found.length === 1 ? '' : 'es'} on ${pages} page${pages === 1 ? '' : 's'} · 1/${found.length}`,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findQuery, findOptions, activeSession, objects],
  );

  useEffect(() => {
    if (findOpen) void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, findQuery, findOptions]);

  function showHit(index: number) {
    if (hits.length === 0) {
      setFindStatus(
        findQuery
          ? `Nothing to jump to — “${findQuery}” matched 0 blocks so far.`
          : 'Type something to search every page.',
      );
      return;
    }
    const next = (index + hits.length) % hits.length;
    const hit = hits[next];
    setHitIndex(next);
    setPage(hit.page);
    setFindStatus(`${next + 1}/${hits.length} on page ${hit.page} · ${hit.preview}`);
  }

  /**
   * Write one replacement into the block that holds the hit.
   *
   * Returns what it did, so Replace All can report one aggregate sentence instead
   * of the count of whichever block happened to be processed last.
   */
  function applyHit(hit: SearchHit, all: boolean): { replaced: number; stale: number } | null {
    const index = searchIndexRef.current;
    const paragraph = index?.paragraphs.get(hit.sourceId);
    if (!paragraph) {
      toast('error', 'That match is not in this document any more — search again before replacing.');
      return null;
    }
    if (findReplacement.trim().length === 0) {
      toast('warn', `Nothing to replace “${findQuery}” with — type the new text first. Nothing was changed.`);
      return null;
    }
    const existing = objects.find(
      (object): object is TextObject => object.kind === 'text' && object.sourceId === paragraph.id,
    );
    // Replace over the text that is on the page *now*, and only at offsets that
    // still read as the query: a stale hit would edit whatever characters moved
    // into its place, which is a wrong answer that looks right.
    const current = existing ? textOfParagraphs(existing.paragraphs) : paragraph.text;
    const scoped: SearchHit[] = all
      ? hits.filter((entry) => entry.sourceId === hit.sourceId)
      : [hit];
    const ranges = liveRanges(current, findQuery, findOptions, scoped.map((entry) => entry.range));
    const stale = scoped.length - ranges.length;
    if (ranges.length === 0) {
      toast(
        'warn',
        `“${findQuery}” is not in that block on page ${hit.page} any more — it was edited after the search. Nothing was changed.`,
      );
      return null;
    }
    const replaced = replaceInText(current, findQuery, findReplacement, findOptions, ranges);
    const style = existing?.style ?? styleFromExtraction(paragraph, { pageWidth: pageSize.width });
    const updated: TextObject = {
      id: existing?.id ?? nextObjectId('text'),
      page: paragraph.page,
      kind: 'text',
      box: existing?.box ?? {
        x: paragraph.box.x - BLOCK_PADDING,
        y: paragraph.box.y - BLOCK_PADDING,
        width: paragraph.box.width + BLOCK_PADDING * 2,
        height: paragraph.box.height + BLOCK_PADDING * 2,
      },
      rotation: existing?.rotation ?? 0,
      flipH: existing?.flipH ?? false,
      flipV: existing?.flipV ?? false,
      z: existing?.z ?? objects.length,
      alt: existing?.alt ?? '',
      state: 'draft',
      paragraphs: paragraphsFromText(replaced.text),
      style,
      deletion: deletionBoxes(paragraph),
      paperColor: existing?.paperColor ?? readPalette(canvasRef.current, paragraph.box, zoom).background,
      sourceId: paragraph.id,
      fromInvisibleLayer: paragraph.invisible,
    };
    if (paragraph.invisible) {
      toast('warn', 'That block is an invisible OCR layer: the replacement is queued for the optional PyMuPDF engine, which rewrites the page underneath it.');
    }
    if (existing) apply({ type: 'replace', id: existing.id, object: updated });
    else apply({ type: 'add', object: updated });
    // The block's text moved, so re-point the live index at it: its old offsets
    // are dead ends now, and `liveRanges` is what refuses them next time.
    if (index) {
      index.blocks = index.blocks.map((block) => (block.id === paragraph.id ? retextBlock(block, replaced.text) : block));
    }
    setHits((remaining) => remaining.filter((entry) => !scoped.includes(entry)));
    setFindStatus(
      `${replaced.count} replacement${replaced.count === 1 ? '' : 's'} queued on page ${paragraph.page}${
        stale > 0 ? `, ${stale} stale match${stale === 1 ? '' : 'es'} skipped` : ''
      }. Export to write them in.`,
    );
    return { replaced: replaced.count, stale };
  }

  /** Replace the match on screen (`false`) or every match in the document. */
  function replaceText(all: boolean) {
    if (hits.length === 0) {
      const line = findQuery
        ? `Nothing to replace: “${findQuery}” matched 0 blocks. Run the search again after any edit.`
        : 'Nothing to replace — type what to find first.';
      setFindStatus(line);
      toast('warn', line);
      return;
    }
    if (!all) {
      applyHit(hits[Math.min(hitIndex, hits.length - 1)], false);
      return;
    }
    const byBlock = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const list = byBlock.get(hit.sourceId) ?? [];
      list.push(hit);
      byBlock.set(hit.sourceId, list);
    }
    let count = 0;
    let stale = 0;
    let blocks = 0;
    const pages = new Set<number>();
    for (const list of byBlock.values()) {
      const outcome = applyHit(list[0], true);
      if (!outcome) continue;
      count += outcome.replaced;
      stale += outcome.stale;
      blocks += 1;
      pages.add(list[0].page);
    }
    if (count === 0) {
      toast('warn', 'Nothing was replaced — every match had gone stale. Search again.');
      return;
    }
    setFindStatus(
      `${count} replacement${count === 1 ? '' : 's'} in ${blocks} block${blocks === 1 ? '' : 's'} on ${pages.size} page${
        pages.size === 1 ? '' : 's'
      } queued. Export to write them in.${stale > 0 ? ` ${stale} stale match${stale === 1 ? '' : 'es'} skipped.` : ''}`,
    );
  }

  // ── export ────────────────────────────────────────────────────────────────
  /**
   * Mark objects as written without creating an undo step.
   *
   * Exporting is not an edit: it used to push several history entries, so Ctrl+Z
   * after a save appeared to do nothing a few times before anything changed.
   */
  function stampState(ids: string[], state: CommitState, note?: string) {
    if (ids.length === 0) return;
    setHistory((current) => {
      const next = editObjects(current.present, { type: 'commit-state', ids, state, note });
      return next === current.present ? current : amendHistory(current, next);
    });
  }

  async function buildOutput(list: EditObject[]): Promise<{ bytes: Uint8Array; report: ExportReport }> {
    if (!source) throw new Error('Open a PDF first.');
    process.startProcessing('Rewriting text', '_edited.pdf');
    process.setPercent(10, 'Opening the document');
    const doc = await openPDF(source.bytes, { password: password || undefined, ignoreEncryption: true });
    if (signed) {
      // Append-only revision keeps the signed byte range verifiable.
      await snapshot(doc);
    }
    process.setPercent(35, list.length > 0 ? 'Deleting the original runs and drawing the edits' : 'Saving');
    const outcome = await applyEdits(doc, list);
    process.setPercent(70, signed ? 'Appending the revision' : 'Saving');
    let bytes = signed ? await saveIncremental(doc) : await savePDF(doc);

    const failedIds = outcome.failed.map((entry) => entry.id);
    const repaired: string[] = [];
    let engineError: string | undefined;
    if (failedIds.length > 0 && engineRepairAvailable()) {
      // 54 MB, fetched once — and it says so before the wait rather than after.
      if (!repairEngineLoaded()) toast('info', repairEngineLine());
      process.setPercent(80, 'Repairing blocked pages with PyMuPDF');
      const blocked = list.filter(
        (object): object is TextObject => failedIds.includes(object.id) && object.kind === 'text',
      );
      const lines = await engineLines(doc, failedIds, list);
      const repair = await repairWithPyMuPDF(
        bytes,
        blocked.map((object) => ({ object })),
        lines,
        password || undefined,
      );
      // A failed fetch must not throw the built-in file away, and must not be
      // quiet about it either: the blocks it was meant to clean are still there.
      if (repair?.error) engineError = repair.error;
      else if (repair) {
        bytes = repair.bytes;
        repaired.push(...repair.repaired);
        stampState(repair.repaired, 'written');
      }
    }
    const stillBlocked = failedIds.filter((id) => !repaired.includes(id));
    stampState(stillBlocked, 'needs-engine', stillBlocked.length > 0 ? outcome.failed[0]?.reason : undefined);
    stampState(
      list.filter((object) => !stillBlocked.includes(object.id)).map((object) => object.id),
      'written',
    );
    // One structured result instead of three transient toasts that expire: the
    // equivalent of a registry tool's `result.warnings`.
    return { bytes, report: exportReport(outcome, list, { signed, repaired, engineError }) };
  }

  /** Lines the PyMuPDF fallback has to insert, in its top-left coordinate space. */
  async function engineLines(
    doc: Parameters<typeof prepareTextObject>[0],
    ids: string[],
    list: EditObject[],
  ): Promise<EngineLine[]> {
    const lines: EngineLine[] = [];
    for (const object of list) {
      if (object.kind !== 'text' || !ids.includes(object.id)) continue;
      const prepared = await prepareTextObject(doc, object);
      for (const line of prepared.layout.lines) {
        for (const piece of line.pieces) {
          if (piece.text.trim().length === 0) continue;
          lines.push({
            page: object.page,
            x: object.box.x + piece.x,
            y: object.box.y + line.baseline,
            size: piece.run.size,
            text: piece.text,
            color: piece.run.color,
          });
        }
      }
    }
    return lines;
  }

  async function exportPdf(list: EditObject[] = commitEdit()) {
    if (!source || busy) return;
    if (list.length === 0) {
      toast('warn', 'Nothing to export yet — click a paragraph and retype it first.');
      return;
    }
    setBusy(true);
    try {
      const { bytes, report } = await buildOutput(list);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      process.setOutput(blob, url);
      process.appendLog(`${report.headline} Saved as ${baseName(source.name)}_edited.pdf`);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${baseName(source.name)}_edited.pdf`;
      anchor.click();
      setExportResult({ headline: report.headline, lines: report.warnings });
      toast(report.warnings.length > 0 ? 'warn' : 'success', report.headline);
      for (const line of report.warnings) process.appendLog(line);
      if (pdfa) toast('warn', `${pdfa} conformance may break: the rewrite embeds new fonts and an added content stream.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The edited PDF could not be written.';
      process.setError(message);
      toast('error', message);
    } finally {
      setBusy(false);
    }
  }

  async function reloadPreview(list: EditObject[] = commitEdit()) {
    if (!source || busy) return;
    if (list.length === 0) {
      toast('warn', 'Nothing to preview yet — the page still holds its original words.');
      return;
    }
    setBusy(true);
    try {
      const { bytes, report } = await buildOutput(list);
      const opened = await openRender(bytes, { password: password || undefined });
      await editedSession?.destroy();
      setEditedSession(opened);
      setSource({ bytes, name: source.name });
      searchIndexRef.current = null;
      setExportResult({ headline: report.headline, lines: report.warnings });
      setPage(1);
      toast('success', 'Preview now shows the edited bytes.');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'The edited preview could not be opened.');
    } finally {
      setBusy(false);
    }
  }

  // ── misc UI plumbing ──────────────────────────────────────────────────────
  const families = useMemo(() => [...BUILT_IN_FAMILIES, ...localFamilies], [localFamilies]);

  async function scanLocalFonts() {
    try {
      const found = await loadLocalFamilies();
      setLocalFamilies(found);
      setLocalScanned(true);
      toast('info', found.length > 0 ? `${found.length} installed fonts are now selectable and will be embedded.` : 'No installed fonts were returned.');
    } catch (err) {
      toast('warn', err instanceof Error ? err.message : 'The browser refused to list installed fonts.');
    }
  }

  async function copyPageText() {
    if (!activeSession) return;
    try {
      const text = joinReadingOrder(items.length ? items : await activeSession.textItems(page));
      await navigator.clipboard.writeText(text);
      toast('success', `Copied page ${page} in reading order.`);
    } catch {
      toast('error', 'The browser would not let this page write to the clipboard.');
    }
  }

  function applyFit(target: FitMode) {
    const viewport = {
      width: scrollRef.current?.clientWidth ?? window.innerWidth,
      height: scrollRef.current?.clientHeight ?? window.innerHeight,
    };
    setZoom(fitScale(pageSize, viewport, target));
  }

  function openAnother() {
    pdfInputRef.current?.click();
  }

  async function onPickPdf(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;
    setFile(chosen);
  }

  const pageScale = { width: pageSize.width * zoom, height: pageSize.height * zoom };
  const visibleObjects = objectsForPage(objects, page);

  return (
    <div className="relative flex h-full min-h-0 flex-1 overflow-hidden bg-cream">
      <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={onPickPdf} />
      <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={onPickImageFile} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopToolbar
          hasDocument={!!source}
          dirty={dirty}
          page={page}
          numPages={numPages}
          zoom={zoom}
          showRulers={showRulers}
          barsHidden={barsHidden}
          canUndo={canUndo(history)}
          canRedo={canRedo(history)}
          canExport={objects.length > 0}
          exportNote={
            objects.length > 0
              ? 'Save the edited PDF (Ctrl+S). The open block is committed first.'
              : 'Nothing to export yet — click a paragraph on the page and retype it.'
          }
          undoNote={canUndo(history) ? 'Undo the last committed edit (Ctrl+Z)' : 'Nothing has been edited yet'}
          redoNote={canRedo(history) ? 'Re-apply the change just undone (Ctrl+Shift+Z)' : 'Nothing has been undone'}
          onBack={() => {
            if (dirty > 0 && !window.confirm(`${dirty} edited block(s) have not been exported yet. Close them anyway?`)) return;
            setFile(null);
          }}
          onOpenAnother={openAnother}
          onExport={() => exportPdf()}
          onUndo={() => stepHistory('undo')}
          onRedo={() => stepHistory('redo')}
          onPrevPage={() => setPage((current) => Math.max(1, current - 1))}
          onNextPage={() => setPage((current) => Math.min(numPages, current + 1))}
          onJumpPage={(value) => setPage(Math.min(Math.max(1, Math.round(value) || 1), Math.max(1, numPages)))}
          onZoom={setZoom}
          onFit={applyFit}
          onToggleRulers={() => setShowRulers((current) => !current)}
          onToggleBars={() => setBarsHidden((current) => !current)}
          onCopyPageText={copyPageText}
          onReloadPreview={() => reloadPreview()}
        />

        {!source && (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-xl space-y-3">
              <FileDropZone
                accept="application/pdf,.pdf"
                label="Drop a PDF here, or click to browse"
                hint="Everything happens in this tab. Text is deleted and rewritten for real — no overlay."
              />
              <DropReassurance lines={DROP_REASSURANCE} />
              <QuickModeChips currentToolId={routeToolId} file={file} onLocal={() => armMode('edit')} />
              <p className="text-[11px] leading-relaxed text-ink-soft">
                Click any paragraph to retype it in place. On export, the original runs are removed from the page's
                content stream and the edited block is drawn back with selectable text. Blocks the client-side engine
                cannot delete are reported instead of doubled, and the optional PyMuPDF engine can finish them.
              </p>
            </div>
          </div>
        )}

        {source && (needsPassword || error) && (
          <div className="space-y-2 border-b border-cream-border bg-warn/10 px-3 py-2">
            {needsPassword && (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="PDF password"
                  className="doodle-input !w-64 !px-2 !py-1 !text-[11px]"
                />
                <ToolButton label="Open" kind="primary" onClick={() => setNeedsPassword(false)} />
              </div>
            )}
            {error && <p className="text-[11px] leading-relaxed text-warn">{error}</p>}
          </div>
        )}

        {source && signed && (
          <p
            data-signed-notice
            className="border-b border-cream-border bg-accent/5 px-3 py-1.5 text-[11px] leading-relaxed text-ink-soft"
          >
            This document is signed. Edits are not written back over the signed bytes: Export produces an appended
            incremental revision that carries the rewritten text, so the existing signature stays verifiable and the new
            words are what a viewer shows. PDF/A conformance may still break.
          </p>
        )}
        {source && pdfa && (
          <p className="border-b border-cream-border bg-accent/5 px-3 py-1.5 text-[11px] leading-relaxed text-ink-soft">
            This file declares {pdfa}. Rewriting text embeds new fonts and adds content streams, which can break
            conformance; re-validate with the PDF/A tool afterwards.
          </p>
        )}
        {advice && (
          <div
            role="status"
            data-page-advice={advice.kind}
            className={`flex flex-wrap items-start gap-2 border-b px-3 py-2 ${
              advice.tone === 'warn' ? 'border-warn/25 bg-warn/10' : 'border-cream-border bg-accent/5'
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className={`text-[11px] font-semibold ${advice.tone === 'warn' ? 'text-warn' : 'text-ink'}`}>
                {advice.headline}
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-ink-soft">{advice.detail}</p>
            </div>
            {advice.actions.map((action) => (
              <ToolButton key={action} label={adviceActionLabel(action)} onClick={() => runAdviceAction(action)} />
            ))}
          </div>
        )}

        {source && (
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              <div ref={scrollRef} className="flex-1 overflow-auto bg-cream-soft p-4">
                <div className="mx-auto flex w-max flex-col gap-1">
                  {showRulers && (
                    <div className="flex">
                      <div className="w-4 shrink-0" />
                      <Ruler orientation="horizontal" lengthPoints={pageSize.width} scale={zoom} />
                    </div>
                  )}
                  <div className="flex gap-1">
                    {showRulers && <Ruler orientation="vertical" lengthPoints={pageSize.height} scale={zoom} />}
                    <div
                      className="relative shrink-0"
                      style={{ width: pageScale.width, height: pageScale.height, lineHeight: 0 }}
                    >
                      <canvas
                        ref={canvasRef}
                        className="rounded-md bg-white shadow-doodle-card"
                        style={{ width: pageScale.width, height: pageScale.height }}
                      />
                      <div
                        className="absolute inset-0"
                        data-page-overlay
                        style={{ zIndex: 10, cursor: mode === 'edit' ? 'default' : 'crosshair' }}
                        onMouseDown={onPageMouseDown}
                        onDoubleClick={onPageDoubleClick}
                        onMouseMove={onPageMouseMove}
                        onMouseUp={onPageMouseUp}
                        onMouseLeave={onPageMouseUp}
                      >
                        {opening && (
                          <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-[11px] text-ink-muted">
                            Opening…
                          </div>
                        )}
                        {blocks.map((block) => {
                          if (visibleObjects.some((object) => object.kind === 'text' && object.sourceId === block.id)) {
                            return null;
                          }
                          const editable = !block.invisible && (scope === 'text' || scope === 'all') && mode === 'edit';
                          // The hover target is the padded box, i.e. exactly the box
                          // a click turns into an editable block — "where you land".
                          const landing = {
                            x: block.box.x - BLOCK_PADDING,
                            y: block.box.y - BLOCK_PADDING,
                            width: block.box.width + BLOCK_PADDING * 2,
                            height: block.box.height + BLOCK_PADDING * 2,
                          };
                          return (
                            <div
                              key={block.id}
                              data-editable-block={editable ? 'yes' : 'no'}
                              data-block-page={block.page}
                              role="button"
                              tabIndex={mode === 'edit' ? 0 : -1}
                              aria-disabled={!editable}
                              aria-label={
                                editable
                                  ? `Rewrite this paragraph on page ${block.page}: ${block.text.slice(0, 60) || 'empty'}`
                                  : block.invisible
                                    ? `Page ${block.page}: invisible OCR text — searchable, not editable here`
                                    : `Page ${block.page}: paragraph text`
                              }
                              title={
                                block.invisible
                                  ? 'Invisible OCR text — selectable, not editable'
                                  : 'Click to rewrite this paragraph'
                              }
                              className={`group absolute rounded-[2px] outline-offset-0 transition-colors ${FOCUS_RING} ${
                                editable
                                  ? 'cursor-pointer hover:bg-accent/10 hover:outline hover:outline-1 hover:outline-accent'
                                  : block.invisible
                                    ? 'cursor-not-allowed outline outline-1 outline-dashed outline-warn'
                                    : ''
                              }`}
                              style={{
                                left: landing.x * zoom,
                                top: landing.y * zoom,
                                width: landing.width * zoom,
                                height: landing.height * zoom,
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter' && event.key !== ' ') return;
                                event.preventDefault();
                                event.stopPropagation();
                                openBlock(block);
                              }}
                            >
                              {editable && (
                                <span className="pointer-events-none absolute left-0 top-full hidden whitespace-nowrap rounded bg-accent px-1 py-0.5 font-mono text-[9px] leading-none text-white group-hover:block group-focus:block">
                                  {Math.round(block.size)} pt · {block.lines.length} line
                                  {block.lines.length === 1 ? '' : 's'} · click to rewrite
                                </span>
                              )}
                            </div>
                          );
                        })}

                        {pageObjects.map((entry) => (
                          <div
                            key={entry.id}
                            className="absolute rounded-[2px] border border-dashed border-accent/40"
                            style={{
                              left: entry.box.x * zoom,
                              top: entry.box.y * zoom,
                              width: entry.box.width * zoom,
                              height: entry.box.height * zoom,
                              display: scope === 'image' || scope === 'shape' || scope === 'all' ? 'block' : 'none',
                            }}
                          />
                        ))}

                        {visibleObjects.map((object) => (
                          <ObjectView
                            key={object.id}
                            object={object}
                            zoom={zoom}
                            selected={selection.includes(object.id)}
                            editing={editingId === object.id}
                            editorRef={editorRef}
                            pendingKey={pendingKeyRef.current}
                            onCommit={stopEditing}
                            onEditStart={startEditing}
                            onHandleMouseDown={onHandleMouseDown}
                            onHandleKeyDown={onHandleKeyDown}
                          />
                        ))}

                        {(draftRect ?? liveSize) && (
                          <SizeBadge box={(draftRect ?? liveSize) as TopLeftBox} scale={zoom} />
                        )}
                        {draftRect && (
                          <div
                            className="absolute border-2 border-dashed border-accent bg-accent/10"
                            style={{
                              left: draftRect.x * zoom,
                              top: draftRect.y * zoom,
                              width: draftRect.width * zoom,
                              height: draftRect.height * zoom,
                            }}
                          />
                        )}
                        {pendingImage && (
                          <div className="absolute left-2 top-2 rounded bg-accent px-2 py-1 text-[10px] text-white">
                            Click where the image should go
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3 border-t border-cream-border bg-cream-light px-3 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                <span>
                  {pageSize.width.toFixed(0)} × {pageSize.height.toFixed(0)} pt
                </span>
                <span>{Math.round(zoom * 100)}%</span>
                <span>{blocks.length} text block(s)</span>
                <span>{summaryText(objects)}</span>
                <span className="ml-auto">{busy ? 'writing…' : editedSession ? 'preview: edited bytes' : 'preview: original bytes'}</span>
              </div>
              {/* Announced, not shown: undo depth, Esc steps, duplicates. */}
              <p className="sr-only" role="status" aria-live="polite" data-text-live>
                {liveText}
              </p>
            </div>

            {!barsHidden && (
              <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-cream-border bg-cream-light p-3">
                <ModePanel
                  mode={mode}
                  scope={scope}
                  pinned={pinned}
                  onMode={armMode}
                  onScope={setScope}
                  onPin={(next) => {
                    setPinned(next);
                    announce(
                      next
                        ? 'Pinned: the placement tool stays armed after each drop.'
                        : 'One-shot again: the tool steps back to Edit after one placement.',
                    );
                  }}
                  onPickImage={() => imageInputRef.current?.click()}
                />
                {editingId && (
                  <div className="flex items-center gap-2 rounded-doodle-md border border-accent/30 bg-accent/5 p-2">
                    <span className="flex-1 text-[10px] leading-relaxed text-ink-soft">
                      Editing page {editing?.page ?? page} in place. Enter inserts a line break; Esc or Done keeps what
                      you typed as one undo step.
                    </span>
                    <ToolButton label="Done" kind="primary" onClick={stopEditing} />
                  </div>
                )}
                <FormatPanel
                  style={currentStyle}
                  hasSelection={Boolean(styleTarget)}
                  families={families}
                  localFontsSupported={supportsLocalFonts()}
                  localFontsLoaded={localScanned}
                  onScanLocalFonts={scanLocalFonts}
                  onStyle={(patch) => selection.length > 0 && apply({ type: 'style', ids: selection, patch })}
                  onInline={(patch) => selection.length > 0 && apply({ type: 'inline-style', ids: selection, patch })}
                  onList={(list: ListKind) => apply({ type: 'list', ids: selection, list })}
                  notes={selected.map((object) => object.note).filter((note): note is string => Boolean(note))}
                />
                <ObjectPanel
                  selection={selected}
                  onSetBox={(box) => {
                    const id = selected[0]?.id;
                    if (id) apply({ type: 'set-box', id, box });
                  }}
                  onTransform={(patch) => apply({ type: 'transform', ids: selection, ...patch })}
                  onRotate={(delta) => {
                    const start = selected[0]?.rotation ?? 0;
                    apply({ type: 'transform', ids: selection, rotation: (((start + delta) % 360) + 360) % 360 });
                  }}
                  onZOrder={(order) => apply({ type: 'zorder', ids: selection, order })}
                  onDuplicate={() => {
                    const copies = selected.map((object, index) =>
                      cloneObject(object, objects.length + index),
                    );
                    apply({ type: 'add-many', objects: copies });
                    setSelection(copies.map((object) => object.id));
                  }}
                  onDelete={() => {
                    apply({ type: 'remove', ids: selection });
                    setSelection([]);
                  }}
                  onAlign={(mode2) => apply({ type: 'align', ids: selection, mode: mode2 })}
                  onDistribute={(axis) => apply({ type: 'distribute', ids: selection, axis })}
                  onAlt={(alt) => apply({ type: 'alt', ids: selection, alt })}
                  onReplaceImage={onReplaceImage}
                  onMove={(dx, dy) => nudge([{ type: 'move', ids: selection, dx, dy }])}
                />
                {exportResult && (
                  <WarningList
                    headline={exportResult.headline}
                    lines={exportResult.lines}
                    onDismiss={() => setExportResult(null)}
                  />
                )}
                <FindReplacePanel
                  open={findOpen}
                  query={findQuery}
                  replacement={findReplacement}
                  caseSensitive={Boolean(findOptions.caseSensitive)}
                  wholeWord={Boolean(findOptions.wholeWord)}
                  ignoreAccents={Boolean(findOptions.ignoreAccents)}
                  status={findStatus}
                  canReplace={hits.length > 0}
                  replaceNote={
                    hits.length > 0
                      ? `Replace the match on screen, or every match in the document.`
                      : findQuery
                        ? `Nothing to replace — “${findQuery}” matched 0 blocks.`
                        : 'Nothing to replace yet — type what to find first.'
                  }
                  searching={searching}
                  onQuery={setFindQuery}
                  onReplacement={setFindReplacement}
                  onToggle={(key, value) => setFindOptions((current) => ({ ...current, [key]: value }))}
                  onNext={() => showHit(hitIndex + 1)}
                  onPrev={() => showHit(hitIndex - 1)}
                  onReplace={() => replaceText(false)}
                  onReplaceAll={() => replaceText(true)}
                  onClose={() => setFindOpen(false)}
                />
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <PanelHeading>Edits</PanelHeading>
                    <ToolButton label={findOpen ? 'Hide find' : 'Find & replace'} active={findOpen} onClick={() => setFindOpen((open) => !open)} className="ml-auto" />
                  </div>
                  <ObjectList
                    objects={objects}
                    selectedIds={selection}
                    onSelect={(id) => {
                      const object = objects.find((entry) => entry.id === id);
                      if (!object) return;
                      setPage(object.page);
                      setSelection([id]);
                    }}
                    onEdit={(id) => {
                      const object = objects.find((entry) => entry.id === id);
                      if (!object) return;
                      setPage(object.page);
                      setSelection([id]);
                      if (object.kind === 'text') startEditing(id);
                    }}
                  />
                </div>
                <InspectorSection
                  id="keys"
                  title="Keyboard"
                  meta={`${TEXT_EDITOR_SHORTCUTS.length} keys`}
                  defaultOpen={false}
                >
                  <ShortcutList compact rows={TEXT_EDITOR_SHORTCUTS} />
                </InspectorSection>
                <p className="text-[10px] leading-relaxed text-ink-muted" data-engine-note>
                  {repairEngineNote()}
                </p>
              </aside>
            )}
          </div>
        )}
      </div>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
    </div>
  );
}

// ── page rendering helpers ──────────────────────────────────────────────────

function ObjectView({
  object,
  zoom,
  selected,
  editing,
  editorRef,
  pendingKey,
  onCommit,
  onEditStart,
  onHandleMouseDown,
  onHandleKeyDown,
}: {
  object: EditObject;
  zoom: number;
  selected: boolean;
  editing: boolean;
  editorRef: React.RefObject<HTMLDivElement>;
  /** Character typed over the selection, which must land inside the box. */
  pendingKey: string | null;
  onCommit: () => void;
  onEditStart: (id: string | null, typed?: string) => void;
  onHandleMouseDown: (event: React.MouseEvent, object: EditObject, handle: ResizeHandle) => void;
  onHandleKeyDown: (event: React.KeyboardEvent, object: EditObject, handle: ResizeHandle) => void;
}) {
  const style: React.CSSProperties = {
    left: object.box.x * zoom,
    top: object.box.y * zoom,
    width: object.box.width * zoom,
    height: object.box.height * zoom,
    transform: `rotate(${object.rotation}deg) scaleX(${object.flipH ? -1 : 1}) scaleY(${object.flipV ? -1 : 1})`,
    zIndex: editing ? 30 : 20 + object.z,
  };
  if (object.kind === 'image') {
    return (
      <div style={{ ...style, position: 'absolute', overflow: 'hidden' }}>
        <img src={imageDataUrl(object.bytes, object.mime)} alt={object.alt} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
        {selected && <SelectionFrame object={object} onEdit={() => onEditStart(object.id)} onMouseDown={onHandleMouseDown} onKeyDown={onHandleKeyDown} />}
      </div>
    );
  }
  if (object.kind === 'shape') {
    return (
      <div
        style={{ ...style, position: 'absolute', background: object.color }}
        title="Cover patch"
      >
        {selected && <SelectionFrame object={object} onEdit={() => onEditStart(object.id)} onMouseDown={onHandleMouseDown} onKeyDown={onHandleKeyDown} />}
      </div>
    );
  }
  const textStyle: React.CSSProperties = {
    fontFamily: familyPreview(object.style.fontFamily),
    fontSize: `${object.style.size * zoom}px`,
    lineHeight: `${object.style.lineSpacing}`,
    color: object.style.color,
    background: object.paperColor,
    textAlign: object.style.align,
    paddingLeft: `${Math.max(0, object.style.indent) * zoom}px`,
    letterSpacing: object.style.charSpacing ? `${object.style.charSpacing * zoom}px` : undefined,
    wordSpacing: object.style.wordSpacing ? `${object.style.wordSpacing * zoom}px` : undefined,
    transform: object.style.horizontalScale !== 100 ? `scaleX(${object.style.horizontalScale / 100})` : undefined,
    transformOrigin: 'left top',
    direction: object.style.direction === 'rtl' ? 'rtl' : 'ltr',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  };
  return (
    <div style={{ ...style, position: 'absolute' }} onDoubleClick={() => onEditStart(object.id)}>
      <div style={textStyle}>
        {editing ? (
          <EditorBox boxRef={editorRef} object={object} pendingKey={pendingKey} onCommit={onCommit} />
        ) : (
          <BlockPreview object={object} />
        )}
      </div>
      {selected && (
        <SelectionFrame
          object={object}
          editing={editing}
          onEdit={() => onEditStart(object.id)}
          onMouseDown={onHandleMouseDown}
          onKeyDown={onHandleKeyDown}
        />
      )}
    </div>
  );
}

/**
 * The active block's bounds and handles.
 *
 * Selection without a frame is guesswork: the user cannot tell which object a
 * click took, nor that its edge can be dragged. Handles are 10 px (the 8 px the
 * checklist asks for, plus a transparent 5 px hit slop), carry the direction-correct
 * resize cursor, and are focusable with their own arrow-key resize so dragging is
 * never the only route (WCAG 2.5.7).
 */
function SelectionFrame({
  object,
  editing = false,
  onEdit,
  onMouseDown,
  onKeyDown,
}: {
  object: EditObject;
  editing?: boolean;
  onEdit: () => void;
  onMouseDown: (event: React.MouseEvent, object: EditObject, handle: ResizeHandle) => void;
  onKeyDown: (event: React.KeyboardEvent, object: EditObject, handle: ResizeHandle) => void;
}) {
  return (
    <div
      data-selection-frame={object.id}
      className="pointer-events-none absolute inset-0 border-2 border-accent"
      style={{ boxShadow: '0 0 0 1px rgba(37,99,235,0.35)' }}
    >
      {!editing &&
        RESIZE_HANDLES.map((handle) => (
          <div
            key={handle.id}
            data-resize-handle={handle.id}
            role="button"
            tabIndex={0}
            aria-label={`${handle.label} — resize this block. Arrow keys resize 1 pt, Shift 10 pt.`}
            title={`${handle.label} — drag to resize`}
            className={`pointer-events-auto absolute flex items-center justify-center rounded-full ${FOCUS_RING}`}
            style={{
              left: `calc(${handle.left * 100}% - ${HANDLE_HIT / 2}px)`,
              top: `calc(${handle.top * 100}% - ${HANDLE_HIT / 2}px)`,
              width: `${HANDLE_HIT}px`,
              height: `${HANDLE_HIT}px`,
              cursor: handle.cursor,
              padding: 0,
            }}
            onMouseDown={(event) => onMouseDown(event, object, handle.id)}
            onKeyDown={(event) => onKeyDown(event, object, handle.id)}
          >
            <span
              data-resize-dot
              aria-hidden
              className="block rounded-full border border-white bg-accent"
              style={{ width: `${HANDLE_DOT}px`, height: `${HANDLE_DOT}px` }}
            />
          </div>
        ))}
      {object.kind === 'text' && !editing && (
        <button
          type="button"
          data-edit-block
          onClick={onEdit}
          className="pointer-events-auto absolute left-0 top-[-18px] rounded bg-accent px-1.5 py-0.5 font-mono text-[9px] leading-none text-white"
          title="Edit these words"
        >
          Edit
        </button>
      )}
    </div>
  );
}

/**
 * The in-place editing surface. Content is built with `createElement` +
 * `textContent` (`editorDom`), never from an HTML string, so a PDF whose text is
 * `<img src=x onerror=…>` cannot run anything in this origin.
 */
function EditorBox({
  object,
  onCommit,
  boxRef,
  pendingKey,
}: {
  object: TextObject;
  onCommit: () => void;
  boxRef: React.RefObject<HTMLDivElement>;
  pendingKey: string | null;
}) {
  // Typing changes the DOM without changing the model, so the content is only
  // rebuilt when a different block opens or a toolbar action rewrote this one.
  const signature = JSON.stringify(object.paragraphs);
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    mountParagraphs(node, object.paragraphs, object.style);
    // An opened block takes the caret: otherwise the first keystroke falls
    // through to the page and fires a shortcut instead of typing.
    focusEditor(node, pendingKey ?? undefined);
    // `signature` is the dependency that matters; the object identity changes on
    // every style tick and must not reset the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object.id, signature]);
  return (
    <div
      ref={boxRef}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-multiline="true"
      aria-label="Edit this paragraph"
      tabIndex={0}
      className="min-h-full outline-none ring-2 ring-accent"
      style={{ padding: 0, cursor: 'text' }}
      onBlur={onCommit}
    />
  );
}

/** Read-only rendering of a committed block, over the patched page area. */
function BlockPreview({ object }: { object: TextObject }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) mountParagraphs(ref.current, object.paragraphs, object.style);
  }, [object]);
  return <div ref={ref} />;
}
const imageUrlCache = new Map<string, string>();

function imageDataUrl(bytes: Uint8Array, mime: string): string {
  const key = `${bytes.byteLength}:${bytes[0] ?? 0}:${bytes[bytes.length - 1] ?? 0}:${mime}`;
  const known = imageUrlCache.get(key);
  if (known) return known;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || 'image/png' }));
  imageUrlCache.set(key, url);
  return url;
}

function boxHit(box: TopLeftBox, point: Point, pad: number): boolean {
  return (
    point.x >= box.x - pad &&
    point.x <= box.x + box.width + pad &&
    point.y >= box.y - pad &&
    point.y <= box.y + box.height + pad
  );
}

function symmetricSelection(current: string[], id: string): string[] {
  return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
}

function normalizeDraft(draft: { from: Point; to: Point }): TopLeftBox | null {
  const box = {
    x: Math.min(draft.from.x, draft.to.x),
    y: Math.min(draft.from.y, draft.to.y),
    width: Math.abs(draft.to.x - draft.from.x),
    height: Math.abs(draft.to.y - draft.from.y),
  };
  if (box.width < 6 || box.height < 6) return null;
  return box;
}

function cloneObject(object: EditObject, z: number): EditObject {
  const id = nextObjectId(object.kind === 'text' ? 'text' : 'image');
  const box = { ...object.box, x: object.box.x + 8, y: object.box.y + 8 };
  if (object.kind === 'text') {
    return {
      ...object,
      id,
      z,
      box,
      state: 'draft',
      style: { ...object.style },
      deletion: [...object.deletion],
      paragraphs: object.paragraphs.map((paragraph) => ({
        ...paragraph,
        style: { ...paragraph.style },
        runs: paragraph.runs.map((run) => ({ ...run, style: { ...run.style } })),
      })),
    };
  }
  return { ...object, id, z, box, state: 'draft' };
}

/**
 * Sample the rendered page for a block's ink and paper colours.
 */
function readPalette(canvas: HTMLCanvasElement | null, box: TopLeftBox, scale: number) {
  if (!canvas) return { color: '#000000', background: '#ffffff' };
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return { color: '#000000', background: '#ffffff' };
    const width = canvas.width;
    const height = canvas.height;
    const x = Math.max(0, Math.floor(box.x * scale));
    const y = Math.max(0, Math.floor(box.y * scale));
    const w = Math.max(1, Math.min(width - x, Math.ceil(box.width * scale)));
    const h = Math.max(1, Math.min(height - y, Math.ceil(box.height * scale)));
    const data = ctx.getImageData(x, y, w, h).data;
    return samplePalette(data, w, h, { x: 0, y: 0, width: w, height: h }, 1);
  } catch {
    // A canvas tainted by a cross-origin font or image cannot be sampled.
    return { color: '#000000', background: '#ffffff' };
  }
}

/**
 * Image and vector placements on a page, from pdf.js's operator list. The `OPS`
 * table is loaded lazily so the module never pulls pdf.js into a test run.
 */
/**
 * Image and vector placements on a page, from pdf.js's operator list. The `OPS`
 * table is read off the loaded module so the code never hard-codes numbers.
 */
async function detectObjects(
  handle: PdfSession,
  page: number,
): Promise<{ kind: 'image' | 'shape'; box: TopLeftBox; id: string }[]> {
  try {
    const proxy = await handle.page(page);
    const list = await proxy.getOperatorList();
    // SAFETY: `pdfjs-dist` types its namespace loosely, but its build exports
    // `OPS` as a plain name → numeric-code map; only that one field is read and
    // every code is checked below before it is used.
    const mod = (await import('pdfjs-dist')) as unknown as { OPS?: Record<string, number> };
    const ops = mod.OPS;
    if (!ops) return [];
    const size = proxy.getViewport({ scale: 1 });
    const codes: OperatorCodes = {
      save: ops.save,
      restore: ops.restore,
      transform: ops.transform,
      paintImageXObject: ops.paintImageXObject,
      paintImageXObjectRepeat: ops.paintImageXObjectRepeat,
      paintInlineImageXObject: ops.paintInlineImageXObject,
      paintImageMaskXObject: ops.paintImageMaskXObject,
      paintSolidColorImageMask: ops.paintSolidColorImageMask,
      constructPath: ops.constructPath,
      fill: ops.fill,
      stroke: ops.stroke,
      fillStroke: ops.fillStroke,
      endPath: ops.endPath,
    };
    if (Object.values(codes).some((value) => typeof value !== 'number')) return [];
    return detectPageObjects(list.fnArray, list.argsArray, codes, {
      width: size.width,
      height: size.height,
    }).map((entry, index) => ({ kind: entry.kind, box: entry.box, id: `${entry.kind}-${page}-${index}` }));
  } catch {
    return [];
  }
}

function baseName(name: string): string {
  return name.replace(/\.pdf$/i, '') || 'document';
}

function summaryText(objects: EditObject[]): string {
  const summary = objectsSummary(objects);
  return `${summary.text} text · ${summary.images} image · ${summary.pending} to export`;
}

export default TextEditor;
