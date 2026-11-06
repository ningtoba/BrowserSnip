import { Suspense, lazy, useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { TOOLS } from '@/lib/constants';
import { getPdfTool, mainViewFor, hasCustomMainView } from '@/lib/pdf/tools/registry';
import { fadeUp, scaleIn, slideLeft, staggerParent, tapDown, floatLoop } from '@/lib/motion';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { VideoPreview } from '@/components/player/VideoPreview';
import { PDFViewer } from '@/components/viewer/PDFViewer';
import { ThumbnailStrip } from '@/components/viewer/ThumbnailStrip';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { LogMonitor } from '@/components/ui/LogMonitor';
import { OutputActions } from '@/components/ui/OutputActions';
import { MemoryWarning } from '@/components/ui/MemoryWarning';
import { PdfToolPanel, ReportView } from '@/components/tools/pdf/shared/PdfToolPanel';
import { useIsCompact } from '@/hooks/useIsCompact';
// Video tool components
import { TrimTool } from '@/components/tools/TrimTool';
import { ResizeTool } from '@/components/tools/ResizeTool';
import { CropTool } from '@/components/tools/CropTool';
import { CompressTool } from '@/components/tools/CompressTool';
import { GifTool } from '@/components/tools/GifTool';
import { AudioTool } from '@/components/tools/AudioTool';
import { SpeedTool } from '@/components/tools/SpeedTool';
import { MetadataTool } from '@/components/tools/MetadataTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { useUIStore } from '@/stores/ui-store';
import type { ToolId } from '@/types';

const VIDEO_COMPONENTS: Record<string, React.ComponentType> = {
  trim: TrimTool,
  resize: ResizeTool,
  crop: CropTool,
  compress: CompressTool,
  gif: GifTool,
  audio: AudioTool,
  speed: SpeedTool,
  metadata: MetadataTool,
};

type PanelMap = Record<string, ComponentType>;

/** PDF tools whose panel is bespoke rather than generated from a field list. */
const PDF_PANELS: PanelMap = {
  'scan-to-pdf': lazyPanel(() => import('@/components/tools/pdf/scan/ScanTool').then(named('ScanTool'))),
  'pdf-crop': lazyPanel(() => import('@/components/tools/pdf/edit/CropTool').then(named('CropTool'))),
  crop: lazyPanel(() => import('@/components/tools/pdf/edit/CropTool').then(named('CropTool'))),
  sign: lazyPanel(() => import('@/components/tools/pdf/security/SignTool').then(named('SignTool'))),
  redact: lazyPanel(() => import('@/components/tools/pdf/security/RedactTool').then(named('RedactTool'))),
  compare: lazyPanel(() => import('@/components/tools/pdf/security/CompareTool').then(named('CompareTool'))),
  'compare-pdfs': lazyPanel(() => import('@/components/tools/pdf/security/CompareTool').then(named('CompareTool'))),
};

function lazyPanel(factory: () => Promise<{ default: ComponentType }>): ComponentType {
  const Panel = lazy(factory);
  return function LazyPanel() {
    return (
      <Suspense fallback={<p className="text-[10px] text-ink-muted">Loading controls…</p>}>
        <Panel />
      </Suspense>
    );
  };
}

/** Bind a module's named export to the `default` shape `lazy` requires. */
function named(name: string) {
  return (module: Record<string, unknown>) => {
    const component = module[name];
    if (typeof component !== 'function') {
      throw new Error(`Expected the "${name}" export from this tool's panel module.`);
    }
    return { default: component as ComponentType };
  };
}

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
  const compact = useIsCompact();
  const file = useFileStore((s) => s.file);
  const files = useFileStore((s) => s.files);
  const isLargeFile = useFileStore((s) => s.isLargeFile);
  const codecWarning = useFileStore((s) => s.codecWarning);
  const previewFileIndex = useFileStore((s) => s.previewFileIndex);
  const setPreviewFileIndex = useFileStore((s) => s.setPreviewFileIndex);
  const { isProcessing, outputUrl, outputBlob, error, report } = useProcessStore();
  const showLogs = useUIStore((s) => s.showLogMonitor);

  const setFileSession = useFileStore((s) => s.setActiveTool);
  const setProcessSession = useProcessStore((s) => s.setActiveTool);
  const persistFile = useFileStore((s) => s.persistCurrent);
  const persistProcess = useProcessStore((s) => s.persistCurrent);

  const mainRef = useRef<HTMLDivElement>(null);

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
  const definition = getPdfTool(toolId);
  const isVideo = tool?.category === 'video';
  const isPDF = tool?.category !== undefined && tool?.category !== 'video';
  const isMultiFile = tool?.multiFile ?? false;
  const hasFiles = isMultiFile ? files.length > 0 : !!file;
  const isImageTool = definition?.inputKind === 'image';
  const isNoFileTool = toolId === 'html-to-pdf' && definition?.accept?.includes('html') === false;
  const VideoComponent = toolId ? VIDEO_COMPONENTS[toolId] : null;
  const PanelComponent = toolId ? PDF_PANELS[toolId] : null;
  const MainComponent = toolId && hasCustomMainView(toolId) ? mainViewFor(toolId) : null;

  const dropZoneProps = isImageTool
    ? {
        accept: '.jpg,.jpeg,.png,.webp,.gif,.avif,.tiff,.tif,.bmp,.heic,.heif,.svg,.psd,image/*',
        label: 'Drop images here or click to browse',
        hint: 'JPG, PNG, WEBP, GIF, AVIF, TIFF, BMP, HEIC, SVG, PSD',
      }
    : definition?.accept && !/pdf/.test(definition.accept)
      ? {
          accept: definition.accept,
          label: `Drop ${definition.accept.split(',')[0]} here or click to browse`,
          hint: definition.accept.replace(/,/g, ' '),
        }
      : isPDF
        ? { accept: '.pdf,application/pdf', label: 'Drop a PDF file or click to browse', hint: 'Everything is processed in this tab' }
        : { accept: 'video/*' };

  const importLabel = isVideo ? 'Import a video to get started' : 'Import a file to get started';
  const dashboardPath = isVideo ? '/video' : '/pdf';
  const safePreviewIndex = Math.min(previewFileIndex, Math.max(0, files.length - 1));
  const previewFile = isMultiFile && files.length > 0 ? files[safePreviewIndex] : file;
  const accent = TOOL_ACCENT[tool?.category ?? ''] ?? DEFAULT_ACCENT;

  if (!tool) {
    return (
      <div className="flex h-screen items-center justify-center bg-cream">
        <div className="animate-fade-in text-center">
          <p className="mb-4 text-sm text-ink-muted">Tool not found.</p>
          <button
            onClick={() => navigate('/')}
            className="text-xs font-medium text-accent transition-colors hover:text-accent-hover"
          >
            &larr; Back to Home
          </button>
        </div>
      </div>
    );
  }

  /**
   * The generated panel owns its own submit button. Clicking it by id is the
   * convention the whole app already uses, and with one mounted branch there is
   * now exactly one element with that id.
   */
  const triggerProcess = () => {
    document.getElementById('tool-process-btn')?.click();
  };

  const showOutput = Boolean(outputUrl && outputBlob && !isProcessing);
  const showPlaceholder = !hasFiles && !isProcessing && !MainComponent && !isNoFileTool && !showOutput;

  const sidebar = (
    <>
      {!isNoFileTool && (
        <div className="shrink-0">
          <FileDropZone multiple={isMultiFile} {...dropZoneProps} />
        </div>
      )}
      {isLargeFile && (
        <div className="shrink-0">
          <MemoryWarning />
        </div>
      )}
      {isVideo && codecWarning && (
        <div className="shrink-0 rounded-md border border-warn/20 bg-warn/5 p-2.5">
          <p className="text-[10px] font-medium leading-relaxed text-warn">{codecWarning}</p>
        </div>
      )}
      {isPDF && hasFiles && !MainComponent && !isImageTool && definition?.surface !== 'pages' && (
        <div className="shrink-0">
          <ThumbnailStrip />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {VideoComponent && <VideoComponent />}
        {PanelComponent && <PanelComponent />}
        {isPDF && !PanelComponent && definition && <PdfToolPanel toolId={definition.id} />}
      </div>
    </>
  );

  const mainArea = showOutput ? (
    <div className="animate-fade-in min-h-0 flex-1 overflow-hidden">
      <OutputActions onCancel={() => useProcessStore.getState().reset()} />
    </div>
  ) : report ? (
    <div className="min-h-0 flex-1 overflow-hidden">
      <ReportView />
    </div>
  ) : MainComponent ? (
    <div className="min-h-0 flex-1 overflow-hidden">
      <MainComponent />
    </div>
  ) : (
    <div className="relative min-h-0 flex-1 overflow-hidden p-4 sm:p-6 lg:p-8">
      {isPDF && isMultiFile && files.length > 1 && (
        <div className="mb-3 flex gap-1 overflow-x-auto scrollbar-hide">
          {files.map((entry, index) => (
            <button
              key={`${entry.name}-${index}`}
              onClick={() => setPreviewFileIndex(index)}
              className={`shrink-0 rounded px-2.5 py-1.5 text-[11px] font-medium transition-colors sm:px-3 ${
                index === safePreviewIndex
                  ? 'border border-accent/20 bg-accent/10 text-accent'
                  : 'border border-cream-border bg-white text-ink-muted hover:text-ink-soft'
              }`}
            >
              {entry.name.length > 18 ? `${entry.name.slice(0, 16)}…` : entry.name}
            </button>
          ))}
        </div>
      )}

      {isVideo && hasFiles ? (
        <VideoPreview />
      ) : isPDF && hasFiles ? (
        <PDFViewer scale={compact ? 1 : 1.5} showControls fileOverride={previewFile} />
      ) : showPlaceholder ? (
        <motion.div
          variants={staggerParent}
          initial="hidden"
          animate="visible"
          className="flex h-full items-center justify-center"
        >
          <div className="text-center opacity-40">
            <motion.div {...floatLoop} className={`mb-3 ${compact ? 'text-4xl' : 'mb-4 text-5xl'}`}>
              {tool.icon}
            </motion.div>
            <motion.p variants={fadeUp} className={`font-medium text-ink-muted ${compact ? 'text-xs' : 'text-sm'}`}>
              {importLabel}
            </motion.p>
            {!compact && (
              <motion.p variants={fadeUp} className="mt-1.5 text-xs text-ink-muted/70">
                Drag &amp; drop a file or use the upload area on the left
              </motion.p>
            )}
          </div>
        </motion.div>
      ) : null}

      {isProcessing && (
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className={`mx-auto ${compact ? 'mt-4' : 'mt-8'} max-w-md`}>
          <ProgressBar />
        </motion.div>
      )}

      {error && (
        <div className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center ${compact ? 'bottom-4' : 'top-4'}`}>
          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            className="pointer-events-auto mx-3 max-w-md rounded-doodle-md border border-danger/20 bg-white/95 p-3 shadow-doodle-card backdrop-blur-sm sm:mx-4 sm:p-4"
          >
            <div className="flex items-start gap-2.5">
              <motion.span aria-hidden {...floatLoop} className="shrink-0 text-base">
                ⚠️
              </motion.span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-danger sm:text-xs">Could not finish</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-danger/80 sm:mt-1 sm:text-[11px]">{error}</p>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );

  return (
    <div ref={mainRef} className="flex h-full flex-col overflow-hidden bg-cream">
      <motion.header
        variants={staggerParent}
        initial="hidden"
        animate="visible"
        className="z-20 flex h-14 shrink-0 items-center gap-3 border-b border-cream-border bg-white/85 px-3 backdrop-blur-subtle sm:px-4"
      >
        <motion.button
          variants={slideLeft}
          onClick={() => navigate(dashboardPath)}
          whileHover="hover"
          className="group flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:text-ink"
        >
          <motion.span
            aria-hidden
            className="inline-flex text-sm leading-none transition-transform duration-200 group-hover:-translate-x-0.5"
            variants={{ hover: { x: -3 } }}
          >
            &larr;
          </motion.span>
          <span className="hidden sm:inline">{isVideo ? 'Video Tools' : 'PDF Tools'}</span>
          <span className="sm:hidden">Back</span>
        </motion.button>
        <span className="text-xs font-bold select-none text-cream-border">/</span>
        <motion.div variants={fadeUp} className="flex min-w-0 items-center gap-2.5">
          <motion.span
            variants={scaleIn}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-base"
            style={{ background: accent.tint, color: accent.fg }}
          >
            {tool.icon}
          </motion.span>
          <span className="truncate font-display text-sm font-semibold tracking-tight text-ink">{tool.name}</span>
        </motion.div>

        <div className="flex-1" />

        <AnimatePresence initial={false}>
          {(hasFiles || isNoFileTool || MainComponent) && !isProcessing && !outputUrl && (
            <motion.button
              key="process"
              variants={scaleIn}
              initial="hidden"
              animate="visible"
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              whileTap={tapDown}
              onClick={triggerProcess}
              className="inline-flex items-center gap-1 rounded-md border border-accent/20 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/15 hover:text-accent"
            >
              Process
            </motion.button>
          )}
          {isProcessing && (
            <motion.span key="processing" variants={scaleIn} initial="hidden" animate="visible" exit={{ opacity: 0, transition: { duration: 0.15 } }} className="text-[11px] font-medium text-ink-muted">
              Processing…
            </motion.span>
          )}
        </AnimatePresence>

        <motion.button
          variants={fadeUp}
          onClick={() => useUIStore.getState().toggleLogMonitor()}
          whileTap={tapDown}
          className={`shrink-0 text-[11px] font-medium transition-colors ${showLogs ? 'text-ink' : 'text-ink-muted hover:text-ink-soft'}`}
        >
          {showLogs ? 'Hide Log' : 'Log'}
        </motion.button>
      </motion.header>

      <div className="flex flex-1 overflow-hidden">
        {compact ? (
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{mainArea}</main>
        ) : (
          <>
            <aside className="flex w-72 shrink-0 flex-col gap-2.5 overflow-hidden border-r border-cream-border bg-cream-light p-4 lg:w-80">
              {sidebar}
            </aside>
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{mainArea}</main>
          </>
        )}
        {compact && (
          <div className="max-h-[46%] shrink-0 space-y-2 overflow-y-auto border-t border-cream-border bg-cream-light p-3">
            {sidebar}
          </div>
        )}
      </div>

      {showLogs && (
        <div className={`shrink-0 border-t border-cream-border bg-white ${compact ? 'h-28' : 'h-44'}`}>
          <LogMonitor />
        </div>
      )}
    </div>
  );
}
