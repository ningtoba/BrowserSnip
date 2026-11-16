/**
 * Round 051 rig: the per-checkbox `/P` table and the re-protect path, driven
 * through the shipped `runPdfTool` rather than through a mock.
 *
 * The row could show a permission sentence and a decoded `/P` on the default
 * flags; it never flipped one checkbox at a time, so "each checkbox writes its
 * bit" was an assumption about `permissionsToFlags` (Table 25 positions are easy
 * to get wrong by one). Each of the eight is flipped alone here, from a
 * permissions-only run, and the raw `/P` integer is read out of the saved bytes
 * bit by bit — with the untouched default as the control that must differ from
 * every one of them.
 *
 *   npx vitest run --config docs/research/protect-round.vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');
const OUT = process.env.PROTECT_ROUND_DIR ?? '';

/** Table 25, 1-based bit → the field that owns it. */
const BITS: [string, number][] = [
  ['allowPrinting', 3],
  ['allowModifying', 4],
  ['allowCopying', 5],
  ['allowAnnotating', 6],
  ['allowFillingForms', 9],
  ['allowAccessibility', 10],
  ['allowAssembling', 11],
  ['printLevelLow', 12],
];

async function fixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Round 051 permission page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

async function protect(values: ToolValues, bytes?: Uint8Array, cardPassword?: string): Promise<{ out: Uint8Array; message: string; warnings: string[] }> {
  const tool = getPdfTool('protect') as PdfToolDefinition;
  const files = [new File([new Uint8Array(bytes ?? await fixture())], 'perm.pdf', { type: 'application/pdf' })];
  const outcome = (await runPdfTool({
    toolId: tool.id, files, values: { mode: 'owner', ownerPassword: 'owner-key', ...values },
    password: cardPassword, onProgress: () => {}, onLog: () => {},
  })) as unknown as { outputs: { blob: Blob }[]; message?: string; warnings: string[] };
  expect(outcome.outputs.length, 'no output').toBeGreaterThan(0);
  return {
    out: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    message: outcome.message ?? '',
    warnings: outcome.warnings,
  };
}

/** The raw `/P` integer, off the bytes — not through this app's decoder. */
function rawP(bytes: Uint8Array): number {
  const found = /\/P\s+(-?\d+)/.exec(latin1.decode(bytes));
  expect(found, 'the file carries no /P').not.toBeNull();
  return Number(found![1]);
}

function bit(value: number, position: number): boolean {
  return ((value >> (position - 1)) & 1) === 1;
}

describe('each /P checkbox writes its own bit and nothing else', () => {
  it('the default mask and every flip, one at a time', async () => {
    const base = await protect({});
    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'default.pdf'), base.out);
    }
    const baseValue = rawP(base.out);
    const rows: string[] = [`default /P ${baseValue}`];
    expect(bit(baseValue, 3), 'printing is on by default').toBe(true);
    expect(bit(baseValue, 11), 'assembly is off by default').toBe(false);

    for (const [key, position] of BITS) {
      const flipped = await protect(key === 'printLevelLow'
        ? { allowPrinting: false }
        : { [key]: key === 'allowAssembling' ? true : false });
      const value = rawP(flipped.out);
      rows.push(`${key} -> /P ${value} bit${position}=${bit(value, position)}`);
      if (OUT) {
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, `${key}.pdf`), flipped.out);
      }
      if (process.env.PROTECT_ROUND_LOG) console.log(rows[rows.length - 1]);
      // The flipped control's own bit, and the difference from the default.
      const wanted = key === 'allowAssembling' ? true : false;
      expect(bit(value, position), `${key} did not write bit ${position}`).toBe(wanted);
      expect(value, `${key} left /P unchanged`).not.toBe(baseValue);
      // ...and every *other* bit keeps its default value, except the one that is
      // subordinate to it: high-resolution printing cannot outlive printing.
      for (const [other, otherBit] of BITS) {
        if (other === key) continue;
        if (key === 'allowPrinting' && other === 'printLevelLow') continue;
        if (key === 'printLevelLow' && other === 'allowPrinting') continue;
        expect(bit(value, otherBit), `${key} also moved ${other}`).toBe(bit(baseValue, otherBit));
      }
    }
    if (process.env.PROTECT_ROUND_LOG) console.log(rows.join('\n'));
  });

  it('the card names the permission set it wrote', async () => {
    const { message } = await protect({ allowCopying: false, allowPrinting: false });
    expect(message).toMatch(/printing blocked/i);
    expect(message).toMatch(/copying blocked/i);
  });
});

describe('an already-locked input', () => {
  const locked = () => readFileSync('/tmp/triage/in/locked.pdf');

  it('opens, re-keys to the new password and keeps the pages', async () => {
    // The card box carries the secret the file opens with; the form's fields are
    // the ones the copy will carry. That split is what the fix restores.
    const { out, message, warnings } = await protect(
      { mode: 'both', userPassword: 'brand-new-pass', ownerPassword: 'owner-key' },
      locked(),
      'reader-pass',
    );
    expect(warnings.join(' ')).toMatch(/already protected/i);
    expect(message).toMatch(/AES-128/);
    const reopened = await PDFDocument.load(out, { password: 'brand-new-pass' });
    expect(reopened.getPageCount()).toBe(4);
  });
});
