/**
 * `pdf-layers`: the toggle lists are the open document's, and they reach the bytes.
 *
 * The card promises "List, toggle, add or delete optional-content groups", and the
 * fix these cases pin is the first half: `ToolField.options` is static, so both
 * multiselects shipped with `options: []` and a person could not toggle anything
 * (measured on the deployed pane, `docs/tasks/layers-toggle-options-ticket.md`).
 * The field now declares `choices`, `usePdfTool` asks the loaded document for them
 * and reads again when the document or its password changes, and a value the new
 * file does not carry is dropped and, until then, blocks the run.
 *
 * The last case is the file half: a box ticked in the pane is run through the real
 * runner and the produced bytes are read back, so "the list is populated" cannot
 * pass while the tick goes nowhere.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@maxwbh/pdf-lib';
import { usePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { OptionsPanel } from '@/components/tools/pdf/shared/FieldControls';
import { addLayer, listLayers } from '@/lib/pdf/core/layers';

/** A real MuPDF export: `DrawnLayer` on, `HiddenLayer` off, each guarding a text run. */
const FIXTURE = 'tests/fixtures/foreign/layers.pdf';
const source = () => new Uint8Array(readFileSync(FIXTURE));

function file(bytes: Uint8Array, name: string): File {
  return new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' });
}

/** A one-page document carrying exactly the named groups, the listed ones on. */
async function withLayers(names: string[], on: string[] = []): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  for (const name of names) addLayer(doc, name, { on: on.includes(name) });
  return file(await doc.save({ useObjectStreams: false }), `layers-${names.join('-') || 'none'}.pdf`);
}

/** A one-page document with no optional-content groups at all. */
async function withoutLayers(): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return file(await doc.save({ useObjectStreams: false }), 'plain.pdf');
}

function load(files: File[]) {
  act(() => useFileStore.setState({ file: files[0] ?? null, files, metadata: null }));
}

/** The hide field, as the panel would see it. */
async function hideField(api: { fields: { key: string; options?: unknown[] }[] }) {
  return api.fields.find((field) => field.key === 'hide')!;
}

