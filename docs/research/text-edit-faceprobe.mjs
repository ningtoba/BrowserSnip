import fs from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const FILE = process.argv[2] || '/tmp/tf/distilled.pdf';
const PROBE = process.argv[3] || 'Q#EmQQl—Zz 42';
const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
const b64 = fs.readFileSync(FILE).toString('base64');
const out = await h.ev(`(async () => {
  const { openPDF } = await import('/src/lib/pdf/core/doc.ts');
  const content = await import('/src/lib/pdf/core/content.ts');
  const raw = atob(${JSON.stringify(b64)});
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const doc = await openPDF(bytes);
  const page = doc.getPage(0);
  const want = ${JSON.stringify(PROBE)};
  return content.pageTextFaces(page).map((face) => ({
    name: face.baseFont,
    subtype: face.subtype,
    codes: [...want].slice(0, 8).map((ch) => [ch, face.codeOf(ch.codePointAt(0)), face.widthOf(face.codeOf(ch.codePointAt(0)) ?? -1)]),
    missing: face.missingFor(want),
  }));
})()`);
console.log(JSON.stringify(out, null, 1));
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
void sleep;
