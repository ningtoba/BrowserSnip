/**
 * The three controls `docs/TOOL-TRIAGE.md` accuses of being inert, measured.
 *
 * The method is the one this campaign keeps having to invent after the fact:
 * **change the value and diff the produced bytes.** Plumbing is not evidence — a
 * value can be threaded through four layers of code and still never reach a page
 * box — so every test here opens the file the tool wrote and reads the answer out
 * of it.
 *
 * 1. `cbz-to-pdf` `Page size`: every selection has to land in `/MediaBox` (and in
 *    the effective `/CropBox`), with the picture scaled and positioned into that
 *    sheet rather than left at its own box.
 * 2. `scan-to-pdf` `Page size`: the accusation was that the pane keeps its own
 *    size state. Both halves are pinned: the registry entry honours the value,
 *    **and** the control the shipped page actually renders — `ScanTool`'s own
 *    select — is driven through a real run, because the generated rail never
 *    appears on a bespoke surface.
 * 3. `sanitize-pdf` `Remove JavaScript and automatic actions`: a document that
 *    genuinely carries script — a catalogue `/OpenAction` with a `/JS` action, an
 *    annotation `/A`, a form-field `/A` — has to lose those actions with the
 *    switch on, keep them with it off, and the card has to say which it did. A
 *    file with nothing to clean must not be reported as a cleaning.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@maxwbh/pdf-lib';
import { cropBox, mediaBox, PAGE_SIZES } from '@/lib/pdf/core/pages';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { ScanTool } from '@/components/tools/pdf/scan/ScanTool';
import {
  fileFrom,
  firstPdf,
  imagesPerPage,
  installConvertToEnv,
  realPng,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
  zipBytes,
} from './convert-to-harness';

vi.mock('@/lib/pdf/core/render', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/render')>();
  return {
    ...real,
    thumbnails: async (_session: unknown, options: { pages?: number[] }) => (options?.pages ?? []).map(() => ''),
  };
});

beforeAll(() => {
  installConvertToEnv();
});

afterEach(() => {
  resetConvertToEnv();
  cleanup();
  useProcessStore.getState().reset();
  useFileStore.getState().setFiles([]);
});

afterAll(() => {
  restoreConvertToEnv();
});

const round = (value: number) => Math.round(value * 100) / 100;

/** Every page's boxes, read back out of the produced file. */
async function boxesOf(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const media = mediaBox(page);
    const crop = cropBox(page);
    return {
      media: [round(media.width), round(media.height)] as [number, number],
      // `/CropBox` is optional (ISO 32000-1 §14.11.2); a page that leaves it out
      // is visible in its `/MediaBox`, which is what a viewer and `mutool` use.
      cropWritten: (page.node as unknown as { get(k: PDFName): unknown }).get(PDFName.of('CropBox')) !== undefined,
      crop: [round(crop.width), round(crop.height)] as [number, number],
    };
  });
}

function cbz(pages: { name: string; width: number; height: number }[]): Promise<Uint8Array> {
  return zipBytes(pages.map((page) => ({ name: page.name, data: realPng(page.width, page.height) })));
}

/* ══ 1. cbz-to-pdf: `Page size` ═══════════════════════════════════════════ */

