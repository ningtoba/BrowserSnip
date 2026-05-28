import { FFmpeg } from '@ffmpeg/ffmpeg';

// ?url imports go through Vite's module pipeline → real URLs that
// work with import(). Used for the core JS + WASM which the main
// module worker loads via import().
import stCoreJS from '/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js?url';
import stCoreWasm from '/node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm?url';
import mtCoreJS from '/node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.js?url';
import mtCoreWasm from '/node_modules/@ffmpeg/core-mt/dist/esm/ffmpeg-core.wasm?url';

// Worker file must be served as-is (no Vite transforms) because
// Emscripten creates classic workers (new Worker(url) without
// type:'module'). Served from public/ where Vite leaves files raw.
const MT_WORKER = '/mt-worker.js';

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
      config.workerURL = MT_WORKER;
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
