import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { downloadBlob, downloadMultipleBlobs, getOutputFileName, formatFileSize, formatCompressionRatio } from '@/lib/utils/download';

interface OutputActionsProps {
  onCancel?: () => void;
}

export function OutputActions({ onCancel }: OutputActionsProps) {
  const { outputBlob, outputUrl, outputBlobs, outputUrls, label, suffix } = useProcessStore();
  const file = useFileStore((s) => s.file);
  const activeTool = useFileStore((s) => s.activeTool);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const prevLengthRef = useRef(0);

  const isImageGallery = activeTool === 'pdf-to-image';
  const isDocumentOutput = activeTool === 'pdf-to-word' || activeTool === 'pdf-to-excel';
  const isVideoOutput = outputBlob?.type.startsWith('video/') ?? false;
  const isGifOutput = outputBlob?.type.includes('gif') ?? false;
  const isAudioOutput = outputBlob?.type.includes('mpeg') ?? false;
  const hasMultiple = outputBlobs.length > 1;
  const allBlobs: Blob[] = hasMultiple ? outputBlobs : (outputBlob ? [outputBlob] : []);
  const allUrls: string[] = hasMultiple ? outputUrls : (outputUrl ? [outputUrl] : []);
  const blobCount = allBlobs.length;

  useEffect(() => {
    if (blobCount !== prevLengthRef.current) {
      prevLengthRef.current = blobCount;
      setSelected(new Set(Array.from({ length: blobCount }, (_, i) => i)));
    }
  }, [blobCount]);

  if (!outputBlob || !outputUrl) return null;

  const totalSize = allBlobs.reduce((sum, b) => sum + b.size, 0);
  const selectedCount = selected.size;
  const allSelected = selectedCount === allBlobs.length;
  const allIndices = Array.from({ length: blobCount }, (_, i) => i);
  const originalSize = file?.size ?? 0;
  const compressedSize = outputBlob.size;

  const toggleSelect = (i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(allIndices));
    }
  };

  const handleDownloadSelected = () => {
    const toDownload = allBlobs.filter((_, i) => selected.has(i));
    if (toDownload.length === 0) return;
    if (toDownload.length === 1) {
      const pageNum = allIndices.find((i) => selected.has(i))! + 1;
      const ext = toDownload[0].type.split('/')[1] ?? 'jpg';
      const baseName = getOutputFileName(file?.name ?? 'page', activeTool ?? 'pdf-to-image');
      downloadBlob(toDownload[0], baseName.replace(/\.[^.]+$/, `_${pageNum}.${ext}`));
    } else {
      downloadMultipleBlobs(toDownload, getOutputFileName(file?.name ?? 'document', activeTool ?? 'pdf-to-image'));
    }
  };

  const handleDownloadAll = () => {
    downloadMultipleBlobs(allBlobs, getOutputFileName(file?.name ?? 'document', activeTool ?? 'pdf-to-image'));
  };

  // ── Simple single download for video/audio/gif tools ──
  const handleDownloadSimple = () => {
    if (!outputBlob) return;
    const fileName = file?.name ?? 'output';
    if (isVideoOutput || isGifOutput || isAudioOutput) {
      const ext = isGifOutput ? 'gif' : isAudioOutput ? 'mp3' : 'mp4';
      const base = fileName.replace(/\.[^/.]+$/, '');
      downloadBlob(outputBlob, `${base}_${suffix}.${ext}`);
    } else {
      downloadBlob(outputBlob, getOutputFileName(fileName, activeTool ?? 'merge'));
    }
  };

  const handleCopy = useCallback(async () => {
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ [outputBlob.type || 'application/pdf']: outputBlob }),
        ]);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      }
    } catch {}
    try {
      const fileName = getOutputFileName(file?.name ?? 'document.pdf', activeTool ?? 'merge');
      await navigator.clipboard.writeText(fileName);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }, [outputBlob, file, activeTool]);

  // Simple output bar for video tools
  if (isVideoOutput || isGifOutput || isAudioOutput) {
    const sizeMB = (outputBlob.size / 1_000_000).toFixed(1);
    return (
      <div className="space-y-4 animate-doodle-pop p-6 max-w-md mx-auto">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-success flex items-center gap-1.5">
            <span>✓</span> {label}
          </span>
          <span className="font-mono font-medium text-ink-muted">{sizeMB} MB</span>
        </div>

        <button onClick={handleDownloadSimple} className="doodle-btn">
          Download File
        </button>

        {isGifOutput ? (
          <img
            src={outputUrl}
            alt="Processed GIF"
            className="w-full sketch-border"
          />
        ) : !isAudioOutput ? (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <video
            src={outputUrl}
            controls
            className="w-full sketch-border"
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden animate-fade-in">
      {/* Action bar */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-cream-border bg-cream-light/90 backdrop-blur-sm px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-ink shrink-0">
            {hasMultiple ? `${allBlobs.length} files` : 'Ready'}
          </span>
          <span className="text-[11px] text-ink-muted tabular-nums shrink-0">
            {formatFileSize(totalSize)}
          </span>
          {originalSize > 0 && !hasMultiple && (
            <span className="text-[11px] text-success font-semibold shrink-0">
              {formatCompressionRatio(originalSize, compressedSize)}
            </span>
          )}
        </div>

        <div className="flex-1" />

        {onCancel && (
          <button onClick={onCancel} className="inline-flex items-center gap-1.5 rounded-doodle-md border border-cream-border bg-cream-light px-3 py-1.5 text-[11px] font-semibold text-ink-muted hover:border-danger/30 hover:text-danger transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Cancel
          </button>
        )}

        {!isImageGallery && !isDocumentOutput && (
          <button onClick={handleCopy} className={`inline-flex items-center gap-1.5 rounded-doodle-md border px-3 py-1.5 text-[11px] font-semibold transition-colors ${copied ? 'border-success/40 bg-success/10 text-success' : 'border-accent/30 bg-accent/5 text-accent hover:bg-accent/15'}`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {copied ? <polyline points="20 6 9 17 4 12" /> : <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>}
            </svg>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}

        {isImageGallery ? (
          <>
            <button onClick={handleDownloadSelected} disabled={selectedCount === 0} className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/15 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download ({selectedCount})
            </button>
            <button onClick={handleDownloadAll} className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent/40 bg-accent px-3 py-1.5 text-[11px] font-semibold text-cream-light hover:bg-accent-hover transition-colors">
              Download All
            </button>
          </>
        ) : (
          <button onClick={handleDownloadSimple} className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent/40 bg-accent px-3 py-1.5 text-[11px] font-semibold text-cream-light hover:bg-accent-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
        )}
      </div>

      {/* Content area */}
      {isImageGallery ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <button onClick={toggleAll} className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-cream-light/50 transition-colors border-b border-cream-border">
            <span className={`inline-flex items-center justify-center w-4 h-4 rounded border-2 transition-colors ${allSelected ? 'bg-accent border-accent' : 'border-cream-border'}`}>
              {allSelected && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span className="text-[11px] font-semibold text-ink-soft">{allSelected ? 'Deselect All' : 'Select All'}</span>
          </button>

          {allBlobs.map((blob, i) => {
            const isSel = selected.has(i);
            const url = allUrls[i] ?? URL.createObjectURL(blob);
            return (
              <button
                key={i}
                onClick={() => toggleSelect(i)}
                className="flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-cream-light/50 transition-colors border-b border-cream-border/50"
              >
                <span className={`inline-flex items-center justify-center w-4 h-4 rounded border-2 shrink-0 transition-colors ${isSel ? 'bg-accent border-accent' : 'border-cream-border'}`}>
                  {isSel && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <img src={url} alt={`Page ${i + 1}`} className="h-12 w-9 object-cover rounded border border-cream-border shrink-0" />
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold text-ink">Page {i + 1}</span>
                  <span className="ml-2 text-[10px] text-ink-muted">{formatFileSize(blob.size)}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : isDocumentOutput ? (
        <div className="flex-1 min-h-0 flex items-center justify-center bg-cream-dark/20 p-8">
          <div className="text-center max-w-xs">
            <div className="mb-4 text-5xl">
              {activeTool === 'pdf-to-word' ? '📝' : '📊'}
            </div>
            <p className="text-sm font-semibold text-ink">
              {activeTool === 'pdf-to-word' ? 'Word Document' : 'Excel Spreadsheet'}
            </p>
            <p className="mt-1.5 text-xs text-ink-muted">
              {formatFileSize(outputBlob.size)} — ready to download
            </p>
            <p className="mt-3 text-[10px] text-ink-muted/70">
              {activeTool === 'pdf-to-word'
                ? 'Opens in Microsoft Word, Google Docs, or any word processor.'
                : 'Opens in Microsoft Excel, Google Sheets, or any spreadsheet app.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 bg-cream-dark/20">
          <iframe
            src={outputUrl}
            className="w-full h-full border-0 block"
            title="Output Preview"
          />
        </div>
      )}
    </div>
  );
}