let objectUrl = 0;

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => `blob:layers-${objectUrl++}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

beforeEach(() => {
  useProcessStore.getState().reset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  useProcessStore.getState().reset();
  useFileStore.setState({ file: null, files: [], metadata: null });
});

describe('the toggle lists are read off the open document', () => {
  it('offers every group the file carries, unchecked, with what the file says now', async () => {
    load([file(source(), 'layers.pdf')]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    await waitFor(async () => {
      const hide = await hideField(result.current);
      expect(hide.options?.map((option) => (option as { label: string }).label)).toEqual([
        'DrawnLayer',
        'HiddenLayer',
      ]);
    });
    const show = result.current.fields.find((field) => field.key === 'show')!;
    expect(show.options?.map((option) => (option as { hint: string }).hint)).toEqual([
      'On in the file now — tick here to hide it.',
      'Hidden in the file now — tick here to show it.',
    ]);
    expect(result.current.values.hide).toEqual([]);
    expect(result.current.values.show).toEqual([]);
  });

  it('follows the document that replaced it, and drops a tick the new one cannot answer', async () => {
    load([file(source(), 'layers.pdf')]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    await waitFor(async () => expect((await hideField(result.current)).options).toHaveLength(2));
    act(() => result.current.setValue('hide', ['HiddenLayer']));

    load([await withLayers(['Revision A', 'Revision B'])]);
    await waitFor(async () => {
      const hide = await hideField(result.current);
      expect(hide.options?.map((option) => (option as { label: string }).label)).toEqual([
        'Revision A',
        'Revision B',
      ]);
    });
    await waitFor(() => expect(result.current.values.hide).toEqual([]));
    expect(result.current.blockers.join(' ')).not.toMatch(/not in this document/);
  });

  it('refuses to submit a ticked name the open document does not carry', async () => {
    load([await withLayers(['Revision A'])]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    await waitFor(async () => expect((await hideField(result.current)).options).toHaveLength(1));
    // A value from somewhere other than the list — a restored form, a preset.
    act(() => result.current.setValue('hide', ['DrawnLayer']));
    await waitFor(() =>
      expect(result.current.issues.hide).toBe('"DrawnLayer" is not in this document — untick it.'),
    );
    expect(result.current.canRun).toBe(false);
    act(() => result.current.setValue('hide', ['Revision A']));
    await waitFor(() => expect(result.current.canRun).toBe(true));
  });
});

describe('the pane draws the list, not an empty box', () => {
  function Panel({ toolId }: { toolId: string }) {
    const api = usePdfTool(toolId);
    return h(OptionsPanel, { api });
  }

  it('renders a box per layer under each heading', async () => {
    load([file(source(), 'layers.pdf')]);
    render(h(Panel, { toolId: 'pdf-layers' }));
    const bar = await waitFor(() => {
      const found = document.querySelector('[data-options-panel] button[aria-expanded]');
      if (!found) throw new Error('no options disclosure');
      return found;
    }, { timeout: 5000 });
    fireEvent.click(bar);
    await waitFor(() => expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(4), {
      timeout: 5000,
    });
    const groups = [...document.querySelectorAll('[role=group]')].map((group) => ({
      label: group.getAttribute('aria-label'),
      rows: [...group.querySelectorAll('label')].map((label) => label.textContent),
    }));
    expect(groups).toEqual([
      { label: 'Hide these layers', rows: ['DrawnLayer', 'HiddenLayer'] },
      { label: 'Show these layers', rows: ['DrawnLayer', 'HiddenLayer'] },
    ]);
    expect([...document.querySelectorAll('input[type=checkbox]')].every((box) => !(box as HTMLInputElement).checked)).toBe(true);
  });

  it('says the document has none instead of leaving a heading over a void', async () => {
    load([await withoutLayers()]);
    render(h(Panel, { toolId: 'pdf-layers' }));
    const bar = await waitFor(() => {
      const found = document.querySelector('[data-options-panel] button[aria-expanded]');
      if (!found) throw new Error('no options disclosure');
      return found;
    }, { timeout: 5000 });
    fireEvent.click(bar);
    await waitFor(() => expect(document.body.textContent).toMatch(/None in this document\./), { timeout: 5000 });
    expect(document.querySelectorAll('input[type=checkbox]')).toHaveLength(0);
  });
});

describe('a tick in the pane reaches the file', () => {
  /** The `/D` lists and the `/OCGs` entries, as object numbers. */
  async function bookkeeping(bytes: Uint8Array) {
    const doc = await PDFDocument.load(bytes);
    const properties = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict);
    const ocgs = (properties.lookup(PDFName.of('OCGs'), PDFArray).asArray() as PDFRef[]).map(
      (ref) => ref.objectNumber,
    );
    const config = properties.lookup(PDFName.of('D'), PDFDict);
    const listed = (key: string) =>
      (config.lookup(PDFName.of(key), PDFArray).asArray() as PDFRef[]).map((ref) => ref.objectNumber);
    const xref = new Map(listLayers(doc).map((layer) => [layer.name, layer.xref]));
    return { ocgs, on: listed('ON'), off: listed('OFF'), xref };
  }

  it('switches the ticked layer off in the default view, by reference', async () => {
    load([file(source(), 'layers.pdf')]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    const hide = await waitFor(async () => {
      const field = await hideField(result.current);
      if ((field.options ?? []).length !== 2) throw new Error('the list is not populated yet');
      return field;
    }, { timeout: 5000 });
    // The name comes from the document, not from a literal in the test.
    const ticked = (hide.options![0] as { value: string }).value;
    expect(ticked).toBe('DrawnLayer');
    act(() => result.current.setValue('hide', [ticked]));
    await waitFor(() => expect(result.current.canRun).toBe(true));

    await act(async () => {
      await result.current.run();
    });
    const produced = useProcessStore.getState().outputBlobs[0];
    expect(produced, 'the run produced no file').toBeTruthy();
    const bytes = new Uint8Array(await produced.arrayBuffer());
    const state = await bookkeeping(bytes);
    const ref = state.xref.get('DrawnLayer');
    expect(ref, 'DrawnLayer is gone from /OCGs').toBeTypeOf('number');
    expect(state.ocgs, 'the hidden layer no longer answers to an /OCGs entry').toContain(ref);
    expect(state.off, 'the hidden layer is in neither /OFF nor anywhere').toContain(ref);
    expect(state.on, 'the hidden layer is also still in /ON').not.toContain(ref);
    // The other group keeps the state the file gave it, untouched.
    const hidden = state.xref.get('HiddenLayer');
    expect(state.off).toContain(hidden);
    // Hiding is not deleting: the drawing operators stay in the page.
    const { pageContentStreams } = await import('@/lib/pdf/core/content');
    const streams = pageContentStreams((await PDFDocument.load(bytes)).getPages()[0]);
    const decoded = streams
      .map((stream) => new TextDecoder('windows-1252').decode(stream.bytes ?? new Uint8Array()))
      .join('\n');
    expect(decoded).toMatch(/\/OC \/MC0 BDC/);
    expect(decoded).toMatch(/EMC/);
  });

  it('leaves the lists of a document with no groups empty, so nothing is run on a stale tick', async () => {
    load([await withoutLayers()]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    await waitFor(async () => expect((await hideField(result.current)).options).toEqual([]));
    expect(listLayers.length).toBeGreaterThan(0);
    expect(result.current.values.hide).toEqual([]);
  });
});

describe('a name typed into the delete field', () => {
  it('takes the definition and every property-list reference to it with it', async () => {
    load([file(source(), 'layers.pdf')]);
    const { result } = renderHook(() => usePdfTool('pdf-layers'));
    await waitFor(async () => expect((await hideField(result.current)).options).toHaveLength(2));
    act(() => result.current.setValue('remove', 'DrawnLayer'));
    await waitFor(() => expect(result.current.canRun).toBe(true));

    await act(async () => {
      await result.current.run();
    });
    const produced = useProcessStore.getState().outputBlobs[0];
    expect(produced, 'the run produced no file').toBeTruthy();
    const bytes = new Uint8Array(await produced.arrayBuffer());
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('/tmp/eight', { recursive: true });
    writeFileSync('/tmp/eight/layers-delete.pdf', Buffer.from(bytes));
    const doc = await PDFDocument.load(bytes);
    expect(listLayers(doc).map((layer) => layer.name)).toEqual(['HiddenLayer']);

    // `/OC /MC0 BDC` stays in the page — the content is not deleted — so the
    // `/Properties` entry that named the group must not outlive the object:
    // otherwise the name points at a free xref object both readers report.
    const live = new Set(
      doc.context.enumerateIndirectObjects().map(([ref]) => ref.toString()),
    );
    const dangling: string[] = [];
    for (const page of doc.getPages()) {
      const properties = page.node.Resources()?.get(PDFName.of('Properties'));
      if (!(properties instanceof PDFDict)) continue;
      for (const [, value] of properties.entries()) {
        if (value instanceof PDFRef && !live.has(value.toString())) dangling.push(value.toString());
      }
    }
    expect(dangling, 'a /Properties entry points at a deleted object').toEqual([]);

    const { pageContentStreams } = await import('@/lib/pdf/core/content');
    const decoded = pageContentStreams(doc.getPages()[0])
      .map((stream) => new TextDecoder('windows-1252').decode(stream.bytes ?? new Uint8Array()))
      .join('\n');
    // The span keeps its tag and loses the operand that named the dead group.
    // The span and its property list are kept: the object is still alive for them.
    expect(decoded).toMatch(/\/OC \/MC0 BDC/);
    // Deleting a definition does not delete drawing: the run is still there.
    expect(decoded.toLowerCase()).toContain(Buffer.from('Painted through DrawnLayer').toString('hex'));
  });
});
