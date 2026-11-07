/**
 * PageOrganizer — the `organize` tool's page planner.
 *
 * The pane renders a *plan* (see `plan.ts`) as a grid of page cards, and every
 * interaction is one action into `workspace.ts`'s reducer. That split is what
 * makes the drag feel testable at all: jsdom has no canvas and no real drag
 * events, so the gap a drop lands in, the selection a Shift-range paints, the
 * carry Space starts and stops, and the number of cards a keystroke dirties are
 * all asserted as state transitions in `tests/pdf/ux-organize.test.ts`.
 *
 * What this file is responsible for:
 *
 * * Sessions — one `PdfSession` per open file, destroyed when the file list
 *   changes and on unmount, plus a bounded thumbnail render per file.
 * * The pointer half of the gestures: drag start / over / drop / end, mapping
 *   client coordinates to a gap and handing the gap to the reducer. Dropping
 *   outside the grid reaches no handler here, so it is a no-op — `dragEnd`
 *   clears the indicator and the plan never moved.
 * * The view: one memoized card, a bounded mount window for 500-page documents
 *   (E7), a rotated- and size-correct preview per card (E8, E9), 1-based page
 *   numbers everywhere, a toolbar that acts on the whole selection, a keyboard
 *   map reachable from inside the pane, and one live region.
 * * The export: refuses to build a plan with no output pages, and says why
 *   (E13); discards a result whose documents or plan moved while it built (E19);
 *   and writes `source /Rotate + planned delta`, which is what the preview shows.
 *
 * `params.pageOrder` holds the plan in the grammar the registry parses
 * (`3, 1r90, blank`). A plan pulling from more than one open document qualifies
 * each token with its file (`f2:3`), which the registry's `parsePlan` cannot see
 * — which is why the pane also builds the file itself with **Save**.
 */
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { PasswordRequiredError, degrees, newPDF, openPDF, savePDF } from '@/lib/pdf/core/doc';
import type { PDFDocument } from '@maxwbh/pdf-lib';
import { displayedSize, resolvePages } from '@/lib/pdf/core/pages';
import { openRender, thumbnails, type PdfSession } from '@/lib/pdf/core/render';
import {
  ORGANIZE_SHORTCUTS,
  cardActionForKey,
  cardModels,
  cardModelsEqual,
  clampGap,
  documentKey as keyForFiles,
  formatOrganizeShortcut,
  gapForCardPoint,
  gapForGridPoint,
  historyAvailability,
  initialWorkspace,
  keysOwnTheOrganizer,
  organizerReducer,
  planRefusal,
  renderWindow,
  saveIsStale,
  saveToken,
  selectionSize,
  type CardModel,
  type WorkspaceAction,
} from './workspace';
import type { SelectMode } from './workspace';
import {
  firstPlannedSource,
  isPristinePlan,
  parsePageOrder,
  planStats,
  planToPageOrder,
  planWarnings,
  type Plan,
  type SourceStatus,
} from './plan';
import { THUMB_SLOT, outputRotation, previewBoxStyle, sizeKey, type PageSize } from './preview';

// The plan model and the `pageOrder` grammar are re-exported here so the pane's
// established import path (`organize/PageOrganizer`) keeps working.
export * from './plan';

/** The stable callback bag one card receives. Identities never change, so
 *  `memo` only ever has to compare the model. */
interface CardHandlers {
  onAction: (action: WorkspaceAction) => void;
  onFocusCard: (index: number) => void;
  onSelect: (index: number, mode: SelectMode) => void;
  onKey: (index: number, event: React.KeyboardEvent<HTMLDivElement>) => void;
  onDragStart: (index: number, event: React.DragEvent<HTMLDivElement>) => void;
  onDragOver: (index: number, event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (index: number, event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onMeasure: (source: number, page: number, size: PageSize) => void;
  register: (index: number, node: HTMLDivElement | null) => void;
}

interface SourceState {
  name: string;
  size: number;
  pages: number;
  /** Thumbnail data URLs, index = page (0-based); sparse while rendering. */
  thumbs: (string | undefined)[];
  status: SourceStatus;
  message?: string;
  /** Pages rendered so far, for the progress line. */
  done: number;
}

const THUMB_MAX_SIDE = Math.max(THUMB_SLOT.width, THUMB_SLOT.height);
/** Mount ceiling for the window (E7): a 500-page plan never mounts more cards
 *  than this, whatever the scroll position. */
const MAX_MOUNTED_CARDS = 96;
const CARD_ROW_HEIGHT = 232;
const CARD_COLUMN_MIN = 152;
const CARD_GRID_GAP = 12;
const TRAY_COLUMNS = 3;
const TRAY_ROW_HEIGHT = 128;

export default function PageOrganizer(): JSX.Element {
  const files = useFileStore((s) => s.files);
  const setParams = useFileStore((s) => s.setParams);
  const pageOrderParam = useFileStore((s) =>
    typeof s.params.pageOrder === 'string' ? s.params.pageOrder : '',
  );

  const [sources, setSources] = useState<SourceState[]>([]);
  const [pageSizes, setPageSizes] = useState<Record<string, PageSize>>({});
  const [state, dispatch] = useReducer(organizerReducer, undefined, initialWorkspace);
  const [tray, setTray] = useState(0);
  const [traySpec, setTraySpec] = useState('all');
  const [trayScroll, setTrayScroll] = useState({ top: 0, height: 0 });
  const [planText, setPlanText] = useState('');
  const [planTextDirty, setPlanTextDirty] = useState(false);
  const [passwords, setPasswords] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0, width: 0 });

