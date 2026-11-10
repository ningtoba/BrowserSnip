/**
 * Field reach: does a declared control reach the bytes, and does the route reach
 * the control?
 *
 * `docs/research/inert-field-sweep.md` named these two fields by static reading.
 * Both are measured here instead, and one of the two premises did not survive it:
 *
 * * **`pdf-to-json.tables`** — the rail *does* render the toggle (group
 *   "Content", no `when`, nothing filters the key), so this was never a
 *   field-definition/rail mismatch. The value has nowhere to go: `buildJson` calls
 *   `documentToJson`, and `core/convert.ts` splices detected tables into every
 *   page's blocks with no flag to refuse them. `tables: true` and `tables: false`
 *   produced byte-identical files, so the control is deleted rather than left
 *   lying, and the first section below refuses any field on this tool whose two
 *   values cannot be told apart in the output.
 * * **`redact-pdf.alsoMetadata`** — the run honours it (the two outputs differ and
 *   an outside reader sees `/Title` present versus gone), so the field is kept.
 *   What was missing was a surface: the fold that made `redact` an alias of
 *   `redact-pdf` left the panel keyed by the folded id, while `ToolWorkspace`
 *   canonicalises the route *before* it looks a panel up, so `/tool/redact-pdf`
 *   mounted the redaction canvas with no way to apply it. Section 2 measures that
 *   for every tool the shell hands to a hand-written surface; section 3 drives the
 *   switch through the panel and judges the bytes it wrote.
 *
 * The byte reads avoid this app's own object model where the question is about
 * bytes: `node:zlib` inflates every stream in the file and the raw bytes are
 * scanned as well, so a helper wrong in the same way twice cannot hide it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { TOOL_CATALOGUE, getPdfTool, isToolAlias } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { writeOutline } from '@/lib/pdf/core/bookmarks';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';
import { RedactTool } from '@/components/tools/pdf/security/RedactTool';
import {
  addRedaction, getRedactState, redactionRegions, removeRedaction,
} from '@/components/tools/pdf/security/RedactMain';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

/**
 * pdf.js derives its worker URL from `import.meta.url`, which Vitest serves over
 * `http:` and the ESM loader refuses, and `openRender` re-assigns it on every call
 * — so the pin has to be a getter. Text extraction runs for real here: it is what
 * `pdf-to-json` writes its JSON from, and what `redact-pdf` re-reads its own
 * output with to prove the glyphs went.
 */
beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
});

afterEach(() => {
  cleanup();
  resetStores();
});

function resetStores() {
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
}

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

function fileOf(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

async function run(id: string, values: ToolValues, bytes: Uint8Array, name = 'fixture.pdf'): Promise<RunOutcome> {
  const outcome = await runPdfTool({
    toolId: id,
    files: [fileOf(bytes, name)],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, `${id} produced no result`).not.toBeNull();
  return outcome!;
}

async function firstBlob(outcome: RunOutcome): Promise<Uint8Array> {
  expect(outcome.outputs.length).toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0]!.blob.arrayBuffer());
}

/**
 * The file as a reader that has not been told where anything is: the surface
 * bytes, plus the inflated body of every stream in it.
 *
 * `/Info` is written into an object stream by default, so a scan of the surface
 * alone sees no property string at all — which is the difference between this and
 * `expect(bytes).toContain('Title')`. Encodings are handled by `holdsWord`.
 */
function readableBytes(bytes: Uint8Array): string {
  const view = Buffer.from(bytes);
  const surface = new TextDecoder('latin1').decode(view);
  const chunks: string[] = [surface];
  // `stream` also occurs inside `endstream`, which is one object off; the
  // lookbehind is what keeps this from inflating the wrong slice.
  const open = /(?<!end)\bstream\r?\n/g;
  for (let match = open.exec(surface); match; match = open.exec(surface)) {
    const end = surface.indexOf('endstream', match.index);
    if (end < 0) break;
    try {
      chunks.push(inflateSync(view.subarray(match.index + match[0].length, end)).toString('latin1'));
    } catch {
      // Not zlib (a raster, or the word inside content), so the surface copy stands.
    }
  }
  return chunks.join('\n');
}

/** Just the page text: the streams that draw operators, not the object stores. */
function textStreams(bytes: Uint8Array): string {
  const view = Buffer.from(bytes);
  const surface = new TextDecoder('latin1').decode(view);
  const bodies: string[] = [];
  const open = /(?<!end)\bstream\r?\n/g;
  for (let match = open.exec(surface); match; match = open.exec(surface)) {
    const end = surface.indexOf('endstream', match.index);
    if (end < 0) break;
    let body: string;
    try {
      body = inflateSync(view.subarray(match.index + match[0].length, end)).toString('latin1');
    } catch {
      body = surface.slice(match.index + match[0].length, end);
    }
    if (/\bBT\b/.test(body)) bodies.push(body);
  }
  return bodies.join('\n');
}

