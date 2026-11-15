/**
 * qpdf loader.
 *
 * CoherentPDF cannot linearize: since its v1.8 the writer shells out to an
 * external `cpdflin` binary, so `toMemory(pdf, true, …)` in the browser build
 * throws `ERROR: toFileMemory: Pdf.PDFError("Linearization not supported since
 * v1.8. Use an external linearizer.")` on every file. qpdf writes the
 * linearization dictionary, the two cross-reference sections and the hint
 * tables itself, in two passes, and ships its own checker
 * (`--check-linearization`), which is also what `libqpdf` runs behind
 * `pikepdf`'s `check_linearization`.
 *
 * `qpdf.js` is an Emscripten module whose default export is the factory. It is
 * fetched as text and re-imported through a blob URL — the same trick the
 * Ghostscript loader uses — because it must not be resolved relative to the
 * page, and its WASM still has to come from the package folder.
 *
 * That blob URL is also what `locateFile` hands back for `qpdf.js` itself: the
 * build is pthread-based and spawns its workers with
 * `new Worker(locateFile('qpdf.js'), { type: 'module' })`, and Chromium refuses
 * a *cross-origin* worker script outright (`Script at … cannot be accessed from
 * origin …`, measured from this dev server against jsDelivr, both with a
 * classic and a module worker). A same-origin blob is the way through; the WASM
 * is still fetched from the CDN, where jsDelivr sends the CORS and CORP headers
 * a COEP-isolated page needs.
 *
 * The build is pthread-based: Emscripten spawns module workers for it, so the
 * page needs `SharedArrayBuffer`, which is why the dev server and the deployed
 * host send COOP/COEP. Everything after load is an ordinary qpdf command line:
 * input files go into the module's in-memory filesystem, `callMain` runs,
 * outputs are read back and unlinked. Bytes in, bytes out, nothing uploaded.
 */
import { EngineUnavailable, engines, normalizeBaseUrl } from './provider';

/** Subset of the Emscripten filesystem this app uses. */
export interface QpdfFileSystem {
  writeFile(path: string, data: Uint8Array | string): void;
  readFile(path: string): Uint8Array;
  stat(path: string): { size: number };
  unlink(path: string): void;
}

export interface QpdfModule {
  FS: QpdfFileSystem;
  /** Runs one qpdf command line. Returns the exit code qpdf exits with. */
  callMain(args: string[]): number;
}

type QpdfFactory = (options: {
  locateFile(file: string): string;
  print(message: string): void;
  printErr(message: string): void;
  noInitialRun?: boolean;
  noExitRuntime?: boolean;
}) => Promise<QpdfModule>;

/**
 * qpdf prints through `console`, not through the factory's `print`/`printErr`:
 * the Emscripten build binds its stdout to `console.log` once, at start-up. So
 * the only way to read what a run said — and the checker's verdict is a
 * *sentence* — is to sit on the console.
 *
 * The bridge is installed *before* the module is created (a sink attached after
 * the fact captures nothing, measured: the first probe returned an empty
 * verdict), and it forwards to whatever sink is live at the time, so a run's
 * log is its own and the lines still reach the devtools console.
 */
let logSink: ((line: string) => void) | null = null;
let bridged = false;

function bridgeConsole(): void {
  if (bridged) return;
  bridged = true;
  for (const key of ['log', 'warn', 'error'] as const) {
    const original = console[key].bind(console);
    console[key] = (...args: unknown[]) => {
      logSink?.(args.map((arg) => String(arg)).join(' ').trim());
      original(...args);
    };
  }
}

let pendingModule: Promise<QpdfModule> | null = null;
let loadedModule: QpdfModule | null = null;
/** The blob the module was imported from; workers keep being made from it. */
let scriptBlob: string | null = null;

