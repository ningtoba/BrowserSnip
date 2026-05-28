import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

let ffmpeg: FFmpeg | null = null;

const CORE_VERSION = '0.12.6';
const BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist`;

export async function getFFmpeg(): Promise<FFmpeg> {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;

  const instance = new FFmpeg();

  instance.on('log', ({ message }) => {
    // Handled by the hook, not here
  });

  const mt = await supportsMultiThread();
  const coreURL = mt
    ? await toBlobURL(`${BASE_URL}/umd/ffmpeg-core.js`, 'text/javascript')
    : await toBlobURL(`${BASE_URL}/esm/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = mt
    ? await toBlobURL(`${BASE_URL}/umd/ffmpeg-core.wasm`, 'application/wasm')
    : await toBlobURL(`${BASE_URL}/esm/ffmpeg-core.wasm`, 'application/wasm');

  await instance.load({ coreURL, wasmURL });
  ffmpeg = instance;
  return instance;
}

export async function terminateFFmpeg(): Promise<void> {
  if (ffmpeg) {
    ffmpeg.terminate();
    ffmpeg = null;
    // Allow GC to collect terminated WASM memory
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function getFFmpegInstance(): FFmpeg | null {
  return ffmpeg;
}

async function supportsMultiThread(): Promise<boolean> {
  try {
    return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  } catch {
    return false;
  }
}