/**
 * Whether a word is anywhere in the file, in whichever form PDF stores a string.
 *
 * A writer may put it in the page content as a literal, in `/Info` as a
 * big-endian UTF-16 string, or as the hex spelling of that — so all three are
 * looked for, and "the redacted word is gone" is a claim about the bytes rather
 * than about one encoding.
 */
function holdsWord(bytes: Uint8Array, word: string): boolean {
  const haystack = readableBytes(bytes);
  const utf16 = Buffer.from(word, 'utf16le').swap16();
  return (
    haystack.includes(word)
    || haystack.includes(utf16.toString('latin1'))
    || haystack.toUpperCase().includes(utf16.toString('hex').toUpperCase())
  );
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** A ruled-free grid `core/tables` reads as a table, plus a page of prose. */
async function gridPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  const columns = ['Item', 'Quantity', 'Price'];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < columns.length; col++) {
      page.drawText(row === 0 ? columns[col]! : `row ${row} col ${col + 1}`, {
        x: 60 + col * 140,
        y: 760 - row * 22,
        size: 11,
        font,
        color: rgb(0, 0, 0),
      });
    }
  }
  const prose = doc.addPage([595.28, 841.89]);
  prose.drawText('No grid here, just prose about the quarter and how it went.', {
    x: 60,
    y: 700,
    size: 11,
    font,
    color: rgb(0, 0, 0),
  });
  return doc.save({ useObjectStreams: false });
}

/**
 * One markable line, one line left alone, and the secret repeated where the
 * option can reach it: `/Title`, `/Author` and a bookmark title. The text sits at
 * user-space y 600 of an 842 pt sheet, i.e. 224 pt from the top of the page as
 * displayed — the frame the pane draws its marks in.
 */
async function secretPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Zephyr Bravo Content', { x: 60, y: 600, size: 18, font, color: rgb(0, 0, 0) });
  page.drawText('Ordinary surviving line', { x: 60, y: 500, size: 18, font, color: rgb(0, 0, 0) });
  doc.setTitle('Zephyr Bravo Content');
  doc.setAuthor('Zephyr');
  writeOutline(doc, [{ title: 'Zephyr Bravo Content', page: 0 }]);
  return doc.save({ useObjectStreams: false });
}

/** The mark over that line, as `RedactMain` stores a mark: page fractions. */
const MARK = { x: 40 / 595, y: 595 / 842, w: 320 / 595, h: 40 / 842 };

function clearMarks(): void {
  for (const mark of [...getRedactState().redactions]) removeRedaction(mark.id);
}

/** The regions the panel hands its tool: one per line, in points. */
function panelRegions(): { page: number; x: number; y: number; width: number; height: number }[] {
  const size = { width: 595, height: 842 };
  return getRedactState().redactions.flatMap((mark) => redactionRegions(mark, size));
}

// ══ 1. pdf-to-json: a field the bytes cannot answer for ════════════════════

describe('pdf-to-json declares only fields its bytes answer for', () => {
  const tool = getPdfTool('pdf-to-json') as PdfToolDefinition;

  /** One pair of values per declared key: the measurement that indicts a field. */
  const FLIPS: Record<string, [ToolValues, ToolValues]> = {
    pages: [{ pages: 'all' }, { pages: '1' }],
  };

  it('moves the produced bytes for every field it declares', async () => {
    const source = await gridPdf();
    const unchecked: string[] = [];
    const inert: string[] = [];
    for (const field of tool.fields ?? []) {
      const pair = FLIPS[field.key];
      if (!pair) {
        unchecked.push(`${field.key} (${field.type}) has no measured pair of values`);
        continue;
      }
      const bytes = [
        await firstBlob(await run('pdf-to-json', { ...pair[0] }, source)),
        await firstBlob(await run('pdf-to-json', { ...pair[1] }, source)),
      ];
      if (sha(bytes[0]!) === sha(bytes[1]!)) {
        inert.push(`${field.key} (${field.type}): both values sha ${sha(bytes[0]!)} at ${bytes[0]!.length} B`);
      }
    }
    // An unchecked key is the shape `tables` had: declared, rendered, never read.
    expect(unchecked).toEqual([]);
    expect(inert).toEqual([]);
  }, 180_000);

  it('keeps the table it always emits, and no longer offers to switch it off', async () => {
    const source = await gridPdf();
    // Deleting the field is the fix, not an oversight. `documentToJson` takes no
    // table flag and `core/convert.ts:189` splices the grid in before any caller
    // sees the blocks, so honouring `off` is a core feature with its own
    // measurement (and its own answer for the help text's "faster" claim), not a
    // wiring typo. See `docs/research/inert-field-sweep.md`.
    expect((tool.fields ?? []).map((field) => field.key)).not.toContain('tables');
    const body = new TextDecoder().decode(await firstBlob(await run('pdf-to-json', { pages: 'all' }, source)));
    expect(body).toContain('"type": "table"');
    expect(body).toContain('"rows"');
    // A stray `tables` in the bag — an old persisted session — still changes
    // nothing, and nothing on the page may now claim it does.
    const ignored = new TextDecoder().decode(
      await firstBlob(await run('pdf-to-json', { pages: 'all', tables: false }, source)),
    );
    expect(ignored).toBe(body);
    expect(tool.promise).toMatch(/tables the grid implies/i);
    expect((tool.notes ?? []).join(' ') + (tool.description ?? '')).not.toMatch(/tables? (can be|are) omitted|without tables/i);
  }, 180_000);
});

