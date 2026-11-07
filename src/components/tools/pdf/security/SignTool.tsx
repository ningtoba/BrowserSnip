/**
 * SignTool — Sidebar for Sign PDF.
 *
 * Prepare signatures via tabs (Text | Image | Draw),
 * then click "Add to PDF" to place them on the page.
 * The overlay (SignMain) handles positioning, resizing, and editing.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import { usePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { fadeUp, scaleIn, staggerParent } from '@/lib/motion';
import { clampPageNumber, fitMarkToPage } from '@/components/tools/pdf/editor/placement';
import { adoptedFile, takeEditorIntent } from '@/components/tools/pdf/editor/quickModes';
import { decodeImage } from '@/lib/pdf/core/images';
import {
  getSignState, addSigItem, updateSigItem, removeSigItem,
  selectSigItem, getSignPageSize, subscribeSign,
} from './SignMain';
import type { SigItem } from './SignMain';

let _nextId = 1;
function nextId() { return `sig-${_nextId++}`; }

const FONTS = [
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'TimesRoman', label: 'Times' },
  { value: 'Courier', label: 'Courier' },
];

type SigTab = 'text' | 'image' | 'draw';

export function SignTool() {
  const { run, isRunning } = usePdfTool('sign');
  const warnings = useProcessStore((s) => s.warnings);
  const file = useFileStore((s) => s.file);
  const setFile = useFileStore((s) => s.setFile);
  const activeToolId = useFileStore((s) => s.activeTool);
  const [st, setSt] = useState(getSignState());
  const [tab, setTab] = useState<SigTab>('text');
  const [notice, setNotice] = useState<string | null>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawActive = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Arriving from the editor chooser's "Sign" chip means the Draw tab, not the
   * default Text tab — the chip promised drawing a signature — and the document
   * follows the user: `useFileStore` keeps a slot per tool, so without adopting the
   * carried file this panel would open empty and the chip would be a lie.
   */
  const intentChecked = useRef(false);
  useEffect(() => {
    if (intentChecked.current) return;
    intentChecked.current = true;
    const routeId = typeof activeToolId === 'string' && activeToolId ? activeToolId : 'sign';
    const intent = takeEditorIntent(routeId);
    if (!intent) return;
    if (intent.panel === 'draw' || intent.panel === 'text' || intent.panel === 'image') setTab(intent.panel);
    const carried = adoptedFile(intent, file ? [file] : []);
    if (carried) {
      setFile(carried);
      setNotice(`Brought ${carried.name} across from the editor chooser — it is still only in this tab.`);
    } else if (intent.note) {
      setNotice(intent.note);
    }
  }, [activeToolId, file, setFile]);

  const [textValue, setTextValue] = useState('');
  const [textFont, setTextFont] = useState('Helvetica');
  const [textColor, setTextColor] = useState('#000000');
  // A typed signature's height follows its width (the preview box is resized by the
  // overlay), so only the width is a user choice here.
  const [textW, setTextW] = useState(180);
  const [textH] = useState(40);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageBytes, setImageBytes] = useState<ArrayBuffer | null>(null);
  const [imageW, setImageW] = useState(120);
  const [imageH, setImageH] = useState(40);

  const [drawUrl, setDrawUrl] = useState<string | null>(null);
  const [drawBytes, setDrawBytes] = useState<ArrayBuffer | null>(null);
  const [drawW, setDrawW] = useState(120);
  const [drawH, setDrawH] = useState(40);

  useEffect(() => subscribeSign(() => setSt(getSignState())), []);

  const selected = st.items.find((s) => s.id === st.selectedId) ?? null;

  /**
   * Sizes here are points, but the page they land on is whatever the document
   * happens to be (E8): a 400 pt signature on a 300 pt page would hang off the
   * paper, where no viewer shows it. Fit it at add time and say what changed,
   * rather than letting the export write something invisible.
   */
  const fitToPage = useCallback((w: number, h: number): { w: number; h: number } => {
    const pageSize = getSignPageSize();
    const widthPt = Math.max(1, pageSize.width);
    const heightPt = Math.max(1, pageSize.height);
    const fit = fitMarkToPage(
      { page: 1, x: 0, y: 0, w: w / widthPt, h: h / heightPt },
      { page: 1, widthPt, heightPt },
    );
    if (fit.reason) setNotice(`Mark was ${fit.reason}.`);
    return { w: fit.mark.w * widthPt, h: fit.mark.h * heightPt };
  }, []);

  const addTextToPDF = useCallback(() => {
    if (!textValue.trim()) return;
    const size = fitToPage(textW, textH);
    addSigItem({
      id: nextId(), type: 'text',
      text: textValue,
      imageDataUrl: null, imageBytes: null,
      w: size.w, h: size.h,
      color: textColor, fontFamily: textFont,
    });
    setTextValue('');
  }, [fitToPage, textColor, textFont, textH, textValue, textW]);

  const addImageToPDF = useCallback(() => {
    if (!imageBytes) return;
    const size = fitToPage(imageW, imageH);
    addSigItem({
      id: nextId(), type: 'image',
      text: '',
      imageDataUrl: imageUrl, imageBytes,
      w: size.w, h: size.h,
    });
    setImageUrl(null); setImageBytes(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [fitToPage, imageBytes, imageH, imageUrl, imageW]);

  const addDrawToPDF = useCallback(() => {
    if (!drawBytes) return;
    const size = fitToPage(drawW, drawH);
    addSigItem({
      id: nextId(), type: 'draw',
      text: '',
      imageDataUrl: drawUrl, imageBytes: drawBytes,
      w: size.w, h: size.h,
    });
    setDrawUrl(null); setDrawBytes(null);
    clearDrawCanvas();
    // `clearDrawCanvas` is declared below and is itself a stable `useCallback`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawBytes, drawH, drawUrl, drawW, fitToPage]);

  /**
   * Read a signature picture off disk.
   *
   * This goes through `core/images`, whose decode is bounded and always settles:
   * awaiting the `<img>` load directly meant a browser without `createImageBitmap`
   * hung on the file picker with no message at all.
   */
  const handleImagePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const decoded = await decodeImage(new Uint8Array(await f.arrayBuffer()), {
        mime: f.type || undefined,
        name: f.name,
      });
      const blob = await new Promise<Blob | null>((r) => decoded.canvas.toBlob(r, 'image/png'));
      if (!blob) {
        setNotice(`"${f.name}" could not be turned into a picture this browser can embed. Draw your signature instead.`);
        return;
      }
      const bytes = await blob.arrayBuffer();
      setImageUrl(URL.createObjectURL(blob));
      setImageBytes(bytes);
      // Preview width is points on the page, so a 2000 px photo is scaled down
      // to a signature-sized mark rather than a banner.
      const maxW = 150;
      const aspect = decoded.width / Math.max(1, decoded.height);
      setImageW(Math.min(maxW, decoded.width));
      setImageH(Math.min(maxW, decoded.width) / aspect);
      setNotice(`"${f.name}" is ready to place — it stays in this tab.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `"${f.name}" could not be opened as a picture.`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const clearDrawCanvas = useCallback(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;
    canvas.width = 220; canvas.height = 80;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    drawActive.current = false;
  }, []);

  useEffect(() => { clearDrawCanvas(); }, [clearDrawCanvas]);

  const drawStart = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    drawActive.current = true;
    const canvas = drawCanvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d')!;
    ctx.beginPath();
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
    ctx.moveTo(cx - rect.left, cy - rect.top);
  }, []);

  const drawMove = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!drawActive.current) return;
    e.preventDefault();
    const canvas = drawCanvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d')!;
    const cx = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const cy = 'touches' in e ? e.touches[0].clientY : e.clientY;
    ctx.lineTo(cx - rect.left, cy - rect.top);
    ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx - rect.left, cy - rect.top);
  }, []);

  const drawEnd = useCallback(async () => {
    if (!drawActive.current) return;
    drawActive.current = false;
    const canvas = drawCanvasRef.current; if (!canvas) return;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) return;
    const bytes = await blob.arrayBuffer();
    setDrawUrl(canvas.toDataURL('image/png'));
    setDrawBytes(bytes);
  }, []);

  /**
   * Re-use a signature already prepared.
   *
   * The list under the tabs is the saved set: the picture and the text survive on
   * the item, so "place again" copies the mark onto the page being viewed instead
   * of making the user draw it again for page 2 and page 3.
   */
  const placeAgain = useCallback((item: SigItem) => {
    addSigItem({
      id: nextId(),
      type: item.type,
      text: item.text,
      imageDataUrl: item.imageDataUrl,
      imageBytes: item.imageBytes,
      w: item.w,
      h: item.h,
      color: item.color,
      fontFamily: item.fontFamily,
    });
    setNotice(
      `Placed another copy of the ${item.type === 'text' ? 'typed' : item.type === 'image' ? 'image' : 'drawn'} signature on page ${st.page}. Drag it where you want it.`,
    );
  }, [st.page]);

  const update = useCallback((patch: Partial<SigItem>) => {
    if (!selected) return;
    updateSigItem(selected.id, patch);
  }, [selected]);

  /**
   * Items whose page still exists (E6, E19). A signature placed on page 3 and a
   * document swapped for a 2-page one must not silently write to a page the output
   * does not have — it is dropped, named, and the user is told.
   */
  const unusable = useMemo(
    () => (st.totalPages > 0 ? st.items.filter((item) => clampPageNumber(item.page, st.totalPages) === null) : []),
    [st.items, st.totalPages],
  );
  const usable = useMemo(
    () => (st.totalPages > 0 ? st.items.filter((item) => clampPageNumber(item.page, st.totalPages) !== null) : st.items),
    [st.items, st.totalPages],
  );

  const handleProcess = useCallback(() => {
    if (unusable.length > 0) {
      setNotice(
        `${unusable.length} signature${unusable.length === 1 ? '' : 's'} sat on a page this document does not have and were left out.`,
      );
    }
    void run({
      // The pane's own geometry, unresolved: `x`/`y` are fractions of the page
      // each mark sits on and `width`/`height` are points, so the tool converts
      // them against *that* page's box. Multiplying by the first page's size
      // here put a mark in the wrong corner of every page that differed (E8).
      marks: usable.map((item) => ({
        type: item.type === 'text' ? ('text' as const) : ('image' as const),
        text: item.text,
        image: item.imageBytes ? new Uint8Array(item.imageBytes) : null,
        mime: 'image/png',
        page: item.page,
        x: item.x,
        y: item.y,
        width: item.w,
        height: item.h,
        color: item.color,
        fontFamily: item.fontFamily,
      })),
    });
  }, [run, unusable, usable]);

  const allReady = usable.length > 0 && usable.every(
    (s) => s.type === 'text' ? s.text.trim().length > 0 : s.imageBytes,
  );

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="doodle-section space-y-2.5"
    >
      <motion.p variants={fadeUp} className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Sign PDF</motion.p>

      {/*
         Honest document state: the overlay measures the page it drew, so until a
         PDF is open there is no page size to place anything on.
      */}
      {!file && (
        <motion.p variants={scaleIn} className="rounded-[12px] border border-cream-border bg-cream-soft px-3 py-2 text-[10px] leading-relaxed text-ink-muted">
          No PDF is open. Prepare a signature now and it is kept in this tab, but nothing can be placed or sized until a document is loaded.
        </motion.p>
      )}
      {file && st.totalPages > 0 && (
        <p className="font-mono text-[10px] tabular-nums text-ink-muted" data-sign-doc-pages={st.totalPages}>
          {file.name} · {st.totalPages} page{st.totalPages === 1 ? '' : 's'} · placing on page {st.page}
          {st.totalPages === 1 ? ' (this document has one page)' : ''}
        </p>
      )}
      {notice && (
        <motion.p
          variants={scaleIn}
          role="status"
          data-sign-notice
          className="rounded-[12px] border border-accent/25 bg-accent/[0.06] px-3 py-2 text-[10px] leading-relaxed text-ink-soft"
        >
          {notice}
        </motion.p>
      )}

      {/* What the run had to admit: marks it pulled inside the page, fonts it
          could not load offline, images it could not embed. */}
      {warnings.length > 0 && (
        <motion.ul
          variants={scaleIn}
          role="status"
          data-sign-warnings={warnings.length}
          className="space-y-1 rounded-[12px] border border-warn/25 bg-warn/[0.07] p-2.5"
        >
          {warnings.map((warning) => (
            <li key={warning} className="text-[10px] leading-relaxed text-ink-soft">· {warning}</li>
          ))}
        </motion.ul>
      )}

      {/* Tab bar */}
      <motion.div variants={fadeUp} role="tablist" aria-label="Signature type" className="flex gap-0.5">
        {([
          ['text', 'Text'],
          ['image', 'Image'],
          ['draw', 'Draw'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={`sig-tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`sig-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              // Arrow keys walk the three tabs; the panel itself stays reachable
              // by Tab from the selected one.
              const order = ['text', 'image', 'draw'] as const;
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = order[(order.indexOf(key) + step + order.length) % order.length];
              setTab(next);
              document.getElementById(`sig-tab-${next}`)?.focus();
            }}
            className={`relative flex-1 text-[10px] font-medium py-1.5 rounded-[10px] px-3 transition-colors ${
              tab === key ? 'text-accent' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {tab === key && (
              <motion.span
                layoutId="sig-tab-indicator"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="absolute inset-0 rounded-[10px] bg-accent/[0.08] ring-1 ring-inset ring-accent/30"
              />
            )}
            <span className="relative">{label}</span>
          </button>
        ))}
      </motion.div>

      {/* Tab content */}
      {tab === 'text' && (
        <motion.div variants={fadeUp} role="tabpanel" aria-labelledby="sig-tab-text" id="sig-panel-text" className="space-y-2">
          <input type="text" value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Your name or initials…"
            className="doodle-input text-xs" />
          <div className="grid grid-cols-4 gap-1.5">
            <select value={textFont} onChange={(e) => setTextFont(e.target.value)}
              className="doodle-input text-[10px] col-span-2">
              {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)}
              className="w-full h-7 rounded-[10px] bg-cream border border-cream-border cursor-pointer" />
            <input type="number" value={textW} min={60} max={400}
              onChange={(e) => setTextW(Number(e.target.value))}
              className="doodle-input text-center text-[10px]" placeholder="W" />
          </div>
          <button onClick={addTextToPDF} disabled={!textValue.trim()}
            title={textValue.trim() ? undefined : 'Type the name or initials to add'}
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            Add text to PDF
          </button>
        </motion.div>
      )}

      {tab === 'image' && (
        <motion.div variants={fadeUp} role="tabpanel" aria-labelledby="sig-tab-image" id="sig-panel-image" className="space-y-2">
          <input ref={fileInputRef} type="file" accept="image/*"
            onChange={handleImagePicked} className="doodle-input text-[10px]" />
          {imageUrl && (
            <>
              <img src={imageUrl} className="h-10 object-contain rounded-[10px] bg-cream" alt="Preview" />
              <div className="flex gap-1.5">
                <input type="number" value={imageW} min={30} max={400}
                  onChange={(e) => setImageW(Number(e.target.value))}
                  className="doodle-input text-center text-[10px] flex-1" placeholder="W" />
                <input type="number" value={imageH} min={20} max={400}
                  onChange={(e) => setImageH(Number(e.target.value))}
                  className="doodle-input text-center text-[10px] flex-1" placeholder="H" />
              </div>
            </>
          )}
          <button onClick={addImageToPDF} disabled={!imageBytes}
            title={imageBytes ? undefined : 'Choose a picture of your signature first'}
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            Add image to PDF
          </button>
        </motion.div>
      )}

      {tab === 'draw' && (
        <motion.div variants={fadeUp} role="tabpanel" aria-labelledby="sig-tab-draw" id="sig-panel-draw" className="space-y-2">
          <div className="border border-cream-border rounded-[10px] overflow-hidden bg-white shadow-doodle">
            <canvas ref={drawCanvasRef}
              onMouseDown={drawStart} onMouseMove={drawMove} onMouseUp={drawEnd} onMouseLeave={drawEnd}
              onTouchStart={drawStart} onTouchMove={drawMove} onTouchEnd={drawEnd}
              className="w-full cursor-crosshair touch-none bg-white" style={{ height: 80 }} />
          </div>
          <div className="flex gap-1.5">
            <button onClick={clearDrawCanvas} className="doodle-chip text-[10px] doodle-chip-inactive flex-1">Clear</button>
            <input type="number" value={drawW} min={30} max={400}
              onChange={(e) => setDrawW(Number(e.target.value))}
              className="doodle-input text-center text-[10px] w-16" placeholder="W" />
            <input type="number" value={drawH} min={20} max={200}
              onChange={(e) => setDrawH(Number(e.target.value))}
              className="doodle-input text-center text-[10px] w-16" placeholder="H" />
          </div>
          <button onClick={addDrawToPDF} disabled={!drawBytes}
            title={drawBytes ? undefined : 'Sign in the box above first — an empty pad adds nothing'}
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            Add drawing to PDF
          </button>
        </motion.div>
      )}

      {/* Properties (when item selected) */}
      {selected && (
        <motion.div variants={scaleIn} className="space-y-1.5 rounded-[12px] border border-cream-border bg-white p-3 shadow-doodle">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
            {selected.type === 'text' ? 'Text' : selected.type === 'image' ? 'Image' : 'Drawing'} · Page {selected.page}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Width</label>
              <input type="number" value={Math.round(selected.w)} min={30} max={500}
                onChange={(e) => update({ w: Number(e.target.value) })}
                className="doodle-input text-center text-xs" />
            </div>
            <div>
              <label className="block font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Height</label>
              <input type="number" value={Math.round(selected.h)} min={14} max={500}
                onChange={(e) => update({ h: Number(e.target.value) })}
                className="doodle-input text-center text-xs" />
            </div>
          </div>
          {selected.type === 'text' && (
            <>
              <input type="text" value={selected.text}
                onChange={(e) => update({ text: e.target.value })}
                placeholder="Signature text" className="doodle-input text-xs" />
              <div className="grid grid-cols-2 gap-1.5">
                <select value={selected.fontFamily ?? 'Helvetica'}
                  onChange={(e) => update({ fontFamily: e.target.value })}
                  className="doodle-input text-[10px]">
                  {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <input type="color" value={selected.color ?? '#000000'}
                  onChange={(e) => update({ color: e.target.value })}
                  className="w-full h-7 rounded-[10px] bg-cream border border-cream-border" />
              </div>
            </>
          )}
          {selected.type !== 'text' && selected.imageDataUrl && (
            <img src={selected.imageDataUrl} className="h-10 object-contain rounded-[10px] bg-cream" alt="" />
          )}
        </motion.div>
      )}

      {/* Saved signatures: prepare once, place on every page that needs it */}
      {st.items.length > 0 && (
        <motion.div variants={fadeUp} className="border-t border-cream-border pt-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted mb-1">
            Saved signatures ({st.items.length})
          </p>
          <div role="listbox" aria-label="Saved signatures" className="space-y-0.5 max-h-24 overflow-y-auto">
            {st.items.map((item) => (
              <div key={item.id}
                role="option"
                aria-selected={item.id === st.selectedId}
                tabIndex={0}
                onClick={() => selectSigItem(item.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectSigItem(item.id);
                  } else if ((event.key === 'd' || event.key === 'D') && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    placeAgain(item);
                  } else if (event.key === 'Delete' || event.key === 'Backspace') {
                    event.preventDefault();
                    removeSigItem(item.id);
                  }
                }}
                className={`flex items-center gap-1.5 p-1 rounded-[10px] cursor-pointer text-[10px] transition-colors duration-150
                  ${item.id === st.selectedId ? 'bg-accent/[0.06] border border-accent/60 shadow-glow' : 'bg-white border border-cream-border hover:border-[#D5D5CD]'}`}
              >
                <span className="text-xs shrink-0">
                  {item.type === 'text' ? 'T' : item.type === 'image' ? '🖼' : '✎'}
                </span>
                <span className="flex-1 truncate">
                  {item.type === 'text' ? (item.text || '(empty)') : item.type === 'image' ? 'Image' : 'Drawing'}
                  {' · p.'}{item.page}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); placeAgain(item); }}
                  aria-label={`Place the ${item.type} signature again on page ${st.page}`}
                  title={`Place a copy on page ${st.page}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-ink-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent"
                >＋</button>
                <button
                  onClick={(e) => { e.stopPropagation(); removeSigItem(item.id); }}
                  aria-label={`Remove the ${item.type} signature on page ${item.page}`}
                  title={`Remove the ${item.type} signature on page ${item.page}`}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] text-danger transition-colors duration-150 hover:bg-danger/10"
                >✕</button>
              </div>
            ))}
          </div>
          <p className="mt-1 text-[9px] leading-relaxed text-ink-muted">
            Select one and press Ctrl/Cmd-D, or use the plus button, to place another copy on page {st.page}.
          </p>
        </motion.div>
      )}

      {/* Why the button is off, in words next to it rather than only in a tooltip. */}
      {!allReady && (
        <p className="text-[10px] leading-relaxed text-ink-muted" data-sign-blocked>
          {usable.length === 0
            ? !file
              ? 'Open a PDF, then add a signature above — there is nothing to write yet.'
              : 'Add a signature above: type one, upload a picture, or draw it.'
            : 'Every placed signature needs text, a picture or a stroke inside it.'}
        </p>
      )}
      {unusable.length > 0 && (
        <p className="text-[10px] leading-relaxed text-warn" data-sign-offpage={unusable.length}>
          {unusable.length} signature{unusable.length === 1 ? '' : 's'} sit on a page this document does not have and
          will be left out — move them to a page that exists.
        </p>
      )}

      <button
        onClick={handleProcess}
        id="tool-process-btn"
        className="doodle-btn"
        disabled={!allReady || !file || isRunning}
        title={
          !file
            ? 'Open a PDF to sign first'
            : !allReady
              ? usable.length === 0
                ? 'Nothing placed yet — add a signature from the tabs above'
                : 'Every placed signature needs text, a picture or a stroke'
              : undefined
        }
      >
        {isRunning ? 'Placing…' : `Place ${usable.length > 0 ? `${usable.length} ` : ''}signature${usable.length === 1 ? '' : 's'}`}
      </button>
    </motion.div>
  );
}
