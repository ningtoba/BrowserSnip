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
import { addAnnotations, applyRedactions } from '@/lib/pdf/core/annotations';
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
  normaliseDrag,
  screenToPdfPoint,
  screenToViewportBox,
  type CssRect,
  type PageGeom,
  type Point,
  type Rotation,
} from './geometry';
import {
  canRedo,
  canUndo,
  createHistory,
  liveHistory,
  pushHistory,
  redoHistory,
  settleHistory,
  undoHistory,
  type HistoryState,
} from './history';
import { pageHasText, snapTextLines } from './quads';
import {
  buildAnnotation,
  describeAnnotation,
  exportPlan,
  moveAnnotation,
  nextAnnotationId,
  workSignature,
  withText,
} from './specs';
import {
  BUILT_IN_STAMPS,
  EDITABLE_TEXT_TOOLS,
  FILLABLE_TOOLS,
  MARKUP_TOOLS,
  STROKED_TOOLS,
  SWATCHES,
  TEXT_TOOLS,
  TOOLS,
  TOOL_BY_ID,
  defaultStyleFor,
} from './tools';
import { MAX_DOCUMENTS, type EditorAnnotation, type EditorToolId, type PlacedRaster, type ToolStyle } from './types';

type Phase = 'empty' | 'loading' | 'ready' | 'locked' | 'error';

interface DocWork {
  history: HistoryState<EditorAnnotation[]>;
  page: number;
  selectedId: string | null;
  /** `workSignature` of the list that was last exported; drives "unsaved". */
  exportedSignature: string | null;
}

/** In-memory only — a page reload really does start from the file on disk. */
const workspaces = new Map<string, DocWork>();

const createWork = (): DocWork => ({
  history: createHistory<EditorAnnotation[]>([]),
  page: 0,
  selectedId: null,
  exportedSignature: null,
});

type Gesture =
  | { mode: 'drag'; from: Point; to: Point }
  | { mode: 'path'; points: Point[] }
  | { mode: 'vertices'; points: Point[]; cursor: Point | null };