// ══ 2. routing: the surface a route resolves to can be run ═════════════════

/** One map's keys, read out of the source that owns it rather than copied. */
function paneMapKeys(file: string, mapName: string): string[] {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const start = source.indexOf(`const ${mapName}`);
  if (start < 0) throw new Error(`${file} no longer declares ${mapName}`);
  const block = source.slice(start, source.indexOf('\n};', start));
  return [...block.matchAll(/^\s{2}'?([a-z0-9]+(?:-[a-z0-9]+)*)'?:/gm)].map((match) => match[1]!);
}

const PANEL_KEYS = paneMapKeys('src/components/layout/ToolWorkspace.tsx', 'PDF_PANELS');
const MAIN_KEYS = paneMapKeys('src/lib/pdf/tools/registry.ts', 'MAIN_VIEWS');

/**
 * The ids this sweep does not judge by button, because their pane owns its action
 * inside the main view: `organize`, `edit-pdf`, `add-stamps`, `form-filler`,
 * `form-creator`.
 *
 * Written down rather than inferred, because it is an exception, and because in
 * jsdom three of them publish no controls at all for a document with no form
 * fields — a missing button there says nothing about the route. They are judged
 * by their own tests (`page-organizer.test.ts`, `editor-surface.test.tsx`, the
 * form suites) and by the key rule above.
 */
const PANE_OWNED_ACTION = ['organize', 'edit-pdf', 'add-stamps', 'form-filler', 'form-creator'];

describe('a route reaches a control that runs its tool', () => {
  it('keys every pane with an id its own route answers', () => {
    // A pane keyed by a folded id can never mount: `ToolWorkspace` resolves the
    // route through `canonicalToolId` before it looks a pane up, so under the
    // canonical key the map is empty and the page loses its only apply button.
    // This is what `8bb1c49` did to `redact`, and every count-based check on the
    // catalogue stayed green while it did.
    const folded = [...new Set([...PANEL_KEYS, ...MAIN_KEYS])].filter((key) => isToolAlias(key)).sort();
    expect(folded, 'pane maps are keyed by the id the route answers').toEqual([]);
    const stranded = [...new Set([...PANEL_KEYS, ...MAIN_KEYS])].filter((key) => !getPdfTool(key));
    expect(stranded).toEqual([]);
  });

  it('mounts the panel beside every canvas that needs one', async () => {
    const source = await secretPdf();
    const problems: string[] = [];
    // Two documents, because `compare-pdfs` refuses to offer its action with one:
    // judging a two-file tool with a single file reports a defect that is not there.
    const inputs = [fileOf(source, 'doc-a.pdf'), fileOf(source, 'doc-b.pdf')];
    const panelled = TOOL_CATALOGUE.filter(
      (entry) => PANEL_KEYS.includes(entry.id) && !PANE_OWNED_ACTION.includes(entry.id),
    );
    for (const entry of panelled) {
      try {
        render(
          createElement(
            MemoryRouter,
            { initialEntries: [`/tool/${entry.id}`] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/tool/:toolId', element: createElement(ToolWorkspace) }),
            ),
          ),
        );
        act(() => {
          useFileStore.setState({ file: inputs[0]!, files: inputs });
        });
        await waitFor(
          () => {
            if (!document.querySelector('[data-run="true"], #tool-process-btn')) {
              throw new Error('the route mounted no control that runs this tool');
            }
          },
          { timeout: 6000, interval: 50 },
        );
        cleanup();
      } catch (error) {
        cleanup();
        problems.push(`${entry.id}: ${(error as Error).message.split('\n')[0]}`);
      }
      resetStores();
    }
    // The five that are meant to reach a sidebar panel. If one drops out of this
    // list, its pane stopped being keyed by the id its route answers.
    expect(panelled.map((entry) => entry.id).sort()).toEqual([
      'compare-pdfs',
      'pdf-crop',
      'redact-pdf',
      'scan-to-pdf',
      'sign',
    ]);
    expect(problems).toEqual([]);
  }, 240_000);
});