async function loadQpdf(): Promise<QpdfModule> {
  if (!engines.isConfigured('qpdf')) {
    throw new EngineUnavailable('qpdf', 'no address is set');
  }
  const base = normalizeBaseUrl(engines.getUrl('qpdf'));
  const scriptUrl = `${base}qpdf.js`;

  try {
    const response = await fetch(scriptUrl, { method: 'GET', mode: 'cors' });
    if (!response.ok) {
      throw new Error(`Could not fetch ${scriptUrl} (HTTP ${response.status}).`);
    }
    const source = await response.text();
    // Before the factory: it binds the console as it starts.
    bridgeConsole();
    scriptBlob = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    const blobUrl = scriptBlob;
    const mod = (await import(/* @vite-ignore */ blobUrl)) as { default?: QpdfFactory };
    const factory = mod.default;
    if (typeof factory !== 'function') {
      throw new Error(`${scriptUrl} did not export the qpdf module factory.`);
    }
    return await factory({
      // Every pthread worker is built from the same-origin blob; the WASM comes
      // from the package folder beside qpdf.js.
      locateFile: (file) => (file.endsWith('.wasm') ? `${base}${file}` : blobUrl),
      print: (line) => logSink?.(line),
      printErr: (line) => logSink?.(line),
      // qpdf is run `callMain`-by-`callMain` for the life of the tab, so the
      // runtime must not shut down after the first command.
      noInitialRun: true,
      noExitRuntime: true,
    });
  } catch (err) {
    // A loader failure is *not* the same event as qpdf running and refusing a
    // file: the tool words the two differently and only the second means the
    // document was looked at. `EngineUnavailable` is that difference.
    const message = err instanceof Error ? err.message : String(err);
    throw new EngineUnavailable('qpdf', `Failed to load qpdf from ${base}: ${message}`);
  }
}

/** The initialised qpdf module. Memoised and concurrent-safe. */
export function qpdf(): Promise<QpdfModule> {
  if (loadedModule) return Promise.resolve(loadedModule);
  if (!pendingModule) {
    pendingModule = loadQpdf().catch((err: unknown) => {
      pendingModule = null;
      throw err;
    });
  }
  return pendingModule.then((module) => {
    loadedModule = module;
    return module;
  });
}

export function resetQpdf(): void {
  loadedModule = null;
  pendingModule = null;
  // The module is being dropped; nothing left will spawn a worker from it.
  if (scriptBlob) URL.revokeObjectURL(scriptBlob);
  scriptBlob = null;
}

export interface QpdfRunOptions {
  /** Sandbox paths to read back after the run, e.g. `['/tmp/out.pdf']`. */
  outputs?: string[];
  /** qpdf's own console output, for logs and for the checker's verdict. */
  onLog?: (line: string) => void;
}

export interface QpdfRun {
  exitCode: number;
  /** Contents of `options.outputs`, keyed by the same sandbox paths. */
  outputs: Record<string, Uint8Array>;
  log: string[];
}

/**
 * One qpdf run inside the module's sandbox.
 *
 * `files` maps absolute sandbox paths (`/tmp/input.pdf`) to their contents;
 * `args` reference those same paths. Every path is unlinked afterwards,
 * including the outputs, so repeated runs on a large document do not grow the
 * heap. A non-zero exit code is thrown here rather than returned: qpdf reports
 * a refused or broken command that way and the caller has to show it.
 */
export async function runQpdf(
  args: string[],
  files: Record<string, Uint8Array> = {},
  options: QpdfRunOptions = {},
): Promise<QpdfRun> {
  const module = await qpdf();
  const paths = Object.keys(files);
  const outputs = options.outputs ?? [];
  const log: string[] = [];
  logSink = (line) => {
    if (!line) return;
    log.push(line);
    options.onLog?.(line);
  };

  try {
    for (const path of paths) module.FS.writeFile(path, files[path]);

    const exitCode = module.callMain(args);

    const collected: Record<string, Uint8Array> = {};
    for (const path of outputs) {
      try {
        collected[path] = module.FS.readFile(path);
      } catch {
        // A missing output is the caller's problem once the exit code is 0;
        // `outputs` simply has no entry for that path.
      }
    }

    if (exitCode !== 0) {
      const tail = log.filter(Boolean).slice(-3).join(' / ');
      throw new Error(
        `qpdf stopped with exit code ${exitCode}${tail ? `: ${tail}` : ''}. ` +
          `The file was not written.`,
      );
    }

    return { exitCode, outputs: collected, log };
  } finally {
    logSink = null;
    for (const path of [...paths, ...outputs]) {
      try {
        module.FS.unlink(path);
      } catch {
        /* never written, or already removed */
      }
    }
  }
}