interface MoveState {
  id: string;
  /** Pointer position at drag start, in PDF user space. */
  origin: Point;
  /** The annotation as it was before the drag. */
  before: EditorAnnotation;
  /** The whole list before the drag, for one undo step. */
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
const CHIP = 'doodle-chip flex-none whitespace-nowrap px-2 py-1 text-[10px]';

/** Small secondary action inside the option panel (`doodle-btn` is full-width). */
const MINI_BTN = 'doodle-btn doodle-btn-secondary w-auto flex-none px-2 py-1 text-[10px]';

export function AnnotationEditor(): JSX.Element {
  /* ── documents ───────────────────────────────────────────────────── */

  const files = useFileStore((s) => s.files);
  const previewFileIndex = useFileStore((s) => s.previewFileIndex);
  const setPreviewFileIndex = useFileStore((s) => s.setPreviewFileIndex);
  const addFile = useFileStore((s) => s.addFile);
  const removeFile = useFileStore((s) => s.removeFile);

  const activeIndex = files.length > 0 ? Math.min(previewFileIndex, files.length - 1) : 0;
  const activeFile = files[activeIndex] ?? null;

  const [work, setWork] = useState<DocWork | null>(null);

  useEffect(() => {
    if (!activeFile) {
      setWork(null);
      return;
    }
    const stored = workspaces.get(activeFile.name);
    setWork(stored ?? createWork());
    // Switching tabs must not silently drop work, so say what was kept.
    if (stored && workSignature(stored.history.present) !== stored.exportedSignature) {
      setNotice({
        tone: 'info',
        text: `Unsaved annotations for ${activeFile.name} are still here — they live in this tab only.`,
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
        workspaces.set(activeFile.name, next);
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
  const page = Math.min(work?.page ?? 0, Math.max(numPages - 1, 0));
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

  const [tool, setTool] = useState<EditorToolId>('highlight');
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

  const patchStyle = useCallback(
    (patch: Partial<ToolStyle>) => {
      setStyles((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }));
    },
    [tool],
  );

  const [notice, setNotice] = useState<Notice | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [raster, setRaster] = useState<PlacedRaster | null>(null);
  const [rasterTool, setRasterTool] = useState<EditorToolId | null>(null);
  const [signOpen, setSignOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ drag: CssRect; kind: 'page' | 'uri'; page: number; uri: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const moveRef = useRef<MoveState | null>(null);

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

  const dirty = work !== null && workSignature(annotations) !== work.exportedSignature;

  /* ── annotation edits ────────────────────────────────────────────── */

  const commit = useCallback(
    (annotation: EditorAnnotation, options: { edit?: boolean } = {}) => {
      updateWork((current) => ({
        ...current,
        history: pushHistory(current.history, [...current.history.present, annotation]),
        selectedId: annotation.id,
      }));
      if (options.edit) setEditingId(annotation.id);
      setNotice(null);
    },
    [updateWork],
  );

  const removeSelected = useCallback(() => {
    const id = work?.selectedId;
    if (!id) return;
    updateWork((current) => ({
      ...current,
      history: pushHistory(current.history, current.history.present.filter((a) => a.id !== id)),
      selectedId: null,
    }));
    setEditingId((current) => (current === id ? null : current));
  }, [updateWork, work?.selectedId]);

  const undo = useCallback(() => {
    updateWork((current) => ({ ...current, history: undoHistory(current.history) }));
    setEditingId(null);
  }, [updateWork]);

  const redo = useCallback(() => {
    updateWork((current) => ({ ...current, history: redoHistory(current.history) }));
    setEditingId(null);
  }, [updateWork]);

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
    (drag: CssRect) => {
      if (!geom || !work) return;

      if (tool === 'link') {
        setLinkDraft({ drag, kind: 'page', page: Math.min(page + 1, Math.max(numPages, 1)), uri: '' });
        return;
      }

      let lines: ReturnType<typeof linesUnder> = [];
      if (MARKUP_TOOLS.includes(tool)) {
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
    [clearRaster, commit, geom, hint, linesUnder, numPages, page, raster, rasterReady, style, textItems, tool, work],
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
    (point: Point) => {
      if (!activeFile || phase !== 'ready') return;
      setEditingId(null);
      if (tool === 'select') {
        updateWork((current) => ({ ...current, selectedId: null }));
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
      setGesture({ mode: 'drag', from: point, to: point });
    },
    [activeFile, phase, raster, rasterTool, tool, updateWork],
  );

  const onAnnotationPointerDown = useCallback(
    (id: string, point: Point) => {
      if (!geom || !work) return;
      const target = work.history.present.find((a) => a.id === id);
      if (!target) return;
      updateWork((current) => ({ ...current, selectedId: id }));
      moveRef.current = {
        id,
        origin: screenToPdfPoint(point, geom),
        before: target,
        beforeList: work.history.present,
      };
    },
    [geom, updateWork, work],
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
          current.history.present.map((a) => (a.id === move.id ? moveAnnotation(move.before, dx, dy) : a)),
        ),
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
      updateWork((current) => ({ ...current, history: settleHistory(current.history, move.beforeList) }));
      return;
    }
    const current = gesture;
    if (!current) return;
    if (current.mode === 'drag') {
      finishDrag(normaliseDrag(current.from, pointFrom(event)));
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

  const goToPage = useCallback(
    (next: number) => {
      const total = numPages || 1;
      updateWork((current) => ({ ...current, page: Math.min(Math.max(next, 0), total - 1) }));
      setEditingId(null);
    },
    [numPages, updateWork],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement | null;
      const typing =
        !!element &&
        (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable);
      if (typing) return;
      const combo = event.ctrlKey || event.metaKey;
      if (combo && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (combo && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          goToPage(page - 1);
          break;
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          goToPage(page + 1);
          break;
        case 'Delete':
        case 'Backspace':
          if (work?.selectedId) {
            event.preventDefault();
            removeSelected();
          }
          break;
        case 'Escape':
          setGesture(null);
          setEditingId(null);
          setLinkDraft(null);
          setSignOpen(false);
          updateWork((current) => ({ ...current, selectedId: null }));
          break;
        case 'Enter':
          if (tool === 'polygon' || tool === 'polyline') {
            event.preventDefault();
            finishVertices();
          }
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finishVertices, goToPage, page, redo, removeSelected, tool, undo, updateWork, work?.selectedId]);

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

      store.setPercent(70, `Writing ${plan.counts.total} annotation${plan.counts.total === 1 ? '' : 's'}…`);
      addAnnotations(copy, plan.specs);
      store.setPercent(90, 'Saving…');
      const output = await savePDF(copy);
      const blob = new Blob([output], { type: 'application/pdf' });
      store.setOutput(blob, URL.createObjectURL(blob));
      const signature = workSignature(list);
      updateWork((current) => ({ ...current, exportedSignature: signature }));
      setNotice({
        tone: warning ? 'warn' : 'success',
        text: warning || `Exported ${plan.counts.total} annotation(s)${plan.counts.redactions ? `, including ${plan.counts.redactions} redaction(s)` : ''}.`,
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
  }, [activeFile, hint, password, sourceBytes, styles.redact.color, updateWork, work]);

  /* ── tabs ────────────────────────────────────────────────────────── */

  const visibleFiles = files.slice(0, MAX_DOCUMENTS);

  const closeTab = useCallback(
    (index: number) => {
      const closing = files[index];
      if (!closing) return;
      const stored = workspaces.get(closing.name);
      const unsaved = stored && workSignature(stored.history.present) !== stored.exportedSignature && stored.history.present.length > 0;
      if (unsaved && !window.confirm(`“${closing.name}” has annotations that were never exported. Close it anyway?`)) {
        return;
      }
      workspaces.delete(closing.name);
      removeFile(index);
      setPreviewFileIndex(Math.max(0, Math.min(index, files.length - 2)));
    },
    [files, removeFile, setPreviewFileIndex],
  );

  const addDocument = useCallback(
    (list: FileList | null) => {
      const picked = Array.from(list ?? []);
      if (picked.length === 0) return;
      const room = MAX_DOCUMENTS - files.length;
      if (room <= 0) {
        hint(`This editor holds ${MAX_DOCUMENTS} documents at a time — close a tab before adding another.`, 'warn');
        return;
      }
      for (const file of picked.slice(0, room)) addFile(file);
      if (picked.length > room) {
        hint(`Only ${room} of the ${picked.length} files you chose were opened — the tab strip holds ${MAX_DOCUMENTS}.`, 'warn');
      }
    },
    [addFile, files.length, hint],
  );

  /* ── derived render data ─────────────────────────────────────────── */

  const pageAnnotations = annotations.filter((a) => a.page === page);
  const selected = annotations.find((a) => a.id === work?.selectedId) ?? null;
  const toolMeta = TOOL_BY_ID[tool];
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
          const stored = workspaces.get(file.name);
          const unsaved =
            stored !== undefined &&
            stored.history.present.length > 0 &&
            workSignature(stored.history.present) !== stored.exportedSignature;
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
        <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-cream-border bg-cream-light p-3 lg:w-72">
          <motion.div variants={staggerParent} initial="hidden" animate="visible" className="space-y-3">
            <motion.div variants={fadeUp}>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Markup tools</p>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {TOOLS.map((meta) => (
                  <button
                    key={meta.id}
                    type="button"
                    title={meta.hint}
                    onClick={() => {
                      setTool(meta.id);
                      setGesture(null);
                      if (meta.id !== 'select') setEditingId(null);
                    }}
                    className={`doodle-chip flex items-center justify-start gap-1.5 px-2 py-1.5 text-[10px] ${
                      tool === meta.id ? 'doodle-chip-active' : 'doodle-chip-inactive'
                    }`}
                  >
                    <span aria-hidden className="text-[12px] leading-none">{meta.icon}</span>
                    <span className="truncate">{meta.label}</span>
                  </button>
                ))}
              </div>
            </motion.div>

            <motion.div variants={fadeUp} className="space-y-2 rounded-doodle-md border border-cream-border bg-white p-2.5">
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                {toolMeta.label} options
              </p>

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
                    {rasterReady
                      ? 'Ready to place — click or drag on the page.'
                      : tool === 'image'
                        ? 'Pick a PNG or JPEG; it is placed as a stamp annotation.'
                        : 'Draw the signature; it is placed as a stamp annotation.'}
                  </p>
                </div>
              )}

              <p className="text-[10px] leading-relaxed text-ink-muted">{toolMeta.hint}</p>
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
                      annotation.id === work?.selectedId
                        ? 'border-accent/40 bg-accent/[0.06] text-ink'
                        : 'border-cream-border bg-white text-ink-soft hover:border-[#D5D5CD]'
                    }`}
                  >
                    <button
                      type="button"
                      title="Select this mark"
                      onClick={() => {
                        setTool('select');
                        updateWork((current) => ({ ...current, selectedId: annotation.id }));
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
                        updateWork((current) => ({
                          ...current,
                          history: pushHistory(
                            current.history,
                            current.history.present.filter((a) => a.id !== annotation.id),
                          ),
                          selectedId: null,
                        }));
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
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-cream-border bg-cream-light px-3 py-1.5">
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

            <span className="flex-1" />

            {selected && (
              <>
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
              </>
            )}
          </div>

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
                  selectedId={work?.selectedId ?? null}
                  editingId={editingId}
                  onSurfacePointerDown={onSurfacePointerDown}
                  onAnnotationPointerDown={onAnnotationPointerDown}
                  onAnnotationDoubleClick={onAnnotationDoubleClick}
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

            {phase === 'empty' && <EmptyState onPick={() => documentInput.current?.click()} />}

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
            {notice ? (
              <p
                className={`min-w-0 flex-1 truncate rounded border px-2 py-1 text-[10px] leading-relaxed ${NOTICE_CLASS[notice.tone]}`}
              >
                {notice.text}
              </p>
            ) : (
              <p className="min-w-0 flex-1 truncate text-[10px] text-ink-muted">{toolMeta.hint}</p>
            )}
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

function EmptyState({ onPick }: { onPick: () => void }) {
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
