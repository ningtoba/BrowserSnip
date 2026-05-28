import { FFmpeg } from '@ffmpeg/ffmpeg';

let ffmpeg: FFmpeg | null = null;
let initError: string | null = null;

const CORE_JS = '/ffmpeg/core/ffmpeg-core.js';
const CORE_WASM = '/ffmpeg/core/ffmpeg-core.wasm';
const MT_CORE_JS = '/ffmpeg/core-mt/ffmpeg-core.js';
const MT_CORE_WASM = '/ffmpeg/core-mt/ffmpeg-core.wasm';

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (initError) throw new Error(initError);

  const instance = new FFmpeg();

  try {
    const mtSupported =
      typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;

    const coreURL = mtSupported ? MT_CORE_JS : CORE_JS;
    const wasmURL = mtSupported ? MT_CORE_WASM : CORE_WASM;

    await instance.load({ coreURL, wasmURL });

    ffmpeg = instance;
    return instance;
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'Failed to load FFmpeg core';
    initError = msg;
    console.error('[BrowserSnip] FFmpeg core load failed:', err);
    throw new Error(msg);
  }
}

export async function terminateFFmpeg(): Promise<void> {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
    } catch {
      // Terminate may throw if WASM is already dead
    }
    ffmpeg = null;
    initError = null;
  }
}

export function getFFmpegInstance(): FFmpeg | null {
  return ffmpeg;
}
