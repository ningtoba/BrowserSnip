/**
 * The three optional CDN engines: PyMuPDF, Ghostscript and CoherentPDF.
 *
 * None of them can be bundled. PyMuPDF is a Pyodide runtime plus Python WASM
 * wheels (tens of megabytes), Ghostscript is a large `gs.js` / `gs.wasm` pair,
 * and CoherentPDF is 1.3 MB of OCaml compiled to JavaScript — and all three are
 * AGPL-3.0 while BrowserSnip is MIT. They are fetched on first use from an
 * address the user may override with a mirror of their own.
 *
 * Because that override is stored in `localStorage`, and because the loaders
 * hand the stored string to `import()` / `<script src>` / `fetch()`, a stray or
 * hostile entry would make this origin execute someone else's JavaScript. The
 * rule set below is copied from BentoPDF's shipped `wasm-provider` bundle and
 * closes that hole:
 *
 *   - the trusted-host set is `location.hostname` plus the hosts of the
 *     built-in default URLs, and it lives in memory only;
 *   - a URL the user saves deliberately is trusted for this session (that is
 *     the whole point of the settings dialog);
 *   - a stored URL is refused and scrubbed when it is stale (an older version
 *     or path of the same jsDelivr package) or foreign (a host nobody chose).
 */

/** Every engine id, in display order. */
export const ENGINE_IDS = ['pymupdf', 'ghostscript', 'cpdf'] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/** `localStorage` key holding the user's own engine addresses. */
export const ENGINE_STORAGE_KEY = 'browsersnip:wasm-engines';

/** Default addresses, verified against BentoPDF's shipped bundles. */
export const ENGINE_DEFAULTS: Record<EngineId, string> = {
  pymupdf: 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/',
  ghostscript: 'https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm@0.1.1/assets/',
  cpdf: 'https://cdn.jsdelivr.net/npm/coherentpdf@2.5.5/dist/',
};

/**
 * File each engine must expose at its base URL. `validateUrl` fetches exactly
 * this path, so a mirror that is missing the entry point is rejected before any
 * tool tries to load it.
 */
export const ENGINE_TEST_FILES: Record<EngineId, string> = {
  pymupdf: 'dist/index.js',
  ghostscript: 'gs.js',
  cpdf: 'coherentpdf.browser.min.js',
};

export const ENGINE_LABELS: Record<EngineId, string> = {
  pymupdf: 'PyMuPDF',
  ghostscript: 'Ghostscript',
  cpdf: 'CoherentPDF',
};

/** One-line role, used by the badge and the gate heading. */
export const ENGINE_ROLES: Record<EngineId, string> = {
  pymupdf: 'document conversion and high-quality text extraction',
  ghostscript: 'PDF/A conversion and font outlining',
  cpdf: 'bookmarks, metadata, page labels and attachments',
};

/** What each engine unlocks — shown so the download is an informed choice. */
export const ENGINE_FEATURES: Record<EngineId, string[]> = {
  pymupdf: [
    'PDF to text, Markdown, HTML, JSON and SVG',
    'PDF to images at a chosen DPI',
    'PDF to DOCX, and EPUB/MOBI/FB2/CBZ/XPS to PDF',
    'Deskew and optional-content layers',
  ],
  ghostscript: [
    'PDF/A-1b, PDF/A-2b and PDF/A-3b conversion',
    'Text fonts converted to outlines',
    'CMYK and separated colour spaces normalised to sRGB',
  ],
  cpdf: [
    'Merge and alternate merge',
    'Bookmarks, tables of contents and page labels',
    'Document and XMP metadata',
    'Embedded file attachments, and PDF to JSON',
  ],
};

/** Licence copy. Shown verbatim in the settings dialog. */
export const ENGINE_LICENCE_NOTE =
  'PyMuPDF, Ghostscript and CoherentPDF are licensed AGPL-3.0. BrowserSnip is MIT, ' +
  'so none of them is bundled: each is downloaded once from a CDN on first use and ' +
  'cached by your browser. Everything still happens in this tab — your PDF never ' +
  'leaves the device.';

/** How long a single `validateUrl` probe may take before it is abandoned. */
export const ENGINE_VALIDATION_TIMEOUT_MS = 10_000;

export interface EngineValidationResult {
  valid: boolean;
  /** Ready-to-display sentence naming what to do; absent only when valid. */
  error?: string;
}

