import { FFmpeg } from '@ffmpeg/ffmpeg';

// Vite's ?url suffix returns the asset URL processed through the module
// pipeline — a real URL that Emscripten pthread workers can load from.
// Unlike blob URLs (toBlobURL), these work with both import() and
// importScripts(), enabling multi-threading.
import stCoreJS from '/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url';
import stCoreWasm from '/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url';
import mtCoreJS from '/node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.js?url';
import mtCoreWasm from '/node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm?url';
import mtWorkerJS from '/node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.worker.js?url';

let ffmpeg: FFmpeg | null = null;
let initError: string | null = null;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg;
  if (initError) throw new Error(initError);

  const instance = new FFmpeg();

  try {
    const mtSupported =
      typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;

    const coreURL = mtSupported ? mtCoreJS : stCoreJS;
    const wasmURL = mtSupported ? mtCoreWasm : stCoreWasm;

    const config: Record<string, string> = { coreURL, wasmURL };
    if (mtSupported) {
      config.workerURL = mtWorkerJS;
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