describe('cbz-to-pdf Page size reaches the page boxes', () => {
  const ART = [
    { name: 'panel-01.png', width: 600, height: 800 },
    { name: 'panel-02.png', width: 800, height: 600 },
  ];

  it('writes a different sheet for A4, Letter and A5, and places the art inside it', async () => {
    const archive = fileFrom(await cbz(ART), 'photos.cbz');
    const seen: string[] = [];
    for (const [size, sheet] of [['a4', PAGE_SIZES.a4], ['letter', PAGE_SIZES.letter], ['a5', PAGE_SIZES.a5]] as const) {
      const outcome = await run('cbz-to-pdf', { pageSize: size }, [archive]);
      const boxes = await boxesOf(await firstPdf(outcome));
      expect(boxes.length, size).toBe(2);
      // A wide panel takes the named sheet sideways; that is the sheet, not a
      // different paper, so both orientations of the same size are accepted.
      const portrait = [round(sheet[0]), round(sheet[1])];
      const landscape = [round(sheet[1]), round(sheet[0])];
      for (const [index, box] of boxes.entries()) {
        const expected = ART[index]!.width > ART[index]!.height ? landscape : portrait;
        expect(box.media, `${size} page ${index + 1}`).toEqual(expected);
        expect(box.crop, `${size} page ${index + 1}`).toEqual(expected);
      }
      // The picture is scaled into the sheet, not left at its native box, and it
      // keeps its ratio: 600 × 800 and 800 × 600 do not both come out the sheet.
      const placed = await imagesPerPage(await firstPdf(outcome));
      for (const [index, images] of placed.entries()) {
        const art = ART[index]!;
        const box = images[0]!.box;
        expect(round(box[2] / box[3]), size).toBeCloseTo(round(art.width / art.height), 1);
        expect(box[2]).toBeLessThan(boxes[index]!.media[0] + 0.01);
        expect(box[3]).toBeLessThanOrEqual(boxes[index]!.media[1] + 0.01);
      }
      seen.push(boxes.map((box) => box.media.join('×')).join('|'));
    }
    // The measurement the ledger asked for: three selections, three answers.
    expect(new Set(seen).size).toBe(3);
  });

  it('keeps hugging each image as a choice, and as the default it did before', async () => {
    const archive = fileFrom(await cbz(ART), 'photos.cbz');
    const hugged = await boxesOf(await firstPdf(await run('cbz-to-pdf', {}, [archive])));
    expect(hugged.map((box) => box.media)).toEqual([[600, 800], [800, 600]]);
    const chosen = await boxesOf(await firstPdf(await run('cbz-to-pdf', { pageSize: 'fit' }, [archive])));
    expect(chosen.map((box) => box.media)).toEqual([[600, 800], [800, 600]]);
  });

  it('says which sheet it built, so the card cannot outlive the bytes', async () => {
    const archive = fileFrom(await cbz([ART[0]]), 'one.cbz');
    const hugged = await run('cbz-to-pdf', { pageSize: 'fit' }, [archive]);
    expect(hugged.message).toMatch(/each page its own artwork|own size/i);
    const sheeted = await run('cbz-to-pdf', { pageSize: 'a5' }, [archive]);
    expect(sheeted.message).toMatch(/A5/);
  });

  it('offers the sheet it honours: every value the run accepts is a choice on the rail', async () => {
    const field = (await import('@/lib/pdf/tools/convert-to')).convertToTools
      .find((tool) => tool.id === 'cbz-to-pdf')!
      .fields!.find((entry) => entry.key === 'pageSize')!;
    const boxes = new Set<string>();
    for (const option of field.options ?? []) {
      const outcome = await run('cbz-to-pdf', { pageSize: option.value }, [fileFrom(await cbz([ART[0]]), 'one.cbz')]);
      const [box] = await boxesOf(await firstPdf(outcome));
      boxes.add(box!.media.join('×'));
    }
    // Six sheets plus the hug: a choice that always gave the same page would show
    // up here as one entry.
    expect(boxes.size).toBe((field.options ?? []).length);
  });
});

/* ══ 2. scan-to-pdf: the `Page size` the user can reach ═══════════════════ */

