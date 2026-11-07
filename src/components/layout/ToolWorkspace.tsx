/**
 * The tool page's routing shell.
 *
 * Three kinds of page live behind `/tool/:toolId`, and they used to share one
 * layout — a settings rail beside a large preview pane — which is why a
 * first visit to any of them looked like a form next to an empty room:
 *
 * * **schema-driven PDF tools** (the ~130 with a field list and a `run`) hand
 *   the whole page to `PdfToolPanel`, whose states live in `ToolSurface`: drop
 *   zone, then cards, then the result screen. No rail, no preview pane.
 * * **bespoke surfaces** (`edit-pdf`, `organize`, `sign`, `crop`, `scan`,
 *   `redact`, `compare`, the form editors) keep their own editors. They get the
 *   same drop-first empty state and the same result screen, but their canvas is
 *   never forced into a card grid.
 * * **video tools** keep the media layout, including the log bar.
 *
 * The workspace header is gone for PDF tools: every surface renders its own
 * primary action, and the identity of the page belongs to the app header.
 */
import { Suspense, lazy, startTransition, useEffect } from 'react';
import type { ComponentType } from 'react';
import { useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { TOOLS } from '@/lib/constants';
import { getPdfTool, mainViewFor, hasCustomMainView } from '@/lib/pdf/tools/registry';
import { fadeUp, floatLoop, staggerParent } from '@/lib/motion';
import { FileDropZone } from '@/components/ui/FileDropZone';
import { VideoPreview } from '@/components/player/VideoPreview';
import { PDFViewer } from '@/components/viewer/PDFViewer';
import { ThumbnailStrip } from '@/components/viewer/ThumbnailStrip';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { LogMonitor } from '@/components/ui/LogMonitor';
import { OutputActions } from '@/components/ui/OutputActions';
import { PdfToolPanel, ReportView } from '@/components/tools/pdf/shared/PdfToolPanel';
import { FileIntake, PDF_ACCEPT, intakeCopy, useIntake } from '@/components/tools/pdf/shared/FileIntake';
import { ResultPane } from '@/components/tools/pdf/shared/ToolSurface';
import { promiseFor } from '@/components/tools/pdf/shared/toolForm';
import { useIsCompact } from '@/hooks/useIsCompact';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { useUIStore } from '@/stores/ui-store';
// Video tool components
import { TrimTool } from '@/components/tools/TrimTool';
import { ResizeTool } from '@/components/tools/ResizeTool';
import { CropTool } from '@/components/tools/CropTool';
import { CompressTool } from '@/components/tools/CompressTool';
import { GifTool } from '@/components/tools/GifTool';
import { AudioTool } from '@/components/tools/AudioTool';
import { SpeedTool } from '@/components/tools/SpeedTool';
import { MetadataTool } from '@/components/tools/MetadataTool';
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

export function ToolWorkspace() {
  const { toolId } = useParams<{ toolId: string }>();
  const compact = useIsCompact();
  const file = useFileStore((s) => s.file);
  const files = useFileStore((s) => s.files);
  const setFiles = useFileStore((s) => s.setFiles);
  const clearCurrent = useFileStore((s) => s.clearCurrent);
  const previewFileIndex = useFileStore((s) => s.previewFileIndex);
  const setPreviewFileIndex = useFileStore((s) => s.setPreviewFileIndex);
  const { isProcessing, outputUrl, outputBlob, error, report } = useProcessStore();
  const fileStates = useProcessStore((s) => s.fileStates);
  const resetProcess = useProcessStore((s) => s.reset);
  const showLogs = useUIStore((s) => s.showLogMonitor);

  const setFileSession = useFileStore((s) => s.setActiveTool);
  const setProcessSession = useProcessStore((s) => s.setActiveTool);
  const persistFile = useFileStore((s) => s.persistCurrent);
  const persistProcess = useProcessStore((s) => s.persistCurrent);

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
  /** Tools whose pane takes typed input rather than a file at all. */
  const isNoFileTool = toolId === 'html-to-pdf' && definition?.accept?.includes('html') === false;
  const VideoComponent = toolId ? VIDEO_COMPONENTS[toolId] : null;
  const PanelComponent = toolId ? PDF_PANELS[toolId] : null;
  const MainComponent = toolId && hasCustomMainView(toolId) ? mainViewFor(toolId) : null;
  /** The generated page owns its own states; nothing is laid around it. */
  const isSchemaTool = isPDF && Boolean(definition) && !MainComponent && !PanelComponent;

  const showOutput = Boolean(outputUrl && outputBlob && !isProcessing);
  const showResult = isPDF && (showOutput || Boolean(report));
  /**
   * A bespoke page opens on the drop zone, like every other page — except the
   * surfaces that work with nothing loaded (the camera in Scan, the typed source
   * in HTML to PDF) and image-input tools, whose pane is the capture view.
   */
  const showIntake =
    isPDF && !isSchemaTool && !hasFiles && !showResult && !isNoFileTool && !isImageTool;

  const intake = useIntake({
    accept: definition?.accept ?? PDF_ACCEPT,
    multiple: isMultiFile,
    enabled: isPDF && !isSchemaTool,
    onFiles: (list) => {
      resetProcess();
      // The editor pane and the bespoke panel are lazy chunks, and this runs
      // inside a file-input change handler. Committing a suspending update as
      // synchronous input is React #426 — the white screen this repo already
      // fought once in the router — so the write goes through a transition.
      startTransition(() => {
        setFiles(isMultiFile ? list : list.slice(0, 1));
      });
    },
  });

  if (!tool) {
    return (
      <div className="flex h-screen items-center justify-center bg-cream">
        <div className="animate-fade-in text-center">
          <p className="mb-4 text-sm text-ink-muted">Tool not found.</p>
          <a href="#/pdf" className="text-xs font-medium text-accent transition-colors hover:text-accent-hover">
            &larr; Back to the tools
          </a>
        </div>
      </div>
    );
  }

  const logStrip = showLogs ? (
    <div className={`shrink-0 border-t border-cream-border bg-white ${compact ? 'h-28' : 'h-44'}`}>
      <LogMonitor />
    </div>
  ) : null;

  /** The result screen, shared by generated pages and bespoke editors. */
  const resultScreen = (
    <ResultPane
      toolName={definition?.name ?? tool.name}
      pagesIn={pagesLoaded(files, fileStates)}
      engines={definition?.engines ?? []}
      onDoAnother={() => {
        resetProcess();
        clearCurrent();
      }}
      report={report ? <ReportView report={report} /> : null}
    />
  );

  // ── generated tool page ──────────────────────────────────────────────────
  if (isSchemaTool && definition) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-cream">
        <div className="min-h-0 flex-1 overflow-hidden">
          <PdfToolPanel toolId={definition.id} />
        </div>
        {logStrip}
      </div>
    );
  }

  // ── empty state for a bespoke surface ────────────────────────────────────
  if (showIntake) {
    const title = definition?.name ?? tool.name;
    return (
      <div
        data-surface="intake"
        className="flex h-full min-h-0 flex-col overflow-hidden bg-cream"
      >
        <FileIntake
          title={title}
          promise={definition ? promiseFor(definition) : tool.description ?? ''}
          copy={intakeCopy(definition?.accept, isMultiFile)}
          controls={intake}
        />
        <input {...intake.inputProps} />
        {logStrip}
      </div>
    );
  }

  // ── editors and video tools ──────────────────────────────────────────────
  const sidebar = (
    <>
      {!isNoFileTool && (
        <div className="shrink-0">
          <FileDropZone multiple={isMultiFile} {...dropZoneProps(definition, isPDF, isImageTool)} />
        </div>
      )}
      {/* The page header prints no promise, so a bespoke pane is the one place
          that still says what pressing its action produces. */}
      <p data-tool-promise="true" className="shrink-0 text-[11px] leading-relaxed text-ink-muted">
        {definition ? promiseFor(definition) : (tool.description ?? 'Everything happens in this tab.')}
      </p>

      {isVideo && codecNotice()}
      {isPDF && hasFiles && !MainComponent && !isImageTool && definition?.surface !== 'pages' && (
        <div className="shrink-0">
          <ThumbnailStrip />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {VideoComponent && <VideoComponent />}
        {PanelComponent && <PanelComponent />}
      </div>
    </>
  );

  const safePreviewIndex = Math.min(previewFileIndex, Math.max(0, files.length - 1));
  const previewFile = isMultiFile && files.length > 0 ? files[safePreviewIndex] : file;

  /** A run in flight, and the reason it stopped, over whichever pane is up. */
  const runOverlays = (
    <>
      {isProcessing && (
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className={`mx-auto ${compact ? 'mt-4' : 'mt-8'} max-w-md`}
        >
          <ProgressBar />
        </motion.div>
      )}

      {error && (
        <div
          className={`pointer-events-none absolute inset-x-0 z-30 flex justify-center ${
            compact ? 'bottom-4' : 'top-4'
          }`}
        >
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
                <p className="mt-0.5 text-[10px] leading-relaxed text-danger/80 sm:mt-1 sm:text-[11px]">
                  {error}
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </>
  );

  const mainArea = showResult ? (
    <div className="animate-fade-in flex min-h-0 flex-1 flex-col overflow-hidden">{resultScreen}</div>
  ) : MainComponent ? (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<PaneLoading label={definition?.name ?? tool.name} />}>
          <MainComponent />
        </Suspense>
      </div>
      {runOverlays}
    </div>
  ) : isVideo && showOutput ? (
    <div className="animate-fade-in min-h-0 flex-1 overflow-hidden">
      <OutputActions onCancel={resetProcess} />
    </div>
  ) : (
    <div className="relative min-h-0 flex-1 overflow-hidden p-4 sm:p-6 lg:p-8">
      {isMultiFile && files.length > 1 && (
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
      ) : (
        <Placeholder
          tool={tool}
          compact={compact}
          importLabel={isVideo ? 'Import a video to get started' : 'Import a file to get started'}
        />
      )}

      {runOverlays}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-cream">
      {isVideo && (
        <motion.header
          variants={staggerParent}
          initial="hidden"
          animate="visible"
          className="z-20 flex h-14 shrink-0 items-center gap-3 border-b border-cream-border bg-white/85 px-3 backdrop-blur-subtle sm:px-4"
        >
          <span className="sr-only">{tool.name}</span>
          <div className="flex-1" />
          {isProcessing && (
            <span className="text-[11px] font-medium text-ink-muted">Processing…</span>
          )}
          <motion.button
            variants={fadeUp}
            onClick={() => useUIStore.getState().toggleLogMonitor()}
            className={`shrink-0 text-[11px] font-medium transition-colors ${showLogs ? 'text-ink' : 'text-ink-muted hover:text-ink-soft'}`}
          >
            {showLogs ? 'Hide Log' : 'Log'}
          </motion.button>
        </motion.header>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
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

      {logStrip}
    </div>
  );

  /** The video pipeline's own codec caveat, which no PDF tool can produce. */
  function codecNotice() {
    const warning = useFileStore.getState().codecWarning;
    if (!warning) return null;
    return (
      <div className="shrink-0 rounded-md border border-warn/20 bg-warn/5 p-2.5">
        <p className="text-[10px] font-medium leading-relaxed text-warn">{warning}</p>
      </div>
    );
  }
}

/** The editor pane’s own chunk is on its way; say so rather than sit blank. */
function PaneLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6" role="status">
      <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
        Opening {label}…
      </p>
    </div>
  );
}

/** The old "import something" pane, kept for surfaces that still show one. */
function Placeholder({
  tool,
  compact,
  importLabel,
}: {
  tool: { icon: string; name: string };
  compact: boolean;
  importLabel: string;
}) {
  return (
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
      </div>
    </motion.div>
  );
}

/** Pages across the loaded inputs, or `null` while any of them is unread. */
function pagesLoaded(files: File[], states: Record<string, { pages?: number | null }>): number | null {
  if (files.length === 0) return null;
  let total = 0;
  for (const file of files) {
    const count = states[file.name]?.pages;
    if (count == null) return null;
    total += count;
  }
  return total > 0 ? total : null;
}

/** What the shared drop zone asks for, named after the tool's own input. */
function dropZoneProps(
  definition: { accept?: string; inputKind?: string } | undefined,
  isPDF: boolean,
  isImageTool: boolean,
) {
  if (isImageTool) {
    return {
      accept: '.jpg,.jpeg,.png,.webp,.gif,.avif,.tiff,.tif,.bmp,.heic,.heif,.svg,.psd,image/*',
      label: 'Drop images here or click to browse',
      hint: 'JPG, PNG, WEBP, GIF, AVIF, TIFF, BMP, HEIC, SVG, PSD',
    };
  }
  if (definition?.accept && !/pdf/.test(definition.accept)) {
    return {
      accept: definition.accept,
      label: `Drop ${definition.accept.split(',')[0]} here or click to browse`,
      hint: definition.accept.replace(/,/g, ' '),
    };
  }
  if (isPDF) {
    return {
      accept: '.pdf,application/pdf',
      label: 'Drop a PDF file or click to browse',
      hint: 'Everything is processed in this tab',
    };
  }
  return { accept: 'video/*' };
}
