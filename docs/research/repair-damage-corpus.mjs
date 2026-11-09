#!/usr/bin/env node
/**
 * The `repair` damage corpus — one file per way a PDF breaks, made by damaging a
 * known-good document, so the corpus is reproducible and not a pile of binaries
 * nobody can remake.
 *
 *   node docs/research/repair-damage-corpus.mjs --dir /tmp/rd
 *
 * Writes `<dir>/corpus/base.pdf`, `<dir>/corpus/<case>.pdf` for every case and
 * `<dir>/manifest.json` describing each one: which base it came from, what was
 * changed, and what the base holds (4 pages, one planted word per page, one solid
 * bar per page) so an outside reader can say whether a "repaired" file still holds
 * the document.
 *
 * Why a corpus and not one broken file: `docs/TOOL-TRIAGE.md` §2 met a single
 * damaged input and found a tool returning 1 blank page for a file three readers
 * still open as 4. One sample cannot tell "repair failed" from "this damage is
 * unrecoverable", and the honest answer differs per class — a truncated tail loses
 * real objects, a lying `/xref` loses none, a bad `/ObjStm` index can keep every
 * page and lose the tree that names them. Each case is named for the structure it
 * breaks, and every case comes from the same base so page counts, ink and words
 * compare.
 *
 * Two bases, because one file cannot carry both index shapes:
 *  · `base.pdf`        — classic `/xref` table, `/FlateDecode` content streams.
 *  · `base-objstm.pdf` — object stream + cross-reference *stream*, the shape this
 *                        app's own writer emits, i.e. what a file downloaded from
 *                        the site and damaged later actually looks like.
 *
 * Every damage is a byte edit — a slice, a digit changed, a token removed, a
 * stream re-deflated — never a rewrite through a PDF library. A library that
 * "damages" a file re-serialises it, and the result measures the library.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/rd');
const CORPUS = join(DIR, 'corpus');
mkdirSync(CORPUS, { recursive: true });

const latin1 = new TextDecoder('latin1');
const encode = (text) => new Uint8Array(Buffer.from(text, 'latin1'));

/** One word per sheet, so "4 pages" can be true while a sheet is missing. */
export const SHEET_WORDS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const SENTENCE = 'Forty-one crates were checked against the ledger by hand.';

/* ── the two known-good bases ────────────────────────────────────────────── */

async function baseBytes(objectStreams) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  SHEET_WORDS.forEach((word, index) => {
    const page = doc.addPage([595, 842]);
    page.drawText(`${word} — ledger sheet ${index + 1}`, { x: 50, y: 760, size: 18, font, color: rgb(0, 0, 0) });
    page.drawText(SENTENCE, { x: 50, y: 720, size: 11, font });
    // A solid bar per sheet: ink becomes a fact about the file, so "4 pages" that
    // rasterise to paper cannot pass as a preserved document.
    page.drawRectangle({ x: 50, y: 400, width: 300, height: 80, color: rgb(0.05, 0.05, 0.05) });
  });
  doc.setTitle('Repair damage corpus');
  doc.setAuthor('BrowserSnip campaign');
  return new Uint8Array(await doc.save({ useObjectStreams: objectStreams }));
}

/* ── byte-level damage primitives ────────────────────────────────────────── */

/** Splice `replacement` over `text`[from, to), leaving the rest byte-for-byte. */
function splice(bytes, from, to, replacement) {
  return new Uint8Array(Buffer.concat([
    bytes.subarray(0, from),
    typeof replacement === 'string' ? encode(replacement) : replacement,
    bytes.subarray(to),
  ]));
}

/**
 * Every `N 0 obj` in the file that holds a stream, in file order.
 *
 * Walked object by object rather than by matching `stream` tokens: a payload can
 * contain the word `stream`, and `/Stream` appears as a name inside many
 * dictionaries, so a token scan finds streams that are not there. An object's own
 * stream is the `stream` keyword between its `obj` and its `endobj`.
 */
