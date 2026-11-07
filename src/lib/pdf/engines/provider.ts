/**
 * The three optional CDN engines: PyMuPDF, Ghostscript and CoherentPDF.
 *
 * None of them can be bundled. PyMuPDF is a Pyodide runtime plus Python WASM
 * wheels, Ghostscript is a large `gs.js` / `gs.wasm` pair, and CoherentPDF is
 * OCaml compiled to JavaScript — and all three are AGPL-3.0 while BrowserSnip
 * is MIT. They are therefore fetched from the default address below, lazily,
 * the first time a tool actually needs one (see `auto.ts`); the browser cache
 * covers every run after that. There is no engine UI and nothing to enable.
 *
 * A mirror can still live in `localStorage`, written by an older build or by an
 * advanced user. Because the loaders hand that string to `import()` /
 * `<script src>` / `fetch()`, a stray or hostile entry would make this origin
 * execute someone else's JavaScript. The rule set below is copied from
 * BentoPDF's shipped `wasm-provider` bundle and closes that hole:
 *
 *   - the trusted-host set is `location.hostname` plus the hosts of the
 *     built-in default URLs, and it lives in memory only;
 *   - a URL saved through `setUrl` is trusted for this session;
 *   - a stored URL is refused and scrubbed when it is stale (an older version
 *     or path of the same jsDelivr package) or foreign (a host nobody chose).
 */

/** Every engine id, in display order. */
export const ENGINE_IDS = ['pymupdf', 'ghostscript', 'cpdf'] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/** `localStorage` key holding the user's own engine addresses. */
export const ENGINE_STORAGE_KEY = 'browsersnip:wasm-engines';

/**
 * Roughly what each download costs the user, measured from the published
 * packages (`data.jsdelivr.com`, 2026-07). Quoted in the one line a run prints
 * before it waits on the network, so a 15 MB stall is not a blank pane.
 */
export const ENGINE_DOWNLOAD_SIZE: Record<EngineId, string> = {
  pymupdf: 'about 54 MB',
  ghostscript: 'about 15 MB',
  cpdf: 'about 0.5 MB',
};

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

/** One-line role: what the engine is for, used in the sentences a run prints. */
export const ENGINE_ROLES: Record<EngineId, string> = {
  pymupdf: 'document conversion and high-quality text extraction',
  ghostscript: 'PDF/A conversion and font outlining',
  cpdf: 'bookmarks, metadata, page labels and attachments',
};

/** How long a single `validateUrl` probe may take before it is abandoned. */
export const ENGINE_VALIDATION_TIMEOUT_MS = 10_000;

export interface EngineValidationResult {
  valid: boolean;
  /** Ready-to-display sentence naming what to do; absent only when valid. */
  error?: string;
}

export interface EngineProvider {
  /** Effective address for an engine: a stored mirror if trusted, else the default. */
  getUrl(id: EngineId): string;
  /** True when an engine has any address at all, so a tool may try to load it. */
  isConfigured(id: EngineId): boolean;
  /** True when the address in use came from storage rather than the default. */
  isUserConfigured(id: EngineId): boolean;
  /** Save a mirror address. An address typed deliberately becomes trusted. */
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

/**
 * Thrown when an engine could not be fetched — offline, a blocked CDN, or a
 * mirror that stopped answering. The sentence names the engine, the host and
 * the reason, and says what happens instead; it never tells the user to enable
 * something, because there is nothing left to enable.
 */
export class EngineUnavailable extends Error {
  readonly name = 'EngineUnavailable';
  readonly engine: EngineId;
  /** Host the default address points at, so copy can name where it failed. */
  readonly host: string;
  /** The loader's own cause, kept separate so callers can quote just that. */
  readonly detail?: string;

  constructor(engine: EngineId, detail?: string) {
    const host = hostnameOf(ENGINE_DEFAULTS[engine]) ?? 'the CDN';
    super(
      `${ENGINE_LABELS[engine]} could not be fetched from ${host}` +
        `${detail ? ` (${detail})` : ''}. It is downloaded once, when a tool needs ` +
        `it, and cached by your browser; nothing was uploaded.`,
    );
    this.engine = engine;
    this.host = host;
    this.detail = detail;
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
          `[engines] "${value}" points at a host this app does not trust; ` +
            `using the built-in address instead.`,
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
