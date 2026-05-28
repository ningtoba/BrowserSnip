import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;
let initError: string | null = null;

const CORE_JS = '/ffmpeg/core/ffmpeg-core.js';
const CORE_WASM = '/ffmpeg/core/ffmpeg-core.wasm';

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (initError) throw new Error(initError);

  const instance = new FFmpeg();

  try {
    // Use single-threaded core only. The multi-threaded core spawns
    // internal pthread workers that fail when loaded from blob URLs
    // because they use import.meta.url in a classic worker context.
    const coreURL = await toBlobURL(CORE_JS, 'text/javascript');
    const wasmURL = await toBlobURL(CORE_WASM, 'application/wasm');

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
