import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { downloadBlob, downloadMultipleBlobs, getOutputFileName, formatFileSize, formatCompressionRatio } from '@/lib/utils/download';
import { fadeUp, scaleIn, springSoft, tapDown } from '@/lib/motion';
import {
  OutputPreview,
  noPreviewCopy,
  outputKind,
  type OutputKind,
} from '@/components/tools/pdf/shared/OutputPreview';

interface OutputActionsProps {
  onCancel?: () => void;
}

/** Named after what the bytes are, never after which tool was open. */
const DOCUMENT_LABEL: Partial<Record<OutputKind, string>> = {
  document: 'Word Document',
  spreadsheet: 'Spreadsheet',
  text: 'Text file',
  other: 'File',
};

const DOCUMENT_GLYPH: Partial<Record<OutputKind, string>> = {
  document: '📝',
  spreadsheet: '📊',
  text: '📃',
  other: '📄',
};

export function OutputActions({ onCancel }: OutputActionsProps) {
  const { outputBlob, outputUrl, outputBlobs, outputUrls, outputNames, label, suffix } = useProcessStore();
  const file = useFileStore((s) => s.file);
  const activeTool = useFileStore((s) => s.activeTool);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const prevLengthRef = useRef(0);

  const isVideoOutput = outputBlob?.type.startsWith('video/') ?? false;
  const isGifOutput = outputBlob?.type.includes('gif') ?? false;
  const isAudioOutput = outputBlob?.type.includes('mpeg') ?? false;
  const hasMultiple = outputBlobs.length > 1;
  const allBlobs: Blob[] = hasMultiple ? outputBlobs : (outputBlob ? [outputBlob] : []);
  const allUrls: string[] = hasMultiple ? outputUrls : (outputUrl ? [outputUrl] : []);
  const blobCount = allBlobs.length;
  // Derived from the produced blobs, not from a hard-coded tool list: the PDF
  // catalogue now emits many more formats than it used to.
  const allImages = allBlobs.length > 0 && allBlobs.every((b) => b.type.startsWith('image/'));
  const isImageGallery = activeTool === 'pdf-to-image' || (allImages && hasMultiple);
  const isDocumentOutput =
    !outputBlob?.type.includes('pdf') && !(outputBlob?.type.startsWith('image/') ?? false);
  /** More than one non-image result, e.g. Split PDF or unmerged Extract Pages. */
  const isFileList = blobCount > 1 && !isImageGallery;
  /** What the single file actually is, so the panel never guesses "Excel". */
  const primaryKind: OutputKind = outputBlob
    ? outputKind(outputNames[0] ?? 'output.bin', outputBlob.type)
    : 'other';
  /** A container has entries to list; the shared preview does that honestly. */
  const isArchive = !hasMultiple && primaryKind === 'archive';

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

  const nameFor = (index: number): string => {
    const stored = outputNames[index];
    if (stored) return stored;
    const fallbackBase = file?.name ?? 'document';
    return getOutputFileName(fallbackBase, activeTool ?? 'merge').replace(
      /(\.[a-z0-9]+)$/i,
      `-${index + 1}$1`,
    );
  };

  const handleDownloadSelected = () => {
    const indices = allIndices.filter((i) => selected.has(i));
    if (indices.length === 0) return;
    if (indices.length === 1) {
      downloadBlob(allBlobs[indices[0]], nameFor(indices[0]));
      return;
    }
    indices.forEach((index, order) => {
      setTimeout(() => downloadBlob(allBlobs[index], nameFor(index)), order * 220);
    });
  };

  const handleDownloadAll = () => {
    if (allImages || blobCount > 6) {
      void downloadAllAsZip();
      return;
    }
    allIndices.forEach((index, order) => {
      setTimeout(() => downloadBlob(allBlobs[index], nameFor(index)), order * 220);
    });
  };

  const downloadAllAsZip = async (): Promise<void> => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    allBlobs.forEach((blob, index) => {
      zip.file(nameFor(index), blob);
    });
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    downloadBlob(blob, `${(file?.name ?? 'browsersnip').replace(/\.[^.]+$/, '')}-results.zip`);
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

  /**
   * Copying is a courtesy, so a refusal is quiet.
   *
   * The bytes are always reachable through Download; the clipboard can say no for
   * reasons the user cannot act on here (no permission, a non-secure context, a
   * format the clipboard will not take), so each failure falls to the next
   * option and the button simply never changes if none of them work.
   */
  const handleCopy = useCallback(async () => {
    const copied = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    };
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({ [outputBlob.type || 'application/pdf']: outputBlob }),
        ]);
        copied();
        return;
      }
    } catch {
      // No file on the clipboard: the name below is the next best thing to it.
    }
    try {
      const fileName = getOutputFileName(file?.name ?? 'document.pdf', activeTool ?? 'merge');
      await navigator.clipboard.writeText(fileName);
      copied();
    } catch {
      // Nothing was copied, and saying so is the button's job: it stays "Copy".
    }
  }, [outputBlob, file, activeTool]);

  // Simple output bar for video tools
  if (isVideoOutput || isGifOutput || isAudioOutput) {
    const sizeMB = (outputBlob.size / 1_000_000).toFixed(1);
    return (
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="space-y-4 p-6 max-w-md mx-auto"
      >
        <div className="flex items-center justify-between text-xs">
          <motion.span
            variants={scaleIn}
            className="font-semibold text-success flex items-center gap-1.5"
          >
            <span>✓</span> {label}
          </motion.span>
          <span className="font-mono font-medium text-ink-muted tabular-nums">{sizeMB} MB</span>
        </div>

        <motion.button
          onClick={handleDownloadSimple}
          whileHover={{ y: -1 }}
          whileTap={tapDown}
          transition={springSoft}
          className="doodle-btn block w-full text-center"
        >
          Download File
        </motion.button>

        {isGifOutput ? (
          <motion.img
            variants={scaleIn}
            src={outputUrl}
            alt="Processed GIF"
            className="w-full sketch-border"
          />
        ) : !isAudioOutput ? (
          /* eslint-disable-next-line jsx-a11y/media-has-caption */
          <motion.video
            variants={scaleIn}
            src={outputUrl}
            controls
            className="w-full sketch-border"
          />
        ) : null}
      </motion.div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Action bar */}
      <motion.div
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="shrink-0 flex items-center gap-2.5 border-b border-cream-border bg-white/90 backdrop-blur-subtle px-4 py-2.5"
      >
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
          <motion.button
            onClick={onCancel}
            whileTap={tapDown}
            transition={springSoft}
            className="inline-flex items-center gap-1.5 rounded-doodle-md border border-cream-border bg-white px-3 py-1.5 text-[11px] font-semibold text-ink-muted shadow-doodle hover:border-danger/30 hover:text-danger transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
            Cancel
          </motion.button>
        )}

        {!isImageGallery && !isDocumentOutput && (
          <motion.button
            onClick={handleCopy}
            whileTap={tapDown}
            transition={springSoft}
            className={`inline-flex items-center gap-1.5 rounded-doodle-md border px-3 py-1.5 text-[11px] font-semibold transition-colors ${copied ? 'border-success/40 bg-success/10 text-success' : 'border-accent/30 bg-accent/5 text-accent hover:bg-accent/15'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              {copied ? <polyline points="20 6 9 17 4 12" /> : <><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>}
            </svg>
            {copied ? 'Copied' : 'Copy'}
          </motion.button>
        )}

        {isImageGallery || isFileList ? (
          <>
            <motion.button
              onClick={handleDownloadSelected}
              disabled={selectedCount === 0}
              whileTap={selectedCount === 0 ? undefined : tapDown}
              transition={springSoft}
              className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent/30 bg-accent/5 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/15 transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download ({selectedCount})
            </motion.button>
            <motion.button
              onClick={handleDownloadAll}
              whileHover={{ y: -1 }}
              whileTap={tapDown}
              transition={springSoft}
              className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-doodle hover:bg-accent-hover transition-colors"
            >
              Download All
            </motion.button>
          </>
        ) : (
          <motion.button
            onClick={handleDownloadSimple}
            whileHover={{ y: -1 }}
            whileTap={tapDown}
            transition={springSoft}
            className="inline-flex items-center gap-1.5 rounded-doodle-md border border-accent bg-accent px-3 py-1.5 text-[11px] font-semibold text-white shadow-doodle hover:bg-accent-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </motion.button>
        )}
      </motion.div>

      {/* Content area */}
      {isFileList ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <button onClick={toggleAll} className="flex w-full items-center gap-2 border-b border-cream-border px-4 py-2 text-left transition-colors hover:bg-cream-soft">
            <span className={`inline-flex h-4 w-4 items-center justify-center rounded border-2 transition-colors ${allSelected ? 'border-accent bg-accent' : 'border-cream-border'}`}>
              {allSelected && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </span>
            <span className="text-[11px] font-semibold text-ink-soft">{allSelected ? 'Deselect All' : 'Select All'}</span>
            <span className="ml-auto text-[10px] text-ink-muted">{blobCount} files · {formatFileSize(totalSize)}</span>
          </button>
          {allBlobs.map((blob, i) => {
            const isSel = selected.has(i);
            return (
              <button
                key={`${nameFor(i)}-${i}`}
                onClick={() => toggleSelect(i)}
                className={`flex w-full items-center gap-3 border-b border-cream-border/50 px-4 py-2.5 text-left transition-colors hover:bg-cream-soft ${isSel ? 'bg-accent/5' : ''}`}
              >
                <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors ${isSel ? 'border-accent bg-accent' : 'border-cream-border'}`}>
                  {isSel && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="shrink-0 text-sm">📄</span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">{nameFor(i)}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-ink-muted">{formatFileSize(blob.size)}</span>
              </button>
            );
          })}
        </div>
      ) : isImageGallery ? (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <button onClick={toggleAll} className="flex items-center gap-2 w-full px-4 py-2 text-left hover:bg-cream-soft transition-colors border-b border-cream-border">
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
                className="flex items-center gap-3 w-full px-4 py-2 text-left hover:bg-cream-soft transition-colors border-b border-cream-border/50"
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
      ) : isArchive ? (
        /*
         * A zip has no page to draw, but "here is your archive" and a bare icon
         * is a weak answer: the shared preview opens the container in the tab and
         * lists what is inside, so the user can see the run worked before taking
         * the file. The bar above still owns the download.
         */
        <div className="min-h-0 flex-1 overflow-y-auto bg-cream-soft p-4">
          <OutputPreview
            items={[{ name: nameFor(0), blob: outputBlob, url: outputUrl }]}
          />
        </div>
      ) : isDocumentOutput ? (
        <div className="flex-1 min-h-0 flex items-center justify-center bg-cream-soft p-8">
          <div className="text-center max-w-xs">
            <div className="mb-4 text-5xl" aria-hidden>
              {DOCUMENT_GLYPH[primaryKind] ?? '\u{1F4C4}'}
            </div>
            <p className="text-sm font-semibold text-ink">
              {DOCUMENT_LABEL[primaryKind] ?? 'File'}
            </p>
            <p className="mt-1.5 text-xs text-ink-muted">
              {formatFileSize(outputBlob.size)} — ready to download
            </p>
            <p className="mt-3 text-[10px] leading-relaxed text-ink-muted/70">
              {noPreviewCopy(primaryKind, nameFor(0))}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 bg-cream-soft">
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
