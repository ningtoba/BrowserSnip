// Which /Encrypt dictionary survives an independent reader, given that this
// engine writes **plaintext streams behind a cipher declaration**?
//
// `@maxwbh/pdf-lib`'s writer registers the dictionary and the /ID and then
// serializes every stream and string exactly as it held it — it never calls its
// own `PDFSecurity.encryptStream` / `encryptString`.  So the only claim a
// dictionary can honestly make about those bytes is "there is a password gate,
// and the data is not ciphered": `/CFM /None`.
//
// Each candidate below is the same fixture with the same user/owner password,
// differing only in the dictionary, and `protect-readers.py` judges them.
//
//   node docs/research/protect-dictionary.mjs /tmp/protect-dict
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  PDFDocument, PDFDict, PDFHexString, PDFName, PDFNumber, StandardFonts, rgb,
} = require('@maxwbh/pdf-lib');

const outDir = process.argv[2] || '/tmp/protect-dict';
mkdirSync(outDir, { recursive: true });

const WORDS = 'Lighthouse Inventory 1887';
const USER = 'reader-pass';
const OWNER = 'owner-pass';

async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${WORDS} page ${i + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  doc.getForm().createTextField('applicant.name').setText('Ada Lovelace');
  return doc;
}

const permissions = {
  printing: false, printingHighQuality: false, modifying: false, copying: false,
  annotating: false, fillingForms: false, contentAccessibility: true, documentAssembly: false,
};

/** The engine's own /Encrypt dictionary for `version`, on a live document. */
async function withEngineDict(version) {
  const doc = await fixture();
  const bytes = await doc.save({
    encrypt: { userPassword: USER, ownerPassword: OWNER, version, permissions },
    useObjectStreams: false,
  });
  const opened = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const dict = opened.context.lookup(opened.context.trailerInfo.Encrypt);
  if (!(dict instanceof PDFDict)) throw new Error('the engine wrote no /Encrypt dictionary');
  return { opened, dict };
}

function filter(doc, entries) {
  return doc.context.obj({ StdCF: doc.context.obj(entries) });
}

const CANDIDATES = {
  // What the AES-256 option writes today.
  'v5-engine': async () => (await withEngineDict(5)).opened,
  'v4-engine': async () => (await withEngineDict(4)).opened,
  'v2-engine': async () => (await withEngineDict(2)).opened,
  // The same gate, with the crypt filter claiming what the bytes are.
  'v4-none-len0': async () => {
    const { opened, dict } = await withEngineDict(4);
    dict.set(PDFName.of('CF'), filter(opened, { CFM: PDFName.of('None'), AuthEvent: PDFName.of('DocOpen'), Length: PDFNumber.of(0) }));
    dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
    dict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
    return opened;
  },
  'v4-none-bare': async () => {
    const { opened, dict } = await withEngineDict(4);
    dict.set(PDFName.of('CF'), filter(opened, { CFM: PDFName.of('None'), AuthEvent: PDFName.of('DocOpen') }));
    dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
    dict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
    dict.set(PDFName.of('EncryptMetadata'), opened.context.obj(true));
    return opened;
  },
  // A complete R6 shape (OE/UE/Perms, AESV3 /Length 32) over the same
  // plaintext bytes: does MuPDF's rejection come from the missing keys, or
  // from the cipher claim itself?
  'v5-aesv3-shape': async () => {
    const { opened, dict } = await withEngineDict(5);
    const long = PDFHexString.fromBytes(new Uint8Array(48).fill(7));
    const short = PDFHexString.fromBytes(new Uint8Array(32).fill(8));
    const perms = PDFHexString.fromBytes(new Uint8Array(16).fill(9));
    dict.set(PDFName.of('O'), long);
    dict.set(PDFName.of('U'), long);
    dict.set(PDFName.of('OE'), short);
    dict.set(PDFName.of('UE'), short);
    dict.set(PDFName.of('Perms'), perms);
    dict.set(PDFName.of('CF'), filter(opened, { CFM: PDFName.of('AESV3'), AuthEvent: PDFName.of('DocOpen'), Length: PDFNumber.of(32) }));
    dict.set(PDFName.of('StmF'), PDFName.of('StdCF'));
    dict.set(PDFName.of('StrF'), PDFName.of('StdCF'));
    dict.set(PDFName.of('EncryptMetadata'), opened.context.obj(true));
    return opened;
  },
};

for (const [name, build] of Object.entries(CANDIDATES)) {
  const doc = await build();
  const bytes = await doc.save({ useObjectStreams: false, updateMetadata: false });
  const file = path.join(outDir, `${name}.pdf`);
  writeFileSync(file, bytes);
  const raw = new TextDecoder('latin1').decode(bytes);
  const dict = /\/Filter\s*\/Standard[\s\S]{0,700}?>>/.exec(raw)?.[0]?.replace(/\s+/g, ' ') ?? '(none)';
  const clear = raw.includes('Ada Lovelace') || /\/V\s*\(Ada/.test(raw);
  console.log(`### ${name} (${bytes.length} B, field value readable in the clear: ${clear})\n    ${dict}\n`);
}
