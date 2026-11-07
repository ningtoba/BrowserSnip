/**
 * Engines resolve themselves.
 *
 * The engine UI is gone: there is no settings dialog, no badge and no chip, so
 * nothing may tell the user to "enable" a module, and nothing may download
 * 15–54 MB of WebAssembly at page load. A tool that needs an engine asks for it
 * inside the run, once, and a failed download leaves the run with an honest
 * sentence rather than a refusal or a blank pane.
 *
 * The loader modules are replaced with doubles here — a test must not touch the
 * real CDN — so these assertions are about *when* a load is attempted, how many
 * times, and what the user is told when it fails. jsdom has no canvas and no
 * blob module, so nothing here inspects pixels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@maxwbh/pdf-lib';

const loaders = vi.hoisted(() => ({
  ghostscript: vi.fn<() => Promise<unknown>>(),
  cpdf: vi.fn<() => Promise<unknown>>(),
  pymupdf: vi.fn<() => Promise<unknown>>(),
  /** Stands in for Ghostscript's `run`, so a provisioned engine can "convert". */
  gsRun: vi.fn<() => Promise<{ exitCode: number; outputs: Record<string, Uint8Array>; log: string[] }>>(),
}));

vi.mock('@/lib/pdf/engines/ghostscript', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/ghostscript')>();
  return { ...real, ghostscript: loaders.ghostscript, run: loaders.gsRun };
});

vi.mock('@/lib/pdf/engines/cpdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/cpdf')>();
  return { ...real, cpdf: loaders.cpdf, loadCpdf: loaders.cpdf };
});

vi.mock('@/lib/pdf/engines/pymupdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/engines/pymupdf')>();
  return { ...real, pymupdf: loaders.pymupdf };
});

import {
  engineFetchLine,
  engineLoaded,
  ensureEngine,
  resetEngines,
} from '@/lib/pdf/engines/auto';
import { ENGINE_DEFAULTS, ENGINE_IDS } from '@/lib/pdf/engines/provider';
import { EngineUnavailable, convertToPdfA } from '@/lib/pdf/core/engine-ops';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import * as engineBarrel from '@/lib/pdf/engines';

const HOST = 'cdn.jsdelivr.net';

/** Every name the deleted engine UI exported; none may come back. */
const ENGINE_UI_NAMES = [
  'EngineGate',
  'EngineSettingsDialog',
  'EngineBadge',
  'EngineRequirementBadge',
  'useEngineStatus',
];

async function pdfFile(name = 'doc.pdf', pages = 1): Promise<File> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < pages; index++) doc.addPage([300, 200]);
  const bytes = await doc.save();
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

