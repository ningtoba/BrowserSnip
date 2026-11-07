/**
 * Engine provider rules: defaults, the trust list, what survives a reload, and
 * `validateUrl` against a stubbed `fetch`.
 *
 * The provider is the security boundary for the optional engines — the string
 * it hands back is passed to `import()`, `<script src>` and `fetch()`, and there
 * is no UI left to police it — so the refused-and-scrubbed paths matter more
 * than the happy path here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENGINE_DEFAULTS,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_STORAGE_KEY,
  ENGINE_TEST_FILES,
  ENGINE_VALIDATION_TIMEOUT_MS,
  EngineUnavailable,
  createEngineProvider,
  engines,
  isStaleEngineUrl,
  normalizeBaseUrl,
  type EngineProvider,
} from '@/lib/pdf/engines';

const FOREIGN_URL = 'https://mirror.example.com/engines/';
const STALE_PYMUPDF = 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.9.9/';

function storedConfig(): Record<string, unknown> {
  const raw = localStorage.getItem(ENGINE_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

interface ResponseOptions {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  readThrows?: boolean;
}

function responseStub(options: ResponseOptions = {}): Response {
  const ok = options.ok ?? true;
  const contentType = options.contentType === undefined ? 'application/javascript' : options.contentType;
  return {
    ok,
    status: options.status ?? (ok ? 200 : 404),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    body: {
      getReader: () => ({
        read: () =>
          options.readThrows
            ? Promise.reject(new Error('blocked by CORS'))
            : Promise.resolve({ done: false, value: new Uint8Array([47, 47]) }),
        cancel: () => Promise.resolve(),
      }),
    },
  } as unknown as Response;
}

function stubFetch(factory: () => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(factory);
  vi.stubGlobal('fetch', mock);
  return mock;
}

let provider: EngineProvider;

beforeEach(() => {
  localStorage.clear();
  provider = createEngineProvider();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('defaults', () => {
  it('names the app-specific localStorage key', () => {
    expect(ENGINE_STORAGE_KEY).toBe('browsersnip:wasm-engines');
  });

  it('ships the observed CDN addresses, each a directory URL', () => {
    expect(ENGINE_DEFAULTS).toEqual({
      pymupdf: 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/',
      ghostscript: 'https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm@0.1.1/assets/',
      cpdf: 'https://cdn.jsdelivr.net/npm/coherentpdf@2.5.5/dist/',
    });
    for (const id of ENGINE_IDS) {
      expect(provider.getUrl(id)).toBe(ENGINE_DEFAULTS[id]);
      expect(ENGINE_DEFAULTS[id].endsWith('/')).toBe(true);
    }
  });

  it('probes the file each package really exposes', () => {
    expect(ENGINE_TEST_FILES).toEqual({
      pymupdf: 'dist/index.js',
      ghostscript: 'gs.js',
      cpdf: 'coherentpdf.browser.min.js',
    });
  });

  it('is configured but not user-configured out of the box', () => {
    for (const id of ENGINE_IDS) {
      expect(provider.isConfigured(id)).toBe(true);
      expect(provider.isUserConfigured(id)).toBe(false);
    }
  });

  it('snapshots the effective address of every engine', () => {
    expect(provider.snapshot()).toEqual({ ...ENGINE_DEFAULTS });

    provider.setUrl('cpdf', FOREIGN_URL);
    expect(provider.snapshot()).toEqual({
      ...ENGINE_DEFAULTS,
      cpdf: normalizeBaseUrl(FOREIGN_URL),
    });
  });

  it('exposes the same singleton the loaders use', () => {
    expect(engines.getUrl('pymupdf')).toBe(ENGINE_DEFAULTS.pymupdf);
    expect(engines.snapshot()).toEqual({ ...ENGINE_DEFAULTS });
  });
});

describe('trusted hosts', () => {
  it('trusts the page origin and the default hosts only', () => {
    for (const id of ENGINE_IDS) {
      expect(provider.isTrustedUrl(ENGINE_DEFAULTS[id])).toBe(true);
    }
    expect(provider.isTrustedUrl(`${location.origin}/vendor/cpdf/`)).toBe(true);
    expect(provider.isTrustedUrl(FOREIGN_URL)).toBe(false);
    expect(provider.isTrustedUrl('not-a-url')).toBe(false);
  });

  it('trusts a host the user chose deliberately', () => {
    provider.setUrl('ghostscript', FOREIGN_URL);
    expect(provider.isTrustedUrl(FOREIGN_URL)).toBe(true);
    expect(provider.isUserConfigured('ghostscript')).toBe(true);
    expect(provider.getUrl('ghostscript')).toBe(normalizeBaseUrl(FOREIGN_URL));
    expect(storedConfig().ghostscript).toBe(normalizeBaseUrl(FOREIGN_URL));
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = provider.subscribe(listener);

    provider.setUrl('cpdf', FOREIGN_URL);
    expect(listener).toHaveBeenCalledTimes(1);

    provider.removeUrl('cpdf');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    provider.setUrl('cpdf', FOREIGN_URL);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('stored configuration', () => {
  it('refuses and scrubs a stale package version', () => {
    localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify({ pymupdf: STALE_PYMUPDF }));
    const reloaded = createEngineProvider();

    expect(reloaded.isUserConfigured('pymupdf')).toBe(false);
    expect(reloaded.getUrl('pymupdf')).toBe(ENGINE_DEFAULTS.pymupdf);
    expect(storedConfig().pymupdf).toBeUndefined();
  });

  it('refuses and scrubs a foreign host', () => {
    localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify({ ghostscript: FOREIGN_URL }));
    const reloaded = createEngineProvider();

    expect(reloaded.getUrl('ghostscript')).toBe(ENGINE_DEFAULTS.ghostscript);
    expect(storedConfig().ghostscript).toBeUndefined();
  });

  it('keeps an override that lives on a trusted host', () => {
    const sameHost = 'https://cdn.jsdelivr.net/gh/vendor/coherentpdf-mirror/dist/';
    localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify({ cpdf: sameHost }));
    const reloaded = createEngineProvider();

    expect(reloaded.isUserConfigured('cpdf')).toBe(true);
    expect(reloaded.getUrl('cpdf')).toBe(sameHost);
  });

  it('refuses another folder of the pinned package: the loaders assume dist/ and assets/', () => {
    const samePackage = 'https://cdn.jsdelivr.net/npm/coherentpdf@2.5.5/build/';
    localStorage.setItem(ENGINE_STORAGE_KEY, JSON.stringify({ cpdf: samePackage }));
    const reloaded = createEngineProvider();

    expect(reloaded.getUrl('cpdf')).toBe(ENGINE_DEFAULTS.cpdf);
    expect(storedConfig().cpdf).toBeUndefined();
  });

  it('drops an unreadable payload instead of falling over', () => {
    localStorage.setItem(ENGINE_STORAGE_KEY, '{not json');
    const reloaded = createEngineProvider();

    expect(reloaded.getUrl('cpdf')).toBe(ENGINE_DEFAULTS.cpdf);
    expect(localStorage.getItem(ENGINE_STORAGE_KEY)).toBeNull();
  });

  it('recognises stale package addresses', () => {
    expect(isStaleEngineUrl('pymupdf', STALE_PYMUPDF)).toBe(true);
    expect(isStaleEngineUrl('pymupdf', 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm/')).toBe(true);
    expect(isStaleEngineUrl('pymupdf', ENGINE_DEFAULTS.pymupdf)).toBe(false);
    expect(isStaleEngineUrl('cpdf', FOREIGN_URL)).toBe(false);
  });

  it('normalizes directory URLs', () => {
    expect(normalizeBaseUrl('https://cdn.example.test/wasm')).toBe('https://cdn.example.test/wasm/');
    expect(normalizeBaseUrl(' https://cdn.example.test/wasm/ ')).toBe('https://cdn.example.test/wasm/');
  });
});

describe('setUrl, removeUrl and reset', () => {
  it('treats saving the built-in address as no override', () => {
    provider.setUrl('cpdf', FOREIGN_URL);
    expect(provider.isUserConfigured('cpdf')).toBe(true);

    provider.setUrl('cpdf', ENGINE_DEFAULTS.cpdf);
    expect(provider.isUserConfigured('cpdf')).toBe(false);
    expect(provider.getUrl('cpdf')).toBe(ENGINE_DEFAULTS.cpdf);
    expect(localStorage.getItem(ENGINE_STORAGE_KEY)).toBeNull();
  });

  it('adds the missing trailing slash', () => {
    provider.setUrl('pymupdf', 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16');
    expect(provider.getUrl('pymupdf')).toBe(ENGINE_DEFAULTS.pymupdf);
    expect(provider.isUserConfigured('pymupdf')).toBe(false);
  });

  it('rejects an address with no host and says what to type', () => {
    expect(() => provider.setUrl('ghostscript', 'gs-wasm/assets/')).toThrow(
      /is not a full web address for Ghostscript/,
    );
    expect(provider.isUserConfigured('ghostscript')).toBe(false);
  });

  it('removes one override and leaves the others alone', () => {
    provider.setUrl('pymupdf', 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/mirror/');
    provider.setUrl('cpdf', FOREIGN_URL);

    provider.removeUrl('cpdf');
    expect(provider.isUserConfigured('cpdf')).toBe(false);
    expect(provider.getUrl('cpdf')).toBe(ENGINE_DEFAULTS.cpdf);
    expect(provider.isUserConfigured('pymupdf')).toBe(true);
  });

  it('does not notify when there is nothing to remove', () => {
    const listener = vi.fn();
    provider.subscribe(listener);
    provider.removeUrl('cpdf');
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset clears storage, overrides and session-trusted hosts', () => {
    provider.setUrl('ghostscript', FOREIGN_URL);
    provider.reset();

    expect(provider.isUserConfigured('ghostscript')).toBe(false);
    expect(provider.getUrl('ghostscript')).toBe(ENGINE_DEFAULTS.ghostscript);
    expect(provider.isTrustedUrl(FOREIGN_URL)).toBe(false);
    expect(localStorage.getItem(ENGINE_STORAGE_KEY)).toBeNull();
  });
});

describe('validateUrl', () => {
  it.each(ENGINE_IDS)('probes %s at its real entry point', async (id) => {
    const mock = stubFetch(() => responseStub());
    const result = await provider.validateUrl(id, ENGINE_DEFAULTS[id]);

    expect(result).toEqual({ valid: true });
    expect(mock).toHaveBeenCalledWith(
      `${ENGINE_DEFAULTS[id]}${ENGINE_TEST_FILES[id]}`,
      expect.objectContaining({ method: 'GET', mode: 'cors' }),
    );
    const signal = (mock.mock.calls[0][1] as RequestInit).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('times out after ten seconds', async () => {
    expect(ENGINE_VALIDATION_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          // Reject the way a real aborted fetch does, once the timer fires.
          setTimeout(() => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          }, ENGINE_VALIDATION_TIMEOUT_MS);
        }),
    );

    const probing = provider.validateUrl('ghostscript', ENGINE_DEFAULTS.ghostscript);
    await vi.advanceTimersByTimeAsync(ENGINE_VALIDATION_TIMEOUT_MS);
    const result = await probing;

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/did not answer within 10 seconds/);
  });

  it('reports a missing file by name and status', async () => {
    stubFetch(() => responseStub({ ok: false, status: 404 }));
    const result = await provider.validateUrl('cpdf', ENGINE_DEFAULTS.cpdf);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Could not find coherentpdf\.browser\.min\.js/);
    expect(result.error).toMatch(/HTTP 404/);
  });

  it('reports a body it cannot read', async () => {
    stubFetch(() => responseStub({ readThrows: true }));
    const result = await provider.validateUrl('pymupdf', ENGINE_DEFAULTS.pymupdf);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/could not read it/);
  });

  it('rejects a response that is not a script', async () => {
    stubFetch(() => responseStub({ contentType: 'application/pdf' }));
    const result = await provider.validateUrl('pymupdf', ENGINE_DEFAULTS.pymupdf);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/content type "application\/pdf"/);
  });

  it('accepts a plain-text error page rather than guessing', async () => {
    stubFetch(() => responseStub({ contentType: 'text/plain; charset=utf-8' }));
    expect(await provider.validateUrl('cpdf', ENGINE_DEFAULTS.cpdf)).toEqual({ valid: true });
  });

  it('reports a network failure as actionable', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const result = await provider.validateUrl('cpdf', ENGINE_DEFAULTS.cpdf);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Could not reach/);
    expect(result.error).toMatch(/CORS/);
  });

  it('checks the address shape before the network', async () => {
    const mock = stubFetch(() => responseStub());

    expect((await provider.validateUrl('cpdf', 'nonsense')).error).toMatch(/not a valid URL/);
    expect((await provider.validateUrl('cpdf', 'ftp://cdn.example.test/cpdf/')).error).toMatch(
      /must start with https:/,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('validates the stored override when no URL is passed', async () => {
    provider.setUrl('cpdf', FOREIGN_URL);
    const mock = stubFetch(() => responseStub());

    expect(await provider.validateUrl('cpdf')).toEqual({ valid: true });
    expect(mock).toHaveBeenCalledWith(
      `${normalizeBaseUrl(FOREIGN_URL)}coherentpdf.browser.min.js`,
      expect.anything(),
    );
  });

  it('leaves a stored override alone when the test fails', async () => {
    stubFetch(() => responseStub({ ok: false, status: 500 }));
    const result = await provider.validateUrl('pymupdf', 'https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/');

    expect(result.valid).toBe(false);
    expect(provider.isUserConfigured('pymupdf')).toBe(false);
  });
});

describe('EngineUnavailable', () => {
  it('carries the engine id, the host and the loader’s own reason', () => {
    const error = new EngineUnavailable('cpdf', 'the CDN returned an HTML page');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EngineUnavailable');
    expect(error.engine).toBe('cpdf');
    expect(error.host).toBe('cdn.jsdelivr.net');
    expect(error.detail).toBe('the CDN returned an HTML page');
    expect(error.message).toContain(ENGINE_LABELS.cpdf);
    expect(error.message).toMatch(/the CDN returned an HTML page/);
    expect(error.message).toMatch(/cdn\.jsdelivr\.net/);
  });

  it('never tells the user to enable or configure anything', () => {
    // The engine UI is gone, so a sentence that sends someone to settings is a
    // dead end: name the failure and what happens instead.
    for (const id of ENGINE_IDS) {
      const message = new EngineUnavailable(id, 'offline').message;
      expect(message, id).not.toMatch(/settings|enable|configure/i);
      expect(message, id).toMatch(/cached by your browser/);
    }
  });
});

// There is no engine UI to test any more: `EngineGate.tsx` is gone, and an
// engine is resolved from the default address inside a run. That behaviour is
// covered by `tests/pdf/engine-auto.test.ts`.
