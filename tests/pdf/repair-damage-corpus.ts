/**
 * The `repair` damage corpus: one known-good document, damaged one structural
 * way at a time.
 *
 * This is the single spelling of the corpus. `tests/pdf/repair-damage.test.ts`
 * imports it directly, and `docs/research/repair-damage-corpus.mjs` bundles the
 * same module with esbuild to write the files the outside readers judge — so the
 * fixtures the campaign measures and the fixtures the test pins cannot drift apart.
 *
 * Every case is a **byte edit** to a document whose healthy shape is known: a
 * slice, a digit changed, a token removed, a payload re-deflated. Nothing here
 * round-trips the file through a PDF library, because a library that "damages" a
 * file re-serialises it and the result measures that library, not the reader.
 *
 * Two bases, because one file cannot carry both index shapes:
 *  · `base` — a classic `/xref` table with `/FlateDecode` content streams;
 *  · `baseObjectStreams` — object stream + cross-reference *stream*, which is the
 *    shape this app's own writer emits, so it is what a file downloaded from the
 *    site and damaged later looks like.
 *
 * The document is built so that every claim about it is checkable per sheet: one
 * planted word each (`SHEET_WORDS`), one line of body copy, and a solid bar — so
 * "4 pages" can be false in three different ways (a sheet missing, a sheet with no
 * words, a sheet with no ink) and the measurement says which.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { PDFDocument, PDFDict, PDFName, StandardFonts, rgb } from '@maxwbh/pdf-lib';

/** One word per sheet: a file that opens as 4 pages can still be missing one. */
export const SHEET_WORDS = ['Alpha', 'Beta', 'Gamma', 'Delta'];

/** The line of body copy planted on every sheet, for an extracted-words check. */
export const SENTENCE = 'Forty-one crates were checked against the ledger by hand.';

/** Latin-1 is the one encoding where a JS string index is a byte offset. */
const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
const encode = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

export type DamageId =
  | 'truncated-tail'
  | 'lying-xref'
  | 'missing-startxref'
  | 'objstm-wrong-offsets'
  | 'duplicate-endobj'
  | 'missing-endobj'
  | 'garbage-dict-midstream'
  | 'triage-report'
  | 'plain-content-tailcut';

export interface DamageCase {
  id: DamageId;
  /** Which base the edit is applied to. */
  base: 'classic' | 'object-streams' | 'plain';
  /** The structure the case breaks, in the words the report uses. */
  breaks: string;
  /**
   * What the readers measured, per class. Every number here came out of
   * `docs/research/repair-damage-readers.py` (MuPDF, qpdf, poppler, pypdf) and
   * `pdf.js` over these exact bytes; none of it is a guess about what a repair
   * ought to manage.
   */
  expect: {
    /** The most any outside reader still opens the damaged input as. */
    inputPages: number;
    /** Sheets whose planted word MuPDF still extracts from the damaged input. */
    inputSheetsWithWords: number;
    /** Sheets in the file `repair` writes, counted by all five readers. */
    repairedPages: number;
    /** Sheets whose planted word survives in the repaired file. */
    repairedSheetsWithWords: number;
    /** Sheets of the repaired file whose display list holds no painting operator. */
    repairedBlankSheets: number;
    /** False when giving up is the honest answer for this damage. */
    mustProduce: boolean;
  };
  apply: (base: Uint8Array) => Uint8Array;
}

/** The known-good document: `pages` sheets, each with a word, a line and a bar. */
export async function damageBase(objectStreams = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  SHEET_WORDS.forEach((word, index) => {
    const page = doc.addPage([595, 842]);
    page.drawText(`${word} ledger sheet ${index + 1}`, { x: 50, y: 760, size: 18, font, color: rgb(0, 0, 0) });
    page.drawText(SENTENCE, { x: 50, y: 720, size: 11, font });
    // A solid bar: ink becomes a fact about the file, so a repaired document whose
    // sheets are paper cannot pass a count of pages.
    page.drawRectangle({ x: 50, y: 400, width: 300, height: 80, color: rgb(0.05, 0.05, 0.05) });
  });
  doc.setTitle('Repair damage corpus');
  doc.setAuthor('BrowserSnip campaign');
  return new Uint8Array(await doc.save({ useObjectStreams: objectStreams }));
}

/**
 * The same document stored with **uncompressed** page content, the way a scanner
 * driver or a hand-built producer writes it.
 *
 * This shape matters because it changes what the broken last resort does: with
 * plaintext payloads, `repair`'s byte harvest finds streams and builds sheets out
 * of them, which is how the file reported in `docs/TOOL-TRIAGE.md` §2 came back as
 * "1 page(s) readable" at 0.00 % ink rather than as a refusal.
 */
