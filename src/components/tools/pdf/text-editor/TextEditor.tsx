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
import { enginePurpose } from '@/lib/pdf/core/engine-ops';
import { displayedSize } from '@/lib/pdf/core/pages';
import type { TopLeftBox } from '@/lib/pdf/core/tables';
import { applyEdits, frameOfPage, prepareTextObject } from './draw';
import { engineRepairAvailable, repairWithPyMuPDF, type EngineLine } from './engine';
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
  ToastStack,
  TopToolbar,
  ToolButton,
  type Toast,
} from './panels';
import {
  DEFAULT_STYLE,
  amendHistory,
  canRedo,
  canUndo,
  clusterParagraphs,
  createHistory,
  deletionBoxes,
  detectPageObjects,
  editObjects,
  fitScale,
  layoutBlock,
  monospaceMeasure,
  nextObjectId,
  objectAtPoint,
  objectsForPage,
  objectsSummary,
  paragraphsFromText,
  pushHistory,
  redoHistory,
  replaceInText,
  samplePalette,
  searchableBlocks,
  searchBlocks,
  styleFromExtraction,
  textOfParagraphs,
  undoHistory,
  type EditObject,
  type EditScope,
  type EditorAction,
  type DomNode,
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
  type SearchHit,
  type SearchableBlock,
  type TextObject,
  type ToolMode,
} from './model';
import { mountParagraphs, readParagraphs } from './editorDom';
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
import { TEXT_EDITOR_SHORTCUTS, textModeForKey } from './keys';
import { adviceActionLabel, pageAdvice, type AdviceAction } from './pageAdvice';
import { EngineSettingsDialog } from '@/lib/pdf/engines/EngineGate';

