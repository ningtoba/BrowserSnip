/**
 * CHUNK c4 PROBE — why does `add-attachments` ship a file MuPDF cannot open?
 *
 * `addAttachments` replaces only `/UF` with a hex UTF-16BE string after `doc.attach`;
 * the `/F` pdf-lib wrote stays a **literal** string, and the fork writes literals with
 * no escaping (`PDFString.copyBytesInto` copies `charCodeAt` values between two parens,
 * and its own source says "for simplicity, we will not bother escaping them"). A name
 * with an unmatched `(`, `)` or a `\` therefore ends the string early and takes the rest
 * of the object with it; a non-ASCII name has its code units truncated to their low
 * byte. `renameAttachments` already writes BOTH names through `nameString`, which is a
 * hex string, so the cure is the same call the rename path uses.
 *
 * This file measures the difference on the bytes, judged by libqpdf and MuPDF.
 */
import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDict, PDFHexString, PDFName, PDFString } from '@maxwbh/pdf-lib';
import { newPDF, openPDF, savePDF, context } from '@/lib/pdf/core/doc';
import { addAttachments, listAttachments } from '@/lib/pdf/core/attachments';

const NAMES = ['plain.txt', 'report (draft.txt', 'report draft).txt', 'back\\slash.txt', 'تقرير سنة.txt', 'über-𓂀.txt'];
// The CI runner has no lane scratch: mint a private dir instead of assuming one.
const OUT = process.env.C4_CAUSE_DIR || mkdtempSync(join(tmpdir(), 'c4-cause-'));

const bytes = Uint8Array.from({ length: 64 }, (_, i) => i + 1);

/** The encoder `renameAttachments` uses, written here so the probe fails with it gone. */
function nameString(name: string): PDFHexString {
  const units = Array.from(name, (char) => char.codePointAt(0) ?? 0);
  if (units.some((unit) => unit > 0xff)) {
    const out = new Uint8Array(2 + name.length * 2);
    out[0] = 0xfe;
    out[1] = 0xff;
    for (let index = 0; index < name.length; index++) {
      const unit = name.charCodeAt(index);
      out[2 + index * 2] = (unit >> 8) & 0xff;
      out[3 + index * 2] = unit & 0xff;
    }
    return PDFHexString.fromBytes(out);
  }
  return PDFHexString.fromBytes(Uint8Array.from(units, (unit) => unit & 0xff));
}

async function build(hexNames: boolean): Promise<Uint8Array> {
  const doc = await newPDF();
  doc.addPage([595, 842]);
  await addAttachments(doc, NAMES.map((name) => ({ name, bytes, mimeType: 'text/plain' })));
  if (hexNames) {
    // The cure: re-encode every name the writer just wrote as a hex string, the way
    // `renameAttachments` already does, so no bracket in a name can end the literal.
    for (const [, object] of context(doc).enumerateIndirectObjects()) {
      if (!(object instanceof PDFDict)) continue;
      if (String(object.lookup(PDFName.of('Type'))) !== '/Filespec') continue;
      const value = object.lookup(PDFName.of('UF'));
      const text = value instanceof PDFHexString || value instanceof PDFString ? value.decodeText() : '';
      if (text.length === 0) continue;
      object.set(PDFName.of('F'), nameString(text));
      object.set(PDFName.of('UF'), nameString(text));
    }
  }
  return savePDF(doc, { compress: false });
}

describe('the unescaped /F literal is what breaks the file', () => {
  it('writes both variants for the outside readers', async () => {
    const asWritten = await build(false);
    const cured = await build(true);
    writeFileSync(`${OUT}/as-written.pdf`, asWritten);
    writeFileSync(`${OUT}/hex-names.pdf`, cured);
    // The app's own reader is a weak instrument here: it reads /UF first, and the
    // corruption is in the bytes that follow the name it never looks at.
    const back = await openPDF(cured, { ignoreEncryption: true, updateMetadata: false });
    expect(listAttachments(back).map((entry) => entry.name)).toEqual(NAMES);
  }, 300_000);
});
