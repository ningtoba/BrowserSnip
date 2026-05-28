export interface VideoMetadata {
  duration: number;
  width: number;
  height: number;
  codec: string;
  fileSize: number;
  fileName: string;
}

export interface ToolParams {
  trim: TrimParams;
  resize: ResizeParams;
  crop: CropParams;
  compress: CompressParams;
  gif: GifParams;
  audio: AudioParams;
  speed: SpeedParams;
  metadata: MetadataParams;
  stitch: StitchParams;
}

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

export interface StitchParams {
  _: null;
}

export type ToolId = keyof ToolParams;

export interface ToolDefinition {
  id: ToolId;
  name: string;
  description: string;
  icon: string;
}

export interface FFmpegProgress {
  percent: number;
  time: string;
  frame: number;
  fps: number;
  eta: string;
}

export interface ProcessState {
  isProcessing: boolean;
  progress: FFmpegProgress;
  logs: string[];
  outputBlob: Blob | null;
  outputUrl: string | null;
  error: string | null;
}