function streams(text) {
  const found = [];
  const header = /^(\d+) 0 obj\b/gm;
  let match = header.exec(text);
  while (match !== null) {
    const objectAt = match.index;
    const endAt = text.indexOf('endobj', objectAt);
    const streamAt = text.indexOf('stream', objectAt);
    if (endAt >= 0 && streamAt >= 0 && streamAt < endAt && text.slice(streamAt - 1, streamAt + 6) !== 'endstream') {
      const payloadStart = text.indexOf('\n', streamAt) + 1;
      const payloadEnd = text.indexOf('endstream', payloadStart);
      const lengthAt = text.lastIndexOf('/Length', streamAt);
      let lengthEnd = lengthAt >= objectAt ? lengthAt + '/Length'.length : -1;
      while (lengthEnd >= 0 && /\s/.test(text[lengthEnd])) lengthEnd += 1;
      const lengthStart = lengthEnd;
      while (lengthEnd >= 0 && /\d/.test(text[lengthEnd])) lengthEnd += 1;
      found.push({
        number: Number(match[1]),
        payloadStart,
        payloadEnd,
        lengthStart: lengthEnd > lengthStart ? lengthStart : -1,
        lengthEnd: Math.max(lengthEnd, lengthStart),
        dict: text.slice(objectAt, streamAt),
      });
    }
    match = header.exec(text);
  }
  return found;
}

/**
 * Replace the payload of the first stream whose dictionary satisfies `pick`,
 * keeping `/Length` truthful for the new bytes.
 *
 * `/Length` is rewritten because leaving it stale would damage the file twice: a
 * short length clips the stream, a long one runs the reader into `endstream`, and
 * the case would then measure the fixture's arithmetic instead of the repair.
 */
function rewriteStream(bytes, pick, edit) {
  const text = latin1.decode(bytes);
  const where = streams(text).filter((item) => item.payloadEnd > 0 && pick(item.dict))[0];
  if (!where) throw new Error('the base has no stream matching this damage');
  const payload = bytes.subarray(where.payloadStart, where.payloadEnd);
  const next = edit(payload, where.dict);
  if (where.lengthStart < 0) throw new Error(`stream #${where.number} has no plain /Length`);
  const step1 = splice(bytes, where.payloadStart, where.payloadEnd, next);
  return splice(step1, where.lengthStart, where.lengthEnd, String(next.length));
}