export async function damageBasePlain(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  SHEET_WORDS.forEach((word, index) => {
    const page = doc.addPage([595, 842]);
    // One font reference per sheet, resolved through the page's own resources so
    // the hand-written stream below is legal content rather than a guess.
    page.drawText(' ', { x: 50, y: 800, size: 8, font });
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    // `PDFName.toString()` already carries the leading slash, so the resource is
    // named `${name}` here and not `/${name}`.
    const name = fonts?.keys()[0] ?? PDFName.of('F1');
    const body = [
      'BT',
      `${name} 18 Tf`,
      '1 0 0 1 50 760 Tm',
      `(${word} ledger sheet ${index + 1}) Tj`,
      `${name} 11 Tf`,
      '1 0 0 1 50 720 Tm',
      `(${SENTENCE.replace(/([()\\])/g, '\\$1')}) Tj`,
      'ET',
      '0.05 0.05 0.05 rg',
      '50 400 300 80 re f',
    ].join('\n');
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(body)));
  });
  doc.setTitle('Repair damage corpus');
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/* ── the byte surgery ────────────────────────────────────────────────────── */

/** Splice `replacement` over `[from, to)` of `bytes`, leaving the rest untouched. */
function splice(bytes: Uint8Array, from: number, to: number, replacement: string | Uint8Array): Uint8Array {
  const part = typeof replacement === 'string' ? encode(replacement) : replacement;
  return new Uint8Array(Buffer.concat([Buffer.from(bytes.subarray(0, from)), Buffer.from(part), Buffer.from(bytes.subarray(to))]));
}

interface LocatedStream {
  number: number;
  dict: string;
  payloadStart: number;
  payloadEnd: number;
  lengthStart: number;
  lengthEnd: number;
}

/**
 * Every stream object in the file, with its payload's byte range.
 *
 * Walked object by object: matching the token `stream` across the whole file finds
 * `/XRefStm`, a `stream` inside a payload, and the `endstream` keyword itself, and
 * a "damage" written against the wrong byte range damages the fixture rather than
 * the file.
 */
