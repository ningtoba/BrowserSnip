/**
 * AnnotationEditor — BrowserSnip's flagship PDF editor (`/edit-pdf`).
 *
 * One page at a time, real `AnnotationSpec`s out of `core/annotations`, and one
 * `PdfSession` owned by this component: it is opened for the active document and
 * destroyed on unmount *and* on document change, which is the leak the previous
 * implementation had when several viewers shared a module-level document.
 *
 * Everything else follows from two rules.
 *
 * 1. Geometry is stored in PDF user space (see `geometry.ts`), so zoom, page
 *    size and rotation cannot drift a mark, and export writes the same numbers
 *    the overlay drew.
 * 2. The annotation list is the source of truth. Undo/redo, the layer list and
 *    the exported file are all views onto that one list, kept per document in a
 *    module-level `Map` keyed by file name so switching tabs — or stepping out
 *    to download an export — does not lose work. Nothing is persisted to disk
 *    automatically; the footer says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { fadeUp, scaleIn, staggerParent, tapDown } from '@/lib/motion';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { openRender, type ExtractedTextItem, type PdfSession } from '@/lib/pdf/core/render';
import { normaliseRotation } from '@/lib/pdf/core/pages';
import { decodeImage, encodeImageBytes, resolveImageMime, sniffImageMime } from '@/lib/pdf/core/images';
import { addAnnotations, applyRedactions, rasterisePageToImage } from '@/lib/pdf/core/annotations';
import {
  PasswordRequiredError,
  clonePDF,
  openPDF,
  savePDF,
  withFontkit,
  type PDFDocument,
} from '@/lib/pdf/core/doc';
import { AnnotationOverlay } from './AnnotationOverlay';
import { SignaturePad } from './SignaturePad';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  fitWidthZoom,
  isMeaningfulDrag,
  normaliseAngle,
  normaliseDrag,
  pdfToScreenPoint,
  quadsToPoints,
  rotationForDrag,
  screenAngle,
  screenToPdfPoint,
  screenToViewportBox,
  unrotateDelta,
  type CssRect,
  type PageGeom,
  type Point,
  type Rotation,
} from './geometry';
import {
  canRedo,
  canUndo,
  liveHistory,
  pushHistory,
  settleHistory,
} from './history';
import {
  ROTATE_SNAP_HINT,
  TOOL_SHORTCUT_KEYS,
  escapeLevelNotice,
  historyCommandForKey,
  isDuplicateKey,
  isSelectAllKey,
  isTypeToEditKey,
  isTypingTarget,
  keyForTool,
  nextEscapeLevel,
  nudgeStep,
  rotationStepForKey,
  toolForKey,
} from './shortcuts';
import { pageHasText, snapTextLines } from './quads';
import {
  annotationRotation,
  buildAnnotation,
  canRotate,
  describeAnnotation,
  dropEmptyMarks,
  duplicateMarks,
  emptyMarks,
  exportPlan,
  marksInMarquee,
  marksSummary,
  markAtPoint,
  moveMarks,
  nextAnnotationId,
  pageSelection,
  removeMarks,
  resizeAnnotation,
  selectedMarks,
  selectionScreenBounds,
  selectionSummary,
  setMarksRotation,
  styleMarks,
  turnMarks,
  workSignature,
  withText,
  type ResizeHandle,
  type SelectionSummary,
  type SharedStyle,
} from './specs';
import {
  BUILT_IN_STAMPS,
  EDITABLE_TEXT_TOOLS,
  FILLABLE_TOOLS,
  GROUP_FOR_TOOL,
  MARKUP_TOOLS,
  STROKED_TOOLS,
  SWATCHES,
  TEXT_TOOLS,
  TOOLS,
  TOOL_BY_ID,
  TOOL_GROUPS,
  AFTER_CREATE_NOTE,
  defaultStyleFor,
  isPlacementTool,
  toolAfterGesture,
  toolGroupById,
  toolsOfGroup,
} from './tools';
import { InspectorSection, SHORTCUT_COUNT, ShortcutList } from './inspector';
import {
  DROP_REASSURANCE,
  adoptedFile,
  defaultToolForToolId,
  takeEditorIntent,
  toolIdFromLocation,
  type QuickMode,
} from './quickModes';
import { DropReassurance, QuickModeChips } from './QuickModeChips';
import {
  addToSelection,
  applyWorkStep,
  clampPageIndex,
  createWork,
  deleteNotice,
  docWork,
  documentKey,
  formatPageExtent,
  isUnsaved,
  marqueeNotice,
  moveSelectionNotice,
  pageContextNotes,
  pruneSelection,
  rotationNotice,
  rotationRefusedNotice,
  selectAllNotice,
  selectOnly,
  selectionNotice,
  sharedStyleNotice,
  switchNotice,
  toggleSelected,
  transferSelectionToPage,
  type DocWork,
} from './workspace';
import { MAX_DOCUMENTS, type EditorAnnotation, type EditorToolId, type PlacedRaster, type ToolStyle } from './types';

type Phase = 'empty' | 'loading' | 'ready' | 'locked' | 'error';

/**
 * What the pointer is doing.
 *
 * `additive` rides along with a drag because the modifier is only true while the
 * button is down: reading it at pointer-up would let Shift-off mid-drag change
 * whether the marquee adds to the selection or replaces it.
 */
type Gesture =
  | { mode: 'drag'; from: Point; to: Point; additive?: boolean }
  | { mode: 'path'; points: Point[] }
  | { mode: 'vertices'; points: Point[]; cursor: Point | null };

/**
 * A drag that moves marks. It names the whole selection rather than the mark
 * under the pointer, and keeps the list it started from, because a group drag is
 * one edit: one undo step, not one per mark.
 */
interface MoveState {
  ids: string[];
  /** Pointer position at drag start, in PDF user space. */
  origin: Point;
  /** The whole list as it was before the drag. */
  beforeList: EditorAnnotation[];
}

/** A corner-drag is the same three-part shape as a move, with one mark. */
type ResizeState = MoveState & { id: string; handle: ResizeHandle };

/** A rotate-handle drag: the arc is measured from the selection's centre. */
interface RotateState {
  ids: string[];
  /** Screen-space pivot the handle swings around. */
  centre: Point;
  /** Pointer angle at drag start, in degrees. */
  startAngle: number;
  /** The angle the selection had when the drag began. */
  startRotation: number;
  beforeList: EditorAnnotation[];
}

interface Notice {
  tone: 'info' | 'success' | 'warn' | 'danger';
  text: string;
}

const NOTICE_CLASS: Record<Notice['tone'], string> = {
  info: 'border-accent/20 bg-accent/5 text-ink-soft',
  success: 'border-success/25 bg-success/5 text-success',
  warn: 'border-warn/25 bg-warn/5 text-warn',
  danger: 'border-danger/25 bg-danger/[0.07] text-danger',
};

/**
 * `.doodle-chip` carries `flex-1`, which is right inside a segmented row but
 * makes toolbar buttons stretch; opt back out with `flex-none`.
 */
const CHIP = 'doodle-chip flex-none whitespace-nowrap px-2 py-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Small secondary action inside the option panel (`doodle-btn` is full-width). */
const MINI_BTN =
  'doodle-btn doodle-btn-secondary w-auto flex-none px-2 py-1 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** What the active place tool is still waiting for. */
function rasterHint(tool: EditorToolId, ready: boolean): string {
  if (ready) return 'Ready to place — click or drag on the page.';
  if (tool === 'signature') return 'Draw the signature; it is placed as a stamp annotation.';
  return 'Pick a PNG or JPEG; it is placed as a stamp annotation.';
}