const CASES = {
  /**
   * A download that stopped early: the xref table, the trailer and the last
   * objects are not in the file at all. `inspectPdf` already flags this shape
   * (`truncated`), so the tool cannot claim it did not know.
   */
  'truncated-tail': (base) => base.subarray(0, Math.floor(base.byteLength * 0.55)),

  /**
   * An index that lies. The table is intact, every object is present, but each
   * offset names a byte three past the object it points at, so a reader that
   * trusts the table finds no `N 0 obj` there. Nothing is missing: losing pages
   * here is a reading failure, not a limit of recovery.
   */
  'lying-xref': (base) => {
    const text = latin1.decode(base);
    const at = text.indexOf('\nxref\n');
    if (at < 0) throw new Error('the base has no classic /xref table');
    const tableStart = at + 1;
    const trailerAt = text.indexOf('trailer', tableStart);
    const table = text.slice(tableStart, trailerAt);
    const broken = table.replace(/^(\d{10}) 00000 n/gm, (_all, off) => {
      const value = Number(off);
      if (value === 0) return '0000000000 00000 n';
      return `${String(value + 3).padStart(10, '0')} 00000 n`;
    });
    if (broken === table) throw new Error('the /xref table held no in-use entries');
    return splice(base, tableStart, trailerAt, broken);
  },

  /**
   * No `startxref`: the pointer to the index is gone while the index itself is
   * still in the file. MuPDF, qpdf and poppler all answer this by scanning for
   * the table, which is the point of the case.
   */
  'missing-startxref': (base) => {
    const text = latin1.decode(base);
    const at = text.lastIndexOf('startxref');
    if (at < 0) throw new Error('the base has no startxref');
    const eof = text.indexOf('%%EOF', at);
    return splice(base, at, eof, '');
  },

  /**
   * The object-stream index is wrong. A `/Type /ObjStm` stream opens with
   * `/N` pairs of `<objnum> <offset>` and then the object bodies, so shifting
   * every offset by 4 keeps the stream decodable and puts every read four bytes
   * into the object it names.
   */
  'objstm-wrong-offsets': (base) => rewriteStream(
    base,
    (dict) => dict.includes('/Type /ObjStm'),
    (payload, dict) => {
      const declared = Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? 0);
      const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? -1);
      if (!declared || first < 0) throw new Error('no /N + /First pair on the object stream');
      const body = Buffer.from(inflateSync(Buffer.from(payload))).toString('latin1');
      const pairs = body.slice(0, first).trim().split(/\s+/).map(Number);
      if (pairs.length < declared * 2) {
        throw new Error(`/ObjStm header holds ${pairs.length} numbers, /N says ${declared}`);
      }
      const shifted = pairs.map((value, index) => (index % 2 === 0 ? value : value + 4));
      const rebuilt = encode(`${shifted.join(' ')}\n${body.slice(first)}`);
      return new Uint8Array(deflateSync(rebuilt));
    },
  ),

  /**
   * One object carries two `endobj` tokens, so the token that closes it sits in
   * front of the next object as junk. Common in hand-patched and crashed-writer
   * files.
   */
  'duplicate-endobj': (base) => {
    const text = latin1.decode(base);
    const at = text.indexOf('endobj');
    if (at < 0) throw new Error('the base has no endobj');
    return splice(base, at + 'endobj'.length, at + 'endobj'.length, '\nendobj');
  },

  /** One object's `endobj` is missing, so its successor opens inside it. */
  'missing-endobj': (base) => {
    const text = latin1.decode(base);
    const at = text.indexOf('endobj');
    if (at < 0) throw new Error('the base has no endobj');
    return splice(base, at, at + 'endobj'.length, '');
  },

  /**
   * Garbage inside a page's content stream: a half-written dictionary planted
   * between two operators, on sheet 2. The structure around it is sound and the
   * page count is reachable, so the only honest report is "this page's content is
   * damaged" — a page count here says nothing at all.
   */
  'garbage-dict-midstream': (base) => rewriteStream(
    base,
    // The second content stream: sheet 2 keeps its index and loses its operators.
    // Named by dictionary, not by position, so a base that grows an object cannot
    // quietly damage the cross-reference stream instead of a page.
    ((seen) => (dict) => {
      if (!/\/Filter \/FlateDecode/.test(dict) || /\/Type \/(ObjStm|XRef)/.test(dict)) return false;
      seen.count += 1;
      return seen.count === 2;
    })({ count: 0 }),
    (payload) => {
      const body = Buffer.from(inflateSync(Buffer.from(payload))).toString('latin1');
      if (!body.includes('BT')) throw new Error('the chosen stream is not a page content stream');
      const cut = Math.floor(body.length / 2);
      const planted = ' << /Fbar (unclosed >> Bz ';
      return new Uint8Array(deflateSync(Buffer.from(`${body.slice(0, cut)}${planted}${body.slice(cut)}`, 'latin1')));
    },
  ),

  /**
   * The shape `docs/TOOL-TRIAGE.md` §2 was measured with: a comment inserted after
   * the header, the tail cut, and `%%EOF` shortened to `%%EO` so even the
   * end-of-file scan fails. Re-derived here so the reported 4-in-1-out result can
   * be re-measured rather than quoted.
   */
  'triage-report': (base) => {
    const text = latin1.decode(base);
    return encode(`${text.slice(0, 12)}\n% damaged by triage\n${text.slice(12, text.length - 40)}\n%%EO\n`);
  },
};

/* ── emit ────────────────────────────────────────────────────────────────── */

const base = await baseBytes(false);
const baseObjStm = await baseBytes(true);
if (!latin1.decode(base).includes('\nxref\n')) throw new Error('base.pdf must carry a classic /xref table');
if (!latin1.decode(baseObjStm).includes('/ObjStm')) throw new Error('base-objstm.pdf must carry an object stream');

writeFileSync(join(CORPUS, 'base.pdf'), base);
writeFileSync(join(CORPUS, 'base-objstm.pdf'), baseObjStm);

const manifest = {
  corpus: CORPUS,
  base: 'base.pdf',
  pages: SHEET_WORDS.length,
  sheet_words: SHEET_WORDS,
  sentence: SENTENCE,
  bases: {
    'base.pdf': { bytes: base.byteLength, index: 'classic /xref table', object_stream: false },
    'base-objstm.pdf': { bytes: baseObjStm.byteLength, index: '/XRef stream', object_stream: true },
  },
  cases: [],
};

for (const [name, damage] of Object.entries(CASES)) {
  const source = name === 'objstm-wrong-offsets' ? baseObjStm : base;
  const which = source === base ? 'base.pdf' : 'base-objstm.pdf';
  const bytes = damage(source);
  writeFileSync(join(CORPUS, `${name}.pdf`), bytes);
  manifest.cases.push({
    name,
    file: `corpus/${name}.pdf`,
    source: which,
    bytes: bytes.byteLength,
    removed_bytes: Math.max(0, source.byteLength - bytes.byteLength),
  });
}

writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`corpus: ${CORPUS}`);
for (const item of manifest.cases) {
  console.log(`  ${item.name.padEnd(24)} ${String(item.bytes).padStart(6)} B  (from ${item.source})`);
}