/** Extra padding around a block when it is converted into an editable box. */
const BLOCK_PADDING = 2;
/** How much of the page a freshly placed image may cover. */
const IMAGE_PLACE_FRACTION = 0.35;

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
  const [engineSettingsOpen, setEngineSettingsOpen] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const searchIndexRef = useRef<{ blocks: SearchableBlock[]; paragraphs: Map<string, ExtractedParagraph> } | null>(null);
  const pendingImageRef = useRef<{ bytes: Uint8Array; mime: string; width: number; height: number } | null>(null);
  const [pendingImage, setPendingImage] = useState(false);
  const dragRef = useRef<{ start: Point; origin: Map<string, TopLeftBox>; moved: boolean } | null>(null);
  const drawRef = useRef<{ from: Point; to: Point } | null>(null);
  const [draftRect, setDraftRect] = useState<TopLeftBox | null>(null);
  const toastSeq = useRef(0);

  const objects = history.present;
  const activeSession = editedSession ?? session;
  const numPages = activeSession?.numPages ?? 0;
  const dirty = objects.filter((object) => object.state !== 'written').length;

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((current) => [...current.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), 8000);
  }, []);

  const apply = useCallback((action: EditorAction, coalesce = false) => {
    setHistory((state) => {
      const next = editObjects(state.present, action);
      if (next === state.present) return state;
      return coalesce ? amendHistory(state, next) : pushHistory(state, next);
    });
  }, []);

  /** Finish an interaction that was coalesced: one undo step for the whole drag. */
  const sealHistory = useCallback(() => {
    setHistory((state) => ({
      past: [...state.past, state.present].slice(-60),
      present: state.present,
      future: [],
    }));
  }, []);

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
    searchIndexRef.current = null;
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
      if (meta && key === 's') {
        event.preventDefault();
        void exportPdf();
        return;
      }
      if (meta && key === 'f') {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      // One guard for every binding below: while a field or the in-place
      // paragraph owns the caret, keys belong to the text, not to the editor.
      const inText = isTypingTarget(event.target);
      const history = historyCommandForKey(event.key, {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      });
      if (history && !inText) {
        event.preventDefault();
        setHistory((state) => (history === 'undo' ? undoHistory(state) : redoHistory(state)));
        return;
      }
      if (!inText && !meta && !event.altKey) {
        const armed = textModeForKey(event.key);
        if (armed) {
          event.preventDefault();
          armMode(armed);
          return;
        }
      }
      if ((key === 'delete' || key === 'backspace') && !inText && !meta && selection.length > 0) {
        event.preventDefault();
        apply({ type: 'remove', ids: selection });
        setSelection([]);
        return;
      }
      if (key === 'escape') {
        if (editingId) stopEditing();
        else if (findOpen) setFindOpen(false);
        else setSelection([]);
      }
      if (!inText && ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) && selection.length > 0) {
        event.preventDefault();
        const stepPx = event.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -stepPx : key === 'arrowright' ? stepPx : 0;
        const dy = key === 'arrowup' ? -stepPx : key === 'arrowdown' ? stepPx : 0;
        apply({ type: 'move', ids: selection, dx, dy });
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
        setEditingId(existing.id);
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
      setEditingId(object.id);
    },
    [apply, objects, toast, zoom, pageSize.width],
  );

  const stopEditing = useCallback(() => {
    const node = editorRef.current;
    if (!node || !editing || editing.kind !== 'text') {
      setEditingId(null);
      return;
    }
    const paragraphs = readParagraphs(node);
    const text = textOfParagraphs(paragraphs).trim();
    if (text.length === 0) {
      // An emptied block is a deletion: keep the object so the commit still
      // removes the original words, with nothing drawn back.
      apply({ type: 'text', id: editing.id, paragraphs: paragraphsFromText('') });
      setEditingId(null);
      toast('info', 'Block cleared: the original words will be removed and nothing drawn back.');
      return;
    }
    const grown = growBox(editing, node, zoom);
    apply({ type: 'text', id: editing.id, paragraphs });
    apply({ type: 'set-box', id: editing.id, box: grown });
    setEditingId(null);
    toast('success', 'Block rewritten. Export to write it into the file.');
  }, [apply, editing, toast, zoom]);

  /**
   * Arm a mode. The panel, the V/T/I keys and a quick-mode chip all come through
   * here so that "Add image" never means three different things — committing the
   * open paragraph first, and asking for the picture immediately.
   */
  const armMode = useCallback(
    (next: ToolMode) => {
      if (editingId) stopEditing();
      setMode(next);
      if (next === 'add-image' && !pendingImageRef.current) imageInputRef.current?.click();
    },
    [editingId, stopEditing],
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
        engineAvailable: engineRepairAvailable(),
      }),
    [blocks, numPages, opening, page, pageObjects, source],
  );

  const runAdviceAction = useCallback(
    (action: AdviceAction) => {
      if (action === 'run-ocr') {
        toast('info', 'Opening OCR PDF with this document still loaded — the recognised page comes back editable.');
        navigateToTool('ocr-pdf');
        return;
      }
      if (action === 'open-engine') {
        setEngineSettingsOpen(true);
        return;
      }
      if (action === 'add-text') armMode('add-text');
      if (action === 'next-page') setPage((current) => Math.min(numPages, current + 1));
    },
    [armMode, numPages, toast],
  );

  /** The on-screen box grows with the typed text, so the overlay never clips. */
  function growBox(object: TextObject, node: HTMLElement, scale: number): TopLeftBox {
    const height = node.scrollHeight / Math.max(0.05, scale);
    return { ...object.box, height: Math.max(8, height + BLOCK_PADDING * 2) };
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
      if (editingId && editingId !== hitObject.id) stopEditing();
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
    if (editingId) stopEditing();
    setSelection([]);
  }

  function onPageMouseMove(event: React.MouseEvent) {
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
    if (dragRef.current?.moved) sealHistory();
    dragRef.current = null;
    const draft = drawRef.current;
    drawRef.current = null;
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
    setMode('edit');
    setEditingId(object.id);
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
  async function ensureSearchIndex(): Promise<{ blocks: SearchableBlock[]; paragraphs: Map<string, ExtractedParagraph> }> {
    if (searchIndexRef.current) return searchIndexRef.current;
    if (!activeSession) return { blocks: [], paragraphs: new Map() };
    const paragraphs = new Map<string, ExtractedParagraph>();
    const all: SearchableBlock[] = [];
    process.startProcessing('Indexing text', '_edited.pdf');
    for (let n = 1; n <= activeSession.numPages; n += 1) {
      const pageItems = await activeSession.textItems(n);
      const clustered = clusterParagraphs(pageItems);
      for (const paragraph of clustered) paragraphs.set(paragraph.id, paragraph);
      all.push(...searchableBlocks(clustered));
      process.setPercent(Math.round((n / activeSession.numPages) * 100), `Reading page ${n} of ${activeSession.numPages}`);
    }
    process.reset();
    searchIndexRef.current = { blocks: all, paragraphs };
    return searchIndexRef.current;
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
        found.length === 0
          ? `No match for “${query}” in this document.`
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
      setFindStatus('Nothing to jump to yet.');
      return;
    }
    const next = (index + hits.length) % hits.length;
    const hit = hits[next];
    setHitIndex(next);
    setPage(hit.page);
    setFindStatus(`${next + 1}/${hits.length} on page ${hit.page} · ${hit.preview}`);
  }

  /** Write one replacement into the block that holds the hit. */
  function applyHit(hit: SearchHit, all: boolean) {
    const index = searchIndexRef.current;
    const paragraph = index?.paragraphs.get(hit.sourceId);
    if (!paragraph) {
      toast('error', 'That match could not be located any more. Search again.');
      return;
    }
    const scoped: SearchHit[] = all
      ? hits.filter((entry) => entry.sourceId === hit.sourceId)
      : [hit];
    const ranges = scoped.map((entry) => entry.range);
    const replaced = replaceInText(paragraph.text, findQuery, findReplacement, findOptions, ranges);
    const existing = objects.find((object) => object.kind === 'text' && object.sourceId === paragraph.id);
    const style = existing && existing.kind === 'text' ? existing.style : styleFromExtraction(paragraph, { pageWidth: pageSize.width });
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
      paperColor: existing && existing.kind === 'text' ? existing.paperColor : readPalette(canvasRef.current, paragraph.box, zoom).background,
      sourceId: paragraph.id,
      fromInvisibleLayer: paragraph.invisible,
    };
    if (paragraph.invisible) {
      toast('warn', 'That block is an invisible OCR layer, so the replacement is queued for the optional PyMuPDF engine.');
    }
    if (existing) apply({ type: 'replace', id: existing.id, object: updated });
    else apply({ type: 'add', object: updated });
    const count = replaced.count;
    setHits((current) => current.filter((entry) => !scoped.includes(entry)));
    setFindStatus(
      `${count} replacement${count === 1 ? '' : 's'} queued on page ${paragraph.page}. Export to write them in.`,
    );
  }

  // ── export ────────────────────────────────────────────────────────────────
  async function buildOutput(): Promise<Uint8Array> {
    if (!source) throw new Error('Open a PDF first.');
    process.startProcessing('Rewriting text', '_edited.pdf');
    process.setPercent(10, 'Opening the document');
    const doc = await openPDF(source.bytes, { password: password || undefined, ignoreEncryption: true });
    if (signed) {
      // Append-only revision keeps the signed byte range verifiable.
      await snapshot(doc);
    }
    process.setPercent(35, objects.length > 0 ? 'Deleting the original runs and drawing the edits' : 'Saving');
    const outcome = await applyEdits(doc, objects);
    process.setPercent(70, signed ? 'Appending the revision' : 'Saving');
    let bytes = signed ? await saveIncremental(doc) : await savePDF(doc);

    if (outcome.failed.length > 0 && engineRepairAvailable()) {
      process.setPercent(80, 'Repairing blocked pages with PyMuPDF');
      const failedIds = outcome.failed.map((entry) => entry.id);
      const blocked = objects.filter(
        (object): object is TextObject => failedIds.includes(object.id) && object.kind === 'text',
      );
      const lines = await engineLines(doc, failedIds);
      const repaired = await repairWithPyMuPDF(
        bytes,
        blocked.map((object) => ({ object })),
        lines,
        password || undefined,
      );
      if (repaired) {
        bytes = repaired.bytes;
        toast('info', repaired.note);
        apply({ type: 'commit-state', ids: repaired.repaired, state: 'written' });
      }
    }
    if (outcome.partial.length > 0) {
      toast(
        'warn',
        `${outcome.partial.length} block(s) still have leftover glyphs under the new text; the optional PyMuPDF engine can clean those.`,
      );
    }
    if (outcome.raster.length > 0) {
      toast('warn', `${outcome.raster.length} block(s) needed raster fallback reporting; check them in a viewer.`);
    }
    const failedIds = outcome.failed.map((entry) => entry.id);
    if (failedIds.length > 0) {
      apply({ type: 'commit-state', ids: failedIds, state: 'needs-engine', note: outcome.failed[0]?.reason });
    }
    const written = objects.filter((object) => !failedIds.includes(object.id)).map((object) => object.id);
    if (written.length > 0) apply({ type: 'commit-state', ids: written, state: 'written' });
    return bytes;
  }

  /** Lines the PyMuPDF fallback has to insert, in its top-left coordinate space. */
  async function engineLines(doc: Parameters<typeof prepareTextObject>[0], ids: string[]): Promise<EngineLine[]> {
    const lines: EngineLine[] = [];
    for (const object of objects) {
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

  async function exportPdf() {
    if (!source || busy) return;
    setBusy(true);
    try {
      const bytes = await buildOutput();
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      process.setOutput(blob, url);
      process.appendLog(`Text editor exported ${objects.length} object(s) as ${baseName(source.name)}_edited.pdf`);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${baseName(source.name)}_edited.pdf`;
      anchor.click();
      toast(
        'success',
        signed
          ? 'Saved as an appended revision, so the existing signature stays verifiable.'
          : `Saved ${objects.length} edited object${objects.length === 1 ? '' : 's'}.`,
      );
      if (pdfa) toast('warn', `${pdfa} conformance may break: the rewrite embeds new fonts and an added content stream.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The edited PDF could not be written.';
      process.setError(message);
      toast('error', message);
    } finally {
      setBusy(false);
    }
  }

  async function reloadPreview() {
    if (!source || busy) return;
    setBusy(true);
    try {
      const bytes = await buildOutput();
      const opened = await openRender(bytes, { password: password || undefined });
      await editedSession?.destroy();
      setEditedSession(opened);
      setSource({ bytes, name: source.name });
      searchIndexRef.current = null;
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
          onBack={() => {
            if (dirty > 0 && !window.confirm(`${dirty} edited block(s) have not been exported yet. Close them anyway?`)) return;
            setFile(null);
          }}
          onOpenAnother={openAnother}
          onExport={exportPdf}
          onUndo={() => setHistory(undoHistory)}
          onRedo={() => setHistory(redoHistory)}
          onPrevPage={() => setPage((current) => Math.max(1, current - 1))}
          onNextPage={() => setPage((current) => Math.min(numPages, current + 1))}
          onJumpPage={(value) => setPage(Math.min(Math.max(1, Math.round(value) || 1), Math.max(1, numPages)))}
          onZoom={setZoom}
          onFit={applyFit}
          onToggleRulers={() => setShowRulers((current) => !current)}
          onToggleBars={() => setBarsHidden((current) => !current)}
          onCopyPageText={copyPageText}
          onReloadPreview={reloadPreview}
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
          <p className="border-b border-cream-border bg-accent/5 px-3 py-1.5 text-[11px] leading-relaxed text-ink-soft">
            This document is signed. Editing invalidates the visual appearance of a signature, so the export is written
            as an appended revision — the original signed bytes stay verifiable. PDF/A conformance may still break.
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
                        style={{ zIndex: 10, cursor: mode === 'edit' ? 'default' : 'crosshair' }}
                        onMouseDown={onPageMouseDown}
                        onMouseMove={onPageMouseMove}
                        onMouseUp={onPageMouseUp}
                        onMouseLeave={onPageMouseUp}
                      >
                        {opening && (
                          <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-[11px] text-ink-muted">
                            Opening…
                          </div>
                        )}
                        {blocks.map((block) =>
                          visibleObjects.some((object) => object.kind === 'text' && object.sourceId === block.id) ? null : (
                            <div
                              key={block.id}
                              title={block.invisible ? 'Invisible OCR text — selectable, not editable' : 'Click to rewrite this paragraph'}
                              className="absolute rounded-[2px] transition-colors"
                              style={{
                                left: block.box.x * zoom,
                                top: block.box.y * zoom,
                                width: block.box.width * zoom,
                                height: block.box.height * zoom,
                                outline: selectionOutlineFor(mode, scope, block.invisible),
                                outlineOffset: 0,
                                background: 'transparent',
                              }}
                              onMouseEnter={(event) => {
                                if (block.invisible || (scope !== 'text' && scope !== 'all')) return;
                                event.currentTarget.style.background = 'rgba(37,99,235,0.08)';
                              }}
                              onMouseLeave={(event) => {
                                event.currentTarget.style.background = 'transparent';
                              }}
                            />
                          ),
                        )}

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
                            onCommit={stopEditing}
                          />
                        ))}

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
            </div>

            {!barsHidden && (
              <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-cream-border bg-cream-light p-3">
                <ModePanel
                  mode={mode}
                  scope={scope}
                  onMode={armMode}
                  onScope={setScope}
                  onPickImage={() => imageInputRef.current?.click()}
                />
                {editingId && (
                  <div className="flex items-center gap-2 rounded-doodle-md border border-accent/30 bg-accent/5 p-2">
                    <span className="flex-1 text-[10px] leading-relaxed text-ink-soft">
                      Editing in place. Enter inserts a line break; the block re-wraps live.
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
                  onMove={(dx, dy) => apply({ type: 'move', ids: selection, dx, dy })}
                />
                <FindReplacePanel
                  open={findOpen}
                  query={findQuery}
                  replacement={findReplacement}
                  caseSensitive={Boolean(findOptions.caseSensitive)}
                  wholeWord={Boolean(findOptions.wholeWord)}
                  ignoreAccents={Boolean(findOptions.ignoreAccents)}
                  status={findStatus}
                  onQuery={setFindQuery}
                  onReplacement={setFindReplacement}
                  onToggle={(key, value) => setFindOptions((current) => ({ ...current, [key]: value }))}
                  onNext={() => showHit(hitIndex + 1)}
                  onPrev={() => showHit(hitIndex - 1)}
                  onReplace={() => hits[0] && applyHit(hits[0], false)}
                  onReplaceAll={() => {
                    const byBlock = new Map<string, SearchHit[]>();
                    for (const hit of hits) {
                      const list = byBlock.get(hit.sourceId) ?? [];
                      list.push(hit);
                      byBlock.set(hit.sourceId, list);
                    }
                    for (const list of byBlock.values()) applyHit(list[0], true);
                  }}
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
                      if (object.kind === 'text') setEditingId(id);
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
                <p className="text-[10px] leading-relaxed text-ink-muted">
                  {engineRepairAvailable()
                    ? 'PyMuPDF engine is reachable: blocks the built-in engine cannot delete are repaired with it on export.'
                    : `Optional engine offline: ${enginePurpose('pymupdf')} Without it, blocks in form XObjects and scans are reported rather than doubled.`}
                </p>
              </aside>
            )}
          </div>
        )}
      </div>
      <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((item) => item.id !== id))} />
      <EngineSettingsDialog open={engineSettingsOpen} onClose={() => setEngineSettingsOpen(false)} />
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
  onCommit,
}: {
  object: EditObject;
  zoom: number;
  selected: boolean;
  editing: boolean;
  editorRef: React.RefObject<HTMLDivElement>;
  onCommit: () => void;
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
        {selected && <SelectionFrame />}
      </div>
    );
  }
  if (object.kind === 'shape') {
    return <div style={{ ...style, position: 'absolute', background: object.color }} title="Cover patch" />;
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
    <div style={{ ...style, position: 'absolute' }}>
      <div style={textStyle}>
        {editing ? (
          <EditorBox boxRef={editorRef} object={object} onCommit={onCommit} />
        ) : (
          <BlockPreview object={object} />
        )}
      </div>
      {selected && <SelectionFrame />}
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
}: {
  object: TextObject;
  onCommit: () => void;
  boxRef: React.RefObject<HTMLDivElement>;
}) {
  // Typing changes the DOM without changing the model, so the content is only
  // rebuilt when a different block opens or a toolbar action rewrote this one.
  const signature = JSON.stringify(object.paragraphs);
  useEffect(() => {
    if (boxRef.current) mountParagraphs(boxRef.current, object.paragraphs, object.style);
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
      className="min-h-full outline-none ring-1 ring-accent/60"
      style={{ padding: 0 }}
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
function SelectionFrame() {
  return (
    <div
      className="pointer-events-none absolute inset-0 border border-accent"
      style={{ boxShadow: '0 0 0 1px rgba(37,99,235,0.35)' }}
    />
  );
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

function selectionOutlineFor(mode: ToolMode, scope: EditScope, invisible: boolean): string {
  if (mode !== 'edit' || (scope !== 'text' && scope !== 'all')) return 'none';
  return invisible ? '1px dotted #D97706' : '1px dotted rgba(37,99,235,0.35)';
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
