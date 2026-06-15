/**
 * SignTool — Sidebar for Sign PDF.
 *
 * Prepare signatures via tabs (Text | Image | Draw),
 * then click "Add to PDF" to place them on the page.
 * The overlay (SignMain) handles positioning, resizing, and editing.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { usePDFEngine } from '@/hooks/usePDFEngine';
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
  const { process } = usePDFEngine();
  const [st, setSt] = useState(getSignState());
  const [tab, setTab] = useState<SigTab>('text');
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawActive = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [textValue, setTextValue] = useState('');
  const [textFont, setTextFont] = useState('Helvetica');
  const [textColor, setTextColor] = useState('#000000');
  const [textW, setTextW] = useState(180);
  const [textH, setTextH] = useState(40);

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

  const addTextToPDF = useCallback(() => {
    if (!textValue.trim()) return;
    addSigItem({
      id: nextId(), type: 'text',
      text: textValue,
      imageDataUrl: null, imageBytes: null,
      w: textW, h: textH,
      color: textColor, fontFamily: textFont,
    });
    setTextValue('');
  }, [textValue, textW, textH, textColor, textFont]);

  const addImageToPDF = useCallback(() => {
    if (!imageBytes) return;
    addSigItem({
      id: nextId(), type: 'image',
      text: '',
      imageDataUrl: imageUrl, imageBytes,
      w: imageW, h: imageH,
    });
    setImageUrl(null); setImageBytes(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [imageBytes, imageUrl, imageW, imageH]);

  const addDrawToPDF = useCallback(() => {
    if (!drawBytes) return;
    addSigItem({
      id: nextId(), type: 'draw',
      text: '',
      imageDataUrl: drawUrl, imageBytes: drawBytes,
      w: drawW, h: drawH,
    });
    setDrawUrl(null); setDrawBytes(null);
    clearDrawCanvas();
  }, [drawBytes, drawUrl, drawW, drawH]);

  const handleImagePicked = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed'));
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) return;
    const bytes = await blob.arrayBuffer();
    setImageUrl(URL.createObjectURL(blob));
    setImageBytes(bytes);
    const maxW = 150;
    const aspect = img.naturalWidth / img.naturalHeight;
    setImageW(Math.min(maxW, img.naturalWidth));
    setImageH(Math.min(maxW, img.naturalWidth) / aspect);
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

  const update = useCallback((patch: Partial<SigItem>) => {
    if (!selected) return;
    updateSigItem(selected.id, patch);
  }, [selected]);

  const handleProcess = useCallback(() => {
    const pageSize = getSignPageSize();
    const sigs = st.items.map((item) => ({
      type: item.type === 'draw' ? 'image' as const : item.type,
      imageData: item.type !== 'text' ? item.imageBytes : null,
      text: item.text,
      page: item.page,
      x: Math.round(item.x * pageSize.width),
      y: Math.round(item.y * pageSize.height),
      width: item.w, height: item.h,
      color: item.color, fontFamily: item.fontFamily,
    }));
    process({ toolId: 'sign', params: { signatures: sigs } });
  }, [process, st.items]);

  const allReady = st.items.length > 0 && st.items.every(
    (s) => s.type === 'text' ? s.text.trim().length > 0 : s.imageBytes,
  );

  return (
    <div className="doodle-section space-y-2.5">
      <p className="text-xs font-semibold text-ink">Sign PDF</p>

      {/* Tab bar */}
      <div className="flex gap-0.5">
        {([
          ['text', 'Text'],
          ['image', 'Image'],
          ['draw', 'Draw'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 text-[10px] font-medium py-1.5 rounded-doodle transition-colors ${
              tab === key
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'bg-cream text-ink-muted border border-cream-border hover:text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'text' && (
        <div className="space-y-2">
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
              className="w-full h-7 rounded bg-cream border border-cream-border cursor-pointer" />
            <input type="number" value={textW} min={60} max={400}
              onChange={(e) => setTextW(Number(e.target.value))}
              className="doodle-input text-center text-[10px]" placeholder="W" />
          </div>
          <button onClick={addTextToPDF} disabled={!textValue.trim()}
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            + Add Text to PDF
          </button>
        </div>
      )}

      {tab === 'image' && (
        <div className="space-y-2">
          <input ref={fileInputRef} type="file" accept="image/*"
            onChange={handleImagePicked} className="doodle-input text-[10px]" />
          {imageUrl && (
            <>
              <img src={imageUrl} className="h-10 object-contain rounded bg-white/50" alt="Preview" />
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
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            + Add Image to PDF
          </button>
        </div>
      )}

      {tab === 'draw' && (
        <div className="space-y-2">
          <div className="border border-cream-border rounded overflow-hidden bg-white">
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
            className="doodle-chip doodle-chip-active text-[10px] w-full disabled:opacity-30">
            + Add Drawing to PDF
          </button>
        </div>
      )}

      {/* Properties (when item selected) */}
      {selected && (
        <div className="space-y-1.5 border-t border-cream-border pt-2">
          <p className="text-[10px] font-medium text-ink-muted uppercase tracking-wider">
            {selected.type === 'text' ? 'Text' : selected.type === 'image' ? 'Image' : 'Drawing'} · Page {selected.page}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="text-[10px] text-ink-muted">Width</label>
              <input type="number" value={Math.round(selected.w)} min={30} max={500}
                onChange={(e) => update({ w: Number(e.target.value) })}
                className="doodle-input text-center text-xs" />
            </div>
            <div>
              <label className="text-[10px] text-ink-muted">Height</label>
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
                  className="w-full h-7 rounded bg-cream border border-cream-border" />
              </div>
            </>
          )}
          {selected.type !== 'text' && selected.imageDataUrl && (
            <img src={selected.imageDataUrl} className="h-10 object-contain rounded bg-white/50" alt="" />
          )}
        </div>
      )}

      {/* Signature list */}
      {st.items.length > 0 && (
        <div className="border-t border-cream-border pt-2">
          <p className="text-[10px] font-medium text-ink-muted mb-1">
            Placed ({st.items.length})
          </p>
          <div className="space-y-0.5 max-h-24 overflow-y-auto">
            {st.items.map((item) => (
              <div key={item.id}
                onClick={() => selectSigItem(item.id)}
                className={`flex items-center gap-1.5 p-1 rounded cursor-pointer text-[10px] transition-colors
                  ${item.id === st.selectedId ? 'bg-accent/10 border border-accent/30' : 'bg-cream/50 border border-transparent hover:bg-cream'}`}
              >
                <span className="text-xs shrink-0">
                  {item.type === 'text' ? 'T' : item.type === 'image' ? '🖼' : '✎'}
                </span>
                <span className="flex-1 truncate">
                  {item.type === 'text' ? (item.text || '(empty)') : item.type === 'image' ? 'Image' : 'Drawing'}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeSigItem(item.id); }}
                  className="text-red-400 hover:text-red-500 text-xs shrink-0">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn" disabled={!allReady}>
        Apply All Signatures
      </button>
    </div>
  );
}
