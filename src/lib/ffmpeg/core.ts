import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;
let initError: string | null = null;

const ST_CORE_JS = '/ffmpeg/core/ffmpeg-core.js';
const ST_CORE_WASM = '/ffmpeg/core/ffmpeg-core.wasm';

const MT_CORE_JS = '/ffmpeg/core-mt/ffmpeg-core.js';
const MT_CORE_WASM = '/ffmpeg/core-mt/ffmpeg-core.wasm';
const MT_CORE_WORKER = '/ffmpeg/core-mt/ffmpeg-core.worker.js';

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (initError) throw new Error(initError);

  const instance = new FFmpeg();

  try {
    const mtSupported =
      typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;

    const coreURL = await toBlobURL(
      mtSupported ? MT_CORE_JS : ST_CORE_JS,
      'text/javascript'
    );
    const wasmURL = await toBlobURL(
      mtSupported ? MT_CORE_WASM : ST_CORE_WASM,
      'application/wasm'
    );

    const config: { coreURL: string; wasmURL: string; workerURL?: string } = {
      coreURL,
      wasmURL,
    };

    if (mtSupported) {
      config.workerURL = await toBlobURL(MT_CORE_WORKER, 'text/javascript');
    }

    await instance.load(config);

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
