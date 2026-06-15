export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
  fileSize: number;
  fileName: string;
}

export interface PDFMetadata {
  pageCount: number;
  fileSize: number;
  fileName: string;
  isEncrypted: boolean;
  hasForms: boolean;
  hasAnnotations: boolean;
  pdfVersion: string;
  title?: string;
  author?: string;
}

export interface PDFPageInfo {
  index: number;
  width: number;
  height: number;
  rotation: number;
  thumbnailUrl?: string;
}

// ── Video Tool Params ──

export interface TrimParams {
  startTime: number;
  endTime: number;
}

export interface ResizeParams {
  width: number;
  height: number;
  lockAspectRatio: boolean;
  preset: '1080p' | '720p' | '480p' | '360p' | 'custom';
}

export interface CropParams {
  aspectRatio: '9:16' | '1:1' | '21:9' | 'custom';
}

export interface CompressParams {
  targetSizeMB: number;
}

export interface GifParams {
  startTime: number;
  duration: number;
  fps: number;
  width: number;
}

export interface AudioParams {
  mode: 'mute' | 'extract' | 'volume';
  volume: number;
}

export interface SpeedParams {
  speed: number;
}

export interface MetadataParams {
  _: null;
}

// Video tool params lookup (backward compat)
export interface ToolParams {
  trim: TrimParams;
  resize: ResizeParams;
  crop: CropParams;
  compress: CompressParams;
  gif: GifParams;
  audio: AudioParams;
  speed: SpeedParams;
  metadata: MetadataParams;
}

// ── PDF Tool Params ──

export interface MergeParams {
  fileOrder: number[];
}

export interface SplitParams {
  mode: 'ranges' | 'every-page' | 'odd-even' | 'custom';
  ranges: string;
  removeSplitPages: boolean;
}

export interface RemovePagesParams {
  pages: number[];
}

export interface ExtractPagesParams {
  pages: number[];
  mergeIntoOne: boolean;
}

export interface OrganizeParams {
  pageOrder: number[];
  pagesToDelete: number[];
}

export interface RotateParams {
  pages: number[];
  degrees: 90 | 180 | 270;
  applyToAll: boolean;
}

export interface PdfCompressParams {
  level: 'low' | 'medium' | 'high' | 'custom';
  imageQuality: number;
  imageMaxDPI: number;
  useGhostscript: boolean;
}

export interface ImageToPDFParams {
  pageSize: 'a4' | 'letter' | 'original' | 'fit';
  orientation: 'portrait' | 'landscape';
  margin: number;
  fitMode: 'contain' | 'cover' | 'stretch';
}

export interface DigitizeDocumentParams {
  pageSize: 'a4' | 'letter' | 'original';
  orientation: 'portrait' | 'landscape';
  margin: number;
}

export interface PDFToImageParams {
  format: 'jpg' | 'png' | 'webp';
  quality: number;
  resolution: number;
  pageRange: string;
}

export interface HTMLToPDFParams {
  pageSize: 'a4' | 'letter';
  orientation: 'portrait' | 'landscape';
  margin: number;
}

export interface WatermarkParams {
  type: 'text' | 'image';
  text: string;
  imageData: ArrayBuffer | null;
  opacity: number;
  rotation: number;
  fontSize: number;
  position: 'center' | 'tile' | 'diagonal' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  color: string;
  pages: string;
  bold?: boolean;
  imageScale?: number;
  tileSpacing?: number;
}

export interface PageNumbersParams {
  font: string;
  fontSize: number;
  position: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
  startAt: number;
  prefix: string;
  suffix: string;
  pages: string;
}

export interface PdfCropParams {
  pages: number[];
  top: number;
  right: number;
  bottom: number;
  left: number;
  unit: 'px' | 'pt' | 'in' | 'mm';
  allPages: boolean;
  uniform: boolean;
}

export interface ProtectParams {
  userPassword: string;
  ownerPassword: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowModifying: boolean;
  allowAnnotating: boolean;
  allowFillingForms: boolean;
  allowAccessibility: boolean;
  allowAssembling: boolean;
  encryptionLevel: 'aes-128' | 'aes-256' | 'rc4-128';
}

export interface UnlockParams {
  password: string;
}

export interface SignParams {
  type: 'draw' | 'image' | 'text';
  imageData: ArrayBuffer | null;
  text: string;
  font: string;
  position: { x: number; y: number; page: number };
  size: { width: number; height: number };
}

export interface RedactParams {
  redactions: Array<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  redactionColor: string;
  overlayText: string;
}

export interface CompareParams {
  mode: 'visual' | 'text' | 'hybrid';
  highlightColor: string;
  sensitivity: number;
}

export interface ScanToPDFParams {
  quality: number;
  pageSize: 'a4' | 'letter';
  enhanceDocument: boolean;
}

// PDF tool params lookup
export interface PdfToolParams {
  merge: MergeParams;
  split: SplitParams;
  'remove-pages': RemovePagesParams;
  'extract-pages': ExtractPagesParams;
  organize: OrganizeParams;
  rotate: RotateParams;
  'scan-to-pdf': ScanToPDFParams;
  'pdf-compress': PdfCompressParams;
  repair: Record<string, never>;
  'image-to-pdf': ImageToPDFParams;
  'html-to-pdf': HTMLToPDFParams;
  'digitize-document': DigitizeDocumentParams;
  'pdf-to-image': PDFToImageParams;
  'pdf-to-word': Record<string, never>;
  'pdf-to-excel': Record<string, never>;
  'pdf-to-pdfa': Record<string, never>;
  'page-numbers': PageNumbersParams;
  watermark: WatermarkParams;
  'pdf-crop': PdfCropParams;
  protect: ProtectParams;
  unlock: UnlockParams;
  sign: SignParams;
  redact: RedactParams;
  compare: CompareParams;
}

// ── Unified Identifiers ──

export type ToolCategory = 'video' | 'organize' | 'optimize' | 'convert-to' | 'convert-from' | 'edit' | 'security';

export type ToolId =
  // Video
  | 'trim'
  | 'resize'
  | 'crop'
  | 'compress'
  | 'gif'
  | 'audio'
  | 'speed'
  | 'metadata'
  // Organize
  | 'merge'
  | 'split'
  | 'remove-pages'
  | 'extract-pages'
  | 'organize'
  | 'rotate'
  | 'scan-to-pdf'
  // Optimize
  | 'pdf-compress'
  | 'repair'
  // Convert to PDF
  | 'image-to-pdf'
  | 'html-to-pdf'
  | 'digitize-document'
  // Convert from PDF
  | 'pdf-to-image'
  | 'pdf-to-word'
  | 'pdf-to-excel'
  | 'pdf-to-pdfa'
  // Edit
  | 'page-numbers'
  | 'watermark'
  | 'pdf-crop'
  // Security
  | 'protect'
  | 'unlock'
  | 'sign'
  | 'redact'
  | 'compare';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description: string;
  icon: string;
  category?: ToolCategory;
  multiFile?: boolean;
}

export interface ToolCategoryDefinition {
  id: ToolCategory;
  label: string;
  icon: string;
}

// ── Progress & Processing ──

export interface FFmpegProgress {
  percent: number;
  time: string;
  frame: number;
  fps: number;
  eta: string;
}

export interface ProcessState {
  isProcessing: boolean;
  progress: number;
  currentProgress: FFmpegProgress | null;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  outputBlobs: Blob[];
  outputUrls: string[];
  error: string | null;
  label: string;
  suffix: string;
}
