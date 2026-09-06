import { useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { TOOLS } from '@/lib/constants';
import {
  fadeUp,
  scaleIn,
  slideLeft,
  staggerParent,
  springSoft,
  tapDown,
  floatLoop,
} from '@/lib/motion';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { VideoPreview } from '@/components/player/VideoPreview';
import { PDFViewer } from '@/components/viewer/PDFViewer';
import { ThumbnailStrip } from '@/components/viewer/ThumbnailStrip';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { LogMonitor } from '@/components/ui/LogMonitor';
import { OutputActions } from '@/components/ui/OutputActions';
import { MemoryWarning } from '@/components/ui/MemoryWarning';
// Video tool components
import { TrimTool } from '@/components/tools/TrimTool';
import { ResizeTool } from '@/components/tools/ResizeTool';
import { CropTool } from '@/components/tools/CropTool';
import { CompressTool } from '@/components/tools/CompressTool';
import { GifTool } from '@/components/tools/GifTool';
import { AudioTool } from '@/components/tools/AudioTool';
import { SpeedTool } from '@/components/tools/SpeedTool';
import { MetadataTool } from '@/components/tools/MetadataTool';
// PDF tool components
import { MergeTool } from '@/components/tools/pdf/organize/MergeTool';
import { SplitTool } from '@/components/tools/pdf/organize/SplitTool';
import { RemovePagesTool } from '@/components/tools/pdf/organize/RemovePagesTool';
import { ExtractPagesTool } from '@/components/tools/pdf/organize/ExtractPagesTool';
import { OrganizeTool } from '@/components/tools/pdf/organize/OrganizeTool';
import { OrganizeMain } from '@/components/tools/pdf/organize/OrganizeMain';
import { RotateTool } from '@/components/tools/pdf/organize/RotateTool';
import { CompressTool as PdfCompressTool } from '@/components/tools/pdf/optimize/CompressTool';
import { RepairTool } from '@/components/tools/pdf/optimize/RepairTool';
import { ImageToPDFTool } from '@/components/tools/pdf/convert-to/ImageToPDFTool';
import { DigitizeDocumentTool } from '@/components/tools/pdf/convert-to/DigitizeDocumentTool';
import { ImageToPdfMain } from '@/components/tools/pdf/convert-to/ImageToPdfMain';
import { HTMLToPDFTool } from '@/components/tools/pdf/convert-to/HTMLToPDFTool';
import { PDFToImageTool } from '@/components/tools/pdf/convert-from/PDFToImageTool';
import { PDFToWordTool } from '@/components/tools/pdf/convert-from/PDFToWordTool';
import { PDFToExcelTool } from '@/components/tools/pdf/convert-from/PDFToExcelTool';
import { PDFToPdfATool } from '@/components/tools/pdf/convert-from/PDFToPdfATool';
import { WatermarkTool } from '@/components/tools/pdf/edit/WatermarkTool';
import { PageNumbersTool } from '@/components/tools/pdf/edit/PageNumbersTool';
import { CropTool as PdfCropTool } from '@/components/tools/pdf/edit/CropTool';
import { CropMain } from '@/components/tools/pdf/edit/CropMain';
import { ProtectTool } from '@/components/tools/pdf/security/ProtectTool';
import { UnlockTool } from '@/components/tools/pdf/security/UnlockTool';
import { SignTool } from '@/components/tools/pdf/security/SignTool';
import { SignMain } from '@/components/tools/pdf/security/SignMain';
import { RedactTool } from '@/components/tools/pdf/security/RedactTool';
import { RedactMain } from '@/components/tools/pdf/security/RedactMain';
import { CompareTool } from '@/components/tools/pdf/security/CompareTool';
import { CompareMain } from '@/components/tools/pdf/security/CompareMain';
import { ScanTool } from '@/components/tools/pdf/scan/ScanTool';
import { ScanMain } from '@/components/tools/pdf/scan/ScanMain';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { useUIStore } from '@/stores/ui-store';
import type { ToolId } from '@/types';

const TOOL_COMPONENTS: Record<string, React.ComponentType> = {
  // Video tools
  trim: TrimTool,
  resize: ResizeTool,
  crop: CropTool,
  compress: CompressTool,
  gif: GifTool,
  audio: AudioTool,
  speed: SpeedTool,
  metadata: MetadataTool,
  // PDF tools
  'merge': MergeTool,
  'split': SplitTool,
  'remove-pages': RemovePagesTool,
  'extract-pages': ExtractPagesTool,
  'organize': OrganizeTool,
  'rotate': RotateTool,
  'pdf-compress': PdfCompressTool,
  'repair': RepairTool,
  'image-to-pdf': ImageToPDFTool,
  'digitize-document': DigitizeDocumentTool,
  'html-to-pdf': HTMLToPDFTool,
  'pdf-to-image': PDFToImageTool,
  'pdf-to-word': PDFToWordTool,
  'pdf-to-excel': PDFToExcelTool,
  'pdf-to-pdfa': PDFToPdfATool,
  'watermark': WatermarkTool,
  'page-numbers': PageNumbersTool,
  'pdf-crop': PdfCropTool,
  'protect': ProtectTool,
  'unlock': UnlockTool,
  'sign': SignTool,
  'redact': RedactTool,
  'compare': CompareTool,
  'scan-to-pdf': ScanTool,
};

const TOOL_MAIN_COMPONENTS: Record<string, React.ComponentType> = {
  'organize': OrganizeMain,
  'scan-to-pdf': ScanMain,
  'image-to-pdf': ImageToPdfMain,
  'digitize-document': ImageToPdfMain,
  'pdf-crop': CropMain,
  'sign': SignMain,
  'redact': RedactMain,
  'compare': CompareMain,
};

// Spec §1 category accents — used only on the tool-header icon tile.
const TOOL_ACCENT: Record<string, { fg: string; tint: string }> = {
  video: { fg: '#2563EB', tint: 'rgba(37, 99, 235, 0.08)' },
  organize: { fg: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  'convert-to': { fg: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  'convert-from': { fg: '#7C3AED', tint: 'rgba(124, 58, 237, 0.08)' },
  edit: { fg: '#D97706', tint: 'rgba(217, 119, 6, 0.08)' },
  optimize: { fg: '#059669', tint: 'rgba(5, 150, 105, 0.08)' },
  security: { fg: '#059669', tint: 'rgba(5, 150, 105, 0.08)' },
};
const DEFAULT_ACCENT = TOOL_ACCENT.video;

export function ToolWorkspace() {
  const { toolId } = useParams<{ toolId: string }>();
  const navigate = useNavigate();
  const file = useFileStore((s) => s.file);
  const files = useFileStore((s) => s.files);
  const isLargeFile = useFileStore((s) => s.isLargeFile);
  const codecWarning = useFileStore((s) => s.codecWarning);
  const previewFileIndex = useFileStore((s) => s.previewFileIndex);
  const setPreviewFileIndex = useFileStore((s) => s.setPreviewFileIndex);
  const { isProcessing, outputUrl, outputBlob, error } = useProcessStore();
  const showLogs = useUIStore((s) => s.showLogMonitor);

  const setFileSession = useFileStore((s) => s.setActiveTool);
  const setProcessSession = useProcessStore((s) => s.setActiveTool);
  const persistFile = useFileStore((s) => s.persistCurrent);
  const persistProcess = useProcessStore((s) => s.persistCurrent);

  const mainRef = useRef<HTMLDivElement>(null);

  const handleCancelOutput = useCallback(() => {
    useProcessStore.getState().reset();
  }, []);

  useEffect(() => {
    const id = (toolId as ToolId) ?? null;
    setFileSession(id);
    setProcessSession(id);
    return () => {
      persistFile();
      persistProcess();
    };
  }, [toolId, setFileSession, setProcessSession, persistFile, persistProcess]);

  const tool = TOOLS.find((t) => t.id === toolId);
  const ToolComponent = toolId ? TOOL_COMPONENTS[toolId] : null;
  const ToolMainComponent = toolId ? TOOL_MAIN_COMPONENTS[toolId] : null;
  const isVideo = tool?.category === 'video';
  const isPDF = tool?.category !== undefined && tool?.category !== 'video';
  const isMultiFile = tool?.multiFile ?? false;
  const hasFiles = isMultiFile ? files.length > 0 : !!file;
  const isImageTool = toolId === 'image-to-pdf' || toolId === 'digitize-document';
  const isNoFileTool = toolId === 'scan-to-pdf' || toolId === 'html-to-pdf';

  const dropZoneProps = isImageTool
    ? {
        accept: '.jpg,.jpeg,.png,.webp,.gif,.avif,.tiff,.tif,image/*',
        label: 'Drop images here or click to browse',
        hint: 'Supports JPG, PNG, WEBP, GIF, AVIF, TIFF',
      }
    : isPDF
      ? { accept: '.pdf,application/pdf', label: 'Drop a PDF file or click to browse', hint: 'Max recommended: 500 MB' }
      : { accept: 'video/*' };

  const importLabel = isPDF
    ? (isImageTool ? 'Import images to get started' : 'Import a PDF to get started')
    : 'Import a video to get started';

  const dashboardPath = isVideo ? '/video' : '/pdf';
  const safePreviewIndex = Math.min(previewFileIndex, Math.max(0, files.length - 1));
  const previewFile = isMultiFile && files.length > 0 ? files[safePreviewIndex] : file;

  if (!tool) {
    return (
      <div className="flex h-screen items-center justify-center bg-cream">
        <div className="text-center animate-fade-in">
          <p className="mb-4 text-sm text-ink-muted">Tool not found.</p>
          <button
            onClick={() => navigate('/')}
            className="text-xs font-medium text-accent hover:text-accent-hover transition-colors"
          >
            &larr; Back to Home
          </button>
        </div>
      </div>
    );
  }

  const triggerProcess = () => {
    const el = document.getElementById('tool-process-btn');
    if (el) el.click();
  };

  const accent = TOOL_ACCENT[tool?.category ?? ''] ?? DEFAULT_ACCENT;

  return (
    <div className="flex h-full flex-col bg-cream overflow-hidden" ref={mainRef}>
      {/* ── Sub-header ── */}
      <motion.header
        variants={staggerParent}
        initial="hidden"
        animate="visible"
        className="flex h-14 shrink-0 items-center gap-3 border-b border-cream-border bg-white/85 backdrop-blur-subtle px-3 sm:px-4 z-20"
      >
        <motion.button
          variants={slideLeft}
          onClick={() => navigate(dashboardPath)}
          whileHover="hover"
          className="group flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
        >
          <motion.span
            aria-hidden
            className="inline-flex text-sm leading-none"
            variants={{ hover: { x: -3 } }}
            transition={springSoft}
          >
            &larr;
          </motion.span>
          <span className="hidden sm:inline">{isVideo ? 'Video Tools' : 'PDF Tools'}</span>
          <span className="sm:hidden">Back</span>
        </motion.button>
        <span className="text-cream-border text-xs font-bold select-none">/</span>
        <motion.div
          variants={fadeUp}
          className="flex min-w-0 items-center gap-2.5"
        >
          <motion.span
            variants={scaleIn}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-base"
            style={{ background: accent.tint, color: accent.fg }}
          >
            {tool.icon}
          </motion.span>
          <span className="truncate font-display text-sm font-semibold tracking-tight text-ink">
            {tool.name}
          </span>
        </motion.div>

        <div className="flex-1" />

        <AnimatePresence initial={false}>
          {(hasFiles || isNoFileTool) && ToolComponent && !isProcessing && !outputUrl && (
            <motion.button
              key="process"
              variants={scaleIn}
              initial="hidden"
              animate="visible"
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              whileTap={tapDown}
              onClick={triggerProcess}
              className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:text-accent hover:bg-accent/15 transition-colors px-2.5 py-1 rounded-md bg-accent/10 border border-accent/20"
            >
              Process
            </motion.button>
          )}
          {isProcessing && (
            <motion.span
              key="processing"
              variants={scaleIn}
              initial="hidden"
              animate="visible"
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              className="text-[11px] font-medium text-ink-muted"
            >
              Processing...
            </motion.span>
          )}
        </AnimatePresence>

        <motion.button
          variants={fadeUp}
          onClick={() => useUIStore.getState().toggleLogMonitor()}
          whileTap={tapDown}
          className={`text-[11px] font-medium transition-colors shrink-0 ${
            showLogs ? 'text-ink' : 'text-ink-muted hover:text-ink-soft'
          }`}
        >
          {showLogs ? 'Hide Log' : 'Log'}
        </motion.button>
      </motion.header>

      {/* ── Body ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Desktop sidebar */}
        <aside className="hidden sm:flex w-72 lg:w-80 shrink-0 flex-col border-r border-cream-border bg-cream-light overflow-hidden">
          <div className="flex flex-col flex-1 min-h-0 p-4 gap-2.5">
            {!isNoFileTool && (
              <div className="shrink-0">
                <FileDropZone
                  multiple={isMultiFile}
                  {...dropZoneProps}
                />
              </div>
            )}
            {isLargeFile && <div className="shrink-0"><MemoryWarning /></div>}
            {isVideo && codecWarning && (
              <div className="shrink-0 rounded-md border border-warn/20 bg-warn/5 p-2.5">
                <p className="text-[10px] font-medium text-warn leading-relaxed">{codecWarning}</p>
              </div>
            )}
            {isPDF && hasFiles && !ToolMainComponent && !isImageTool && (
              <div className="shrink-0"><ThumbnailStrip /></div>
            )}
            {(hasFiles || ToolMainComponent || isNoFileTool) && ToolComponent && (
              <div className="flex-1 min-h-0">
                <ToolComponent />
              </div>
            )}
          </div>
        </aside>

        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden min-w-0">
          {/* ────────────── Mobile layout ────────────── */}
          <div className="sm:hidden flex flex-col flex-1 overflow-hidden min-h-0 relative">
            {outputUrl && outputBlob && !isProcessing ? (
              <div className="flex-1 min-h-0 overflow-hidden animate-fade-in">
                <OutputActions onCancel={handleCancelOutput} />
              </div>
            ) : (
              <>
                {!isNoFileTool && (
                  <div className="shrink-0 px-3 pt-3 pb-2">
                    <FileDropZone
                      multiple={isMultiFile}
                      {...dropZoneProps}
                    />
                  </div>
                )}

                {isLargeFile && (
                  <div className="shrink-0 px-3 pb-1">
                    <MemoryWarning />
                  </div>
                )}

                {isVideo && codecWarning && (
                  <div className="shrink-0 px-3 pb-1">
                    <div className="rounded-md border border-warn/20 bg-warn/5 p-2">
                      <p className="text-[10px] font-medium text-warn leading-relaxed">{codecWarning}</p>
                    </div>
                  </div>
                )}

                {!hasFiles && !isProcessing && !ToolMainComponent && !isNoFileTool && (
                  <motion.div
                    variants={staggerParent}
                    initial="hidden"
                    animate="visible"
                    className="flex flex-1 items-center justify-center p-4"
                  >
                    <div className="text-center opacity-40">
                      <motion.div {...floatLoop} className="mb-3 text-4xl">{tool.icon}</motion.div>
                      <motion.p variants={fadeUp} className="text-xs font-medium text-ink-muted">{importLabel}</motion.p>
                    </div>
                  </motion.div>
                )}

                {(hasFiles || ToolMainComponent || (isNoFileTool && ToolComponent)) && (
                  <>
                    {isPDF && isMultiFile && files.length > 1 && !ToolMainComponent && (
                      <div className="shrink-0 px-3 pt-2 flex gap-1 overflow-x-auto scrollbar-hide">
                        {files.map((f, i) => (
                          <button
                            key={`${f.name}-${i}`}
                            onClick={() => setPreviewFileIndex(i)}
                            className={`shrink-0 px-2.5 py-1 rounded text-[10px] font-medium transition-colors ${
                              i === safePreviewIndex
                                ? 'bg-accent/10 text-accent border border-accent/20'
                                : 'bg-white text-ink-muted border border-cream-border hover:text-ink-soft'
                            }`}
                          >
                            {f.name.length > 16 ? f.name.slice(0, 14) + '…' : f.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {ToolMainComponent ? (
                      <div className="flex-1 min-h-0 overflow-hidden">
                        <ToolMainComponent />
                      </div>
                    ) : isVideo && hasFiles ? (
                      <div className="flex-1 min-h-0 px-3 pb-2 flex items-center justify-center overflow-hidden">
                        <VideoPreview />
                      </div>
                    ) : isPDF && hasFiles ? (
                      <div className="flex-1 min-h-0 px-3 pb-2 flex items-center justify-center overflow-hidden">
                        <PDFViewer scale={1.0} showControls={true} fileOverride={previewFile} />
                      </div>
                    ) : null}

                    {ToolComponent && (
                      <div className="shrink-0 border-t border-cream-border bg-cream-light">
                        <div className="p-3">
                          <ToolComponent />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {isProcessing && (
                  <div className="shrink-0 border-t border-cream-border bg-cream-light p-3">
                    <ProgressBar />
                  </div>
                )}

                {error && (
                  <div className="absolute inset-x-0 bottom-4 z-30 flex justify-center pointer-events-none">
                    <motion.div
                      variants={fadeUp}
                      initial="hidden"
                      animate="visible"
                      className="pointer-events-auto mx-3 max-w-md rounded-doodle-md border border-danger/20 bg-white/95 backdrop-blur-sm shadow-doodle-card p-3"
                    >
                      <div className="flex items-start gap-2">
                        <motion.span
                          aria-hidden
                          className="text-base shrink-0"
                          {...floatLoop}
                        >⚠️</motion.span>
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold text-danger">Processing Error</p>
                          <p className="mt-0.5 text-[10px] text-danger/80 leading-relaxed">{error}</p>
                        </div>
                      </div>
                    </motion.div>
                  </div>
                )}
              </>
            )}

            {showLogs && (
              <div className="h-32 shrink-0 border-t border-cream-border bg-white">
                <LogMonitor />
              </div>
            )}
          </div>

          {/* ────────────── Desktop layout ────────────── */}
          <div className="hidden sm:flex flex-1 flex-col overflow-hidden">
            {outputUrl && outputBlob && !isProcessing ? (
              <div className="flex-1 min-h-0 overflow-hidden animate-fade-in">
                <OutputActions onCancel={handleCancelOutput} />
              </div>
            ) : (
              <div className={`flex-1 min-h-0 relative ${ToolMainComponent ? '' : 'overflow-hidden p-6 lg:p-8'}`}>
                {isPDF && isMultiFile && files.length > 1 && !ToolMainComponent && (
                  <div className="flex gap-1 overflow-x-auto scrollbar-hide mb-3">
                    {files.map((f, i) => (
                      <button
                        key={`${f.name}-${i}`}
                        onClick={() => setPreviewFileIndex(i)}
                        className={`shrink-0 px-3 py-1.5 rounded text-[11px] font-medium transition-colors ${
                          i === safePreviewIndex
                            ? 'bg-accent/10 text-accent border border-accent/20'
                            : 'bg-white text-ink-muted border border-cream-border hover:text-ink-soft'
                        }`}
                      >
                        {f.name}
                      </button>
                    ))}
                  </div>
                )}
                {ToolMainComponent ? (
                  <ToolMainComponent />
                ) : isVideo && hasFiles ? (
                  <VideoPreview />
                ) : isPDF && hasFiles ? (
                  <PDFViewer scale={1.5} showControls={true} fileOverride={previewFile} />
                ) : null}

                {!hasFiles && !isProcessing && !ToolMainComponent && !isNoFileTool && (
                  <motion.div
                    variants={staggerParent}
                    initial="hidden"
                    animate="visible"
                    className="flex h-full items-center justify-center"
                  >
                    <div className="text-center opacity-40">
                      <motion.div {...floatLoop} className="mb-4 text-5xl">{tool.icon}</motion.div>
                      <motion.p variants={fadeUp} className="text-sm font-medium text-ink-muted">{importLabel}</motion.p>
                      <motion.p variants={fadeUp} className="mt-1.5 text-xs text-ink-muted/70">
                        Drag & drop a file or use the upload area on the left
                      </motion.p>
                    </div>
                  </motion.div>
                )}

                {isProcessing && (
                  <motion.div
                    variants={fadeUp}
                    initial="hidden"
                    animate="visible"
                    className="mx-auto mt-8 max-w-md"
                  >
                    <ProgressBar />
                  </motion.div>
                )}

                {error && (
                  <div className="absolute inset-x-0 top-4 z-30 flex justify-center pointer-events-none">
                    <motion.div
                      variants={fadeUp}
                      initial="hidden"
                      animate="visible"
                      className="pointer-events-auto mx-4 max-w-md rounded-doodle-md border border-danger/20 bg-white/95 backdrop-blur-sm shadow-doodle-card p-4"
                    >
                      <div className="flex items-start gap-3">
                        <motion.span aria-hidden className="text-lg shrink-0" {...floatLoop}>⚠️</motion.span>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-danger">Processing Error</p>
                          <p className="mt-1 text-[11px] text-danger/80 leading-relaxed">{error}</p>
                        </div>
                      </div>
                    </motion.div>
                  </div>
                )}
              </div>
            )}

            {showLogs && (
              <div className="h-44 shrink-0 border-t border-cream-border bg-white">
                <LogMonitor />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
