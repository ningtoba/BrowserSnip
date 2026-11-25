// Is the corrupt `add-attachments` output the unescaped `/F` literal, and does a hex
// `/F` cure it? Vendored pdf-lib only (the fork's `es` build is extensionless, so the
// `cjs` entry is required through createRequire), no app code.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { PDFDocument, PDFHexString, PDFName } = require('@maxwbh/pdf-lib/cjs');

const names = ['plain.txt', 'report (draft.txt', 'report draft).txt', 'تقرير سنة.txt', 'back\\slash.txt', 'über-𓂀.txt'];
const bytes = Uint8Array.from({ length: 64 }, (_, i) => i + 1);

const utf16 = (name) => {
  const out = new Uint8Array(2 + name.length * 2);
  out[0] = 0xfe; out[1] = 0xff;
  for (let i = 0; i < name.length; i++) { out[2 + i * 2] = name.charCodeAt(i) >> 8; out[3 + i * 2] = name.charCodeAt(i) & 0xff; }
  return PDFHexString.fromBytes(out);
};
const nameString = (name) => ([...name].some((c) => c.codePointAt(0) > 0xff)
  ? utf16(name)
  : PDFHexString.fromBytes(Uint8Array.from([...name], (c) => c.charCodeAt(0) & 0xff)));

for (const mode of ['as-written', 'hex-F-and-UF']) {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  for (const name of names) await doc.attach(bytes, name, { mimeType: 'text/plain' });
  await doc.flush();
  if (mode !== 'as-written') {
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      const type = object?.lookup?.(PDFName.of('Type'));
      if (String(type) !== '/Filespec') continue;
      const text = object.lookup(PDFName.of('UF')).decodeText();
      object.set(PDFName.of('F'), nameString(text));
      object.set(PDFName.of('UF'), utf16(text));
    }
  }
  const saved = await doc.save({ useObjectStreams: false });
  writeFileSync(`/tmp/lane-security/c4/cause/${mode}.pdf`, Buffer.from(saved));
  console.log(mode, saved.length, 'bytes');
}