export function AnnotationEditor(): JSX.Element {
  /* ── documents ───────────────────────────────────────────────────── */

  const files = useFileStore((s) => s.files);
  const previewFileIndex = useFileStore((s) => s.previewFileIndex);
  const setPreviewFileIndex = useFileStore((s) => s.setPreviewFileIndex);
  const addFile = useFileStore((s) => s.addFile);
  const removeFile = useFileStore((s) => s.removeFile);
  /** Which tool route this editor is mounted on (`edit-pdf`, `annotate`, …). */
  const activeToolId = useFileStore((s) => s.activeTool);

  const activeIndex = files.length > 0 ? Math.min(previewFileIndex, files.length - 1) : 0;
  const activeFile = files[activeIndex] ?? null;
  /** Two files called `report.pdf` are not the same document (E19). */
  const workKey = documentKey(activeFile);
  /**
   * Route id this editor is mounted on. The same component serves `edit-pdf`,
   * `annotate`, `add-stamps` and `redact`, and a quick-mode chip has to know
   * which one the user is standing in to decide whether to move them.
   */
  const routeToolId =
    typeof activeToolId === 'string' && activeToolId.length > 0 ? activeToolId : toolIdFromLocation();

  const [work, setWork] = useState<DocWork | null>(null);

  useEffect(() => {
    if (!activeFile) {
      setWork(null);
      return;
    }
    const stored = docWork.get(documentKey(activeFile));
    setWork(stored ?? createWork());
    // Switching tabs must not silently drop work, so say what was kept.
    if (stored && isUnsaved(stored)) {
      setNotice({
        tone: 'info',
        text: `Unsaved annotations for ${activeFile.name} are still here — ${stored.history.present.length} mark(s), kept in this tab only.`,
      });
    } else {
      setNotice(null);
    }
  }, [activeFile]);

  const updateWork = useCallback(
    (change: (current: DocWork) => DocWork) => {
      setWork((current) => {
        if (!current || !activeFile) return current;
        const next = change(current);
        docWork.set(documentKey(activeFile), next);
        return next;
      });
    },
    [activeFile],
  );

  /* ── session ─────────────────────────────────────────────────────── */

  const [session, setSession] = useState<PdfSession | null>(null);
  const [phase, setPhase] = useState<Phase>(files.length > 0 ? 'loading' : 'empty');
  const [errorMessage, setErrorMessage] = useState('');
  const [password, setPassword] = useState('');
  const [passwordTry, setPasswordTry] = useState(0);
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [renderError, setRenderError] = useState('');
  const [pageInfo, setPageInfo] = useState<{ width: number; height: number; rotation: Rotation } | null>(null);
  const [textItems, setTextItems] = useState<ExtractedTextItem[]>([]);
  /** Read at open time so typing a password does not re-open on each key. */
  const passwordRef = useRef(password);
  passwordRef.current = password;

  const numPages = session?.numPages ?? 0;
  const page = clampPageIndex(work?.page ?? 0, numPages);
  const annotations = work?.history.present ?? [];

  useEffect(() => {
    if (!activeFile) {
      setPhase('empty');
      setSession(null);
      setSourceBytes(null);
      return;
    }
    let disposed = false;
    let owned: PdfSession | null = null;
    setPhase('loading');
    setErrorMessage('');
    setSession(null);
    setPageInfo(null);
    setTextItems([]);
    (async () => {
      try {
        const bytes = new Uint8Array(await activeFile.arrayBuffer());
        const opened = await openRender(bytes, { password: passwordRef.current || undefined });
        if (disposed) {
          void opened.destroy();
          return;
        }
        owned = opened;
        setSourceBytes(bytes);
        setSession(opened);
        setPhase('ready');
      } catch (error) {
        if (disposed) return;
        if (error instanceof PasswordRequiredError) {
          setPhase('locked');
        } else {
          setPhase('error');
          setErrorMessage(
            error instanceof Error
              ? error.message
              : 'This PDF could not be opened for annotation. Try Repair PDF, then reload it.',
          );
        }
      }
    })();
    // One session per document: tearing it down here is what stops the leak —
    // on unmount, on tab change, and when `passwordTry` re-runs the open.
    return () => {
      disposed = true;
      void owned?.destroy();
    };
  }, [activeFile, passwordTry]);

  /* ── zoom ────────────────────────────────────────────────────────── */

  const paneRef = useRef<HTMLDivElement>(null);
  const pageHostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState<'fit' | 'manual'>('fit');

  useEffect(() => {
    const element = paneRef.current;
    if (!element || phase !== 'ready') return;
    const measure = () => setPaneWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [phase]);

  useEffect(() => {
    if (!pageInfo || paneWidth <= 0) return;
    if (fitMode === 'fit') setZoom(fitWidthZoom(paneWidth, pageInfo.width));
  }, [fitMode, pageInfo, paneWidth]);

  const geom: PageGeom | null = useMemo(() => {
    if (!pageInfo) return null;
    return {
      zoom,
      cssWidth: pageInfo.width * zoom,
      cssHeight: pageInfo.height * zoom,
      rotation: pageInfo.rotation,
    };
  }, [pageInfo, zoom]);

  /* ── page metrics, render, text ──────────────────────────────────── */

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    (async () => {
      try {
        const pageProxy = await session.page(page + 1);
        const viewport = pageProxy.getViewport({ scale: 1 });
        const info = {
          width: viewport.width,
          height: viewport.height,
          rotation: normaliseRotation(pageProxy.rotate),
        };
        pageProxy.cleanup();
        if (!disposed) setPageInfo(info);
      } catch {
        if (!disposed) setPageInfo(null);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [session, page]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    setTextItems([]);
    session
      .textItems(page + 1)
      .then((items) => {
        if (!disposed) setTextItems(items);
      })
      .catch(() => {
        if (!disposed) setTextItems([]);
      });
    return () => {
      disposed = true;
    };
  }, [session, page]);

  useEffect(() => {
    if (!session || !pageInfo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = zoom * dpr;
    let cancelled = false;
    let proxy: Awaited<ReturnType<PdfSession['page']>> | null = null;
    let task: { promise: Promise<unknown>; cancel(): void } | null = null;
    setRenderError('');
    (async () => {
      try {
        proxy = await session.page(page + 1);
        const viewport = proxy.getViewport({ scale });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setRenderError('This tab cannot paint a page because its 2D canvas is unavailable.');
          return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        task = proxy.render({ canvasContext: ctx, viewport });
        await task.promise;
      } catch (error) {
        if (cancelled) return;
        setRenderError(
          error instanceof Error && /cancel/i.test(error.message)
            ? ''
            : 'This page could not be drawn. The rest of the document still annotates and exports.',
        );
      } finally {
        try {
          proxy?.cleanup();
        } catch {
          /* the session was already destroyed */
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* the render already settled */
      }
    };
  }, [session, page, zoom, pageInfo]);

  /* ── tools + styles ──────────────────────────────────────────────── */

  const [tool, setTool] = useState<EditorToolId>('select');
  /** Palette section expand/collapse — controlled so a chip can open what it armed. */
  const [toolsOpen, setToolsOpen] = useState(true);
  /**
   * Inspector group the last arm or quick mode landed in. The options card is
   * titled with it, so "Words" above a font slider tells the user which half of
   * the palette they are looking at.
   */
  const [focusedGroup, setFocusedGroup] = useState<string>('markup');
  const [styles, setStyles] = useState<Record<EditorToolId, ToolStyle>>(() =>
    TOOLS.reduce(
      (acc, meta) => {
        acc[meta.id] = defaultStyleFor(meta.id);
        return acc;
      },
      {} as Record<EditorToolId, ToolStyle>,
    ),
  );
  const style = styles[tool] ?? defaultStyleFor(tool);

  /**
   * Change the pen, and whatever the pen is standing on.
   *
   * With marks picked, a colour or a width is a statement about *them*, so the
   * same edit lands on every selected mark as one undo step — and the pen
   * remembers it too, because the next mark should match the last one. With
   * nothing picked this is exactly what it always was: the pen's appearance.
   *
   * Fill and stamp face stay pen-only. "Fill these four marks" is a question
   * about shapes the group did not agree to be asked, and the panel says so.
   */
  const patchStyle = useCallback(
    (patch: Partial<ToolStyle>) => {
      setStyles((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }));
      const ids = work?.selection ?? [];
      if (ids.length === 0) return;
      const shared: SharedStyle = {
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        ...(patch.opacity !== undefined ? { opacity: patch.opacity } : {}),
        ...(patch.strokeWidth !== undefined ? { strokeWidth: patch.strokeWidth } : {}),
        ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
      };
      const changed = Object.keys(shared) as (keyof SharedStyle)[];
      if (changed.length === 0) return;
      updateWork((current) => ({
        ...current,
        history: pushHistory(current.history, styleMarks(current.history.present, current.selection, shared)),
      }));
      setStatus(sharedStyleNotice(changed, ids.length));
    },
    [tool, updateWork, work?.selection],
  );

  /**
   * The one way a palette entry becomes the armed tool — from a click, a key, or
   * a quick-mode chip — so all three leave the same state behind: the mark being
   * dragged is dropped, and the inspector section that owns the tool is open.
   */
  const armTool = useCallback((next: EditorToolId) => {
    setTool(next);
    setFocusedGroup(GROUP_FOR_TOOL[next] ?? 'markup');
    setToolsOpen(true);
    setGesture(null);
    setStatus(null);
    // The arrow is how you get at the text of a box you are still writing, so it
    // must not close the editor the way arming another pen does.
    if (next !== 'select') setEditingId(null);
  }, []);

  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * Quiet status for the `aria-live` region: steps back through
   * `Esc`, undo and redo. Kept apart from `notice` because a notice is a problem
   * with a colour and this is a sentence with no styling change.
   */
  const [status, setStatus] = useState<string | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [raster, setRaster] = useState<PlacedRaster | null>(null);
  const [rasterTool, setRasterTool] = useState<EditorToolId | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ drag: CssRect; kind: 'page' | 'uri'; page: number; uri: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const moveRef = useRef<MoveState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const rotateRef = useRef<RotateState | null>(null);

  const imageInput = useRef<HTMLInputElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const rasterUrl = useRef<string | null>(null);

  const setRasterSafely = useCallback((next: PlacedRaster | null) => {
    const previous = rasterUrl.current;
    if (previous && previous !== next?.url && previous.startsWith('blob:')) {
      URL.revokeObjectURL(previous);
    }
    rasterUrl.current = next?.url ?? null;
    setRaster(next);
  }, []);

  const clearRaster = useCallback(() => {
    setRasterSafely(null);
    setRasterTool(null);
  }, [setRasterSafely]);

  /** A chosen picture/signature is only armed for the tool that asked for it. */
  const rasterReady = raster !== null && rasterTool === tool;

  const dirty = isUnsaved(work, annotations);

  /* ── what the editor can say about this document (E6, E8, E9, E13) ── */

  /**
   * Distinct page sizes seen per document. Mixed sizes (E8) can only be noticed
   * by visiting the pages, so the set is accumulated rather than read from the
   * catalogue, and it is keyed by document so a second tab cannot inherit it.
   */
  const sizeKeys = useRef(new Map<string, Set<string>>());
  const [distinctSizes, setDistinctSizes] = useState(1);

  useEffect(() => {
    if (!pageInfo || !workKey) return;
    const seen = sizeKeys.current.get(workKey) ?? new Set<string>();
    sizeKeys.current.set(workKey, seen);
    const before = seen.size;
    seen.add(`${Math.round(pageInfo.width)}×${Math.round(pageInfo.height)}`);
    if (seen.size !== before) setDistinctSizes(seen.size);
  }, [pageInfo, workKey]);

  const contextNotes = useMemo(
    () =>
      pageInfo
        ? pageContextNotes({
            index: page,
            total: numPages,
            rotation: pageInfo.rotation,
            widthPt: pageInfo.width,
            heightPt: pageInfo.height,
            distinctSizes,
          })
        : [],
    [distinctSizes, numPages, page, pageInfo],
  );

  /** Marks that would be written but change nothing — E13, before the export. */
  const uselessMarks = useMemo(() => emptyMarks(annotations), [annotations]);

  const dropUselessMarks = useCallback(() => {
    if (uselessMarks.length === 0) return;
    const removed = uselessMarks.length;
    updateWork((current) => {
      const kept = dropEmptyMarks(current.history.present);
      return {
        ...current,
        history: pushHistory(current.history, kept),
        selection: pruneSelection(current.selection, kept, current.page),
      };
    });
    setNotice({
      tone: 'info',
      text: `Removed ${removed} mark${removed === 1 ? '' : 's'} that would have been written without changing anything.`,
    });
  }, [updateWork, uselessMarks]);

  /* ── annotation edits ────────────────────────────────────────────── */

  /**
   * The single place a new mark enters the document, and therefore the single
   * place the step-aside rule is applied. Keying it to a real create is the
   * whole fix for Bug 1: a gesture that made nothing (a highlight over no words,
   * a two-pixel rectangle) never reaches this function, so it cannot take the
   * tool out of the user's hand.
   */
  const commit = useCallback(
    (annotation: EditorAnnotation, options: { edit?: boolean } = {}) => {
      updateWork((current) => ({
        ...current,
        history: pushHistory(current.history, [...current.history.present, annotation]),
        selection: selectOnly(annotation.id),
      }));
      if (options.edit) setEditingId(annotation.id);
      setNotice(null);
      // Back to the cursor, with the mark the user just made still the selection,
      // so drag handles, arrow-nudge, Cmd/Ctrl-D and Delete work without a click.
      armTool(toolAfterGesture(annotation.tool, true));
      // …but the option panel stays on the pen that made the mark: pdf.js mirrors
      // the selection into the toolbar, and "Select options" under a text-box
      // slider is a panel that changed the subject on its own.
      setFocusedGroup(GROUP_FOR_TOOL[annotation.tool] ?? 'markup');
      setStatus(
        options.edit
          ? `Placed a ${annotation.kind === 'Text' ? 'note' : 'text box'} — keep typing. Select is armed.`
          : `Placed ${describeAnnotation(annotation)}. Select is armed.`,
      );
    },
    [armTool, updateWork],
  );

  /** Delete the whole selection as one edit, so one undo brings it all back. */
  const removeSelected = useCallback(() => {
    const ids = work?.selection ?? [];
    if (ids.length === 0) return;
    updateWork((current) => ({
      ...current,
      history: pushHistory(current.history, removeMarks(current.history.present, current.selection)),
      selection: [],
    }));
    setEditingId((current) => (current !== null && ids.includes(current) ? null : current));
  }, [updateWork, work?.selection]);

  /**
   * Turn the selection about its own middle: `R` and `Shift`+`R`.
   *
   * A group swings around the centre of the group, which is what a rotate key is
   * for on several marks at once; a single mark spins in place because its centre
   * is the pivot. Marks that cannot carry an angle are refused by name.
   */
  const turnSelected = useCallback(
    (delta: number) => {
      const ids = work?.selection ?? [];
      if (ids.length === 0 || delta === 0) return false;
      const marks = selectedMarks(work?.history.present ?? [], ids);
      const refused = marks.filter((mark) => !canRotate(mark));
      if (refused.length === marks.length) {
        setStatus(rotationRefusedNotice(TOOL_BY_ID[refused[0].tool]?.label ?? 'This'));
        return false;
      }
      updateWork((current) => ({
        ...current,
        history: pushHistory(current.history, turnMarks(current.history.present, current.selection, delta)),
      }));
      const angle = normaliseAngle(annotationRotation(marks[0]) + delta);
      setStatus(rotationNotice(ids.length, angle, false));
      if (refused.length > 0) {
        setStatus(
          `${rotationNotice(ids.length - refused.length, angle, false)} ${rotationRefusedNotice(
            TOOL_BY_ID[refused[0].tool]?.label ?? 'Those',
          )}`,
        );
      }
      return true;
    },
    [updateWork, work?.history.present, work?.selection],
  );

  /** Set the angle of the whole selection from the inspector's number field. */
  const rotateSelectedTo = useCallback(
    (degrees: number) => {
      const ids = work?.selection ?? [];
      if (ids.length === 0) return;
      const marks = selectedMarks(work?.history.present ?? [], ids);
      const turned = marks.filter(canRotate).map((mark) => annotationRotation(mark));
      // One field, one angle: the set is turned *by* the difference so marks that
      // were already at different angles keep the difference between them rather
      // than snapping onto top of each other.
      const delta =
        turned.length > 1
          ? normaliseAngle(degrees) - turned[turned.length - 1]
          : undefined;
      updateWork((current) => ({
        ...current,
        history: pushHistory(
          current.history,
          delta === undefined
            ? setMarksRotation(current.history.present, current.selection, degrees)
            : turnMarks(current.history.present, current.selection, delta),
        ),
      }));
      setStatus(rotationNotice(ids.length, normaliseAngle(degrees), false));
    },
    [updateWork, work?.history.present, work?.selection],
  );

  const undo = useCallback(() => {
    const stepped = applyWorkStep(work, 'undo');
    if (stepped.work && stepped.work !== work) updateWork(() => stepped.work as DocWork);
    setEditingId(null);
    if (stepped.notice) setStatus(stepped.notice);
  }, [updateWork, work]);

  const redo = useCallback(() => {
    const stepped = applyWorkStep(work, 'redo');
    if (stepped.work && stepped.work !== work) updateWork(() => stepped.work as DocWork);
    setEditingId(null);
    if (stepped.notice) setStatus(stepped.notice);
  }, [updateWork, work]);

  const draftText = useCallback(
    (id: string, text: string) => {
      updateWork((current) => ({
        ...current,
        history: pushHistory(
          current.history,
          current.history.present.map((a) => (a.id === id ? withText(a, text) : a)),
        ),
      }));
    },
    [updateWork],
  );

  /* ── gestures ────────────────────────────────────────────────────── */

  const pointFrom = useCallback((event: { clientX: number; clientY: number }): Point => {
    const box = pageHostRef.current?.getBoundingClientRect();
    if (!box) return { x: event.clientX, y: event.clientY };
    // Clamping to the page box keeps a drag that leaves the page from pushing a
    // mark into negative user space, where no viewer would show it.
    return {
      x: Math.min(Math.max(event.clientX - box.left, 0), box.width),
      y: Math.min(Math.max(event.clientY - box.top, 0), box.height),
    };
  }, []);

  const linesUnder = useCallback(
    (drag: CssRect) => {
      if (!geom) return [];
      return snapTextLines(textItems, screenToViewportBox(drag, geom));
    },
    [geom, textItems],
  );

  /** The in-progress mark, built by the same pure factory as a committed one. */
  const draft = useMemo<EditorAnnotation | null>(() => {
    if (!geom || !work) return null;
    if (gesture?.mode === 'drag') {
      const drag = normaliseDrag(gesture.from, gesture.to);
      return buildAnnotation({
        tool,
        page,
        style,
        geom,
        drag,
        ...(MARKUP_TOOLS.includes(tool) ? { lines: linesUnder(drag) } : {}),
        ...(rasterReady && raster ? { raster } : {}),
      });
    }
    if (gesture?.mode === 'path' || gesture?.mode === 'vertices') {
      return buildAnnotation({ tool, page, style, geom, points: gesture.points });
    }
    return null;
  }, [gesture, geom, linesUnder, page, raster, rasterReady, style, tool, work]);

  const hint = useCallback((text: string, tone: Notice['tone'] = 'info') => {
    setNotice({ tone, text });
  }, []);

  const finishDrag = useCallback(
    (drag: CssRect, additive = false) => {
      if (!geom || !work) return;

      if (tool === 'link') {
        setLinkDraft({ drag, kind: 'page', page: Math.min(page + 1, Math.max(numPages, 1)), uri: '' });
        return;
      }

      let lines: ReturnType<typeof linesUnder> = [];
      if (MARKUP_TOOLS.includes(tool)) {
        // A click on a mark that is already there is the user pointing at that
        // mark, not asking for a second one on top of it. Checked before the
        // text snap, because the words under an existing highlight always snap.
        if (!isMeaningfulDrag(drag)) {
          const tapped = markAtPoint(
            work.history.present,
            page,
            screenToPdfPoint({ x: drag.x + drag.width / 2, y: drag.y + drag.height / 2 }, geom),
          );
          if (tapped) {
            // The tool stays in the hand (Highlight is sticky by ruling); only the
            // selection moves, which is what makes Delete and arrow-nudge work on
            // the mark that was clicked. Shift takes it into the set instead.
            updateWork((current) => ({
              ...current,
              selection: additive
                ? toggleSelected(current.selection, tapped.id)
                : selectOnly(tapped.id),
            }));
            setStatus(`Selected ${describeAnnotation(tapped)} instead of drawing a second mark.`);
            return;
          }
        }
        lines = linesUnder(drag);
        if (lines.length === 0) {
          hint(
            pageHasText(textItems)
              ? 'That drag did not cross any selectable text on this page — drag across the words themselves, or use Rectangle to mark the area.'
              : `Page ${page + 1} has no selectable text, so there is nothing to highlight — it is a scan. Run OCR (Convert → Searchable PDF) first, or use Rectangle to mark the area.`,
            'warn',
          );
          return;
        }
      }

      const built = buildAnnotation({
        tool,
        page,
        style,
        geom,
        drag,
        ...(MARKUP_TOOLS.includes(tool) ? { lines } : {}),
        ...(rasterReady && raster ? { raster } : {}),
      });
      if (!built) {
        hint('Draw a bigger shape first — a click with no size is not a rectangle.', 'warn');
        return;
      }
      commit(built, { edit: tool === 'freetext' || tool === 'note' });
      if (rasterReady) {
        clearRaster();
      }
    },
    [armTool, clearRaster, commit, geom, hint, linesUnder, numPages, page, raster, rasterReady, style, textItems, tool, updateWork, work],
  );

  const finishPath = useCallback(
    (points: Point[]) => {
      if (!geom || !work) return;
      const built = buildAnnotation({ tool, page, style, geom, points });
      if (!built) {
        hint('The pen needs a stroke — drag across the page rather than tapping it.', 'warn');
        return;
      }
      commit(built);
    },
    [commit, geom, hint, page, style, tool, work],
  );

  const finishVertices = useCallback(() => {
    const current = gesture;
    if (!current || current.mode !== 'vertices' || !geom || !work) return;
    const built = buildAnnotation({ tool, page, style, geom, points: current.points });
    if (!built) {
      hint(
        tool === 'polygon'
          ? 'A closed shape needs at least three corners — click the page to add them.'
          : 'A freeform line needs at least two points — click the page to add them.',
        'warn',
      );
      return;
    }
    commit(built);
    setGesture(null);
  }, [commit, gesture, geom, hint, page, style, tool, work]);

  const onSurfacePointerDown = useCallback(
    (point: Point, additive = false) => {
      if (!activeFile || phase !== 'ready') return;
      setEditingId(null);
      if (tool === 'select') {
        // Paper, not a mark: a press starts a marquee, and the marquee decides on
        // release whether this was a click (clear) or a band (select). Clearing on
        // press would throw the selection away while the user is still drawing.
        setGesture({ mode: 'drag', from: point, to: point, additive });
        return;
      }
      if ((tool === 'image' || tool === 'signature') && !rasterReady) {
        if (tool === 'image') imageInput.current?.click();
        else setSignOpen(true);
        return;
      }
      if (tool === 'ink') {
        setGesture({ mode: 'path', points: [point] });
        return;
      }
      if (tool === 'polygon' || tool === 'polyline') {
        setGesture((current) =>
          current && current.mode === 'vertices'
            ? { ...current, points: [...current.points, point], cursor: point }
            : { mode: 'vertices', points: [point], cursor: point },
        );
        return;
      }
      setGesture({ mode: 'drag', from: point, to: point, additive });
    },
    [activeFile, phase, rasterReady, tool],
  );

  /**
   * Grabbing a mark starts a drag of the **whole selection**, not of the mark
   * under the pointer: a group is moved as one object, which is the only reason
   * to have selected several.
   *
   * Shift+click is the membership edit — it takes a mark in or back out and does
   * not start a drag, because the thing being dragged after a toggle is the set
   * the user has just changed their mind about, and moving it by two pixels while
   * adding it is how a selection ends up somewhere the user did not put it.
   */
  const onAnnotationPointerDown = useCallback(
    (id: string, point: Point, additive = false) => {
      if (!geom || !work) return;
      const target = work.history.present.find((a) => a.id === id);
      if (!target) return;
      if (additive) {
        updateWork((current) => ({ ...current, selection: toggleSelected(current.selection, id) }));
        const rest = toggleSelected(work.selection, id);
        setStatus(selectionNotice(rest.length, page, rest.includes(id) ? [target] : []));
        return;
      }
      const ids = work.selection.includes(id) ? work.selection : selectOnly(id);
      if (!work.selection.includes(id)) updateWork((current) => ({ ...current, selection: ids }));
      moveRef.current = {
        ids,
        origin: screenToPdfPoint(point, geom),
        beforeList: work.history.present,
      };
    },
    [geom, page, updateWork, work],
  );

  /**
   * A corner handle is grabbed whatever tool is armed: the mark the user just
   * placed is the selection, so resizing has to be reachable without first
   * clicking through the palette.
   */
  const onHandlePointerDown = useCallback(
    (id: string, handle: ResizeHandle, point: Point) => {
      if (!geom || !work) return;
      const target = work.history.present.find((a) => a.id === id);
      if (!target) return;
      updateWork((current) => ({ ...current, selection: selectOnly(id) }));
      resizeRef.current = {
        id,
        handle,
        ids: [id],
        origin: screenToPdfPoint(point, geom),
        beforeList: work.history.present,
      };
    },
    [geom, updateWork, work],
  );

  /**
   * Grabbing the rotate handle. The drag is measured as an arc around the
   * selection's screen centre, so the mark follows the pointer instead of
   * jumping to an angle read off the page.
   */
  const onRotatePointerDown = useCallback(
    (point: Point) => {
      if (!geom || !work) return;
      const marks = selectedMarks(work.history.present, work.selection);
      if (marks.length === 0) return;
      if (!marks.some(canRotate)) {
        setStatus(rotationRefusedNotice(TOOL_BY_ID[marks[0].tool]?.label ?? 'This'));
        return;
      }
      const box = selectionScreenBounds(marks, geom);
      if (!box) return;
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      rotateRef.current = {
        ids: [...work.selection],
        centre,
        startAngle: screenAngle(centre, point),
        startRotation: annotationRotation(marks[marks.length - 1]),
        beforeList: work.history.present,
      };
    },
    [geom, work],
  );

  const onAnnotationDoubleClick = useCallback(
    (id: string) => {
      const target = annotations.find((a) => a.id === id);
      if (!target) return;
      if (EDITABLE_TEXT_TOOLS.includes(target.tool)) {
        setTool('select');
        setEditingId(id);
      }
    },
    [annotations],
  );

  /** Live pointer work: read from `live` so the mount-once listeners stay fresh. */
  const live = useRef({
    onPointerMove: (_event: PointerEvent) => {},
    onPointerUp: (_event: PointerEvent) => {},
  });

  live.current.onPointerMove = (event: PointerEvent) => {
    const move = moveRef.current;
    if (move && geom) {
      const now = screenToPdfPoint(pointFrom(event), geom);
      const dx = now.x - move.origin.x;
      const dy = now.y - move.origin.y;
      updateWork((current) => ({
        ...current,
        history: liveHistory(
          current.history,
          // Every mark moves from where it was when the drag began, so a long
          // drag cannot drift the set apart the way per-frame deltas would.
          moveMarks(move.beforeList, move.ids, dx, dy),
        ),
      }));
      return;
    }
    const resize = resizeRef.current;
    if (resize && geom) {
      const now = screenToPdfPoint(pointFrom(event), geom);
      const before = resize.beforeList.find((a) => a.id === resize.id);
      if (!before) return;
      // The pull is along the mark's own axes, which a turned mark's are not.
      const local = unrotateDelta(now.x - resize.origin.x, now.y - resize.origin.y, annotationRotation(before));
      updateWork((current) => ({
        ...current,
        history: liveHistory(
          current.history,
          current.history.present.map((a) =>
            a.id === resize.id ? resizeAnnotation(before, resize.handle, local.x, local.y) : a,
          ),
        ),
      }));
      return;
    }
    const rotate = rotateRef.current;
    if (rotate && geom) {
      const point = pointFrom(event);
      const angle = rotationForDrag(
        rotate.startAngle + (screenAngle(rotate.centre, point) - rotate.startAngle),
        !event.shiftKey,
      );
      const delta = angle - rotate.startRotation;
      updateWork((current) => ({
        ...current,
        history: liveHistory(current.history, turnMarks(rotate.beforeList, rotate.ids, delta)),
      }));
      return;
    }
    const point = pointFrom(event);
    setGesture((current) => {
      if (!current) return current;
      if (current.mode === 'drag') return { ...current, to: point };
      if (current.mode === 'path') {
        const last = current.points[current.points.length - 1];
        if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return current;
        return { ...current, points: [...current.points, point] };
      }
      return { ...current, cursor: point };
    });
  };

  live.current.onPointerUp = (event: PointerEvent) => {
    const move = moveRef.current;
    if (move) {
      moveRef.current = null;
      const from = move.origin;
      updateWork((current) => ({ ...current, history: settleHistory(current.history, move.beforeList) }));
      if (geom) {
        const now = screenToPdfPoint(pointFrom(event), geom);
        const dx = now.x - from.x;
        const dy = now.y - from.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) setStatus(moveSelectionNotice(move.ids.length, dx, dy));
      }
      return;
    }
    const resize = resizeRef.current;
    if (resize) {
      resizeRef.current = null;
      updateWork((current) => ({ ...current, history: settleHistory(current.history, resize.beforeList) }));
      return;
    }
    const rotate = rotateRef.current;
    if (rotate) {
      rotateRef.current = null;
      const point = pointFrom(event);
      const angle = rotationForDrag(
        rotate.startAngle + (screenAngle(rotate.centre, point) - rotate.startAngle),
        !event.shiftKey,
      );
      updateWork((current) => ({ ...current, history: settleHistory(current.history, rotate.beforeList) }));
      setStatus(rotationNotice(rotate.ids.length, angle, !event.shiftKey));
      return;
    }
    const current = gesture;
    if (!current) return;
    if (current.mode === 'drag') {
      const box = normaliseDrag(current.from, pointFrom(event));
      // With Select armed, a band drawn on empty paper is a marquee; a click is
      // the release of the selection.
      if (tool === 'select') {
        setGesture(null);
        if (!isMeaningfulDrag(box)) {
          updateWork((next) => ({ ...next, selection: [] }));
          setStatus(selectionNotice(0, page));
          return;
        }
        const ids = marksInMarquee(annotations, page, box, geom ?? { zoom: 1, cssWidth: 0, cssHeight: 0, rotation: 0 });
        const merged = current.additive ? addToSelection(work?.selection ?? [], ids) : ids;
        updateWork((next) => ({ ...next, selection: merged }));
        setStatus(marqueeNotice(ids.length, page));
        return;
      }
      finishDrag(box, Boolean(current.additive));
      setGesture(null);
      return;
    }
    if (current.mode === 'path') {
      finishPath(current.points);
      setGesture(null);
    }
  };

  useEffect(() => {
    const onMove = (event: PointerEvent) => live.current.onPointerMove(event);
    const onUp = (event: PointerEvent) => live.current.onPointerUp(event);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  /* ── keyboard ────────────────────────────────────────────────────── */

  /**
   * Turn the page.
   *
   * The selection does not come with: marks are geometry in one page's user
   * space, so taking page 2's four selected shapes to page 5 would either move
   * them sideways into another page's coordinates or silently drop three of them
   * at the border. The editor refuses, says so, and leaves the set where it is
   * drawn.
   */
  const goToPage = useCallback(
    (next: number) => {
      const total = numPages || 1;
      const target = Math.min(Math.max(next, 0), total - 1);
      let leftBehind: string | null = null;
      updateWork((current) => {
        const moved = transferSelectionToPage(current.selection, current.page, target);
        leftBehind = moved.notice;
        return { ...current, page: target, selection: moved.selection };
      });
      setEditingId(null);
      if (leftBehind) setStatus(leftBehind);
    },
    [numPages, updateWork],
  );

  /**
   * Move the selection by an arrow step. The step is a screen distance (1 px, or
   * 10 px with Shift) and is mapped through the page geometry, so it looks the
   * same size at every zoom and on a rotated page — and it moves every mark the
   * selection names, because the set is what the arrows act on.
   */
  const nudgeSelected = useCallback(
    (step: { dx: number; dy: number }) => {
      if (!geom || !work || work.selection.length === 0) return false;
      const ids = work.selection;
      const before = selectedMarks(work.history.present, ids);
      if (before.length === 0) return false;
      const origin = screenToPdfPoint({ x: 0, y: 0 }, geom);
      const moved = screenToPdfPoint({ x: step.dx, y: step.dy }, geom);
      const dx = moved.x - origin.x;
      const dy = moved.y - origin.y;
      updateWork((current) => ({
        ...current,
        history: pushHistory(current.history, moveMarks(current.history.present, ids, dx, dy)),
      }));
      const across = step.dx < 0 ? 'left' : step.dx > 0 ? 'right' : step.dy < 0 ? 'up' : 'down';
      setStatus(
        `${before.length === 1 ? `Nudged ${TOOL_BY_ID[before[0].tool]?.label ?? 'mark'}` : `Nudged ${before.length} marks`} ${Math.abs(step.dx) + Math.abs(step.dy)} px ${across}.`,
      );
      return true;
    },
    [geom, updateWork, work],
  );

  /** `Cmd/Ctrl-A`: the current page's marks, and no one else's. */
  const selectAllOnPage = useCallback(() => {
    if (!work) return false;
    const ids = pageSelection(work.history.present, page);
    updateWork((current) => ({ ...current, selection: ids }));
    setStatus(selectAllNotice(ids.length, page));
    return true;
  }, [page, updateWork, work]);

  /** `Cmd/Ctrl-D`: a copy of the selection, offset, and immediately the selection. */
  const duplicateSelected = useCallback(() => {
    if (!work || work.selection.length === 0) return false;
    const before = selectedMarks(work.history.present, work.selection);
    if (before.length === 0) return false;
    updateWork((current) => {
      const { marks, ids } = duplicateMarks(current.history.present, current.selection);
      return {
        ...current,
        history: pushHistory(current.history, [...current.history.present, ...marks]),
        selection: ids,
      };
    });
    setStatus(
      before.length === 1
        ? `Duplicated ${TOOL_BY_ID[before[0].tool]?.label ?? 'mark'} — the copy is selected.`
        : `Duplicated ${before.length} marks in one step — the copies are selected.`,
    );
    return true;
  }, [updateWork, work]);

  /**
   * `Alt` + arrow: the keyboard equivalent of dragging a resize handle. A handle
   * is 10 px on screen with a 22 px grab, but it is still a pointer-only target,
   * and the brief asks for a key route to every pointer action.
   *
   * With a group selected, every mark takes the same edge — the alternative is a
   * key that silently does nothing once the user has selected more than one
   * thing. Each pull runs along the mark's own axes, so a turned mark grows along
   * its edges rather than along the page's.
   */
  const resizeSelected = useCallback(
    (key: string, shift: boolean) => {
      if (!geom || !work || work.selection.length === 0) return false;
      const before = selectedMarks(work.history.present, work.selection);
      if (before.length === 0) return false;
      const step = nudgeStep(key, shift);
      if (!step) return false;
      const origin = screenToPdfPoint({ x: 0, y: 0 }, geom);
      const moved = screenToPdfPoint({ x: step.dx, y: step.dy }, geom);
      const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
      const dx = horizontal ? moved.x - origin.x : 0;
      const dy = horizontal ? 0 : moved.y - origin.y;
      const handle: ResizeHandle =
        key === 'ArrowLeft' ? 'sw' : key === 'ArrowRight' ? 'se' : key === 'ArrowUp' ? 'nw' : 'sw';
      updateWork((current) => ({
        ...current,
        history: pushHistory(
          current.history,
          current.history.present.map((a) => {
            if (!current.selection.includes(a.id)) return a;
            const local = unrotateDelta(dx, dy, annotationRotation(a));
            return resizeAnnotation(a, handle, local.x, local.y);
          }),
        ),
      }));
      setStatus(
        before.length === 1
          ? `Resized ${TOOL_BY_ID[before[0].tool]?.label ?? 'mark'} from the ${key.replace('Arrow', '').toLowerCase()} edge.`
          : `Resized ${before.length} marks from the ${key.replace('Arrow', '').toLowerCase()} edge.`,
      );
      return true;
    },
    [geom, updateWork, work],
  );

  /**
   * One `Esc`, one level. The ladder is `nextEscapeLevel`, so the order is a
   * documented rule rather than the order of a switch statement.
   */
  const stepBack = useCallback(() => {
    const ids = work?.selection ?? [];
    const level = nextEscapeLevel({
      // A marquee in progress is a half-drawn selection, so it is dismissed
      // first; a marquee that has not been dragged yet is just a pressed cursor.
      editing: editingId !== null || linkDraft !== null || signOpen || gesture !== null,
      selected: ids.length > 0,
      armed: tool !== 'select',
    });
    switch (level) {
      case 'dismiss':
        setGesture(null);
        setEditingId(null);
        setLinkDraft(null);
        setSignOpen(false);
        break;
      case 'selection':
        updateWork((current) => ({ ...current, selection: [] }));
        break;
      case 'disarm':
        armTool('select');
        break;
      default:
        break;
    }
    if (level !== 'none') setStatus(escapeLevelNotice(level, level === 'selection' ? ids.length : undefined));
    return level;
  }, [armTool, editingId, gesture, linkDraft, signOpen, tool, updateWork, work?.selection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const modifiers = {
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      };
      const history = historyCommandForKey(event.key, modifiers);
      if (history) {
        event.preventDefault();
        if (history === 'undo') undo();
        else redo();
        return;
      }
      // `Cmd/Ctrl-A` is the page's, not the document's: a mark belongs to one
      // page's user space, so a selection that crossed pages could not be nudged,
      // drawn or exported as one thing anyway.
      if (isSelectAllKey(event.key, modifiers)) {
        event.preventDefault();
        selectAllOnPage();
        return;
      }
      if (isDuplicateKey(event.key, modifiers)) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      // Only a one-mark selection can take typed text: a group has no single
      // object's body to write into, and inventing one would be the inspector
      // pretending to show something it does not hold.
      const picked = work ? selectedMarks(work.history.present, work.selection) : [];
      const selectedMark = picked.length === 1 ? picked[0] : null;
      // Type-to-edit: a selected text box or note takes the next character, the
      // way pdf.js hands focus to the box it just made. This has to be tested
      // before the single-key tool arms, or typing "p" would swap the pen.
      if (
        selectedMark &&
        EDITABLE_TEXT_TOOLS.includes(selectedMark.tool) &&
        isTypeToEditKey(event.key, modifiers)
      ) {
        event.preventDefault();
        armTool('select');
        setEditingId(selectedMark.id);
        const current = selectedMark.kind === 'Text' ? selectedMark.contents ?? '' : selectedMark.text ?? '';
        draftText(selectedMark.id, current + event.key);
        return;
      }
      // `R` turns the selection a quarter turn, `Shift+R` back. It sits after
      // type-to-edit on purpose: with a text box selected, `r` is a letter.
      const turn = rotationStepForKey(event.key, modifiers);
      if (turn !== null && (work?.selection.length ?? 0) > 0) {
        event.preventDefault();
        turnSelected(turn);
        return;
      }
      // Single-key tool arms (V H T P) — only bare keys, so Ctrl+P still prints.
      if (!event.ctrlKey && !event.metaKey && !event.altKey) {
        const armed = toolForKey(event.key);
        if (armed) {
          event.preventDefault();
          armTool(armed);
          return;
        }
      }
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'ArrowRight':
        case 'ArrowDown': {
          event.preventDefault();
          const step = nudgeStep(event.key, event.shiftKey);
          if (!step) break;
          // Alt takes the edge, plain arrows take the whole mark, and arrows
          // with nothing selected still turn the page.
          if (event.altKey && resizeSelected(event.key, event.shiftKey)) break;
          if (!event.altKey && nudgeSelected(step)) break;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') goToPage(page - 1);
          else goToPage(page + 1);
          break;
        }
        case 'Delete':
        case 'Backspace':
          if ((work?.selection.length ?? 0) > 0) {
            event.preventDefault();
            const count = work?.selection.length ?? 0;
            removeSelected();
            setStatus(deleteNotice(count));
          }
          break;
        case 'Escape':
          event.preventDefault();
          stepBack();
          break;
        case 'Enter':
          if (tool === 'polygon' || tool === 'polyline') {
            event.preventDefault();
            finishVertices();
          } else if (selectedMark && EDITABLE_TEXT_TOOLS.includes(selectedMark.tool)) {
            // Enter is the keyboard equivalent of double-clicking the mark.
            event.preventDefault();
            setEditingId(selectedMark.id);
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    annotations,
    armTool,
    duplicateSelected,
    draftText,
    finishVertices,
    goToPage,
    nudgeSelected,
    page,
    redo,
    removeSelected,
    resizeSelected,
    stepBack,
    tool,
    undo,
    turnSelected,
    selectAllOnPage,
    work?.selection,
    work?.history.present,
  ]);

  /* ── unsaved changes ─────────────────────────────────────────────── */

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  /* ── rasters ─────────────────────────────────────────────────────── */

  const chooseImageFile = useCallback(
    async (file: File) => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mime = sniffImageMime(bytes) ?? file.type;
        const decoded = await decodeImage(bytes, { mime, maxSide: 1800, background: '#ffffff' });
        const embeddable =
          mime === 'image/jpeg'
            ? bytes
            : (await encodeImageBytes(decoded.canvas, { format: 'jpeg', quality: 0.92, background: '#ffffff' })).bytes;
        const url = URL.createObjectURL(new Blob([bytes], { type: resolveImageMime(bytes, file.type, file.name) }));
        setRasterSafely({ bytes: embeddable, url, width: decoded.width, height: decoded.height });
        // A raster chosen while the Stamp tool is armed becomes a stamp image;
        // otherwise the Image tool takes it.
        const armed: EditorToolId = tool === 'stamp' || tool === 'signature' ? tool : 'image';
        setRasterTool(armed);
        setTool(armed);
        hint(`Click or drag on page ${page + 1} to place ${file.name}.`, 'info');
      } catch (error) {
        hint(
          error instanceof Error
            ? error.message
            : 'That image could not be decoded — choose a PNG or JPEG file.',
          'danger',
        );
      }
    },
    [hint, page, setRasterSafely, tool],
  );

  /* ── export ──────────────────────────────────────────────────────── */

  const exportPdf = useCallback(async () => {
    if (!activeFile || !work) return;
    const list = work.history.present;
    if (list.length === 0) {
      hint('Nothing to export yet — add at least one annotation to the page.', 'warn');
      return;
    }
    const store = useProcessStore.getState();
    setExporting(true);
    store.startProcessing('Annotated PDF', '_annotated.pdf');
    try {
      store.setPercent(8, 'Opening the document…');
      const bytes = sourceBytes ?? new Uint8Array(await activeFile.arrayBuffer());
      const copy = withFontkit(await clonePDF(await loadForExport(bytes, password)));
      const plan = exportPlan(list);

      let warning = '';
      if (plan.counts.redactions > 0) {
        store.setPercent(45, `Applying ${plan.counts.redactions} redaction${plan.counts.redactions === 1 ? '' : 's'}…`);
        const outcome = applyRedactions(copy, plan.redactions, { fill: styles.redact.color });
        store.appendLog(`Redactions deleted ${outcome.removed} text run(s).`);
        if (outcome.rasterised) {
          warning =
            'A redaction region overlapped page artwork, so the text under it was deleted and the area painted, but the image pixels remain. Convert that page to an image and rebuild the PDF to remove them as well.';
          store.appendLog(warning);
        }
      }

      /*
         A redaction turned to an angle that is not a right one covers a
         parallelogram, and the text engine cuts axis-aligned boxes: handing it the
         bounding box would delete whole words the mark never touched, and handing
         it the unrotated box would delete the wrong ones altogether. So those
         regions burn their page as pixels instead — which is why the notice says
         the page is a picture now.
      */
      let burnedNotice = '';
      if (plan.rasterisations.length > 0) {
        store.setPercent(55, `Burning ${plan.rasterisations.length} rotated redaction${plan.rasterisations.length === 1 ? '' : 's'}…`);
        const burned = await burnRotatedRedactions(copy, session, plan.rasterisations, styles.redact.color);
        const pages = burned.burned.join(', ');
        if (burned.burned.length > 0) {
          burnedNotice = `Page${burned.burned.length === 1 ? '' : 's'} ${pages} ${burned.burned.length === 1 ? 'was' : 'were'} rasterised to burn a rotated redaction: the text there is pixels now, not selectable words.`;
          store.appendLog(burnedNotice);
        }
        if (burned.failed.length > 0) {
          const failed = burned.failed.join(', ');
          burnedNotice = `${burnedNotice} ${failed === pages ? 'The rotated redaction could not be burned' : `Page${burned.failed.length === 1 ? '' : 's'} ${failed} could not be painted`}, so nothing was deleted there — draw the redaction unrotated, or run Convert → PDF to Image on that page.`.trim();
          store.appendLog(burnedNotice);
        }
      }

      store.setPercent(70, `Writing ${plan.counts.total} annotation${plan.counts.total === 1 ? '' : 's'}…`);
      addAnnotations(copy, plan.specs);
      store.setPercent(90, 'Saving…');
      const output = await savePDF(copy);
      const blob = new Blob([output], { type: 'application/pdf' });
      store.setOutput(blob, URL.createObjectURL(blob));
      const signature = workSignature(list);
      updateWork((current) => ({ ...current, exportedSignature: signature }));
      setNotice({
        tone: warning || burnedNotice ? 'warn' : 'success',
        text:
          [warning, burnedNotice].filter(Boolean).join(' ') ||
          `Exported ${plan.counts.total} annotation(s)${plan.counts.redactions ? `, including ${plan.counts.redactions} redaction(s)` : ''}.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The annotated PDF could not be written.';
      store.setError(message);
      setNotice({ tone: 'danger', text: message });
      if (error instanceof PasswordRequiredError) setPhase('locked');
    } finally {
      setExporting(false);
    }
  }, [activeFile, hint, password, session, sourceBytes, styles.redact.color, updateWork, work]);

  /* ── tabs ────────────────────────────────────────────────────────── */

  const visibleFiles = files.slice(0, MAX_DOCUMENTS);

  const closeTab = useCallback(
    (index: number) => {
      const closing = files[index];
      if (!closing) return;
      const stored = docWork.get(documentKey(closing));
      const unsaved = isUnsaved(stored);
      if (unsaved && !window.confirm(`“${closing.name}” has annotations that were never exported. Close it anyway?`)) {
        return;
      }
      docWork.delete(documentKey(closing));
      removeFile(index);
      setPreviewFileIndex(Math.max(0, Math.min(index, files.length - 2)));
    },
    [files, removeFile, setPreviewFileIndex],
  );

  /**
   * Opening the same file twice is a mistake, not a second document: it would
   * get a second tab bound to the same workspace key (E16).
   */
  const addDocument = useCallback(
    (list: FileList | null) => {
      const picked = Array.from(list ?? []);
      if (picked.length === 0) return;
      const known = new Set(files.map((entry) => documentKey(entry)));
      const fresh = picked.filter((entry) => !known.has(documentKey(entry)));
      const repeats = picked.length - fresh.length;
      const room = MAX_DOCUMENTS - files.length;
      if (room <= 0) {
        hint(`This editor holds ${MAX_DOCUMENTS} documents at a time — close a tab before adding another.`, 'warn');
        return;
      }
      const opening = fresh.slice(0, room);
      for (const file of opening) addFile(file);
      const parts: string[] = [];
      if (opening.length === 0 && fresh.length === 0) {
        parts.push(`${picked.length} of those files ${picked.length === 1 ? 'is' : 'are'} already open — a tab per document, not per drop.`);
      } else if (repeats > 0) {
        parts.push(`${repeats} already-open file${repeats === 1 ? ' was' : 's were'} skipped.`);
      }
      if (fresh.length > room) {
        parts.push(`Only ${room} of the ${fresh.length} new files were opened — the tab strip holds ${MAX_DOCUMENTS}.`);
      }
      if (parts.length > 0) hint(parts.join(' '), opening.length > 0 ? 'info' : 'warn');
    },
    [addFile, files, hint],
  );

  /* ── arriving from a quick-mode chip ───────────────────────────── */

  const intentApplied = useRef(false);

  useEffect(() => {
    if (intentApplied.current) return;
    intentApplied.current = true;
    const intent = routeToolId ? takeEditorIntent(routeToolId) : null;
    // The route itself implies a pen: `/tool/add-stamps` must not open on the
    // highlighter just because that is the component default.
    const armed = intent?.armTool ?? defaultToolForToolId(routeToolId);
    if (armed) armTool(armed);
    const carried = adoptedFile(intent, files);
    if (carried) {
      addFile(carried);
      setNotice({
        tone: 'info',
        text: `Brought ${carried.name} across from the editor chooser — it is still only in this tab.`,
      });
    } else if (intent?.note) {
      setNotice({ tone: 'info', text: intent.note });
    }
  }, [addFile, armTool, files.length, routeToolId]);

  /**
   * A chip that lands on the route already open does not navigate; it arms the
   * palette group the job lives in, which is the part the user asked for.
   */
  const applyLocalQuickMode = useCallback(
    (mode: QuickMode) => {
      const armed = mode.armTool ?? defaultToolForToolId(routeToolId) ?? 'select';
      armTool(armed);
      setNotice({
        tone: 'info',
        text: `${mode.label} is what this page already does — the ${
          toolGroupById(GROUP_FOR_TOOL[armed] ?? '')?.label ?? 'matching'
        } tools are open in the rail.`,
      });
    },
    [armTool, routeToolId],
  );

  /* ── switching documents mid-edit (E19) ────────────────────────── */

  const lastWorkKey = useRef<string | null>(null);

  useEffect(() => {
    const previous = lastWorkKey.current;
    lastWorkKey.current = workKey;
    if (previous === null || previous === workKey) return;
    // A half-drawn mark, an open link dialog and an armed picture all belong to
    // the page that was on screen, not the one that just arrived.
    const pendingMark = gesture !== null || linkDraft !== null;
    setGesture(null);
    setLinkDraft(null);
    setEditingId(null);
    clearRaster();
    setDistinctSizes(sizeKeys.current.get(workKey)?.size ?? 1);
    const kept = docWork.get(workKey)?.history.present.length ?? 0;
    setNotice({
      tone: 'info',
      text: switchNotice({
        fileName: activeFile?.name ?? 'the other document',
        kept,
        discardedPending: pendingMark,
      }),
    });
    // Only the key change matters; the transient values are read as-is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workKey]);

  /* ── derived render data ─────────────────────────────────────────── */

  const pageAnnotations = annotations.filter((a) => a.page === page);
  /**
   * The selection, in the order it was built. `primary` is the newest id and is
   * what the corner handles, the rotate handle and the inspector's angle field
   * point at; `selected` is only a selection of one, because "the selected
   * object" stops being a true phrase once there are two of them.
   */
  const selection = work?.selection ?? [];
  const selectionMarks = selectedMarks(pageAnnotations, selection);
  const primary = selectionMarks.length > 0 ? selectionMarks[selectionMarks.length - 1] : null;
  const selected = selectionMarks.length === 1 ? selectionMarks[0] : null;
  /**
   * What the selection panel prints. For one mark it names the mark; for a group
   * it prints the set and the properties the set agrees on, and never one mark's
   * text — that is the difference between a summary and a lie.
   */
  const selectionView = selectionMarks.length > 0 ? selectionSummary(pageAnnotations, selection) : null;
  const selectionGroup = selectionView && selectionView.count > 1 ? selectionView : null;
  /** The marquee being dragged with Select, or `null` for any other gesture. */
  const marqueeBand =
    tool === 'select' && gesture?.mode === 'drag' ? normaliseDrag(gesture.from, gesture.to) : null;
  const marquee = marqueeBand && isMeaningfulDrag(marqueeBand) ? marqueeBand : null;
  const toolMeta = TOOL_BY_ID[tool];
  /**
   * The footer sentence for the armed tool. A placement tool says what happens
   * next, so "will my next click make another one?" has an answer without
   * hovering the palette, and assistive tech hears it through the live region.
   */
  const armedHint = isPlacementTool(tool) ? `${toolMeta.hint} ${AFTER_CREATE_NOTE}` : toolMeta.hint;
  const pageCount = numPages || 1;

  const verticesPreview =
    gesture?.mode === 'vertices' ? { points: gesture.points, cursor: gesture.cursor } : null;

  const showCanvas = phase === 'ready' && geom !== null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-cream">
      {/* ── document tabs ── */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-cream-border bg-cream-light px-2 py-1.5 scrollbar-hide">
        <span className="shrink-0 pr-1 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          Documents
        </span>
        {visibleFiles.map((file, index) => {
          const stored = docWork.get(documentKey(file));
          const unsaved = isUnsaved(stored);
          const active = index === activeIndex;
          return (
            <span
              key={`${file.name}-${index}`}
              className={`flex shrink-0 items-center gap-1 rounded-doodle border px-2 py-1 text-[10px] transition-colors ${
                active
                  ? 'border-accent/35 bg-accent/[0.08] text-accent'
                  : 'border-cream-border bg-white text-ink-muted hover:text-ink-soft'
              }`}
            >
              <button type="button" onClick={() => setPreviewFileIndex(index)} className="max-w-[160px] truncate font-medium">
                {file.name}
              </button>
              {unsaved && <span title="Unsaved annotations" className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
              <button
                type="button"
                aria-label={`Close ${file.name}`}
                onClick={() => closeTab(index)}
                className="text-ink-muted transition-colors hover:text-danger"
              >
                ✕
              </button>
            </span>
          );
        })}
        <button
          type="button"
          onClick={() => documentInput.current?.click()}
          className={`${CHIP} doodle-chip-inactive shrink-0`}
          title={`Add another PDF (up to ${MAX_DOCUMENTS})`}
        >
          ＋ PDF
        </button>
        {files.length > MAX_DOCUMENTS && (
          <span className="shrink-0 text-[10px] text-warn">
            {files.length - MAX_DOCUMENTS} more file(s) are not shown — the tab strip holds {MAX_DOCUMENTS}.
          </span>
        )}
        {work && (
          <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {dirty ? 'unsaved' : 'saved export matches'}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── palette + options ── */}
        <aside
          data-editor-palette
          data-armed-tool={tool}
          className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-cream-border bg-cream-light p-3 lg:w-72"
        >
          <motion.div variants={staggerParent} initial="hidden" animate="visible" className="space-y-3">
            <motion.div variants={fadeUp}>
              <InspectorSection
                id="tools"
                title="Markup tools"
                meta={`${TOOLS.length} pens`}
                open={toolsOpen}
                onToggle={setToolsOpen}
              >
                <div className="space-y-2.5" data-focused-group={focusedGroup}>
                  {TOOL_GROUPS.map((group) => {
                    const items = toolsOfGroup(group);
                    const active = GROUP_FOR_TOOL[tool] === group.id;
                    return (
                      <div key={group.id} data-tool-group={group.id} {...(active ? { 'data-group-active': 'true' } : {})}>
                        <p
                          className={`font-mono text-[9px] uppercase tracking-[0.12em] ${
                            active ? 'text-accent' : 'text-ink-muted/80'
                          }`}
                        >
                          {group.label}
                        </p>
                        <div
                          className="mt-1 grid grid-cols-2 gap-1"
                          role="toolbar"
                          aria-label={`${group.label} tools`}
                          aria-orientation="horizontal"
                        >
                          {items.map((meta) => {
                            const shortcutKey = keyForTool(meta.id);
                            const armed = tool === meta.id;
                            return (
                              <button
                                key={meta.id}
                                type="button"
                                data-tool={meta.id}
                                aria-pressed={armed}
                                {...(shortcutKey ? { 'aria-keyshortcuts': shortcutKey } : {})}
                                title={meta.hint}
                                onClick={() => armTool(meta.id)}
                                className={`doodle-chip flex items-center justify-start gap-1.5 px-2 py-1.5 text-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                                  armed ? 'doodle-chip-active' : 'doodle-chip-inactive'
                                }`}
                              >
                                <span aria-hidden className="text-[12px] leading-none">
                                  {meta.icon}
                                </span>
                                <span className="min-w-0 flex-1 truncate text-left">{meta.label}</span>
                                {shortcutKey && (
                                  <kbd className="shrink-0 rounded border border-cream-border bg-cream px-1 text-[8px] uppercase text-ink-soft">
                                    {shortcutKey}
                                  </kbd>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[9px] leading-relaxed text-ink-muted/80">
                  {TOOLS.length} tools in {TOOL_GROUPS.length} named groups. {Object.keys(TOOL_SHORTCUT_KEYS).join(' ')}
                  {' '}arm {Object.values(TOOL_SHORTCUT_KEYS).map((id) => TOOL_BY_ID[id].label.toLowerCase()).join(', ')}.
                </p>
                <p className="text-[9px] leading-relaxed text-ink-muted/80" data-after-create-explained>
                  {AFTER_CREATE_NOTE} Esc unwinds one step at a time: the half-drawn mark, then the
                  selection, then the tool.
                </p>
              </InspectorSection>
            </motion.div>

            {/*
               The selection's own card. For one mark it is a short readout; for a
               group it is a summary — count, kinds, pages — plus the properties the
               set shares. It deliberately never shows a body of text for a group:
               "the note says X" is a sentence about one object, and a group has
               none.
            */}
            {selectionView && primary ? (
              <motion.div variants={fadeUp}>
                <InspectorSection
                  id="selection"
                  title={selectionGroup ? `${selectionGroup.count} marks selected` : 'Selected mark'}
                  meta={selectionGroup ? 'shared properties' : (TOOL_BY_ID[primary.tool]?.label ?? 'mark')}
                >
                  <SelectionPanel
                    summary={selectionView}
                    angle={annotationRotation(primary)}
                    turnable={selectionMarks.some(canRotate)}
                    refusedLabel={
                      selectionMarks.length > 0 && !canRotate(primary)
                        ? (TOOL_BY_ID[primary.tool]?.label ?? 'This')
                        : null
                    }
                    onStyle={(shared) => patchStyle(shared)}
                    onAngle={rotateSelectedTo}
                    onTurn={(delta) => turnSelected(delta)}
                  />
                </InspectorSection>
              </motion.div>
            ) : null}

            {/* Once a document is open the chips carry it across, which is the
                only reason a chip beats opening the other tool by hand. In the
                empty state the chooser below is the single source of chips. */}
            {phase !== 'empty' && (
              <motion.div variants={fadeUp}>
                <QuickModeChips
                  currentToolId={routeToolId}
                  file={activeFile}
                  onLocal={applyLocalQuickMode}
                />
              </motion.div>
            )}

            <motion.div variants={fadeUp}>
              <InspectorSection
                id="options"
                title={`${toolMeta.label} options`}
                meta={toolGroupById(GROUP_FOR_TOOL[tool] ?? '')?.label ?? 'marks'}
              >                <div className="space-y-2">

              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-f]{6}$/i.test(style.color) ? style.color : '#000000'}
                  onChange={(event) => patchStyle({ color: event.target.value })}
                  className="h-7 w-10 cursor-pointer rounded border border-cream-border bg-white"
                  aria-label="Colour"
                />
                <div className="flex flex-wrap gap-1">
                  {SWATCHES.map((swatch) => (
                    <button
                      key={swatch}
                      type="button"
                      aria-label={`Use ${swatch}`}
                      onClick={() => patchStyle({ color: swatch })}
                      className={`h-4 w-4 rounded border ${
                        style.color.toLowerCase() === swatch.toLowerCase()
                          ? 'border-accent ring-1 ring-accent/40'
                          : 'border-cream-border'
                      }`}
                      style={{ background: swatch }}
                    />
                  ))}
                </div>
              </div>

              {STROKED_TOOLS.includes(tool) && (
                <Slider
                  label="Stroke"
                  value={style.strokeWidth}
                  min={0.5}
                  max={12}
                  step={0.5}
                  unit="pt"
                  onChange={(strokeWidth) => patchStyle({ strokeWidth })}
                />
              )}

              <Slider
                label="Opacity"
                value={style.opacity}
                min={0.05}
                max={1}
                step={0.05}
                display={`${Math.round(style.opacity * 100)}%`}
                onChange={(opacity) => patchStyle({ opacity })}
              />

              {FILLABLE_TOOLS.includes(tool) && (
                <div className="space-y-1">
                  <label className="flex cursor-pointer items-center justify-between gap-2 text-[10px] text-ink-soft">
                    Fill
                    <input
                      type="checkbox"
                      checked={style.filled}
                      onChange={(event) => patchStyle({ filled: event.target.checked })}
                      className="h-3 w-3 accent-[#2563EB]"
                    />
                  </label>
                  {style.filled && (
                    <input
                      type="color"
                      value={/^#[0-9a-f]{6}$/i.test(style.fillColor) ? style.fillColor : '#ffffff'}
                      onChange={(event) => patchStyle({ fillColor: event.target.value })}
                      className="h-6 w-full cursor-pointer rounded border border-cream-border bg-white"
                      aria-label="Fill colour"
                    />
                  )}
                </div>
              )}

              {TEXT_TOOLS.includes(tool) && (
                <Slider
                  label="Text size"
                  value={style.fontSize}
                  min={6}
                  max={72}
                  step={1}
                  unit="pt"
                  onChange={(fontSize) => patchStyle({ fontSize })}
                />
              )}

              {tool === 'stamp' && (
                <div className="space-y-1">
                  <span className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                    Stamp
                  </span>
                  <select
                    value={style.stampName}
                    onChange={(event) => patchStyle({ stampName: event.target.value })}
                    disabled={rasterReady}
                    className="doodle-input py-1 text-[11px] disabled:opacity-50"
                  >
                    {BUILT_IN_STAMPS.map((stamp) => (
                      <option key={stamp.value} value={stamp.value}>
                        {stamp.label}
                      </option>
                    ))}
                  </select>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => imageInput.current?.click()}
                      className={MINI_BTN}
                    >
                      Custom image…
                    </button>
                    {rasterReady && (
                      <button type="button" onClick={clearRaster} className={MINI_BTN}>
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] leading-relaxed text-ink-muted">
                    {rasterReady
                      ? 'A custom image is armed — click or drag to place it, or Clear to go back to the built-in stamps.'
                      : 'Click or drag on the page to place the selected stamp.'}
                  </p>
                </div>
              )}

              {(tool === 'image' || tool === 'signature') && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => imageInput.current?.click()}
                      className={MINI_BTN}
                    >
                      Choose image…
                    </button>
                    <button
                      type="button"
                      onClick={() => setSignOpen(true)}
                      className={MINI_BTN}
                    >
                      Draw signature…
                    </button>
                    {rasterReady && (
                      <button type="button" onClick={clearRaster} className={MINI_BTN}>
                        Clear
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] leading-relaxed text-ink-muted">
                    {rasterHint(tool, rasterReady)}
                  </p>
                </div>
              )}

              <p className="text-[10px] leading-relaxed text-ink-muted">{toolMeta.hint}</p>
                </div>
              </InspectorSection>
            </motion.div>

            <motion.div variants={fadeUp} className="space-y-1.5">
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={undo}
                  disabled={!work || !canUndo(work.history)}
                  className="doodle-chip doodle-chip-inactive text-[10px] disabled:opacity-40"
                  title="Undo (Ctrl+Z)"
                >
                  ↶ Undo
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={!work || !canRedo(work.history)}
                  className="doodle-chip doodle-chip-inactive text-[10px] disabled:opacity-40"
                  title="Redo (Ctrl+Shift+Z)"
                >
                  ↷ Redo
                </button>
              </div>
              <motion.button
                whileTap={tapDown}
                type="button"
                id="tool-process-btn"
                onClick={() => void exportPdf()}
                disabled={exporting || phase !== 'ready' || annotations.length === 0}
                className="doodle-btn text-[12px] disabled:opacity-50"
              >
                {exporting ? 'Writing PDF…' : `Export annotated PDF (${annotations.length})`}
              </motion.button>
              <p className="text-[10px] leading-relaxed text-ink-muted">
                The original file is copied, the annotations are written into that copy, and redaction
                regions are cut out of the page content before saving.
              </p>
              <p className="font-mono text-[10px] tabular-nums text-ink-soft" data-export-summary>
                {marksSummary(annotations)}
              </p>
              {uselessMarks.length > 0 && (
                <div className="space-y-1 rounded-doodle-md border border-warn/30 bg-warn/[0.07] p-2" data-empty-marks>
                  <p className="text-[10px] font-semibold text-warn">
                    {uselessMarks.length} mark{uselessMarks.length === 1 ? '' : 's'} would be written but change nothing
                  </p>
                  <ul className="space-y-0.5">
                    {uselessMarks.slice(0, 4).map((mark) => (
                      <li key={mark.id} className="text-[10px] leading-relaxed text-ink-soft">
                        · {mark.reason}
                      </li>
                    ))}
                    {uselessMarks.length > 4 && (
                      <li className="text-[10px] text-ink-muted">· and {uselessMarks.length - 4} more</li>
                    )}
                  </ul>
                  <button type="button" onClick={dropUselessMarks} className={MINI_BTN}>
                    Remove {uselessMarks.length === 1 ? 'it' : `them`}
                  </button>
                </div>
              )}
            </motion.div>

            <motion.div variants={fadeUp}>
              <InspectorSection
                id="keys"
                title="Keyboard"
                meta={`${SHORTCUT_COUNT} keys`}
                defaultOpen={false}
              >
                <ShortcutList compact />
              </InspectorSection>
            </motion.div>

            <motion.div variants={fadeUp} className="space-y-1 border-t border-cream-border pt-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                This page · {pageAnnotations.length} mark{pageAnnotations.length === 1 ? '' : 's'}
              </p>
              <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
                {pageAnnotations.length === 0 && (
                  <p className="text-[10px] text-ink-muted">
                    Nothing on this page yet. {annotations.length > 0 ? 'Other pages have marks.' : ''}
                  </p>
                )}
                {pageAnnotations.map((annotation) => (
                  <div
                    key={annotation.id}
                    className={`flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] ${
                      selection.includes(annotation.id)
                        ? 'border-accent/40 bg-accent/[0.06] text-ink'
                        : 'border-cream-border bg-white text-ink-soft hover:border-[#D5D5CD]'
                    }`}
                  >
                    <button
                      type="button"
                      title="Select this mark; Shift adds it to the selection"
                      aria-pressed={selection.includes(annotation.id)}
                      onClick={(event) => {
                        setTool('select');
                        updateWork((current) => ({
                          ...current,
                          selection: event.shiftKey
                            ? toggleSelected(current.selection, annotation.id)
                            : selectOnly(annotation.id),
                        }));
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    >
                      <span aria-hidden className="text-[11px] leading-none">
                        {TOOL_BY_ID[annotation.tool]?.icon ?? '✦'}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{describeAnnotation(annotation)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete annotation"
                      onClick={() => {
                        updateWork((current) => {
                          const kept = current.history.present.filter((a) => a.id !== annotation.id);
                          return {
                            ...current,
                            history: pushHistory(current.history, kept),
                            selection: pruneSelection(current.selection, kept, current.page),
                          };
                        });
                      }}
                      className="shrink-0 text-ink-muted transition-colors hover:text-danger"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <p className="font-mono text-[10px] tabular-nums text-ink-muted">
                {annotations.length} total · {new Set(annotations.map((a) => a.page)).size} page(s) marked
              </p>
            </motion.div>
          </motion.div>
        </aside>

        {/* ── page ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cream-border bg-cream-light px-3 py-1.5"
            role="toolbar"
            aria-label="Page and zoom controls"
          >
            <button
              type="button"
              onClick={() => goToPage(page - 1)}
              disabled={page <= 0}
              className={`${CHIP} doodle-chip-inactive disabled:opacity-30`}
            >
              ◂ Prev
            </button>
            <input
              type="number"
              min={1}
              max={pageCount}
              value={page + 1}
              onChange={(event) => {
                const next = event.target.valueAsNumber;
                if (Number.isFinite(next)) goToPage(Math.round(next) - 1);
              }}
              className="doodle-input w-16 px-2 py-1 text-center text-[11px]"
              aria-label="Page number"
            />
            <span className="font-mono text-[10px] tabular-nums text-ink-muted">of {pageCount}</span>
            {pageInfo && (
              <span
                className="font-mono text-[10px] tabular-nums text-ink-muted"
                title="Size of this page, and how it was turned for display"
                data-page-extent={`${Math.round(pageInfo.width)}x${Math.round(pageInfo.height)}@${pageInfo.rotation}`}
              >
                {formatPageExtent(pageInfo.width, pageInfo.height)}
                {pageInfo.rotation !== 0 ? ` · ${pageInfo.rotation}°` : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => goToPage(page + 1)}
              disabled={page >= pageCount - 1}
              className={`${CHIP} doodle-chip-inactive disabled:opacity-30`}
            >
              Next ▸
            </button>

            <span className="ml-1 flex items-center gap-1 border-l border-cream-border pl-2">
              <button
                type="button"
                onClick={() => {
                  setFitMode('manual');
                  setZoom((z) => clampZoom(z / 1.25));
                }}
                disabled={!geom || zoom <= MIN_ZOOM + 0.001}
                className={`${CHIP} doodle-chip-inactive disabled:opacity-30`}
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="w-12 text-center font-mono text-[10px] tabular-nums text-ink-muted">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => {
                  setFitMode('manual');
                  setZoom((z) => clampZoom(z * 1.25));
                }}
                disabled={!geom || zoom >= MAX_ZOOM - 0.001}
                className={`${CHIP} doodle-chip-inactive disabled:opacity-30`}
                aria-label="Zoom in"
              >
                ＋
              </button>
              <button
                type="button"
                onClick={() => setFitMode('fit')}
                className={`${CHIP} ${fitMode === 'fit' ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
              >
                Fit width
              </button>
              <button
                type="button"
                onClick={() => {
                  setFitMode('manual');
                  setZoom(1);
                }}
                className={`${CHIP} doodle-chip-inactive`}
              >
                100%
              </button>
            </span>

            {selected && (
              <div className="ml-auto flex items-center gap-2">
                <span className="max-w-[220px] truncate font-mono text-[10px] text-ink-muted">
                  {describeAnnotation(selected)}
                </span>
                {EDITABLE_TEXT_TOOLS.includes(selected.tool) && (
                  <button
                    type="button"
                    onClick={() => {
                      setTool('select');
                      setEditingId(selected.id);
                    }}
                    className={`${CHIP} doodle-chip-inactive`}
                  >
                    Edit text
                  </button>
                )}
                <button
                  type="button"
                  onClick={removeSelected}
                  className={`${CHIP} doodle-chip-inactive text-danger`}
                >
                  Delete
                </button>
              </div>
            )}
          </div>

          {/*
             What the editor knows about the page under the pen (E6, E8, E9). These
             are the three cases where a user suspects a mark landed wrong and cannot
             tell from the picture, so the answer is printed next to the page controls.
          */}
          {contextNotes.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-cream-border bg-white/70 px-3 py-1">
              {contextNotes.map((note) => (
                <p
                  key={note.text}
                  role="note"
                  data-tone={note.tone}
                  className={`text-[10px] leading-relaxed ${
                    note.tone === 'warn' ? 'text-warn' : 'text-ink-muted'
                  }`}
                >
                  {note.tone === 'warn' ? '⚠ ' : '· '}
                  {note.text}
                </p>
              ))}
            </div>
          )}

          <div
            ref={paneRef}
            className="relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-cream-soft p-4 sm:p-6"
          >
            {showCanvas && geom && (
              <div
                ref={pageHostRef}
                className="relative shrink-0"
                style={{ width: geom.cssWidth, height: geom.cssHeight, lineHeight: 0 }}
              >
                <canvas
                  ref={canvasRef}
                  className="rounded-doodle-md border border-cream-border bg-white shadow-doodle-card"
                  style={{ width: geom.cssWidth, height: geom.cssHeight }}
                />
                <AnnotationOverlay
                  geom={geom}
                  annotations={pageAnnotations}
                  draft={draft}
                  vertices={verticesPreview}
                  tool={tool}
                  selection={selection}
                  editingId={editingId}
                  marquee={marquee}
                  onSurfacePointerDown={onSurfacePointerDown}
                  onAnnotationPointerDown={onAnnotationPointerDown}
                  onAnnotationDoubleClick={onAnnotationDoubleClick}
                  onHandlePointerDown={onHandlePointerDown}
                  onRotatePointerDown={onRotatePointerDown}
                  onFinishVertices={finishVertices}
                  onTextDraft={draftText}
                  onTextCommit={() => setEditingId(null)}
                />
              </div>
            )}

            {showCanvas && renderError && (
              <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-doodle-md border border-danger/25 bg-white/95 px-3 py-2 text-[10px] text-danger shadow-doodle-card">
                {renderError}
              </p>
            )}

            {phase === 'empty' && (
              <EmptyState
                onPick={() => documentInput.current?.click()}
                currentToolId={routeToolId}
                file={null}
                onLocal={applyLocalQuickMode}
              />
            )}

            {phase === 'loading' && (
              <motion.div variants={scaleIn} initial="hidden" animate="visible" className="flex h-full items-center justify-center">
                <div className="text-center">
                  <div className="mb-3 animate-spin text-3xl">⏳</div>
                  <p className="text-xs text-ink-muted">Opening {activeFile?.name ?? 'your PDF'}…</p>
                  <p className="mt-1 text-[10px] text-ink-muted/80">Everything happens in this tab — nothing is uploaded.</p>
                </div>
              </motion.div>
            )}

            {phase === 'locked' && (
              <PasswordCard
                value={password}
                onChange={setPassword}
                onSubmit={() => setPasswordTry((n) => n + 1)}
              />
            )}

            {phase === 'error' && (
              <ErrorCard
                message={errorMessage}
                onRetry={() => setPasswordTry((n) => n + 1)}
                onPick={() => documentInput.current?.click()}
              />
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-cream-border bg-cream-light px-3 py-1.5">
            {/*
               One permanent live region: the footer swaps styling with the news,
               but the element itself never unmounts, so assistive tech hears the
               undo, the step-back and the pin flip instead of a silent canvas.
            */}
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-editor-status={notice ? notice.tone : 'idle'}
              className={`min-w-0 flex-1 truncate rounded border px-2 py-1 text-[10px] leading-relaxed ${
                notice ? NOTICE_CLASS[notice.tone] : 'border-transparent text-ink-muted'
              }`}
            >
              {notice?.text ?? status ?? armedHint}
            </p>
            <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              In memory only — nothing is saved automatically
            </p>
          </div>
        </div>
      </div>

      {/* document picker (tabs) and image picker (placement) */}
      <input
        ref={documentInput}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        onChange={(event) => {
          addDocument(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void chooseImageFile(file);
        }}
      />

      <SignaturePad
        open={signOpen}
        color={styles.signature.color}
        onCancel={() => setSignOpen(false)}
        onAccept={(next) => {
          setRasterSafely(next);
          setRasterTool('signature');
          setSignOpen(false);
          setTool('signature');
          hint('Click or drag on the page to place the signature.', 'info');
        }}
      />

      {linkDraft && (
        <LinkDialog
          maxPage={pageCount}
          state={linkDraft}
          onChange={setLinkDraft}
          onCancel={() => setLinkDraft(null)}
          onApply={(target) => {
            if (!geom) return;
            const built = buildAnnotation({
              tool: 'link',
              page: page,
              style: styles.link,
              geom,
              drag: linkDraft.drag,
              link: target,
              id: nextAnnotationId(),
            });
            if (built) commit(built);
            setLinkDraft(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Load the original file for export. A password that the user typed for an
 * encrypted file is used; if the document turns out not to need it we retry
 * rather than failing the export.
 */
async function loadForExport(bytes: Uint8Array, password: string): Promise<PDFDocument> {
  if (!password) return openPDF(bytes, { ignoreEncryption: true });
  try {
    return await openPDF(bytes, { password });
  } catch (error) {
    if (error instanceof PasswordRequiredError) throw error;
    return openPDF(bytes, { ignoreEncryption: true });
  }
}

/** Pixels per PDF point for a burned page — the same 2× a thumbnail uses. */
const BURN_SCALE = 2;

/**
 * Paint each rotated redaction's page back into `doc` as one picture.
 *
 * The page is rendered through the editor's own session (the only canvas this tab
 * has), the rotated quads are filled over it in the burn colour, and the result
 * replaces the page's content — so the words under the turn are gone rather than
 * merely covered. Pages this tab cannot paint are reported, not pretended about:
 * an unburned rotated redaction deletes nothing, which is the safe direction.
 *
 * `regions` come from `exportPlan`, whose `quad` is already in PDF user space.
 */
async function burnRotatedRedactions(
  doc: PDFDocument,
  session: PdfSession | null,
  regions: { page: number; quad: number[] }[],
  fill: string,
): Promise<{ burned: number[]; failed: number[] }> {
  const burned: number[] = [];
  const failed: number[] = [];
  if (!session) {
    failed.push(...new Set(regions.map((region) => region.page + 1)));
    return { burned, failed };
  }

  const byPage = new Map<number, number[][]>();
  for (const region of regions) {
    const quads = byPage.get(region.page) ?? [];
    quads.push(region.quad);
    byPage.set(region.page, quads);
  }

  for (const [pageIndex, quads] of byPage) {
    try {
      const proxy = await session.page(pageIndex + 1);
      const viewport = proxy.getViewport({ scale: BURN_SCALE });
      const rotation = normaliseRotation(proxy.rotate);
      const pageGeom: PageGeom = {
        zoom: BURN_SCALE,
        cssWidth: viewport.width,
        cssHeight: viewport.height,
        rotation,
      };
      proxy.cleanup();
      const render = await session.renderPage(pageIndex + 1, BURN_SCALE, { background: '#ffffff' });
      const ctx = render.ctx;
      ctx.save();
      ctx.fillStyle = fill;
      for (const quad of quads) {
        const points = quadsToPoints(quad).map((point) => pdfToScreenPoint(point, pageGeom));
        ctx.beginPath();
        points.forEach((point, index) => (index === 0 ? ctx.moveTo(point.x, point.y) : ctx.lineTo(point.x, point.y)));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      const encoded = await encodeImageBytes(render.canvas, {
        format: 'jpeg',
        quality: 0.92,
        background: '#ffffff',
      });
      rasterisePageToImage(doc, pageIndex, encoded.bytes, { rotation });
      render.cancel();
      burned.push(pageIndex + 1);
    } catch {
      failed.push(pageIndex + 1);
    }
  }
  return { burned, failed };
}

/* ------------------------------------------------------------------ *
 * Panels that are only about presentation                            *
 * ------------------------------------------------------------------ */

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit = '',
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  display?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        <span>{label}</span>
        <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
          {display ?? `${value}${unit}`}
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
    </label>
  );
}

/**
 * The selection card: what is picked, and the properties a group can share.
 *
 * `onStyle` is the pen's own patch handler, which also writes the selection — so
 * the sliders here and the ones in the tool card cannot disagree, and one of them
 * is the source of truth for the value shown.
 */
function SelectionPanel({
  summary,
  angle,
  turnable,
  refusedLabel,
  onStyle,
  onAngle,
  onTurn,
}: {
  summary: SelectionSummary;
  angle: number;
  turnable: boolean;
  refusedLabel: string | null;
  onStyle: (shared: SharedStyle) => void;
  onAngle: (degrees: number) => void;
  onTurn: (delta: number) => void;
}): JSX.Element {
  const group = summary.count > 1;
  const mixed = new Set(summary.mixed);
  const what = summary.kinds.map((kind) => `${kind.label} ×${kind.count}`).join(', ');
  return (
    <div className="space-y-2" data-selection-panel={group ? 'group' : 'single'}>
      <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted" data-selection-summary>
        {summary.text}
      </p>
      {what ? <p className="text-[10px] leading-relaxed text-ink-soft">{what}</p> : null}
      {group ? (
        <p className="text-[10px] leading-relaxed text-ink-muted">
          A group has no single body of text, so nothing is shown here that belongs to only one mark — select one
          to edit its words.{' '}
          {mixed.size > 0
            ? `${[...mixed].join(', ')} differ between these marks; setting one below writes it into all ${summary.count}.`
            : ''}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(summary.shared.color ?? '') ? (summary.shared.color as string) : '#000000'}
          onChange={(event) => onStyle({ color: event.target.value })}
          className="h-7 w-10 cursor-pointer rounded border border-cream-border bg-white"
          aria-label="Colour of the selection"
        />
        <span className="text-[10px] text-ink-muted">{mixed.has('color') ? 'mixed colours' : 'colour'}</span>
      </div>

      <Slider
        label="Opacity"
        value={summary.shared.opacity}
        min={0.05}
        max={1}
        step={0.05}
        display={mixed.has('opacity') ? 'mixed' : `${Math.round(summary.shared.opacity * 100)}%`}
        onChange={(opacity) => onStyle({ opacity })}
      />
      <Slider
        label="Stroke"
        value={summary.shared.strokeWidth}
        min={0.5}
        max={12}
        step={0.5}
        unit="pt"
        display={mixed.has('strokeWidth') ? 'mixed' : undefined}
        onChange={(strokeWidth) => onStyle({ strokeWidth })}
      />
      {summary.shared.fontSize !== undefined || mixed.has('fontSize') ? (
        <Slider
          label="Text size"
          value={summary.shared.fontSize ?? 12}
          min={6}
          max={72}
          step={1}
          unit="pt"
          display={mixed.has('fontSize') ? 'mixed' : undefined}
          onChange={(fontSize) => onStyle({ fontSize })}
        />
      ) : null}

      <label className="block space-y-1">
        <span className="flex items-baseline justify-between gap-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
          <span>Rotation</span>
          <span className="font-display text-[11px] normal-case tracking-normal text-ink-soft tabular-nums">
            {Math.round(angle)}°
          </span>
        </span>
        <input
          type="number"
          min={0}
          max={359}
          step={15}
          value={Math.round(angle)}
          disabled={!turnable}
          onChange={(event) => onAngle(event.target.valueAsNumber)}
          className="doodle-input text-[11px] disabled:opacity-50"
          aria-label="Rotation in degrees"
        />
      </label>
      <div className="flex gap-1">
        <button
          type="button"
          disabled={!turnable}
          onClick={() => onTurn(-90)}
          className={`${MINI_BTN} disabled:opacity-40`}
          title="Turn the selection 90° back (Shift+R)"
        >
          ↺ 90°
        </button>
        <button
          type="button"
          disabled={!turnable}
          onClick={() => onTurn(90)}
          className={`${MINI_BTN} disabled:opacity-40`}
          title="Turn the selection 90° (R)"
        >
          90° ↻
        </button>
      </div>
      {!turnable && refusedLabel ? (
        <p className="text-[10px] leading-relaxed text-ink-muted">{rotationRefusedNotice(refusedLabel)}</p>
      ) : (
        <p className="text-[10px] leading-relaxed text-ink-muted">{ROTATE_SNAP_HINT}</p>
      )}
    </div>
  );
}

function EmptyState({
  onPick,
  currentToolId,
  file,
  onLocal,
}: {
  onPick: () => void;
  currentToolId: string | null;
  file: File | null;
  onLocal: (mode: QuickMode) => void;
}) {
  return (
    <motion.div
      variants={staggerParent}
      initial="hidden"
      animate="visible"
      className="flex h-full w-full items-center justify-center"
    >
      <div className="max-w-sm text-center">
        <motion.div variants={fadeUp} className="mb-3 text-5xl">
          📝
        </motion.div>
        <motion.p variants={fadeUp} className="text-sm font-medium text-ink">
          Annotate, highlight, redact, comment
        </motion.p>
        <motion.p variants={fadeUp} className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
          Open a PDF to draw on it. Highlights snap to the text underneath, redactions delete the
          text rather than covering it, and the export is written on this device.
        </motion.p>
        <motion.button
          variants={fadeUp}
          whileTap={tapDown}
          type="button"
          onClick={onPick}
          className="doodle-btn mx-auto mt-4 w-auto px-4 py-2 text-[12px]"
        >
          Choose a PDF
        </motion.button>
        <motion.div variants={fadeUp} className="mt-4">
          <QuickModeChips currentToolId={currentToolId} file={file} onLocal={onLocal} />
        </motion.div>
        <motion.div variants={fadeUp} className="mt-4">
          <DropReassurance lines={DROP_REASSURANCE} />
        </motion.div>
        <motion.p variants={fadeUp} className="mt-2 text-[10px] text-ink-muted/80">
          Or drop one in the panel on the left.
        </motion.p>
      </div>
    </motion.div>
  );
}

function PasswordCard({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <motion.div
      variants={scaleIn}
      initial="hidden"
      animate="visible"
      className="m-auto w-full max-w-sm rounded-doodle-md border border-cream-border bg-white p-4 text-center shadow-doodle-card"
    >
      <div className="mb-2 text-3xl">🔒</div>
      <p className="text-xs font-semibold text-ink">This PDF is password protected</p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
        Type the password to preview and annotate it. The password is used in this tab only.
      </p>
      <input
        type="password"
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
        placeholder="Document password"
        className="doodle-input mt-3 text-[12px]"
        autoComplete="off"
      />
      <button type="button" onClick={onSubmit} className="doodle-btn mt-2 text-[12px]">
        Unlock and open
      </button>
    </motion.div>
  );
}

function ErrorCard({
  message,
  onRetry,
  onPick,
}: {
  message: string;
  onRetry: () => void;
  onPick: () => void;
}) {
  return (
    <motion.div
      variants={scaleIn}
      initial="hidden"
      animate="visible"
      className="m-auto w-full max-w-md rounded-doodle-md border border-danger/25 bg-white p-4 text-center shadow-doodle-card"
    >
      <div className="mb-2 text-3xl">⚠️</div>
      <p className="text-xs font-semibold text-danger">This PDF could not be opened for annotation</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-soft">{message}</p>
      <div className="mt-3 flex justify-center gap-2">
        <button type="button" onClick={onRetry} className="doodle-btn doodle-btn-secondary px-3 py-1.5 text-[11px]">
          Try again
        </button>
        <button type="button" onClick={onPick} className="doodle-btn px-3 py-1.5 text-[11px]">
          Choose another PDF
        </button>
      </div>
    </motion.div>
  );
}

function LinkDialog({
  maxPage,
  state,
  onChange,
  onCancel,
  onApply,
}: {
  maxPage: number;
  state: { drag: CssRect; kind: 'page' | 'uri'; page: number; uri: string };
  onChange: (next: { drag: CssRect; kind: 'page' | 'uri'; page: number; uri: string }) => void;
  onCancel: () => void;
  onApply: (link: { type: 'goTo'; page: number } | { type: 'uri'; uri: string }) => void;
}) {
  const valid = state.kind === 'page' ? state.page >= 1 && state.page <= maxPage : /^https?:\/\/\S+$/i.test(state.uri.trim());
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4 backdrop-blur-subtle">
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="w-full max-w-sm rounded-doodle-lg border border-cream-border bg-cream-light p-4 shadow-doodle-card"
      >
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Link target</p>
        <div className="mt-2 flex gap-1">
          {(['page', 'uri'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onChange({ ...state, kind })}
              className={`doodle-chip text-[10px] ${state.kind === kind ? 'doodle-chip-active' : 'doodle-chip-inactive'}`}
            >
              {kind === 'page' ? 'Go to page' : 'Open URL'}
            </button>
          ))}
        </div>
        {state.kind === 'page' ? (
          <label className="mt-3 block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              Page (1–{maxPage})
            </span>
            <input
              type="number"
              min={1}
              max={maxPage}
              value={state.page}
              autoFocus
              onChange={(event) => onChange({ ...state, page: event.target.valueAsNumber || 1 })}
              className="doodle-input text-[12px]"
            />
          </label>
        ) : (
          <label className="mt-3 block space-y-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
              Address
            </span>
            <input
              type="url"
              value={state.uri}
              autoFocus
              placeholder="https://example.com"
              onChange={(event) => onChange({ ...state, uri: event.target.value })}
              className="doodle-input text-[12px]"
            />
          </label>
        )}
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={onCancel} className="doodle-btn doodle-btn-secondary text-[11px]">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid}
            onClick={() =>
              onApply(
                state.kind === 'page'
                  ? { type: 'goTo', page: Math.round(state.page) - 1 }
                  : { type: 'uri', uri: state.uri.trim() },
              )
            }
            className="doodle-btn text-[11px] disabled:opacity-40"
          >
            Add link
          </button>
        </div>
      </motion.div>
    </div>
  );
}

export default AnnotationEditor;
