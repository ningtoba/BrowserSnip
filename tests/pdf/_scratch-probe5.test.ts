import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { pageContentStreams, streamBytes } from '@/lib/pdf/core/content';

const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

const line = (s: string): void => process.stderr.write(`${s}\n`);

function shownText(content: string): string[] {
  const out: string[] = [];
  const decode = (raw: string, hex: boolean): string =>
    hex
      ? Buffer.from(raw.length % 2 === 0 ? raw : `${raw}0`, 'hex').toString('latin1')
      : raw.replace(/\\([()\\])/g, '$1');
  for (const m of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")/g)) out.push(decode(m[1], false));
  for (const m of content.matchAll(/<([0-9A-Fa-f\s]*)>\s*(?:Tj|'|")/g)) out.push(decode(m[1].replace(/\s+/g, ''), true));
  for (const m of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    for (const s of m[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]*)>/g)) {
      out.push(s[1] !== undefined ? decode(s[1], false) : decode((s[2] ?? '').replace(/\s+/g, ''), true));
    }
  }
  return out;
}

function dictOf(doc: PDFDocument, value: unknown): PDFDict | null {
  const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : null;
}

export function drawnText(doc: PDFDocument, index: number): string {
  const page = doc.getPages()[index];
  const parts: string[] = [];
  const seen = new Set<string>();
  const walk = (content: string, resources: PDFDict | null, depth: number): void => {
    parts.push(...shownText(content));
    if (depth > 3 || !resources) return;
    const forms = dictOf(doc, resources.get(PDFName.of('XObject')));
    if (!forms) return;
    for (const [, value] of forms.entries()) {
      const ref = value instanceof PDFRef ? value.toString() : null;
      if (ref && seen.has(ref)) continue;
      if (ref) seen.add(ref);
      const stream = (value instanceof PDFRef ? doc.context.lookup(value) : value) as unknown;
      if (!(stream instanceof PDFRawStream)) continue;
      const inner = Buffer.from(streamBytes(stream)).toString('latin1');
      walk(inner, dictOf(doc, stream.dict.get(PDFName.of('Resources'))), depth + 1);
    }
  };
  const content = pageContentStreams(page).map((s) => Buffer.from(s.bytes).toString('latin1')).join('\n');
  walk(content, dictOf(doc, page.node.Resources()), 0);
  return parts.join('');
}

async function sheets(n: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([200, 100]);
    page.drawText(`${label} ${i + 1}`, { x: 10, y: 60, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

async function runDoc(toolId: string, values: Record<string, unknown>, files: File[], index = 0): Promise<PDFDocument> {
  const { runPdfTool } = await import('@/lib/pdf/tools/runner');
  const outcome = await runPdfTool({ toolId, files, values });
  const bytes = new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
  return PDFDocument.load(bytes);
}
async function run(toolId: string, values: Record<string, unknown>, files: File[]) {
  const { runPdfTool } = await import('@/lib/pdf/tools/runner');
  return runPdfTool({ toolId, files, values });
}

describe('probe5', () => {
  it('reads text through a rebuild and through imposition', async () => {
    const bytes = await sheets(3, 'R');
    const plain = await PDFDocument.load(bytes);
    line(`FIXTURE ${plain.getPages().map((_, i) => drawnText(plain, i)).join(' / ')}`);
    const reverse = await runDoc('reverse-pages', {}, [fileOf(bytes, 'r.pdf')]);
    line(`REVERSE ${reverse.getPages().map((_, i) => drawnText(reverse, i)).join(' / ')}`);
    const nup = await runDoc('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false, gutter: 0, margin: 0, pages: 'all' }, [fileOf(bytes, 'r.pdf')]);
    line(`NUP ${nup.getPages().map((_, i) => drawnText(nup, i)).join(' / ')}`);
    const alt = await runDoc('alternate-merge', { pattern: 'reverse-alternate' }, [fileOf(await sheets(3, 'A'), 'a.pdf'), fileOf(await sheets(3, 'B'), 'b.pdf')]);
    line(`ALT ${alt.getPages().map((_, i) => drawnText(alt, i)).join(' ')}`);
    const crop = await runDoc('divide-pages', { axis: 'vertical', parts: 2, pages: 'all' }, [fileOf(bytes, 'r.pdf')]);
    line(`DIVIDE ${crop.getPages().map((_, i) => drawnText(crop, i)).join(' | ')}`);
    expect(1).toBe(1);
  });
});