// ══ 3. redact-pdf: the switch the panel offers is the switch the bytes obey ═

describe('redact-pdf alsoMetadata is reachable from its own surface', () => {
  it('forwards the panel’s switch, and the properties say which way it was set', async () => {
    const source = await secretPdf();
    const tool = getPdfTool('redact-pdf') as PdfToolDefinition;
    expect((tool.fields ?? []).map((field) => field.key)).toContain('alsoMetadata');

    clearMarks();
    render(createElement(MemoryRouter, null, createElement(RedactTool)));
    act(() => {
      useFileStore.setState({ file: fileOf(source, 'doc.pdf'), files: [fileOf(source, 'doc.pdf')] });
    });
    act(() => {
      addRedaction(MARK);
    });

    // The switch on the panel is the definition's own field, labelled from it.
    const box = (await waitFor(() => {
      const found = document.querySelector('input[type=checkbox]') as HTMLInputElement | null;
      if (!found) throw new Error('the panel offers no metadata switch');
      return found;
    })) as HTMLInputElement;
    expect(box.checked, 'the switch keeps its default-on').toBe(true);
    expect(document.body.textContent).toMatch(/Also clear matching text from metadata and bookmarks/);

    const produced = async (): Promise<Uint8Array> => {
      const button = document.getElementById('tool-process-btn') as HTMLButtonElement;
      expect(button, 'the panel that owns this route has an apply button').toBeTruthy();
      expect(button.disabled, `regions: ${JSON.stringify(panelRegions())}`).toBe(false);
      await act(async () => {
        fireEvent.click(button);
        await new Promise((resolveRun) => setTimeout(resolveRun, 3000));
      });
      const blob = useProcessStore.getState().outputBlob;
      expect(blob, useProcessStore.getState().error ?? 'the run produced no file').toBeTruthy();
      return new Uint8Array(await blob!.arrayBuffer());
    };

    const scrubbed = await produced();
    act(() => {
      fireEvent.click(box);
      useProcessStore.getState().reset();
    });
    expect(box.checked).toBe(false);
    const kept = await produced();

    // The mark deleted the words in both runs, so the only difference between the
    // two files is the store the switch is about — and the geometry is right: a
    // mark handed to the tool in the wrong frame leaves the line selectable.
    for (const [label, bytes] of [['on', scrubbed], ['off', kept]] as const) {
      const page = textStreams(bytes);
      expect(holdsWord(bytes, 'Ordinary surviving line'), `the "${label}" run deleted the line it was not aiming at`).toBe(true);
      expect(
        page.includes('Ordinary surviving line') || /Ordinary/.test(page),
        `the unmarked line is not in the page text of the "${label}" run`,
      ).toBe(true);
      expect(holdsWord(bytes, 'Zephyr Bravo Content'), `the mark covered nothing on the "${label}" run`).toBe(label === 'off');
      expect((await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()).toBe(1);
    }
    expect(sha(scrubbed)).not.toBe(sha(kept));
    const on = await PDFDocument.load(scrubbed, { updateMetadata: false });
    const off = await PDFDocument.load(kept, { updateMetadata: false });
    expect(on.getTitle() ?? '', 'the switch was on, so /Title lost the word').not.toMatch(/Zephyr/);
    expect(off.getTitle(), 'the switch was off, so /Title kept it').toBe('Zephyr Bravo Content');
    expect(off.getAuthor()).toBe('Zephyr');
    // Outside this app's parser as well: the property string survives in the off
    // file's bytes and is gone from the on file's, in either page of neither.
    expect(holdsWord(kept, 'Zephyr')).toBe(true);
    expect(holdsWord(scrubbed, 'Zephyr')).toBe(false);
    clearMarks();
  }, 240_000);

  it('moves the bytes from the registry entry alone, both ways', async () => {
    const source = await secretPdf();
    const regions = [{ page: 0, x: 40, y: 224, width: 320, height: 30 }];
    const on = await firstBlob(await run('redact-pdf', { fill: '#000000', alsoMetadata: true, regions }, source));
    const off = await firstBlob(await run('redact-pdf', { fill: '#000000', alsoMetadata: false, regions }, source));
    expect(sha(on)).not.toBe(sha(off));
    expect(holdsWord(off, 'Zephyr')).toBe(true);
    expect(holdsWord(on, 'Zephyr')).toBe(false);
  }, 240_000);
});