  const sessions = useRef(new Map<number, PdfSession>());
  const passwordsRef = useRef(passwords);
  passwordsRef.current = passwords;
  const stateRef = useRef(state);
  stateRef.current = state;
  const cardRefs = useRef(new Map<number, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement | null>(null);

  const docKey = useMemo(
    () => keyForFiles(files.map((f) => ({ name: f.name, size: f.size }))),
    [files],
  );
  const planSources = useMemo(() => sources.map((s) => ({ name: s.name, pages: s.pages })), [sources]);
  const statuses = useMemo(() => sources.map((s) => s.status), [sources]);
  const stats = useMemo(() => planStats(state.plan, sources.length), [state.plan, sources.length]);
  const loading = sources.some((s) => s.status === 'loading');
  const customised = planSources.length > 0 && !isPristinePlan(state.plan, planSources, 0);
  const multiFile = stats.perSource.filter((n) => n > 0).length > 1;
  const planNotes = useMemo(
    () => planWarnings(state.plan, planSources, { statuses }),
    [state.plan, planSources, statuses],
  );
  const selectedCount = selectionSize(state.selection);
  const history = historyAvailability(state);
  const refusal = planRefusal(state.plan, planSources, statuses);
  const canSave = !saving && !loading && refusal === null;

  const thumbFor = useCallback(
    (source: number, page: number) => sources[source]?.thumbs[page],
    [sources],
  );
  const models = useMemo(
    () => cardModels(state, { thumbFor, sizes: pageSizes }),
    [state, thumbFor, pageSizes],
  );

  const columns = Math.max(
    1,
    Math.floor((scroll.width + CARD_GRID_GAP) / (CARD_COLUMN_MIN + CARD_GRID_GAP)) || 1,
  );
  const windowRange = useMemo(
    () =>
      renderWindow({
        count: models.length,
        columns,
        rowHeight: CARD_ROW_HEIGHT,
        scrollTop: scroll.top,
        viewportHeight: scroll.height,
        maxItems: MAX_MOUNTED_CARDS,
        minRows: 2,
      }),
    [models.length, columns, scroll.top, scroll.height],
  );
  const mounted = models.slice(windowRange.start, windowRange.end);

  // ── one session + thumbnail strip per open file ───────────────────────────
  const destroySessions = useCallback(() => {
    for (const session of sessions.current.values()) void session.destroy();
    sessions.current.clear();
  }, []);

  useEffect(() => {
    const token = { alive: true };
    destroySessions();
    setPasswords({});
    setPageSizes({});
    setPlanTextDirty(false);
    if (files.length === 0) {
      setSources([]);
      setTray(0);
      return () => {
        token.alive = false;
      };
    }

    setSources(
      files.map(
        (file): SourceState => ({
          name: file.name,
          size: file.size,
          pages: 0,
          thumbs: [],
          status: 'loading',
          done: 0,
        }),
      ),
    );
    setTray((current) => (current < files.length ? current : 0));

    const patch = (index: number, next: Partial<SourceState>) =>
      setSources((current) => current.map((s, i) => (i === index ? { ...s, ...next } : s)));

    const fillThumb = (index: number, page: number, url: string) =>
      setSources((current) => {
        const existing = current[index];
        if (!existing) return current;
        const thumbs = [...existing.thumbs];
        thumbs[page - 1] = url;
        return current.map((s, i) =>
          i === index ? { ...s, thumbs, done: Math.max(s.done, page) } : s,
        );
      });

    (async () => {
      for (let index = 0; index < files.length; index += 1) {
        if (!token.alive) return;
        const file = files[index];
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const session = await openRender(bytes, { password: passwordsRef.current[index] });
          if (!token.alive) {
            await session.destroy();
            return;
          }
          sessions.current.set(index, session);
          patch(index, { pages: session.numPages, thumbs: new Array(session.numPages), done: 0 });
          const urls = await thumbnails(session, {
            maxSide: THUMB_MAX_SIDE,
            onPage: (page, url) => {
              if (token.alive) fillThumb(index, page, url);
            },
          });
          if (!token.alive) return;
          patch(index, { status: 'ready', thumbs: urls, done: urls.length });
        } catch (err) {
          if (!token.alive) return;
          const message = err instanceof Error ? err.message : 'This PDF could not be previewed.';
          patch(index, {
            status: err instanceof PasswordRequiredError ? 'locked' : 'error',
            message,
          });
        }
      }
    })();

    return () => {
      token.alive = false;
      destroySessions();
    };
    // Password retries are handled by `retryWithPassword`, so `passwords` is
    // read through a ref and stays out of these dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, destroySessions]);

  /** Re-preview one locked file with the password just typed for it. */
  const retryWithPassword = useCallback(
    async (index: number) => {
      const file = files[index];
      if (!file) return;
      setSources((current) =>
        current.map((s, i) => (i === index ? { ...s, status: 'loading', message: undefined } : s)),
      );
      try {
        const session = await openRender(new Uint8Array(await file.arrayBuffer()), {
          password: passwords[index] || undefined,
        });
        await sessions.current.get(index)?.destroy().catch(() => undefined);
        sessions.current.set(index, session);
        const thumbs = new Array<string | undefined>(session.numPages);
        setSources((current) =>
          current.map((s, i) => (i === index ? { ...s, pages: session.numPages, thumbs } : s)),
        );
        const urls = await thumbnails(session, {
          maxSide: THUMB_MAX_SIDE,
          onPage: (page, url) => {
            setSources((current) => {
              const existing = current[index];
              if (!existing) return current;
              const next = [...existing.thumbs];
              next[page - 1] = url;
              return current.map((s, i) =>
                i === index ? { ...s, thumbs: next, done: Math.max(s.done, page) } : s,
              );
            });
          },
        });
        setSources((current) =>
          current.map((s, i) =>
            i === index ? { ...s, status: 'ready', thumbs: urls, done: urls.length } : s,
          ),
        );
        dispatch({
          type: 'announce',
          message: `Unlocked ${file.name} — ${session.numPages} pages available.`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'That password did not open this PDF.';
        setSources((current) =>
          current.map((s, i) => (i === index ? { ...s, status: 'locked', message } : s)),
        );
      }
    },
    [dispatch, files, passwords],
  );

  // ── feed the reducer ──────────────────────────────────────────────────────
  useEffect(() => {
    dispatch({ type: 'sync', docKey, sources: planSources, statuses });
  }, [docKey, planSources, statuses]);

  // Honour a `pageOrder` written elsewhere (the rail, a pasted plan) once per
  // document set, then let the plan be the source of truth.
  const seededFor = useRef('');
  useEffect(() => {
    const mark = `${docKey}|${planSources.map((s) => s.pages).join(',')}`;
    if (seededFor.current === mark) return;
    if (!planSources.some((s) => s.pages > 0)) return;
    seededFor.current = mark;
    const external = pageOrderParam.trim();
    if (!external) return;
    try {
      parsePageOrder(external, planSources);
      dispatch({ type: 'applyPlanText', spec: external });
    } catch {
      // A plan written against a different set of documents: keep this
      // document's own order rather than emptying the grid.
    }
  }, [docKey, pageOrderParam, planSources]);

  // Publish the plan as the registry's `pageOrder` value.
  useEffect(() => {
    const spec = planToPageOrder(state.plan);
    if (!planTextDirty) setPlanText(spec);
    const current = useFileStore.getState().params;
    // An emptied grid must not silently mean "the whole document": the registry
    // reads an empty *string* as "no plan was written" and would copy every page
    // (E13). The array shape is the one the registry parses as an explicit plan,
    // so `Run` refuses it with "The page order is empty" instead.
    const value: unknown = state.plan.length === 0 ? [] : spec;
    const matches = Array.isArray(value)
      ? Array.isArray(current.pageOrder) && current.pageOrder.length === 0
      : current.pageOrder === value;
    if (matches) return;
    setParams({ ...current, pageOrder: value });
  }, [planTextDirty, setParams, state.plan]);

  // Measure the grid once and on resize. Without this the mount window would be
  // computed from a 0×0 viewport, which in a real browser is two cards.
  useEffect(() => {
    const node = gridRef.current;
    if (!node) return;
    const measure = () =>
      setScroll((current) =>
        current.top === node.scrollTop &&
        current.height === node.clientHeight &&
        current.width === node.clientWidth
          ? current
          : { top: node.scrollTop, height: node.clientHeight, width: node.clientWidth },
      );
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [files.length]);

  // Keep the keyboard selection on screen, and keep focus on the card a keyboard
  // action just moved — without ever stealing it from the toolbar or the page.
  useEffect(() => {
    const focused = state.focused;
    if (focused === null) return;
    if (focused < windowRange.start || focused >= windowRange.end) {
      const grid = gridRef.current;
      if (grid) {
        const row = Math.floor(focused / columns);
        grid.scrollTop = Math.max(0, row * CARD_ROW_HEIGHT - grid.clientHeight / 2);
      }
      return;
    }
    const node = cardRefs.current.get(focused);
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!node || !gridRef.current || !active || !gridRef.current.contains(active)) return;
    if (active === node) return;
    node.focus();
  }, [columns, state.focused, state.revision, windowRange.end, windowRange.start]);

  // ── gestures ──────────────────────────────────────────────────────────────
  const handlers = useMemo<CardHandlers>(
    () => ({
      onAction: (action) => dispatch(action),
      onFocusCard: (index) => dispatch({ type: 'focusCard', index }),
      onSelect: (index, mode) => dispatch({ type: 'select', index, mode }),
      onKey: (index, event) => {
        if (
          !keysOwnTheOrganizer({
            key: event.key,
            defaultPrevented: event.defaultPrevented,
            target: event.target,
          })
        ) {
          return;
        }
        const current = stateRef.current;
        const action = cardActionForKey(
          {
            key: event.key,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
          },
          { index, carrying: current.carrying !== null, fromChild: event.target !== event.currentTarget },
        );
        if (!action) return;
        event.preventDefault();
        dispatch(action);
      },
      onDragStart: (index, event) => {
        const selected = stateRef.current.selection.indexes;
        const indexes = selected.includes(index) ? [...selected] : [index];
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `plan:${indexes.join(',')}`);
        dispatch({ type: 'dragStart', payload: { kind: 'plan', indexes } });
      },
      onDragOver: (index, event) => {
        if (!stateRef.current.drag) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        dispatch({
          type: 'dragOver',
          gap: gapForCardPoint(rect, index, { x: event.clientX, y: event.clientY }),
        });
      },
      onDrop: (index, event) => {
        event.preventDefault();
        event.stopPropagation();
        dispatch({ type: 'drop', gap: stateRef.current.gap ?? index });
      },
      onDragEnd: () => dispatch({ type: 'dragEnd' }),
      onMeasure: (source, page, size) => {
        if (!(size.width > 0 && size.height > 0)) return;
        const key = sizeKey(source, page);
        setPageSizes((existing) => {
          const known = existing[key];
          if (known && known.width === size.width && known.height === size.height) return existing;
          return { ...existing, [key]: size };
        });
      },
      register: (index, node) => {
        if (node) cardRefs.current.set(index, node);
        else cardRefs.current.delete(index);
      },
    }),
    [dispatch],
  );

  /** Grid rect + last card rect → the gap a container-level drop means. */
  const gridGapFor = (event: React.DragEvent): number | null => {
    const current = stateRef.current;
    const box = event.currentTarget.getBoundingClientRect();
    const lastIndex = current.plan.length - 1;
    const last = lastIndex >= 0 ? cardRefs.current.get(lastIndex)?.getBoundingClientRect() : undefined;
    return gapForGridPoint(
      { left: box.left, top: box.top, width: box.width, height: box.height },
      last
        ? { left: last.left, top: last.top, width: last.width, height: last.height }
        : null,
      current.plan.length,
      { x: event.clientX, y: event.clientY },
    );
  };

  const onGridDragOver = (event: React.DragEvent) => {
    const current = stateRef.current;
    if (!current.drag) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const gap = gridGapFor(event);
    dispatch({ type: 'dragOver', gap: gap ?? current.gap ?? current.plan.length });
  };

  const onGridDrop = (event: React.DragEvent) => {
    event.preventDefault();
    const current = stateRef.current;
    const gap = gridGapFor(event);
    dispatch({
      type: 'drop',
      gap: clampGap(gap ?? current.gap ?? current.plan.length, current.plan),
    });
  };

  const insertFromTray = useCallback(
    (pages: number[]) => {
      try {
        dispatch({ type: 'insertPages', source: tray, pages });
      } catch (err) {
        dispatch({
          type: 'announce',
          message: err instanceof Error ? err.message : 'That page selection could not be read.',
        });
      }
    },
    [dispatch, tray],
  );

  const applyPlanText = () => {
    dispatch({ type: 'applyPlanText', spec: planText });
    setPlanTextDirty(false);
  };

  // ── export ────────────────────────────────────────────────────────────────
  const buildPlan = useCallback(
    async (plan: Plan): Promise<PDFDocument> => {
      if (plan.length === 0) throw new Error('The page order is empty — add a page first.');
      const blocked = planRefusal(plan, planSources, statuses);
      if (blocked) throw new Error(blocked);
      const docs = new Map<number, PDFDocument>();
      const open = async (source: number): Promise<PDFDocument> => {
        const cached = docs.get(source);
        if (cached) return cached;
        const file = files[source];
        if (!file) throw new Error(`File ${source + 1} is no longer open.`);
        try {
          const doc = await openPDF(new Uint8Array(await file.arrayBuffer()), {
            password: passwordsRef.current[source] || undefined,
          });
          docs.set(source, doc);
          return doc;
        } catch (err) {
          const message = err instanceof Error ? err.message : 'it could not be read.';
          throw new Error(`"${file.name}" could not be opened: ${message}`);
        }
      };
      const sizeOfFirstPage = async (): Promise<PageSize> => {
        const source = firstPlannedSource(plan) ?? 0;
        const doc = await open(source);
        if (doc.getPageCount() === 0) {
          throw new Error(
            `"${files[source]?.name ?? 'That file'}" has no pages to size a blank sheet from.`,
          );
        }
        return displayedSize(doc.getPage(0));
      };

      const target = await newPDF();
      for (let index = 0; index < plan.length; index += 1) {
        const item = plan[index];
        if (item.kind === 'blank') {
          const reference =
            target.getPageCount() > 0
              ? displayedSize(target.getPage(target.getPageCount() - 1))
              : await sizeOfFirstPage();
          target.insertPage(index, [reference.width, reference.height]);
        } else {
          const source = await open(item.source);
          const [page] = await target.copyPages(source, [item.page]);
          // The copied page already carries the source `/Rotate`; the plan's
          // value is a delta on top of it, exactly like the preview (E9).
          const sourceAngle = readPageRotation(page);
          const angle = outputRotation(sourceAngle, item.rotate);
          if (angle !== sourceAngle) page.setRotation(degrees(angle));
          target.insertPage(index, page);
        }
        useProcessStore
          .getState()
          .setPercent(
            Math.round((90 * (index + 1)) / plan.length),
            item.kind === 'blank'
              ? 'Inserted a blank sheet'
              : `Placed page ${index + 1} of ${plan.length}`,
          );
      }
      return target;
    },
    [files, planSources, statuses],
  );

  const save = useCallback(async () => {
    const current = stateRef.current;
    if (current.refusal) {
      dispatch({ type: 'announce', message: `Not saved: ${current.refusal}` });
      return;
    }
    const started = saveToken(current);
    const planAtStart = current.plan;
    setSaving(true);
    setSaveError(null);
    const store = useProcessStore.getState();
    store.startProcessing('Organize PDF', '_organized.pdf');
    store.setPercent(
      3,
      `Rebuilding ${planAtStart.length} page${planAtStart.length === 1 ? '' : 's'}…`,
    );
    try {
      const doc = await buildPlan(planAtStart);
      store.setPercent(94, 'Saving…');
      const bytes = await savePDF(doc);
      const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
      if (saveIsStale(started, stateRef.current)) {
        // E19: the documents or the plan moved while this was in flight, so these
        // bytes are not what the grid shows. Say so instead of publishing them.
        dispatch({
          type: 'announce',
          message: 'Discarded a save that finished after the plan changed — nothing was downloaded.',
        });
        return;
      }
      store.setOutput(blob, URL.createObjectURL(blob));
      const built = planStats(planAtStart, planSources.length);
      store.appendLog(
        `PageOrganizer: ${built.pages} page${built.pages === 1 ? '' : 's'} from ${
          built.perSource.filter((n) => n > 0).length
        } file(s), ${built.blanks} blank sheet${built.blanks === 1 ? '' : 's'}.`,
      );
      dispatch({
        type: 'announce',
        message: `Saved a ${planAtStart.length}-page PDF: ${built.pages} page${
          built.pages === 1 ? '' : 's'
        } from documents, ${built.blanks} blank.`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The reordered PDF could not be saved.';
      store.setError(message);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  }, [buildPlan, dispatch, planSources.length]);

  // ── render ────────────────────────────────────────────────────────────────
  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <div className="mb-3 text-4xl" aria-hidden>
            📑
          </div>
          <p className="font-display text-[13px] font-semibold text-ink">No pages to organise yet</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
            Add one or more PDFs in the left panel. The first becomes the page order you edit, and every
            other file becomes a source you can pull pages from.
          </p>
        </div>
      </div>
    );
  }

  const traySource = sources[tray];
  const trayTotal = traySource?.pages ?? 0;
  const trayWindow = renderWindow({
    count: trayTotal,
    columns: TRAY_COLUMNS,
    rowHeight: TRAY_ROW_HEIGHT,
    scrollTop: trayScroll.top,
    viewportHeight: trayScroll.height,
    maxItems: 90,
    minRows: 4,
  });
  const trayPages: number[] = [];
  for (let page = trayWindow.start; page < trayWindow.end; page += 1) trayPages.push(page);
  const reused =
    stats.distinct === stats.pages
      ? ''
      : ` · ${stats.distinct} source page${stats.distinct === 1 ? '' : 's'} reused`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cream-border bg-cream-light/60 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            Plan: {stats.total} page{stats.total === 1 ? '' : 's'}
          </span>
          <span className="text-[10px] text-ink-muted">
            {stats.pages} from documents · {stats.blanks} blank{reused}
          </span>
          {sources.length > 1 && (
            <span className="text-[10px] text-ink-muted">
              {sources.map((s, i) => `${i + 1}: ${s.pages}p`).join(' · ')}
            </span>
          )}
          {customised && <span className="text-[10px] font-medium text-accent">Custom order</span>}
          {loading && <span className="text-[10px] text-warn">Rendering thumbnails…</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handlers.onAction({ type: 'resetOrder' })}
            className="doodle-chip text-[10px] doodle-chip-inactive"
          >
            Reset order
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave}
            title={refusal ?? 'Rebuild the PDF from this plan'}
            className="doodle-btn text-[11px] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save reordered PDF'}
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="shrink-0 border-b border-cream-border bg-cream-light/40 px-3 py-2">
          <div role="toolbar" aria-label="Actions for the selected pages" className="flex flex-wrap items-center gap-1.5">
            <ToolbarButton
              label="Undo"
              hint={history.canUndo ? undefined : 'Nothing to undo for these documents yet.'}
              disabled={!history.canUndo}
              onClick={() => handlers.onAction({ type: 'undo' })}
            >
              ↶ Undo
            </ToolbarButton>
            <ToolbarButton
              label="Redo"
              hint={history.canRedo ? undefined : 'Nothing to redo.'}
              disabled={!history.canRedo}
              onClick={() => handlers.onAction({ type: 'redo' })}
            >
              ↷ Redo
            </ToolbarButton>
            <Divider />
            <ToolbarButton
              label="Rotate the selection 90 degrees counter-clockwise"
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'rotate', delta: -90 })}
            >
              ⟲
            </ToolbarButton>
            <ToolbarButton
              label="Rotate the selection 90 degrees clockwise"
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'rotate', delta: 90 })}
            >
              ⟳
            </ToolbarButton>
            <ToolbarButton
              label="Move the selection one position earlier"
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'nudge', delta: -1 })}
            >
              ◀
            </ToolbarButton>
            <ToolbarButton
              label="Move the selection one position later"
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'nudge', delta: 1 })}
            >
              ▶
            </ToolbarButton>
            <ToolbarButton
              label="Duplicate the selection"
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'duplicate' })}
            >
              ⧉ Duplicate
            </ToolbarButton>
            <ToolbarButton
              label="Insert a blank sheet after the selection"
              onClick={() => handlers.onAction({ type: 'insertBlank' })}
            >
              ▢ Blank sheet
            </ToolbarButton>
            <ToolbarButton
              label="Remove the selected pages"
              danger
              disabled={selectedCount === 0}
              hint={emptySelectionHint}
              onClick={() => handlers.onAction({ type: 'remove' })}
            >
              ✕ Remove
            </ToolbarButton>
            <Divider />
            <ToolbarButton
              label="Select every page in the plan"
              disabled={state.plan.length === 0}
              hint="The plan has no pages to select."
              onClick={() => handlers.onAction({ type: 'selectAll' })}
            >
              Select all
            </ToolbarButton>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-muted">
            {selectedCount === 0
              ? 'No pages selected — click a page, Shift-click for a range, or Cmd/Ctrl-click to add single pages. Every action above applies to the whole selection.'
              : `${selectedCount} page${selectedCount === 1 ? '' : 's'} selected — every action applies to all of them.`}
          </p>
          <details className="mt-1 text-[10px] text-ink-muted">
            <summary className="cursor-pointer select-none hover:text-ink">Keyboard shortcuts</summary>
            <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
              {ORGANIZE_SHORTCUTS.map((shortcut) => (
                <li key={formatOrganizeShortcut(shortcut)} className="flex items-baseline gap-2">
                  <kbd className="rounded border border-cream-border bg-cream-light px-1 font-mono text-[9px] text-ink">
                    {formatOrganizeShortcut(shortcut)}
                  </kbd>
                  <span>{shortcut.label}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>

        {planNotes.length > 0 && (
          <ul
            data-plan-warnings={planNotes.length}
            className="shrink-0 flex flex-wrap gap-x-4 gap-y-1 border-b border-cream-border bg-cream-light/40 px-3 py-1.5"
          >
            {planNotes.map((note) => (
              <li
                key={note.text}
                role="note"
                data-tone={note.tone}
                className={`text-[10px] leading-relaxed ${
                  note.tone === 'danger'
                    ? 'text-danger'
                    : note.tone === 'warn'
                      ? 'text-warn'
                      : 'text-ink-muted'
                }`}
              >
                {note.tone === 'info' ? '· ' : '⚠ '}
                {note.text}
              </li>
            ))}
          </ul>
        )}

        {/* the plan */}
        <div
          ref={gridRef}
          className="min-h-0 flex-1 overflow-y-auto p-3"
          onDragOver={onGridDragOver}
          onDrop={onGridDrop}
          onScroll={(event) =>
            setScroll({
              top: event.currentTarget.scrollTop,
              height: event.currentTarget.clientHeight,
              width: event.currentTarget.clientWidth,
            })
          }
        >
          {saveError && <Notice tone="danger">{saveError}</Notice>}
          {refusal && (
            <p className="mb-2 text-[10px] leading-relaxed text-danger" data-save-refusal>
              Save is off: {refusal}
            </p>
          )}
          <ul
            role="listbox"
            aria-multiselectable="true"
            aria-label={`Planned page order, ${stats.total} page${stats.total === 1 ? '' : 's'}`}
            aria-activedescendant={
              state.focused !== null &&
              state.focused >= windowRange.start &&
              state.focused < windowRange.end
                ? `plan-card-${state.focused}`
                : undefined
            }
            className="grid list-none gap-3 p-0 sm:grid-cols-[repeat(auto-fill,minmax(152px,1fr))]"
          >
            {windowRange.hiddenBefore > 0 && (
              <li
                aria-hidden
                className="col-span-full text-[10px] text-ink-muted"
                style={{ height: windowRange.padTop }}
              >
                {windowRange.hiddenBefore} earlier pages are not drawn — scroll to see them.
              </li>
            )}
            {mounted.map((model) => (
              <PlanCard key={model.key} model={model} handlers={handlers} />
            ))}
            {state.plan.length === 0 && (
              <li className="col-span-full rounded-doodle-md border border-dashed border-cream-border p-6 text-center text-[11px] leading-relaxed text-ink-muted">
                Every page was removed, so this plan has 0 output pages and Save is off. Drag a page in
                from the right, or press Reset order.
              </li>
            )}
            {windowRange.hiddenAfter > 0 && (
              <li
                aria-hidden
                className="col-span-full text-[10px] text-ink-muted"
                style={{ height: windowRange.padBottom }}
              >
                {windowRange.hiddenAfter} later pages are not drawn — scroll to see them.
              </li>
            )}
            {state.gap !== null && windowRange.end < state.plan.length && (
              <li className="col-span-full text-[10px] text-accent" aria-hidden>
                Release to place the carried pages at position {state.gap + 1} of {state.plan.length}.
              </li>
            )}
          </ul>

          <div className="mt-4 rounded-doodle-md border border-cream-border bg-cream-light p-3">
            <label
              className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted"
              htmlFor="plan-order-field"
            >
              Page order value
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="plan-order-field"
                value={planText}
                onChange={(event) => {
                  setPlanText(event.target.value);
                  setPlanTextDirty(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    applyPlanText();
                  }
                  if (event.key === 'Escape') {
                    setPlanText(planToPageOrder(stateRef.current.plan));
                    setPlanTextDirty(false);
                  }
                }}
                spellCheck={false}
                className="doodle-input flex-1 font-mono text-[11px]"
                aria-describedby="plan-order-help"
                aria-invalid={state.inputError ? true : undefined}
              />
              <button type="button" onClick={applyPlanText} className="doodle-btn text-[11px]">
                Apply
              </button>
            </div>
            <p id="plan-order-help" className="mt-1 text-[10px] leading-relaxed text-ink-muted">
              This is the <code>pageOrder</code> value the tool registry parses, so the sidebar field and
              this grid always agree.{' '}
              {state.plan.length === 0
                ? 'The grid is empty, so the plan is published as an explicit empty plan: Run refuses it instead of copying every page.'
                : multiFile
                  ? 'This plan uses more than one file, so its tokens carry a file prefix (f2:3) and only the Save button above can build it — the sidebar Run reads the first file alone.'
                  : 'Tokens: 3 = page 3, 3r90 = page 3 rotated 90°, blank = empty sheet.'}
            </p>
            {state.inputError && <p className="mt-1 text-[10px] text-danger">{state.inputError}</p>}
          </div>
        </div>

        {/* sources */}
        <aside className="flex max-h-80 min-h-0 w-full shrink-0 flex-col border-t border-cream-border bg-cream-light/40 lg:max-h-none lg:w-72 lg:border-l lg:border-t-0">
          <div
            className="flex shrink-0 flex-wrap gap-1 border-b border-cream-border px-2 py-2"
            role="tablist"
            aria-label="Source files"
          >
            {sources.map((source, index) => (
              <button
                key={`${source.name}-${index}`}
                type="button"
                role="tab"
                aria-selected={tray === index}
                title={source.name}
                onClick={() => setTray(index)}
                className={`doodle-chip max-w-[10rem] truncate text-[10px] ${
                  tray === index ? 'doodle-chip-active' : 'doodle-chip-inactive'
                }`}
              >
                {index + 1}. {source.name}
                {source.status === 'locked' ? ' 🔒' : ''}
              </button>
            ))}
          </div>

          {traySource?.status === 'locked' && (
            <div className="shrink-0 space-y-1 border-b border-cream-border px-2 py-2">
              <p className="text-[10px] leading-relaxed text-warn">{traySource.message}</p>
              <div className="flex gap-1">
                <input
                  type="password"
                  value={passwords[tray] ?? ''}
                  onChange={(event) => setPasswords((c) => ({ ...c, [tray]: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void retryWithPassword(tray);
                    }
                  }}
                  placeholder="Password"
                  className="doodle-input flex-1 text-[11px]"
                  aria-label={`Password for ${traySource.name}`}
                />
                <button
                  type="button"
                  onClick={() => void retryWithPassword(tray)}
                  className="doodle-btn text-[10px]"
                >
                  Open
                </button>
              </div>
            </div>
          )}

          {traySource?.status === 'error' && (
            <div className="shrink-0 border-b border-cream-border px-2 py-2">
              <p className="text-[10px] leading-relaxed text-danger">{traySource.message}</p>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-1 px-2 py-2">
            <input
              value={traySpec}
              onChange={(event) => setTraySpec(event.target.value)}
              className="doodle-input flex-1 font-mono text-[10px]"
              aria-label={`Pages to insert from ${traySource?.name ?? 'this file'}`}
              placeholder="1,3,5-7"
            />
            <button
              type="button"
              onClick={() => {
                if (trayTotal === 0) return;
                insertFromTray(resolvePages(traySpec || 'all', trayTotal));
              }}
              disabled={!traySource || traySource.status !== 'ready'}
              className="doodle-btn text-[10px] disabled:opacity-40"
              title={
                traySource?.status === 'ready'
                  ? 'Insert the listed pages after the selection'
                  : 'Waiting for this file to preview'
              }
            >
              Insert
            </button>
            <button
              type="button"
              onClick={() => handlers.onAction({ type: 'useAsBase', source: tray })}
              disabled={!traySource || traySource.status !== 'ready'}
              className="doodle-chip text-[10px] doodle-chip-inactive disabled:opacity-40"
              title="Replace the plan with every page of this file"
            >
              Use as base
            </button>
          </div>

          <div
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            onScroll={(event) =>
              setTrayScroll({
                top: event.currentTarget.scrollTop,
                height: event.currentTarget.clientHeight,
              })
            }
          >
            {traySource?.status === 'loading' && (
              <p className="px-1 py-2 text-[10px] text-ink-muted">
                Rendering thumbnails… {traySource.done}/{traySource.pages || '?'}
              </p>
            )}
            <div className="grid grid-cols-3 gap-1.5">
              {trayPages.map((page) => (
                <button
                  key={page}
                  type="button"
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.setData('text/plain', `f${tray + 1}:${page + 1}`);
                    dispatch({ type: 'dragStart', payload: { kind: 'source', source: tray, page } });
                  }}
                  onDragEnd={() => dispatch({ type: 'dragEnd' })}
                  onClick={() => insertFromTray([page])}
                  title={`Insert page ${page + 1} of ${traySource?.name ?? ''}`}
                  aria-label={`Insert page ${page + 1} of ${traySource?.name ?? 'this file'}`}
                  className="relative min-h-[28px] overflow-hidden rounded border border-cream-border bg-white hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {traySource?.thumbs[page] ? (
                    <img
                      src={traySource.thumbs[page]}
                      alt=""
                      className="h-auto w-full select-none"
                      draggable={false}
                      onLoad={(event) =>
                        handlers.onMeasure(tray, page, {
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        })
                      }
                    />
                  ) : (
                    <span className="flex aspect-[3/4] items-center justify-center bg-cream-soft text-[9px] text-ink-muted">
                      {page + 1}
                    </span>
                  )}
                  <span className="absolute bottom-0 right-0 bg-white/85 px-1 text-[8px] font-semibold tabular-nums text-ink-muted">
                    {page + 1}
                  </span>
                </button>
              ))}
            </div>
            {(trayWindow.hiddenBefore > 0 || trayWindow.hiddenAfter > 0) && (
              <p className="px-1 pt-2 text-[10px] text-ink-muted">
                Showing pages {trayWindow.start + 1}–{trayWindow.end} of {trayTotal}.
              </p>
            )}
            {traySource?.status === 'ready' && (
              <p className="px-1 pt-2 text-[10px] leading-relaxed text-ink-muted">
                Drag a page into the plan, or click it to insert after the selected page. Used here:{' '}
                {stats.perSource[tray] ?? 0} of {traySource.pages}.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* live region: every plan edit, carry, refusal and undo is announced here */}
      <div
        className="shrink-0 border-t border-cream-border bg-cream-light/60 px-3 py-1.5 text-[10px] leading-relaxed text-ink-muted"
        aria-live="polite"
      >
        {state.status}
      </div>
    </div>
  );
}

const emptySelectionHint = 'Select at least one page first — click a page or press Ctrl+A.';

/**
 * pdf.js thumbnails already bake in the source page's `/Rotate`, and pdf-lib's
 * `copyPages` keeps it. `getRotation` can hand back an unresolved ref in odd
 * files, so read it defensively and treat anything unexpected as 0.
 */
function readPageRotation(page: unknown): number {
  const candidate = page as { getRotation?: () => { angle?: number } } | undefined;
  if (typeof candidate?.getRotation !== 'function') return 0;
  try {
    const angle = candidate.getRotation()?.angle;
    return typeof angle === 'number' && Number.isFinite(angle) ? angle : 0;
  } catch {
    return 0;
  }
}

// ── one planned page ────────────────────────────────────────────────────────

const PlanCard = memo(PlanCardBase, (a, b) => a.handlers === b.handlers && cardModelsEqual(a.model, b.model));

function PlanCardBase({ model, handlers }: { model: CardModel; handlers: CardHandlers }): JSX.Element {
  const styles = previewBoxStyle(model.preview);
  const group = model.groupSize > 1 ? ` ${model.groupSize} selected pages` : ' this page';
  const act = (verb: string) => `${verb}${group}`;
  return (
    <li className="relative flex justify-center">
      {model.gapBefore && <GapIndicator side="left" target={model.gapTarget} />}
      <div
        ref={(node) => handlers.register(model.index, node)}
        id={`plan-card-${model.index}`}
        data-plan-card={model.index}
        role="option"
        aria-selected={model.selected}
        aria-roledescription="planned page"
        aria-label={model.selected ? `${model.label}, selected` : model.label}
        title={model.kind === 'page' ? model.sourceName : 'Blank sheet'}
        tabIndex={model.focused ? 0 : -1}
        draggable
        onDragStart={(event) => handlers.onDragStart(model.index, event)}
        onDragEnd={handlers.onDragEnd}
        onDragOver={(event) => handlers.onDragOver(model.index, event)}
        onDrop={(event) => handlers.onDrop(model.index, event)}
        onFocus={() => handlers.onFocusCard(model.index)}
        onClick={(event) => {
          // A press on one of the card's own buttons belongs to that button; the
          // action it dispatches already resolves the target selection.
          const target = event.target as HTMLElement | null;
          if (typeof target?.closest === 'function' && target.closest('button')) return;
          handlers.onSelect(
            model.index,
            event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'single',
          );
        }}
        onKeyDown={(event) => handlers.onKey(model.index, event)}
        className={`relative w-full max-w-[168px] cursor-grab rounded-doodle-md border bg-white transition-all active:cursor-grabbing ${
          model.selected ? 'border-accent ring-1 ring-accent/30' : 'border-cream-border'
        } ${model.lifted ? 'opacity-50 ring-2 ring-accent' : ''} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
      >
        <div className="flex items-center justify-center overflow-visible rounded-t-[10px] p-1.5">
          {model.thumb ? (
            <div style={styles.outer}>
              <img
                src={model.thumb}
                alt=""
                draggable={false}
                className="select-none"
                style={{ ...styles.inner, transition: 'transform 160ms ease-out' }}
                onLoad={(event) =>
                  handlers.onMeasure(model.source, model.page, {
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
              />
            </div>
          ) : (
            <div
              style={styles.outer}
              className={`flex items-center justify-center rounded text-[10px] text-ink-muted ${
                model.kind === 'blank'
                  ? 'border border-dashed border-cream-border bg-cream-soft'
                  : 'bg-cream-soft'
              }`}
            >
              {model.kind === 'blank' ? 'blank' : '…'}
            </div>
          )}
        </div>
        <span className="absolute left-1 top-1 rounded-full bg-ink/75 px-1.5 py-0.5 text-[9px] font-bold tabular-nums text-white">
          {model.position}
        </span>
        {model.kind === 'page' && model.rotate !== 0 && (
          <span className="absolute right-1 top-1 rounded bg-accent px-1 py-0.5 text-[9px] font-semibold text-white">
            r{model.rotate}
          </span>
        )}
        {model.kind === 'page' && model.source !== 0 && (
          <span className="absolute right-1 top-6 rounded bg-acc-violet px-1 py-0.5 text-[9px] font-semibold text-white">
            f{model.source + 1}
          </span>
        )}
        <span className="block truncate border-t border-cream-border px-1 py-0.5 text-center text-[9px] tabular-nums text-ink-muted">
          {model.kind === 'blank'
            ? 'blank sheet'
            : `page ${model.sourcePage} of ${model.sourcePages}`}
        </span>
        <div className="flex flex-wrap items-center justify-center gap-0.5 border-t border-cream-border px-1 py-1">
          <CardButton
            title={`${act('Rotate 90° counter-clockwise')} (Shift+R)`}
            onClick={() => handlers.onAction({ type: 'rotate', index: model.index, delta: -90 })}
          >
            ⟲
          </CardButton>
          <CardButton
            title={`${act('Rotate 90° clockwise')} (R)`}
            onClick={() => handlers.onAction({ type: 'rotate', index: model.index, delta: 90 })}
          >
            ⟳
          </CardButton>
          <CardButton
            title={`${act('Move one position earlier')} (Alt+←)`}
            onClick={() => handlers.onAction({ type: 'nudge', index: model.index, delta: -1 })}
          >
            ◀
          </CardButton>
          <CardButton
            title={`${act('Move one position later')} (Alt+→)`}
            onClick={() => handlers.onAction({ type: 'nudge', index: model.index, delta: 1 })}
          >
            ▶
          </CardButton>
          <CardButton
            title={`${act('Duplicate')} (D)`}
            onClick={() => handlers.onAction({ type: 'duplicate', index: model.index })}
          >
            ⧉
          </CardButton>
          <CardButton
            title="Insert a blank sheet after this page (B)"
            onClick={() => handlers.onAction({ type: 'insertBlank', index: model.index })}
          >
            ▢
          </CardButton>
          <CardButton
            title={`${act('Remove')} (Delete)`}
            danger
            onClick={() => handlers.onAction({ type: 'remove', index: model.index })}
          >
            ✕
          </CardButton>
        </div>
      </div>
      {model.gapAfter && <GapIndicator side="right" target={model.gapTarget} />}
    </li>
  );
}

/**
 * The landing gap. One bar per gap — never one on each side of it, which reads
 * as two possible destinations — plus the 1-based position the carried pages
 * would take, the badge Stirling's own issue #6170 asks for.
 */
function GapIndicator({ side, target }: { side: 'left' | 'right'; target: number | null }): JSX.Element {
  return (
    <span
      data-gap-indicator={side}
      className={`absolute top-0 z-10 h-full w-1 rounded bg-accent ${side === 'left' ? '-left-1' : '-right-1'}`}
      aria-hidden
    >
      {target !== null && (
        <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-accent px-1 py-0.5 text-[9px] font-bold tabular-nums text-white">
          → {target}
        </span>
      )}
    </span>
  );
}

function Divider(): JSX.Element {
  return <span className="mx-1 h-4 w-px bg-cream-border" aria-hidden />;
}

function CardButton({
  title,
  onClick,
  children,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`min-h-[24px] min-w-[24px] rounded px-1 py-0.5 text-[11px] leading-none transition-colors hover:bg-cream-soft focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        danger ? 'text-danger' : 'text-ink-soft'
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarButton({
  label,
  hint,
  disabled,
  onClick,
  danger,
  children,
}: {
  label: string;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? (hint ?? `${label} is not available yet`) : label}
      disabled={disabled}
      onClick={onClick}
      className={`doodle-chip min-h-[28px] px-2 text-[10px] ${
        danger ? 'doodle-chip-inactive text-danger' : 'doodle-chip-inactive'
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function Notice({ tone, children }: { tone: 'danger' | 'warn'; children: React.ReactNode }): JSX.Element {
  const cls =
    tone === 'danger'
      ? 'border-danger/25 bg-danger/[0.07] text-danger'
      : 'border-warn/25 bg-warn/5 text-warn';
  return (
    <p className={`mb-3 rounded-doodle-md border px-3 py-2 text-[11px] leading-relaxed ${cls}`}>
      {children}
    </p>
  );
}

// The pane is mounted as the default export by `tools/registry.ts`, and the
// named export is what `tests/pdf/page-organizer.test.ts` pins.
export { PageOrganizer };
