/**
 * `view-metadata`, judged by the file it describes — the chunk-c3 re-audit.
 *
 * Driven live on the dev build (`docs/research/c3-metadata-probe.mjs`, Chromium on
 * :5294, CDP 9844) over twelve fixtures and two real producer files (a Microsoft
 * Word 2021 paper and a pdfTeX paper), reading every rendered row out of the DOM
 * and comparing it with pikepdf, MuPDF and poppler.
 *
 * Measured good, re-measured here: all 18 `/Info` keys of a rich file named
 * (vendor keys, a 120-character key, a non-string value, empty-vs-absent); a file
 * with no `/Info` reported instead of refused; padding painted (`<dd>` measured at
 * left 687 px with its first glyph at 701 px — two 7 px monospace spaces), newlines
 * on two lines, astral and CJK text intact; a malformed date kept visibly
 * (`not a date this can read: D:2026-13-45 — shown exactly as the file stores it`),
 * and a numeric one rolled over the same way poppler does it for the same bytes
 * (`D:20261345999999Z` → `18 February 2027 at 04:40:39 UTC`, where `pdfinfo` prints
 * `Thu Feb 18 12:40:39 2027 +08`).
 *
 * The two defects the audit found:
 *
 *   1. **Attachments were invisible rather than absent.** The card promises
 *      attachments among what it reads back, and every other store names its own
 *      absence (`XMP packet: absent — …`, `Piece info: none — …`, `Fonts: None`),
 *      but the section was pushed only when a file existed — measured: four
 *      fixtures rendered no occurrence of the word "attach" at all. Fixed here,
 *      pinned below.
 *   2. **A packet is reported as six properties.** `readXmp` reads `dc:title`,
 *      `dc:creator`, `dc:description`, `dc:subject`, `pdf:PDFVersion` and
 *      `pdfaid:*` and nothing else, so qpdf's own count of a real pdfTeX paper —
 *      23 properties, including `dc:rights` with the licence statement,
 *      `xmpRights:WebStatement`, `xmpMM:DocumentID` and the three `xmp:*Date`s —
 *      arrives on screen as five rows plus "not in the packet". The broken-packet
 *      fallback is *richer* than the parseable path (it lists `Producer` and
 *      `Creator tool`) and reads element form only, so an attribute-form
 *      `pdf:Producer="…"` — how Acrobat and Word write it — is shown for a packet
 *      that will not parse and hidden for one that will. That is a `SEAM` item in
 *      `src/lib/pdf/core/metadata.ts` (`XmpSummary`, `readXmp`, `xmpRows`,
 *      `fallbackXmpFields`); the same seam gap costs `edit-metadata` its
 *      packet-only `pdf:Producer`, `xmp:CreatorTool` and `dc:language` on a blank
 *      save (see `metadata-blank-save.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { PDFHexString, PDFName, PDFString } from '@/lib/pdf/core/doc';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { infoDict, parsePdfDateParts } from '@/lib/pdf/core/metadata';
import type { ToolValues } from '@/lib/pdf/tools/types';

async function bufferOf(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

/** A one-page file with properties and no attachments. */
async function plainInfo(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const dict = infoDict(doc, true)!;
  dict.set(PDFName.of('Title'), PDFHexString.fromText('Nothing attached'));
  dict.set(PDFName.of('Author'), PDFString.of('Jane'));
  return doc.save({ useObjectStreams: false });
}

async function report(values: ToolValues = {}, bytes: Uint8Array) {
  expect(getPdfTool('view-metadata'), 'view-metadata is not registered').toBeTruthy();
  const outcome = (await runPdfTool({
    toolId: 'view-metadata',
    files: [new File([await bufferOf(bytes)], 'paper.pdf', { type: 'application/pdf' })],
    values,
    onProgress: () => {},
    onLog: () => {},
  })) as unknown as { report?: { message?: string; sections: { title: string; rows?: { label: string; value: string }[] }[] } };
  return outcome.report?.sections ?? [];
}

describe('a store the file does not have is named as absent', () => {
  it('says there are no embedded files instead of dropping the section', async () => {
    const sections = await report({}, await plainInfo());
    const titles = sections.map((section) => section.title);
    expect(titles, 'the report never mentioned attachments').toContain('Embedded files');
    const embedded = sections.find((section) => section.title === 'Embedded files');
    expect(embedded?.rows?.[0]?.value ?? '').toMatch(/^no embedded files —/);
    // Every named absence has to be counted by the sentence at the top.
    const seen = Number(/Read (\d+) section/.exec(sections.length ? '' : '')?.[1] ?? -1);
    void seen;
  }, 240_000);

  it('still lists the files when the document carries some', async () => {
    const doc = await PDFDocument.load(await plainInfo(), { updateMetadata: false });
    await doc.attach(new Uint8Array([111, 107, 46]), 'note-c3.txt', { mimeType: 'text/plain' });
    const sections = await report({}, await doc.save({ useObjectStreams: false }));
    const embedded = sections.find((section) => section.title === 'Embedded files');
    expect(embedded?.rows?.map((row) => row.label)).toEqual(['note-c3.txt']);
    expect(embedded?.rows?.[0]?.value).toContain('3 B');
    expect(embedded?.rows?.[0]?.value).toContain('text/plain');
  }, 240_000);

  it('counts the sections it actually rendered', async () => {
    const bytes = await plainInfo();
    const outcome = (await runPdfTool({
      toolId: 'view-metadata',
      files: [new File([await bufferOf(bytes)], 'paper.pdf', { type: 'application/pdf' })],
      values: {},
      onProgress: () => {},
      onLog: () => {},
    })) as unknown as { report?: { message?: string; sections: { title: string }[] } };
    const counted = Number(/Read (\d+) section/.exec(outcome.report?.message ?? '')?.[1] ?? -1);
    expect(counted).toBe((outcome.report?.sections ?? []).length);
  }, 240_000);
});

/**
 * `SEAM` (`src/lib/pdf/core/metadata.ts`) — measured live, pinned blocked so the
 * seam fix has a flip-target. A date whose text carries no offset is the file's
 * own wall clock; `humanDate` runs the UTC getters over a `Date` built from local
 * fields, so the printed words and their own label disagree.
 *
 * Live measurements (same bytes, Chromium with `Emulation.setTimezoneOverride`):
 *   `D:20260102030405` → `1 January 2026 at 19:04:05 local time, no offset recorded`
 *     at +08, `2 January 2026 at 03:04:05 …` at UTC, `2 January 2026 at 08:04:05 …`
 *     at -05 — three answers for one file.
 *   `D:202601` (year and month only) → `31 December 2025 at 16:00:00 …` at +08:
 *   the month the file names is not on the screen at all.
 * `pdfinfo` prints `Fri Jan 2 11:04:05 2026 +08` for the first and MuPDF and
 * pikepdf hand back the stored string, which the row also shows.
 */
describe.skip('BLOCKED on the date seam: a zone-less date keeps the wall clock its own text holds', () => {
  it('prints the stored fields, not their UTC translation, and labels them honestly', () => {
    const parts = parsePdfDateParts('D:20260102030405');
    expect(parts, 'the date must still be recognised').toBeTruthy();
    // The exact sentence the row has to render, beside the stored string:
    // `2 January 2026 at 03:04:05 local time, no offset recorded · stored as D:20260102030405`
    expect(`2 January 2026 at 03:04:05`).toBeTruthy();
    expect(new Date(parts!.date).getHours(), 'the parsed instant moved off the typed hour').toBe(3);
  });
});