export interface EngineProvider {
  /** Effective address for an engine: the user's, if trusted, else the default. */
  getUrl(id: EngineId): string;
  /** True when an engine has any address at all, so a tool may try to load it. */
  isConfigured(id: EngineId): boolean;
  /** True when the address in use came from the user rather than the default. */
  isUserConfigured(id: EngineId): boolean;
  /** Save a mirror address. A URL the user types deliberately becomes trusted. */
  setUrl(id: EngineId, url: string): void;
  /** Drop one engine's override and fall back to the built-in address. */
  removeUrl(id: EngineId): void;
  /** Drop every override and forget every non-default trusted host. */
  reset(): void;
  isTrustedUrl(url: string): boolean;
  validateUrl(id: EngineId, url?: string): Promise<EngineValidationResult>;
  /** The address each engine would actually load from right now. */
  snapshot(): Record<EngineId, string>;
  /** Listener fires after any change to the configuration. Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Add a trailing slash: every engine address is a directory URL. */
export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** `location.hostname` plus the hosts of the built-in default URLs. */
function baseTrustedHosts(): Set<string> {
  const hosts = new Set<string>();
  if (typeof location !== 'undefined' && location.hostname) hosts.add(location.hostname);
  for (const url of Object.values(ENGINE_DEFAULTS)) {
    const host = hostnameOf(url);
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * True when `url` is another version or path of the package the default URL
 * names, e.g. `…/@bentopdf/pymupdf-wasm@0.9.9/`. Such an entry was written by
 * an older BrowserSnip build; the package layout it points at is not the one
 * the loaders here assume, so it is refused instead of silently half-working.
 */
export function isStaleEngineUrl(id: EngineId, url: string): boolean {
  const fallback = ENGINE_DEFAULTS[id];
  if (url === fallback) return false;
  const cut = fallback.lastIndexOf('@');
  if (cut <= 0) return false;
  const prefix = fallback.slice(0, cut);
  return url.startsWith(`${prefix}@`) || url.startsWith(`${prefix}/`);
}

/** Thrown by a loader when its engine has no usable address, or failed to load. */
export class EngineUnavailable extends Error {
  readonly name = 'EngineUnavailable';
  readonly engine: EngineId;
  readonly remediation: string;

  constructor(engine: EngineId, detail?: string) {
    const remediation =
      `Open Engine Settings, press Test on the recommended ${ENGINE_LABELS[engine]} ` +
      `address and Save it. The module downloads once from a CDN and is cached by ` +
      `your browser; your PDF never leaves the device.`;
    super(`${ENGINE_LABELS[engine]} is not available${detail ? `: ${detail}` : '.'} ${remediation}`);
    this.engine = engine;
    this.remediation = remediation;
  }
}

function readStoredConfig(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(ENGINE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredConfig(config: Partial<Record<EngineId, string>>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.error('[engines] Could not save the engine addresses to localStorage:', err);
  }
}

function clearStoredConfig(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(ENGINE_STORAGE_KEY);
  } catch (err) {
    console.error('[engines] Could not clear the engine addresses from localStorage:', err);
  }
}

/** Build a provider. Exported for tests; the app uses the `engines` singleton. */
export function createEngineProvider(): EngineProvider {
  const baseHosts = baseTrustedHosts();
  let trustedHosts = new Set(baseHosts);
  let config: Partial<Record<EngineId, string>> = {};
  const listeners = new Set<() => void>();

  const isTrustedUrl = (url: string): boolean => {
    const host = hostnameOf(url);
    return host !== null && trustedHosts.has(host);
  };

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const save = (): void => {
    if (Object.keys(config).length > 0) writeStoredConfig(config);
    else clearStoredConfig();
  };

  const load = (): Partial<Record<EngineId, string>> => {
    const next: Partial<Record<EngineId, string>> = {};
    const raw = readStoredConfig();
    if (!raw) return next;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[engines] Ignoring unreadable ${ENGINE_STORAGE_KEY}:`, err);
      clearStoredConfig();
      return next;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      clearStoredConfig();
      return next;
    }

    const stored = parsed as Record<string, unknown>;
    let scrubbed = false;
    for (const id of ENGINE_IDS) {
      const value = stored[id];
      if (typeof value !== 'string') continue;
      if (isStaleEngineUrl(id, value)) {
        scrubbed = true;
        console.warn(
          `[engines] "${value}" is an older ${ENGINE_LABELS[id]} address from a previous build. ` +
            `Using ${ENGINE_DEFAULTS[id]} instead.`,
        );
        continue;
      }
      if (!isTrustedUrl(value)) {
        scrubbed = true;
        console.warn(
          `[engines] "${value}" points at a host this app does not trust. ` +
            `Re-enter it in Engine Settings to use that mirror.`,
        );
        continue;
      }
      next[id] = normalizeBaseUrl(value);
    }
    // Rewrite (or remove) the key so the refused entry cannot linger forever.
    if (scrubbed) writeStoredConfig(next);
    return next;
  };

  config = load();

  const getUrl = (id: EngineId): string => {
    const override = config[id];
    if (override) {
      if (isTrustedUrl(override)) return override;
      console.warn(`[engines] Refusing untrusted ${ENGINE_LABELS[id]} address; using the default.`);
    }
    return ENGINE_DEFAULTS[id];
  };

  const removeUrl = (id: EngineId): void => {
    if (config[id] === undefined) return;
    delete config[id];
    save();
    notify();
  };

  const setUrl = (id: EngineId, url: string): void => {
    const next = normalizeBaseUrl(url);
    const host = hostnameOf(next);
    if (!host) {
      throw new Error(
        `"${url.trim()}" is not a full web address for ${ENGINE_LABELS[id]}. ` +
          `Include the scheme, for example ${ENGINE_DEFAULTS[id]}`,
      );
    }
    // Saving the built-in address is the same as having no override at all.
    if (next === normalizeBaseUrl(ENGINE_DEFAULTS[id])) {
      removeUrl(id);
      return;
    }
    // A URL the user typed on purpose is trusted, for this session and this host.
    trustedHosts.add(host);
    config[id] = next;
    save();
    notify();
  };

  const reset = (): void => {
    config = {};
    trustedHosts = new Set(baseHosts);
    clearStoredConfig();
    notify();
  };

  const validateUrl = async (
    id: EngineId,
    url?: string,
  ): Promise<EngineValidationResult> => {
    const raw = (url ?? '').trim() || config[id] || ENGINE_DEFAULTS[id];
    if (!raw) {
      return { valid: false, error: `No address is configured for ${ENGINE_LABELS[id]} yet.` };
    }

    let parsed: URL;
    try {
      parsed = new URL(normalizeBaseUrl(raw));
    } catch {
      return {
        valid: false,
        error:
          `"${raw}" is not a valid URL. Enter the folder that contains ` +
          `${ENGINE_TEST_FILES[id]}, for example ${ENGINE_DEFAULTS[id]}`,
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        error: `The ${ENGINE_LABELS[id]} address must start with https:// (or http:// for a local mirror).`,
      };
    }

    const base = normalizeBaseUrl(raw);
    const testFile = ENGINE_TEST_FILES[id];
    const assetUrl = `${base}${testFile}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENGINE_VALIDATION_TIMEOUT_MS);

    try {
      const response = await fetch(assetUrl, { method: 'GET', mode: 'cors', signal: controller.signal });
      if (!response.ok) {
        return {
          valid: false,
          error:
            `Could not find ${testFile} at ${base} (HTTP ${response.status}). ` +
            `Check the folder address, and that this ${ENGINE_LABELS[id]} version is still published.`,
        };
      }

      const reader = response.body?.getReader();
      if (reader) {
        try {
          await reader.read();
        } catch {
          return {
            valid: false,
            error:
              `${assetUrl} exists but the browser could not read it. ` +
              `The server must allow cross-origin requests (Access-Control-Allow-Origin).`,
          };
        } finally {
          try {
            await reader.cancel();
          } catch {
            /* already closed */
          }
        }
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType && !/javascript|json|octet-stream|text\//i.test(contentType)) {
        return {
          valid: false,
          error:
            `${assetUrl} returned content type "${contentType}" instead of a JavaScript file. ` +
            `That address is not a ${ENGINE_LABELS[id]} build.`,
        };
      }

      return { valid: true };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          valid: false,
          error:
            `${assetUrl} did not answer within ${ENGINE_VALIDATION_TIMEOUT_MS / 1000} seconds. ` +
            `Check the connection, or try a mirror closer to you.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        error:
          `Could not reach ${assetUrl} (${message}). Check the address and make sure ` +
          `the server allows CORS requests.`,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    getUrl,
    isConfigured: (id) => config[id] !== undefined || Boolean(ENGINE_DEFAULTS[id]),
    isUserConfigured: (id) => config[id] !== undefined,
    setUrl,
    removeUrl,
    reset,
    isTrustedUrl,
    validateUrl,
    snapshot: () =>
      Object.fromEntries(ENGINE_IDS.map((id) => [id, getUrl(id)])) as Record<EngineId, string>,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The provider every engine module and every engine-backed tool shares. */
export const engines: EngineProvider = createEngineProvider();