describe('scan-to-pdf Page size reaches the page boxes', () => {
  const CAPTURE = { width: 592, height: 423 };
  const capture = () =>
    fileFrom(realPng(CAPTURE.width, CAPTURE.height), 'capture-01.png', 'image/png');

  it('honours every sheet the entry declares, through the registry', async () => {
    const boxes = new Map<string, string>();
    for (const size of ['a4', 'letter', 'fit', 'original']) {
      const outcome = await run('scan-to-pdf', { pageSize: size, orientation: 'portrait', margin: 10, fit: 'contain' }, [capture()]);
      const [box] = await boxesOf(await firstPdf(outcome));
      boxes.set(size, box!.media.join('×'));
    }
    expect(boxes.get('a4')).toBe('595.28×841.89');
    expect(boxes.get('letter')).toBe('612×792');
    expect(boxes.get('fit')).toBe(`${CAPTURE.width + 20}×${CAPTURE.height + 20}`);
    // The two hug spellings are the same sheet; the field's help says so.
    expect(boxes.get('original')).toBe(boxes.get('fit'));
  });

  it('scales and centres the capture into the chosen sheet, not at its native box', async () => {
    const bytes = await firstPdf(await run('scan-to-pdf', { pageSize: 'a4', orientation: 'portrait', margin: 10, fit: 'contain' }, [capture()]));
    const [placed] = (await imagesPerPage(bytes))[0]!;
    const [box] = await boxesOf(bytes);
    expect(placed!.box[2]).toBeLessThan(CAPTURE.width);
    expect(round(placed!.box[2] / placed!.box[3])).toBe(round(CAPTURE.width / CAPTURE.height));
    expect(placed!.box[0]).toBeCloseTo(10, 1);
    expect(placed!.box[2]).toBeCloseTo(box!.media[0] - 20, 1);
  });

  it('drives the same bytes from the select the shipped page renders', async () => {
    // `scan-to-pdf` is a bespoke surface: the generated rail is never mounted, so
    // the only `Page size` a visitor can touch is the pane's own select. That is
    // the control this row accused of being overridden.
    const view = render(createElement(MemoryRouter, null, createElement(ScanTool)));
    act(() => {
      useFileStore.getState().setFiles([capture() as never]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const select = view.container.querySelector('select') as HTMLSelectElement;
    const button = view.container.querySelector('#tool-process-btn') as HTMLButtonElement;
    const sizes: Record<string, string> = {};
    for (const size of ['letter', 'fit']) {
      act(() => {
        fireEvent.change(select, { target: { value: size } });
      });
      useProcessStore.getState().reset();
      await act(async () => {
        fireEvent.click(button);
        await new Promise((resolve) => setTimeout(resolve, 900));
      });
      const blob = useProcessStore.getState().outputBlob;
      expect(blob, size).toBeTruthy();
      const [box] = await boxesOf(new Uint8Array(await blob!.arrayBuffer()));
      sizes[size] = box!.media.join('×');
    }
    expect(sizes.letter).toBe('612×792');
    expect(sizes.fit).toBe(`${CAPTURE.width + 20}×${CAPTURE.height + 20}`);
  });
});

/* ══ 3. sanitize-pdf: the JavaScript switch ══════════════════════════════ */

/**
 * A PDF that really runs script, written the way a generator writes it: the
 * actions are **inline dictionaries inside the catalogue and the annotation**,
 * not indirect objects of their own. The shapes:
 *
 *  - `/OpenAction << /S /JavaScript /JS (…) >>` in the catalogue,
 *  - an annotation `/A << /S /JavaScript /JS (…) >>`, written inline,
 *  - a form field `/A` pointing at a JavaScript action through a reference,
 *  - a page `/AA` trigger and a `/Names » /JavaScript` entry, which the tool has
 *    always seen and which must keep being seen.
 */
function scriptFixture(): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert(\'on open\')) >> '
    + '/AcroForm 8 0 R /Names << /JavaScript << /Names [ (boot) 6 0 R ] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Annots [4 0 R 5 0 R] '
    + '/AA << /O << /S /JavaScript /JS (on page) >> >> >>',
    // An annotation whose action is written inline, the shape the ledger's fixture used.
    '<< /Type /Annot /Subtype /Link /Rect [10 150 90 170] /A << /S /JavaScript /JS (annotation clicked) >> >>',
    // A form field whose action is a dictionary of its own, reached by reference.
    '<< /Type /Annot /Subtype /Widget /Rect [10 10 90 30] /FT /Tx /T (amount) /V (12) /A 7 0 R >>',
    '<< /S /JavaScript /JS (named boot) >>',
    '<< /S /JavaScript /JS (field calc) >>',
    '<< /Fields [5 0 R] >>',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((source, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${source}\nendobj\n`;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/** Where script still lives, as sentences a reader can check against the file. */
function scriptPlaces(bytes: Uint8Array): Promise<string[]> {
  return PDFDocument.load(bytes, { updateMetadata: false }).then((doc) => {
    const found: string[] = [];
    const isJavaScriptAction = (dict: PDFDict) =>
      dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString() === '/JavaScript' || dict.get(PDFName.of('JS')) !== undefined;
    const follow = (value: unknown): PDFDict | null => {
      const target = value instanceof PDFRef ? doc.context.lookupMaybe(value, PDFDict) : value;
      return target instanceof PDFDict ? target : null;
    };
    // One label per dictionary, so a widget that is both an annotation and a
    // form field is one place that runs script, not two.
    const hosts = new Map<PDFDict, string>([[doc.catalog, 'catalogue']]);
    for (const page of doc.getPages()) {
      hosts.set(page.node, 'page');
      const annots = page.node.Annots();
      for (let index = 0; annots && index < annots.size(); index++) {
        const annot = doc.context.lookupMaybe(annots.get(index), PDFDict);
        if (annot && !hosts.has(annot)) hosts.set(annot, 'annotation');
      }
    }
    const fields = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.lookupMaybe(PDFName.of('Fields'), PDFArray);
    for (let index = 0; fields && index < fields.size(); index++) {
      const field = doc.context.lookupMaybe(fields.get(index), PDFDict);
      if (field && !hosts.has(field)) hosts.set(field, 'form field');
    }
    for (const [dict, label] of hosts) {
      for (const key of ['OpenAction', 'A']) {
        const action = follow(dict.get(PDFName.of(key)));
        if (action && isJavaScriptAction(action)) found.push(`${label} /${key}`);
      }
      const auto = follow(dict.get(PDFName.of('AA')));
      if (auto) {
        for (const [, trigger] of auto.entries()) {
          const action = follow(trigger);
          if (action && isJavaScriptAction(action)) found.push(`${label} /AA`);
        }
      }
      if (label !== 'catalogue' && (dict.get(PDFName.of('JS')) !== undefined || dict.get(PDFName.of('JavaScript')) !== undefined)) {
        found.push(`${label} /JS`);
      }
    }
    const javascript = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('JavaScript'), PDFDict);
    const names = javascript?.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (names && names.size() > 0) found.push('names tree');
    return found;
  });
}

describe('sanitize-pdf Remove JavaScript does what the switch says', () => {
  it('takes every action out with the switch on, and says how many', async () => {
    const source = scriptFixture();
    expect((await scriptPlaces(source)).sort()).toEqual([
      'annotation /A',
      'annotation /A',
      'catalogue /OpenAction',
      'names tree',
      'page /AA',
    ].sort());
    const outcome = await run(
      'sanitize-pdf',
      { javascript: true, attachments: false, metadata: false, info: false, annotations: false },
      [fileFrom(source, 'js.pdf', 'application/pdf')],
    );
    const after = await scriptPlaces(await firstPdf(outcome));
    expect(after, `script still in the file: ${JSON.stringify(after)}`).toEqual([]);
    expect(outcome.message).toMatch(/script reference\(s\) removed/);
    expect(outcome.message).not.toMatch(/Nothing to remove/);
    expect(outcome.warnings.join(' ')).not.toMatch(/survived in a place/i);
  });

  it('leaves every action in with the switch off, and says that too', async () => {
    const source = scriptFixture();
    const before = await scriptPlaces(source);
    const outcome = await run(
      'sanitize-pdf',
      { javascript: false, attachments: false, metadata: false, info: false, annotations: false },
      [fileFrom(source, 'js.pdf', 'application/pdf')],
    );
    expect(await scriptPlaces(await firstPdf(outcome))).toEqual(before);
    expect(outcome.message).toMatch(new RegExp(`${before.length} script reference\\(s\\) left in place`));
    // The sentence that reads like a cleaning is the one this row exists to kill.
    expect(outcome.message).not.toMatch(/^Nothing to remove/);
    expect(outcome.message).not.toMatch(/no script references were present/);
  });

  it('does not report a cleaning on a file that carried nothing to clean', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText('no script here', { x: 20, y: 100 });
    const clean = fileFrom(new Uint8Array(await doc.save()), 'quiet.pdf', 'application/pdf');
    const outcome = await run(
      'sanitize-pdf',
      { javascript: true, attachments: false, metadata: false, info: false, annotations: false },
      [clean],
    );
    expect(outcome.message).toMatch(/^Nothing to remove/);
    expect(outcome.message).toMatch(/no script references were present/);
    expect(outcome.message).not.toMatch(/script reference\(s\) removed/);
  });

  it('names what it left alone when the document carried script and the switch was the only one off', async () => {
    // The card must not print "Nothing to remove" over a file that had script in
    // it and kept it: there *was* something to remove, and this run declined.
    const outcome = await run(
      'sanitize-pdf',
      { javascript: false, attachments: true, metadata: true, info: false, annotations: false },
      [fileFrom(scriptFixture(), 'js.pdf', 'application/pdf')],
    );
    expect(outcome.message).toMatch(/left in place/);
    expect(outcome.warnings.join(' ')).toMatch(/script/i);
  });

  it('keeps counting the places it can already see, so the two halves agree', async () => {
    const outcome = await run(
      'sanitize-pdf',
      { javascript: true, attachments: false, metadata: false, info: false, annotations: false },
      [fileFrom(scriptFixture(), 'js.pdf', 'application/pdf')],
    );
    const removed = Number(/(\d+) script reference\(s\) removed/.exec(outcome.message ?? '')?.[1] ?? 0);
    // OpenAction, the page /AA, the annotation's inline action, the field's
    // referenced action and the named entry.
    expect(removed).toBe(5);
  });
});