beforeEach(() => {
  resetEngines();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('nothing is fetched at page load', () => {
  it('has no engine loaded just because the modules were imported', () => {
    // Importing `core/engine-ops` and the tool runner is what the app shell does
    // on every page; it must not cost a download.
    for (const id of ENGINE_IDS) expect(engineLoaded(id), id).toBe(false);
    expect(loaders.ghostscript).not.toHaveBeenCalled();
    expect(loaders.cpdf).not.toHaveBeenCalled();
    expect(loaders.pymupdf).not.toHaveBeenCalled();
  });

  it('loads an engine only when something asks for it', async () => {
    loaders.ghostscript.mockResolvedValue({});
    expect(loaders.ghostscript).not.toHaveBeenCalled();

    await ensureEngine('ghostscript');

    expect(loaders.ghostscript).toHaveBeenCalledTimes(1);
    expect(engineLoaded('ghostscript')).toBe(true);
  });
});

describe('ensureEngine', () => {
  it('fetches once per session and reuses the live module', async () => {
    loaders.cpdf.mockResolvedValue({});

    await expect(ensureEngine('cpdf')).resolves.toMatchObject({ ok: true, loaded: true });
    await expect(ensureEngine('cpdf')).resolves.toMatchObject({ ok: true, loaded: false });

    expect(loaders.cpdf).toHaveBeenCalledTimes(1);
  });

  it('shares one download between tools started together, and says so once', async () => {
    // The release handle lives on an object, not in a `let`: the loader assigns
    // it from inside a promise executor, which control-flow analysis cannot see,
    // so `release?.()` used to compile as a call on `never` — and would have been
    // a silent no-op had the loader not been reached yet.
    const gate: { release: (() => void) | null } = { release: null };
    loaders.ghostscript.mockImplementation(
      () => new Promise((resolve) => {
        gate.release = () => resolve({});
      }),
    );
    const status = vi.fn();

    const both = Promise.all([ensureEngine('ghostscript', { onStatus: status }), ensureEngine('ghostscript', { onStatus: status })]);
    expect(gate.release, 'the download was not in flight to be shared').toBeTypeOf('function');
    gate.release?.();

    await expect(both).resolves.toMatchObject([
      { ok: true, loaded: true },
      { ok: true, loaded: true },
    ]);
    expect(loaders.ghostscript).toHaveBeenCalledTimes(1);
    expect(status.mock.calls.filter(([line]) => String(line).includes('is being fetched'))).toHaveLength(1);
  });

  it('reports a failed download instead of throwing, and tries again next run', async () => {
    loaders.cpdf.mockRejectedValueOnce(new Error('Failed to fetch'));
    const status = vi.fn();

    const first = await ensureEngine('cpdf', { onStatus: status });

    expect(first.ok).toBe(false);
    expect(!first.ok && first.reason).toMatch(/Failed to fetch/);
    expect(engineLoaded('cpdf')).toBe(false);

    // Back online: the failure must not have poisoned the tab.
    loaders.cpdf.mockResolvedValue({});
    await expect(ensureEngine('cpdf')).resolves.toMatchObject({ ok: true });
    expect(loaders.cpdf).toHaveBeenCalledTimes(2);
  });

  it('warns about the size and the host before it waits on the network', () => {
    const line = engineFetchLine('ghostscript');

    expect(line).toContain('Ghostscript');
    expect(line).toContain(HOST);
    expect(line).toMatch(/about 15 MB/);
    expect(line).toMatch(/Your PDF stays on this device/);
    // No prompt: the address is the built-in one, so there is nothing to enable.
    expect(line).not.toMatch(/settings|enable|configure/i);
    expect(engineFetchLine('cpdf')).toContain(HOST);
  });
});

describe('an operation provisions its own engine', () => {
  it('runs Ghostscript after fetching it', async () => {
    const input = new Uint8Array([1, 2, 3]);
    const output = new Uint8Array([9, 9, 9]);
    loaders.ghostscript.mockResolvedValue({});
    loaders.gsRun.mockResolvedValue({ exitCode: 0, outputs: { '/tmp/output.pdf': output }, log: [] });

    const outcome = await convertToPdfA(input, '2b', { onStatus: () => {} });

    expect(Array.from(outcome.bytes)).toEqual(Array.from(output));
    expect(loaders.ghostscript).toHaveBeenCalledTimes(1);
    expect(loaders.gsRun).toHaveBeenCalledTimes(1);
  });

  it('refuses with a sentence that names the engine and the host, not a setting', async () => {
    loaders.ghostscript.mockRejectedValue(new Error('Failed to fetch'));
    const status = vi.fn();

    const error = await convertToPdfA(new Uint8Array([1]), '2b', { onStatus: status }).catch((err) => err);

    expect(error).toBeInstanceOf(EngineUnavailable);
    expect((error as Error).message).toMatch(new RegExp(`Ghostscript could not be fetched from ${HOST}`));
    expect((error as Error).message).toMatch(/Failed to fetch/);
    expect((error as Error).message).not.toMatch(/settings|enable|configure/i);
    // The engine itself was never asked to do anything.
    expect(loaders.gsRun).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledTimes(1);
  });
});

describe('a run degrades instead of asking the user to enable something', () => {
  it('hands back a locally rebuilt file with one warning when CoherentPDF cannot be fetched', async () => {
    const file = await pdfFile('linearize-me.pdf', 2);
    loaders.cpdf.mockRejectedValue(new Error('Failed to fetch'));

    const outcome = await runPdfTool({ toolId: 'linearize-pdf', files: [file], values: {} });

    expect(outcome.outputs).toHaveLength(1);
    expect(outcome.warnings.join(' ')).toMatch(/CoherentPDF could not be reach.*Failed to fetch/i);
    expect(outcome.warnings.join(' ')).toMatch(/rebuilt locally and is not linearized/i);
    expect(outcome.message).toMatch(/not a conforming linearized PDF/i);
    expect(`${outcome.message} ${outcome.warnings.join(' ')}`).not.toMatch(/settings|enable/i);

    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount()).toBe(2);
  });

  it('refuses plainly when a tool has no fallback, and names the alternative', async () => {
    const file = await pdfFile('type.pdf', 1);
    loaders.ghostscript.mockRejectedValue(new Error('Failed to fetch'));

    const error = await runPdfTool({ toolId: 'font-to-outline', files: [file], values: {} }).catch((err) => err);

    expect((error as { code?: string }).code).toBe('NEEDS_ENGINE');
    const text = `${(error as Error).message} ${(error as { hint?: string }).hint ?? ''}`;
    expect(text).toMatch(/Ghostscript could not be reached/i);
    expect(text).toMatch(/nothing was outlined/i);
    expect(text).toMatch(/Rasterize PDF/i);
    expect(text).not.toMatch(/settings|enable|configure/i);
    expect(loaders.ghostscript).toHaveBeenCalledTimes(1);
  });

  it('never downloads twice for two runs of the same tool', async () => {
    const file = await pdfFile('linearize-me.pdf', 1);
    loaders.cpdf.mockResolvedValue({
      fromMemory: () => ({}),
      toMemory: () => new Uint8Array([1]),
      deletePdf: () => {},
    });

    await runPdfTool({ toolId: 'linearize-pdf', files: [file], values: {} }).catch(() => undefined);
    await runPdfTool({ toolId: 'linearize-pdf', files: [file], values: {} }).catch(() => undefined);

    expect(loaders.cpdf).toHaveBeenCalledTimes(1);
  });
});

describe('the engine UI is gone, and cannot creep back', () => {
  it('deleted the gate module and its exports', () => {
    expect(existsSync(join(process.cwd(), 'src/lib/pdf/engines/EngineGate.tsx'))).toBe(false);
    for (const name of ENGINE_UI_NAMES) {
      expect(engineBarrel, name).not.toHaveProperty(name);
    }
  });

  it('leaves no importer of the engine UI anywhere in src', () => {
    const files = sourceFiles(join(process.cwd(), 'src'));
    expect(files.length, 'expected to read the source tree').toBeGreaterThan(50);

    for (const name of ENGINE_UI_NAMES) {
      const importers = files.filter((path) => readFileSync(path, 'utf8').includes(name));
      expect(importers, name).toEqual([]);
    }
  });

  it('keeps the capability: the loaders and the default addresses are still there', () => {
    expect(ENGINE_DEFAULTS.ghostscript).toContain(HOST);
    expect(typeof ensureEngine).toBe('function');
    expect(engineBarrel.ghostscript).toBeTypeOf('function');
    expect(engineBarrel.cpdf).toBeTypeOf('function');
    expect(engineBarrel.pymupdf).toBeTypeOf('function');
  });
});
