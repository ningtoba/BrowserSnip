/**
 * Ghostscript loader.
 *
 * `gs.js` is an Emscripten module whose default export is the module factory.
 * It is fetched as text and re-imported through a blob URL — the same trick
 * BentoPDF ships — because the factory needs `locateFile` pointing at the CDN
 * folder for `gs.wasm`, and importing the text keeps the WASM path under our
 * control rather than relative to the blob.
 *
 * Everything after that is a normal Ghostscript invocation: write input files
 * into the module's in-memory filesystem, `callMain(args)`, read the output
 * back, unlink. Bytes in, bytes out; nothing is uploaded.
 */
import { EngineUnavailable, engines, normalizeBaseUrl } from './provider';

/** Subset of the Emscripten filesystem this app uses. */
export interface GhostscriptFileSystem {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  stat(path: string): { size: number };
  unlink(path: string): void;
}

export interface GhostscriptModule {
  FS: GhostscriptFileSystem;
  /** Runs one Ghostscript command line. Returns the exit code. */
  callMain(args: string[]): number;
}

type GhostscriptFactory = (options: {
  locateFile(file: string): string;
  print(message: string): void;
  printErr(message: string): void;
}) => Promise<GhostscriptModule>;

/**
 * Ghostscript's own output goes to the factory's `print`/`printErr`, which are
 * fixed when the module is created — but a run needs those lines to explain a
 * failure. `callMain` is synchronous, so one sink at a time is enough.
 */
let logSink: ((line: string) => void) | null = null;

export interface GhostscriptRunOptions {
  /** Sandbox paths to read back after the run, e.g. `['/tmp/output.pdf']`. */
  outputs?: string[];
  /** Ghostscript's own stdout/stderr, for `progress()` messages and logs. */
  onLog?: (line: string) => void;
}

export interface GhostscriptRun {
  exitCode: number;
  /** Contents of `options.outputs`, keyed by the same sandbox paths. */
  outputs: Record<string, Uint8Array>;
  log: string[];
}

let pendingModule: Promise<GhostscriptModule> | null = null;
let loadedModule: GhostscriptModule | null = null;

export function ghostscriptConfigured(): boolean {
  return engines.isConfigured('ghostscript');
}

async function loadGhostscript(): Promise<GhostscriptModule> {
  if (!engines.isConfigured('ghostscript')) throw new EngineUnavailable('ghostscript');

  const base = normalizeBaseUrl(engines.getUrl('ghostscript'));
  const scriptUrl = `${base}gs.js`;

  try {
    const response = await fetch(scriptUrl, { method: 'GET', mode: 'cors' });
    if (!response.ok) {
      throw new Error(`Could not fetch ${scriptUrl} (HTTP ${response.status}).`);
    }
    const source = await response.text();
    const blobUrl = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    try {
      const mod = (await import(/* @vite-ignore */ blobUrl)) as { default?: GhostscriptFactory };
      const factory = mod.default;
      if (typeof factory !== 'function') {
        throw new Error(`${scriptUrl} did not export the Ghostscript module factory.`);
      }
      return await factory({
        locateFile: (file) => (file.endsWith('.wasm') ? `${base}gs.wasm` : `${base}${file}`),
        print: (line) => {
          console.log('[ghostscript]', line);
          logSink?.(line);
        },
        printErr: (line) => {
          console.error('[ghostscript]', line);
          logSink?.(line);
        },
      });
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load Ghostscript from ${base}: ${message}`);
  }
}

/** The initialised Ghostscript module. Memoised and concurrent-safe. */
export function ghostscript(): Promise<GhostscriptModule> {
  if (loadedModule) return Promise.resolve(loadedModule);
  if (!pendingModule) {
    pendingModule = loadGhostscript().catch((err: unknown) => {
      pendingModule = null;
      throw err;
    });
  }
  return pendingModule;
}

export function resetGhostscript(): void {
  loadedModule = null;
  pendingModule = null;
}

/**
 * One Ghostscript run inside the module's sandbox.
 *
 * `files` maps absolute sandbox paths (`/tmp/input.pdf`) to their contents;
 * `args` may reference those same paths. Every path is unlinked afterwards,
 * including the outputs, so repeated runs on a large document do not grow the
 * WASM heap. A non-zero exit code is an error, not a warning: Ghostscript
 * reports a refused or broken conversion that way, and the caller needs to show
 * it rather than save an empty PDF.
 */
export async function run(
  args: string[],
  files: Record<string, Uint8Array> = {},
  options: GhostscriptRunOptions = {},
): Promise<GhostscriptRun> {
  const gs = await ghostscript();
  const paths = Object.keys(files);
  const outputs = options.outputs ?? [];
  const log: string[] = [];
  const previousSink = logSink;
  logSink = (line) => {
    log.push(line);
    options.onLog?.(line);
  };

  try {
    for (const path of paths) gs.FS.writeFile(path, files[path]);

    const exitCode = gs.callMain(args);

    const collected: Record<string, Uint8Array> = {};
    for (const path of outputs) {
      try {
        collected[path] = gs.FS.readFile(path);
      } catch {
        // A missing output is the caller's problem once the exit code is 0;
        // `outputs` simply has no entry for that path.
      }
    }

    if (exitCode !== 0) {
      const tail = log.slice(-3).join(' / ');
      throw new Error(
        `Ghostscript stopped with exit code ${exitCode}${tail ? `: ${tail}` : ''}. ` +
          `The PDF was not converted; try the tool again, or simplify the document ` +
          `(fonts and colour spaces are the usual causes).`,
      );
    }

    return { exitCode, outputs: collected, log };
  } finally {
    logSink = previousSink;
    for (const path of [...paths, ...outputs]) {
      try {
        gs.FS.unlink(path);
      } catch {
        /* never written, or already removed by Ghostscript */
      }
    }
  }
}
