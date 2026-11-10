/**
 * The app's own answer for one file: run the shipped `repair` tool and report
 * what it says, without judging it.
 *
 * Bundled by `repair-damage-measure.mjs` with esbuild, so this runs on the real
 * module graph — the same `getPdfTool('repair').run` the rail calls — and not on a
 * re-implementation of it. `repair-damage-readers.py` is what judges the bytes.
 */
import { inspectPdf } from '../../src/lib/pdf/core/guard';
import { getPdfTool } from '../../src/lib/pdf/tools/registry';
import { defaultValues } from '../../src/lib/pdf/tools/types';

export interface AppAnswer {
  file: string;
  ok: boolean;
  message: string;
  warnings: string[];
  /** What the tool reported as its page count. */
  pages: number | null;
  /** What a fresh parse of the produced bytes says. */
  outPages: number | null;
  outError: string | null;
  /** What the input looked like to the guard before anything ran. */
  inPages: number;
  inDeclared: number | null;
  inError: string | null;
  inRecovered: boolean;
  inTruncated: boolean;
  /** Size of the produced file, 0 when the tool refused. */
  bytes: number;
  /** The repaired bytes, kept out of the JSON and written to `<dir>/out/`. */
  produced?: Uint8Array;
}

/** Run `repair` over `bytes`, or return the refusal when it throws. */
export async function answer(name: string, bytes: Uint8Array): Promise<AppAnswer> {
  const tool = getPdfTool('repair');
  if (!tool?.run) throw new Error('repair is not registered');
  const before = await inspectPdf(bytes, name);
  const context = {
    inputs: [{
      name,
      size: bytes.byteLength,
      type: 'application/pdf',
      bytes: async () => bytes,
      blob: () => new Blob([bytes as BlobPart], { type: 'application/pdf' }),
    }],
    values: defaultValues(tool.fields ?? []),
    progress: () => {},
    log: () => {},
    signal: new AbortController().signal,
  };
  const base = {
    file: name,
    inPages: before.pages,
    inDeclared: before.declaredPages,
    inError: before.error,
    inRecovered: before.recovered,
    inTruncated: before.truncated,
  };
  let result;
  try {
    result = await tool.run(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      ok: false,
      message,
      warnings: [],
      pages: null,
      outPages: null,
      outError: null,
      bytes: 0,
    };
  }
  const produced = result?.kind === 'pdf' ? result.bytes : new Uint8Array(0);
  const after = await inspectPdf(produced, name);
  return {
    ...base,
    ok: true,
    message: result?.message ?? '',
    warnings: result?.warnings ?? [],
    pages: result?.pages ?? null,
    outPages: after.error ? null : after.pages,
    outError: after.error,
    bytes: produced.byteLength,
    produced,
  };
}

export { inspectPdf };