function locateStreams(text: string): LocatedStream[] {
  const found: LocatedStream[] = [];
  const header = /(?:^|[\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  let match = header.exec(text);
  while (match !== null) {
    const number = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endObj = text.indexOf('endobj', bodyStart);
    if (endObj < 0) break;
    const streamAt = text.indexOf('stream', bodyStart);
    if (streamAt >= 0 && streamAt < endObj && /[\r\n]/.test(text[streamAt + 6] ?? '')) {
      let payloadStart = streamAt + 6;
      if (text[payloadStart] === '\r') payloadStart += 1;
      payloadStart += 1; // past the single LF that ends the `stream` keyword line
      const payloadEnd = text.indexOf('endstream', payloadStart);
      const dict = text.slice(bodyStart, streamAt);
      const lengthAt = dict.lastIndexOf('/Length');
      let lengthStart = -1;
      let lengthEnd = -1;
      if (lengthAt >= 0) {
        let at = lengthAt + '/Length'.length;
        while (at < dict.length && /\s/.test(dict[at])) at += 1;
        lengthStart = bodyStart + at;
        while (at < dict.length && /\d/.test(dict[at])) at += 1;
        lengthEnd = bodyStart + at;
      }
      found.push({ number, dict, payloadStart, payloadEnd, lengthStart, lengthEnd });
    }
    header.lastIndex = endObj;
    match = header.exec(text);
  }
  return found;
}

/** Replace one stream's payload, keeping its `/Length` truthful for the new bytes. */
function rewriteStream(
  bytes: Uint8Array,
  pick: (candidate: LocatedStream) => boolean,
  edit: (payload: Uint8Array, dict: string) => Uint8Array,
): Uint8Array {
  const where = locateStreams(decode(bytes)).filter((item) => item.payloadEnd > 0 && pick(item))[0];
  if (!where) throw new Error('the base does not hold the stream this damage needs');
  const next = edit(bytes.subarray(where.payloadStart, where.payloadEnd), where.dict);
  if (where.lengthStart < 0) throw new Error('the chosen stream has no plain /Length');
  const step1 = splice(bytes, where.payloadStart, where.payloadEnd, next);
  return splice(step1, where.lengthStart, where.lengthEnd, String(next.length));
}

const isPageContent = (dict: string): boolean =>
  /\/FlateDecode/.test(dict) && !/\/ObjStm|\/XRef|\/FontFile|\/Image|\/Metadata/.test(dict);

/* ── the cases ───────────────────────────────────────────────────────────── */

export const DAMAGE_CASES: DamageCase[] = [
  {
    id: 'truncated-tail',
    base: 'classic',
    breaks: 'the tail of the file: 45 % of the bytes, the index and the last objects',
    expect: { inputPages: 4, inputSheetsWithWords: 2, repairedPages: 2, repairedSheetsWithWords: 1, repairedBlankSheets: 1, mustProduce: true },
    apply: (base) => base.subarray(0, Math.floor(base.byteLength * 0.55)),
  },
  {
    id: 'lying-xref',
    base: 'classic',
    breaks: 'the `/xref` table: every offset names a byte three past its object',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      const at = text.indexOf('\nxref\n');
      if (at < 0) throw new Error('the classic base has no /xref table');
      const tableStart = at + 1;
      const trailerAt = text.indexOf('trailer', tableStart);
      const table = text.slice(tableStart, trailerAt);
      const broken = table.replace(/^(\d{10}) 00000 n/gm, (_all, offset: string) => {
        const value = Number(offset);
        return value === 0 ? '0000000000 00000 n' : `${String(value + 3).padStart(10, '0')} 00000 n`;
      });
      if (broken === table) throw new Error('the /xref table held no in-use entries');
      return splice(base, tableStart, trailerAt, broken);
    },
  },
  {
    id: 'missing-startxref',
    base: 'classic',
    breaks: 'the `startxref` pointer: the index is in the file and nothing points at it',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      const at = text.lastIndexOf('startxref');
      if (at < 0) throw new Error('the classic base has no startxref');
      return splice(base, at, text.indexOf('%%EOF', at), '');
    },
  },
  {
    id: 'objstm-wrong-offsets',
    base: 'object-streams',
    breaks: 'an `/ObjStm` header: every object offset inside the stream is four past its object',
    expect: { inputPages: 4, inputSheetsWithWords: 0, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => rewriteStream(base, (item) => /\/Type\s*\/ObjStm/.test(item.dict), (payload, dict) => {
      const declared = Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? 0);
      const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? -1);
      if (!declared || first < 0) throw new Error('the object stream names no /N + /First pair');
      const body = Buffer.from(inflateSync(Buffer.from(payload))).toString('latin1');
      const pairs = body.slice(0, first).trim().split(/\s+/).map(Number);
      if (pairs.length < declared * 2) {
        throw new Error(`/ObjStm header holds ${pairs.length} numbers, /N says ${declared}`);
      }
      const shifted = pairs.map((value, index) => (index % 2 === 0 ? value : value + 4));
      return new Uint8Array(deflateSync(encode(`${shifted.join(' ')}\n${body.slice(first)}`)));
    }),
  },
  {
    id: 'duplicate-endobj',
    base: 'classic',
    breaks: 'one object carries a second `endobj`, so a token that closes it sits before the next',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      const at = text.indexOf('endobj');
      if (at < 0) throw new Error('the classic base has no endobj');
      return splice(base, at + 'endobj'.length, at + 'endobj'.length, '\nendobj');
    },
  },
  {
    id: 'missing-endobj',
    base: 'classic',
    breaks: 'one object’s `endobj` is gone, so its successor opens inside it',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      const at = text.indexOf('endobj');
      if (at < 0) throw new Error('the classic base has no endobj');
      return splice(base, at, at + 'endobj'.length, '');
    },
  },
  {
    id: 'garbage-dict-midstream',
    base: 'classic',
    breaks: 'sheet 2’s content stream: a half-written dictionary between two operators',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      let seen = 0;
      return rewriteStream(base, (item) => isPageContent(item.dict) && ++seen === 2, (payload) => {
        const body = Buffer.from(inflateSync(Buffer.from(payload))).toString('latin1');
        if (!body.includes('BT')) throw new Error('the chosen stream is not a page content stream');
        const cut = Math.floor(body.length / 2);
        const planted = ' << /Fbar (unclosed >> Bz ';
        return new Uint8Array(deflateSync(encode(`${body.slice(0, cut)}${planted}${body.slice(cut)}`)));
      });
    },
  },
  {
    id: 'triage-report',
    base: 'classic',
    breaks: 'the shape `docs/TOOL-TRIAGE.md` §2 met: a comment after the header, the tail cut, `%%EOF` shortened',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      return encode(`${text.slice(0, 12)}\n% damaged by triage\n${text.slice(12, text.length - 40)}\n%%EO\n`);
    },
  },
  {
    /**
     * The same edit on the plaintext-content base, which is the case that produced
     * the ledger's headline number: the index is unreadable **and** the byte
     * harvest finds streams, so the tool used to answer with a sheet of extracted
     * content and print "1 page(s) readable" — a partial read described as a
     * repair, with pages and words both gone from the report.
     */
    id: 'plain-content-tailcut',
    base: 'plain',
    breaks: 'the index of a plaintext-content file, so only the byte harvest can read it at all',
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedPages: 4, repairedSheetsWithWords: 4, repairedBlankSheets: 0, mustProduce: true },
    apply: (base) => {
      const text = decode(base);
      return encode(`${text.slice(0, 12)}\n% damaged by triage\n${text.slice(12, text.length - 40)}\n%%EO\n`);
    },
  },
];

/** The corpus: every case applied to its base, with the healthy document beside it. */
export async function buildDamageCorpus(): Promise<{
  bases: { name: string; bytes: Uint8Array }[];
  cases: { name: string; bytes: Uint8Array; case: DamageCase }[];
}> {
  const classic = await damageBase(false);
  const streams = await damageBase(true);
  const plain = await damageBasePlain();
  const byBase = { classic, 'object-streams': streams, plain };
  return {
    bases: [
      { name: 'base.pdf', bytes: classic },
      { name: 'base-objstm.pdf', bytes: streams },
      { name: 'base-plain.pdf', bytes: plain },
    ],
    cases: DAMAGE_CASES.map((item) => ({
      name: `${item.id}.pdf`,
      bytes: item.apply(byBase[item.base]),
      case: item,
    })),
  };
}
