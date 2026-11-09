/**
 * The `encrypted-inputs` rig: what this app *believes* about a PDF that a real
 * encryptor locked, and what its routine operations hand back.
 *
 * Inputs come from `docs/research/encrypted-inputs-fixtures.py`, which writes
 * them with qpdf (libqpdf) and MuPDF — never with the engine that reads them
 * here — and records each file's object census as an outside reader sees it.
 * This file asserts no number. It answers, per fixture, the questions
 * `docs/TOOL-CAMPAIGN.md`'s `encrypted-inputs` row is made of, and dumps every
 * produced file into `<dir>/out/` for `docs/research/encrypted-inputs-readers.py`
 * to judge with readers that share no code with this app.
 *
 *   python3 docs/research/encrypted-inputs-fixtures.py /tmp/einp
 *   ENCRYPTED_INPUTS_DIR=/tmp/einp npx vitest run \
 *     --config docs/research/encrypted-inputs.vitest.config.ts | tee docs/research/encrypted-inputs-app.log
 *   python3 docs/research/encrypted-inputs-readers.py /tmp/einp | tee docs/research/encrypted-inputs-readers.log
 *
 * Probes, in order:
 *   1 `gate: no password`      — does the app ask, and what does it claim first?
 *   2 `gate: user password`    — does the right one work?
 *   3 `gate: owner password`   — the other lock; conflating them is a defect (E4/E5)
 *   4 `gate: wrong password`   — does a wrong one fail *clearly*?
 *   5 `tool asks without one`  — the refusal a routine run gets, and `isPasswordRequired`
 *   6 `page count`             — the app's number against MuPDF's
 *   7 `preview (pdf.js)`       — pages, extracted words, and the operators pdf.js's
 *                                interpreter produced for sheet 1 (jsdom has no 2-D
 *                                raster, so draw calls stand in for ink; see
 *                                `encrypted-inputs-canvas.ts`)
 *   8 `thumbnail (core/render)`— the shipped `thumbnails()` over the same document
 *   9 `census (engine)`        — what the editing engine counts, beside what MuPDF counts
 *  10 `after rotate` / `after delete page 2` / `after protect again` — the three
 *     routine operations, each with the output's own gate, preview, engine census
 *     and the runner's warnings — or, since the ciphered-input guard, the refusal
 *     that stands in for the file and the sentence that explains it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PDFArray,
  PDFCheckBox,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFTextField,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { inspectPdf, isPasswordRequired } from '@/lib/pdf/core/guard';
import { openRender, thumbnails } from '@/lib/pdf/core/render';
import { annotationCount } from '@/lib/pdf/core/annotations';
import { listAttachments } from '@/lib/pdf/core/attachments';
import { readOutline } from '@/lib/pdf/core/bookmarks';
import { createRecorder, drawSummary, installCanvas } from './encrypted-inputs-canvas';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const DIR = process.env.ENCRYPTED_INPUTS_DIR ?? '';
const OUT_DIR = DIR ? path.join(DIR, 'out') : '';

/** The password this rig sets when it asks `protect` to lock a file again. */
const AGAIN_USER = 'again-pass';

interface Census {
  pages?: number;
  annots?: number;
  annots_entries?: number;
  fields?: number;
  field_values?: string[];
  bookmarks?: number;
  attachments?: string[];
  planted_pages?: number;
  sheet_words?: string[];
  ink_page1_percent?: number;
  page1_excerpt?: string;
}

interface ManifestFixture {
  file: string;
  kind: string;
  made_by: string;
  bytes: number;
  dictionary: Record<string, string>;
  census: Census | null;
  mupdf_cipher: string | null;
  qpdf: Record<string, unknown>;
}

interface Manifest {
  passwords: { user: string; owner: string; wrong: string };
  planted: { sentence: string; pages: number; sheet_words: string[] };
  base?: { census: Census };
  fixtures: ManifestFixture[];
}

let cached: Manifest | null = null;

/** The fixture script's manifest, read once: it owns the names and passwords here. */
function book(): Manifest {
  cached ??= JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as Manifest;
  return cached;
}

/**
 * pdf.js's own complaints, kept out of the transcript and reported per probe.
 *
 * A page of ciphertext under a `/FlateDecode` makes the interpreter say so
 * (`Unknown compression method in flate stream`, `Unknown command`, …) once per
 * stream, which is hundreds of lines over this many probes — so they are counted
 * by kind and attached to the probe that provoked them rather than printed.
 */
const complaints: string[] = [];

/**
 * Glyph-path failures are this environment, not the app: pdf.js has no standard
 * font data under jsdom, so every Helvetica character it paints logs one. The
 * complaints worth recording are the stream-level ones — a ciphertext content
 * stream under a `/FlateDecode` is what `Unknown compression method` means.
 */
const ENVIRONMENT_NOISE = /getPathGenerator|Ignoring width table|Cannot polyfill|font loading/;

function installComplaintCollector(): void {
  for (const method of ['warn', 'log'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
      if (!text.startsWith('Warning:')) original(...args);
      else if (!ENVIRONMENT_NOISE.test(text)) complaints.push(text.slice(8, 140).trim());
    };
  }
}

/** The complaints raised since `from`, collapsed to `3× kind` per distinct text. */
function complaintsSince(from: number): string {
  const seen = new Map<string, number>();
  for (const item of complaints.slice(from)) {
    // One key per *kind* of complaint: the byte values in a flate error differ
    // per stream and would otherwise read as a list of distinct failures.
    const kind = item.replace(/\d+/g, 'N').slice(0, 72);
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
  }
  if (!seen.size) return '(none)';
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([text, count]) => `${count}× ${text}`)
    .join(' · ');
}

beforeAll(() => {
  installComplaintCollector();
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
  installCanvas(createRecorder());
  if (OUT_DIR) mkdirSync(OUT_DIR, { recursive: true });
});

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob; name: string }[];
  message?: string;
  warnings: string[];
  pagesOut: number | null;
}

async function run(id: string, values: ToolValues, file: File, password?: string): Promise<RunOutcome> {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  return (await runPdfTool({
    toolId: id, files: [file], values, password, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

/**
 * pdf.js's own view of a file: pages, the words it can pull out, what it would
 * paint, and the drawing calls its renderer issued into the recording canvas.
 */
async function preview(bytes: Uint8Array, password?: string) {
  const recorder = createRecorder();
  installCanvas(recorder);
  const since = complaints.length;
  const session = await openRender(bytes, password ? { password } : {});
  try {
    const pages = session.numPages;
    const texts: string[] = [];
    for (let page = 1; page <= pages; page++) {
      texts.push((await session.textItems(page)).map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim());
    }
    // The operator list is what the painter consumes: an undecipherable content
    // stream yields no operators, so the count separates "nothing to draw" from
    // "a page to draw" without a raster.
    const proxy = await session.doc.getPage(1);
    const list = await proxy.getOperatorList();
    proxy.cleanup();
    // …and this is the shipped paint path itself: `renderToCanvas` on a detached
    // canvas, settled, so the recorder sees what a preview would have asked for.
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 280;
    await session.renderToCanvas(1, canvas, 0.3);
    return {
      pages,
      text: texts.join(' | '),
      ops: list.fnArray.length,
      draws: drawSummary(recorder),
      noise: complaintsSince(since),
    };
  } finally {
    await session.destroy();
  }
}

/** The app's own thumbnail strip, over the same document. */
async function thumbnail(bytes: Uint8Array, password?: string): Promise<string> {
  const recorder = createRecorder();
  installCanvas(recorder);
  const session = await openRender(bytes, password ? { password } : {});
  try {
    const urls = await thumbnails(session, { maxSide: 96, pages: [1] });
    const url = urls[0] ?? '';
    const payload = url.startsWith('data:') ? atob(url.slice(url.indexOf(',') + 1)) : '(empty)';
    return `pages=${session.numPages} url=${url ? `${url.length} bytes ${payload}` : '(none)'} draws: ${drawSummary(recorder)}`;
  } finally {
    await session.destroy();
  }
}

/** The head of a page's content stream: `78 …` is flate, anything else is cipher. */
function headOf(doc: PDFDocument, pageOne: number): string {
  const value = doc.getPages()[pageOne - 1]?.node.get(PDFName.of('Contents'));
  if (!value) return '(no /Contents)';
  const first = value instanceof PDFArray ? value.get(0) : value;
  const resolved = first instanceof PDFRef ? doc.context.lookup(first) : first;
  if (!(resolved instanceof PDFRawStream)) return `${value.constructor.name}, not a stream`;
  const head = Array.from(resolved.getContents()).slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
  const filter = resolved.dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.decodeText() ?? '';
  // A zlib stream is `78` plus one of the four legal check bytes; only the first
  // two are ever meaningful, and a head is four bytes wide.
  const plain = /^78 (01|5e|9c|da)\b/.test(head);
  return `${head} /Filter /${filter} — ${plain ? 'flate, so the engine holds plaintext' : 'ciphertext behind its own /Filter'}`;
}

/**
 * The object census the *engine* takes of a document it opened with a password —
 * the same helpers `protect` uses for its before/after claim. `truth` is the
 * census MuPDF took of the same bytes in the fixture script.
 */
async function engineCensus(bytes: Uint8Array, password?: string) {
  const doc = await PDFDocument.load(bytes, {
    ...(password ? { password } : {}),
    // A password is an instruction to decrypt; without one, read the structure.
    ignoreEncryption: !password,
    updateMetadata: false,
  });
  let annotsEntries = 0;
  for (const page of doc.getPages()) {
    const value = page.node.get(PDFName.of('Annots'));
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (resolved instanceof PDFArray) annotsEntries += resolved.size();
  }
  const form = doc.getForm();
  const values = form.getFields().map((field) => (
    field instanceof PDFTextField ? field.getText() : field instanceof PDFCheckBox && field.isChecked() ? 'checked' : ''
  ));
  return {
    pages: doc.getPageCount(),
    annotations: annotationCount(doc),
    annotsEntries,
    fields: form.getFields().length,
    fieldValues: values.sort(),
    bookmarks: readOutline(doc).length,
    attachments: listAttachments(doc).map((file) => file.name).sort(),
    firstBytes: headOf(doc, 1),
  };
}

function engineLine(counted: Awaited<ReturnType<typeof engineCensus>>): string {
  return `engine pages=${counted.pages} annots=${counted.annotations}/entries ${counted.annotsEntries} `
    + `fields=${counted.fields} [${counted.fieldValues.map((value) => JSON.stringify(value)).join(', ')}] `
    + `bookmarks=${counted.bookmarks} attachments=[${counted.attachments.join(', ')}]`;
}

function mupdfLine(truth: Census | null | undefined): string {
  return `MuPDF   pages=${truth?.pages} annots=${truth?.annots}/entries ${truth?.annots_entries} `
    + `fields=${truth?.fields} [${(truth?.field_values ?? []).join(', ')}] `
    + `bookmarks=${truth?.bookmarks} attachments=[${(truth?.attachments ?? []).join(', ')}]`;
}

/**
 * Every number a produced file is asked for, from this app's own modules.
 *
 * Each question is asked on its own here too, for the same reason the fixtures
 * are: a file that makes pdf.js throw while the tool that wrote it succeeded is a
 * different finding from a tool that produced nothing, and one unguarded `await`
 * would collapse the two into the same line.
 */
async function describeOutput(bytes: Uint8Array, name: string, opener?: string) {
  const ask = async (of: () => Promise<string>) => {
    try {
      return await of();
    } catch (error) {
      return `this probe throws ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  };
  const claims = await ask(async () => {
    const seen = await inspectPdf(bytes, name, opener ? { password: opener } : {});
    return `encrypted=${seen.encrypted} algorithm=${seen.algorithm ?? '—'} `
      + `needsPassword=${seen.needsPassword} opensEmpty=${seen.opensWithEmptyPassword} `
      + `pages=${seen.pages} /P=${seen.permissions?.raw ?? '—'} accepted=${seen.passwordAccepted} `
      + `error=${seen.error ?? '—'} · "${seen.message}"`;
  });
  // Which secret the output answers to, from the app's own point of view: the
  // ruling under test is that a routine edit keeps a locked file locked, and
  // "still encrypted" is not that claim — the password the user holds opening it is.
  const source = book();
  const gates = await ask(async () => {
    const parts: string[] = [];
    for (const [label, secret] of [
      ['none', undefined],
      ['user', source.passwords.user],
      ['owner', source.passwords.owner],
      ['again', AGAIN_USER],
    ] as const) {
      const probe = await inspectPdf(bytes, name, secret ? { password: secret } : {});
      parts.push(`${label}:${probe.passwordAccepted ? 'opens' : (probe.error ?? 'no')}`);
    }
    return parts.join(' ');
  });
  const seen = await ask(async () => {
    const open = await preview(bytes, opener);
    return `pdf.js pages=${open.pages} ops=${open.ops} text="${open.text.slice(0, 70)}"\n       `
      + `draws ${open.draws} · pdf.js said: ${open.noise}`;
  });
  const counted = await ask(async () => {
    const census = await engineCensus(bytes, opener);
    return `${engineLine(census)} · page 1: ${census.firstBytes}`;
  });
  return [`claims ${claims}`, `gate (this app): ${gates}`, seen, counted].join('\n       ');
}

const OPS: { id: string; label: string; values: ToolValues; reopensWith: 'source' | 'again' }[] = [
  { id: 'rotate', label: 'rotate', values: { degrees: 90 }, reopensWith: 'source' },
  { id: 'remove-pages', label: 'delete page 2', values: { pages: '2' }, reopensWith: 'source' },
  {
    id: 'protect',
    label: 'protect again',
    values: {
      mode: 'both',
      userPassword: AGAIN_USER,
      ownerPassword: 'again-owner',
      allowPrinting: false,
      printLevel: 'low',
      allowModifying: false,
      allowCopying: false,
      allowAnnotating: false,
      allowFillingForms: false,
      allowAccessibility: true,
      allowAssembling: false,
    },
    reopensWith: 'again',
  },
];

describe.skipIf(!DIR)('what this app believes about files a real encryptor locked', () => {
  it('answers every gate, preview and routine-operation probe for every fixture', async () => {
    const source = book();
    const rows: Record<string, string>[] = [];
    // The transcript is written as a file as well as logged: vitest's default
    // reporter swallows stdout, and a measurement nobody can re-read is anecdote.
    const transcripts: string[] = [];

    /**
     * Every question, asked of one document.
     *
     * `truth` is the census MuPDF took of it — from the manifest for a fixture,
     * from `base.pdf` for this app's own protected file, which is the control the
     * `rotate` ruling needs: the tests that assert it lock a file this engine
     * wrote, so "the password still opens it" may only be pdf-lib reading its own
     * output back.
     */
    const probe = async (file: string, bytes: Uint8Array, keyed: string, madeBy: string, kind: string, truth: Census | null) => {
      const locked = kind === 'user-password';
      const row: Record<string, string> = {
        fixture: `${file}  [${madeBy} · ${kind}${locked ? ` · ${source.passwords.user ? 'user password supplied' : ''}` : ''}]`,
      };
      // Each question is asked on its own: "the second step threw" is itself one
      // of the numbers this row exists to record.
      const step = async (name: string, ask: () => Promise<string>) => {
        try {
          row[name] = await ask();
        } catch (error) {
          // Where it died matters as much as the sentence: a `ToolInputError` from
          // the gate is an explained refusal, a parser error from the engine is a
          // crash the user sees as a red banner.
          const stack = (error instanceof Error ? error.stack ?? '' : '')
            .split('\n').slice(1, 4)
            .map((frame) => frame.trim().replace(/\?\?.*/, '').replace(/^at /, ''))
            .filter(Boolean).join(' ← ');
          row[name] = `throws ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
            + (stack ? `\n       at: ${stack.slice(0, 220)}` : '');
        }
      };

      await step('gate: no password', async () => {
        const blind = await inspectPdf(bytes, file);
        return `encrypted=${blind.encrypted} needsPassword=${blind.needsPassword} `
          + `opensEmpty=${blind.opensWithEmptyPassword} algorithm=${blind.algorithm ?? '—'} `
          + `pages=${blind.pages} /P=${blind.permissions?.raw ?? '—'} error=${blind.error ?? '—'} · "${blind.message}"`;
      });
      await step('gate: user password', async () => {
        const opened = await inspectPdf(bytes, file, { password: keyed });
        return `accepted=${opened.passwordAccepted} pages=${opened.pages} error=${opened.error ?? '—'} · "${opened.message}"`;
      });
      await step('gate: owner password', async () => {
        const owner = await inspectPdf(bytes, file, { password: source.passwords.owner });
        return `accepted=${owner.passwordAccepted} pages=${owner.pages} error=${owner.error ?? '—'}`;
      });
      await step('gate: wrong password', async () => {
        const wrong = await inspectPdf(bytes, file, { password: source.passwords.wrong });
        return `accepted=${wrong.passwordAccepted} pages=${wrong.pages} error=${wrong.error ?? '—'} · "${wrong.message}"`;
      });
      await step('tool asks without one', async () => {
        try {
          const outcome = await run('rotate', { degrees: 90 }, pdfFile(bytes, file));
          return `ran with no password at all (nothing was asked); warnings=${JSON.stringify(outcome.warnings)}`;
        } catch (error) {
          const code = (error as { code?: string }).code ?? '—';
          return `refused: ${code} isPasswordRequired=${isPasswordRequired(error)} · "${(error as Error).message}"`;
        }
      });
      await step('page count', async () => {
        const app = await inspectPdf(bytes, file, { password: keyed });
        return `app=${app.pages} MuPDF=${truth?.pages}`;
      });
      await step('preview (pdf.js)', async () => {
        const seen = await preview(bytes, keyed || undefined);
        return `pages=${seen.pages} ops=${seen.ops} text="${seen.text.slice(0, 78)}"\n       draws: ${seen.draws}\n       pdf.js said: ${seen.noise}`;
      });
      await step('thumbnail (core/render)', () => thumbnail(bytes, keyed || undefined));
      await step('census (engine)', async () => {
        const counted = await engineCensus(bytes, keyed || undefined);
        return `${engineLine(counted)} · page 1: ${counted.firstBytes}\n       ${mupdfLine(truth)}`;
      });

      for (const op of OPS) {
        await step(`after ${op.label}`, async () => {
          /**
           * A refusal is one of the answers this row exists to record.
           *
           * Since the `encrypted-inputs` guard, a fixture whose crypt filter names
           * a real cipher is refused before any work, so the row reads `refused:
           * UNSUPPORTED …` with the sentence the user sees instead of the
           * `dumped: out/…` line of a file the readers would go on to judge. Both
           * are recorded here: "produced nothing, and said why" is a different
           * finding from "produced a file", and it is the finding the guard is for.
           */
          const outcome = await run(op.id, op.values, pdfFile(bytes, file), keyed || undefined)
            .then((ran) => ran, (error: unknown) => {
              const coded = error as { code?: string; hint?: string; passwordRequired?: boolean };
              return `refused: ${coded.code ?? '—'} isPasswordRequired=${isPasswordRequired(error)} `
                + `· "${(error as Error).message}"\n       hint: ${JSON.stringify(coded.hint ?? '—')}`;
            });
          if (typeof outcome === 'string') return outcome;
          const produced = await bytesOf(outcome);
          const name = `${file.replace(/\.pdf$/, '')}--${op.id}.pdf`;
          writeFileSync(path.join(OUT_DIR, name), produced);
          const opener = op.reopensWith === 'again' ? AGAIN_USER : keyed || undefined;
          const described = await describeOutput(produced, op.id, opener);
          return `${described}\n       runner: pagesOut=${outcome.pagesOut} warnings=${JSON.stringify(outcome.warnings)}\n`
            + `       message: "${(outcome.message ?? '').slice(0, 130)}"\n`
            + `       ${mupdfLine(truth)} (the file the operation started from)\n`
            + `       dumped: out/${name}`;
        });
      }

      rows.push(row);
      const transcript = [`### ${row.fixture}`,
        ...Object.entries(row).filter(([key]) => key !== 'fixture').map(([key, value]) => `  ${key}: ${value}`),
      ].join('\n');
      console.log(`\n${transcript}`);
      transcripts.push(transcript);
    };

    for (const fixture of source.fixtures) {
      const bytes = new Uint8Array(readFileSync(path.join(DIR, fixture.file)));
      const keyed = fixture.kind === 'user-password' ? source.passwords.user : '';
      await probe(fixture.file, bytes, keyed, `${fixture.made_by} (outside)`, fixture.kind, fixture.census);
    }

    // The unencrypted control: the same document before anyone locked it. Anything
    // this app mis-reads here — a nested bookmark, a name-tree attachment — is a
    // helper gap and not an effect of the cipher, and the two must not be blamed
    // on each other in the table above.
    const baseBytes = new Uint8Array(readFileSync(path.join(DIR, 'base.pdf')));
    await probe('base.pdf', baseBytes, '', 'MuPDF (unencrypted control)', 'no-password', source.base?.census ?? null);

    // The control that answers the ruling's own question: the same document locked
    // by *this app*, asked the same questions.
    const own = await run('protect', {
      ...OPS[2].values,
      userPassword: source.passwords.user,
      ownerPassword: source.passwords.owner,
    }, pdfFile(baseBytes, 'base.pdf'));
    const ownBytes = await bytesOf(own);
    writeFileSync(path.join(OUT_DIR, 'own-protected.pdf'), ownBytes);
    await probe('own-protected.pdf', ownBytes, source.passwords.user, 'this app (protect)', 'user-password', source.base?.census ?? null);

    // Every fixture, plus the two controls this app and MuPDF wrote.
    expect(rows.length).toBe(source.fixtures.length + 2);

    /**
     * The guard's acceptance criterion, counted on the files rather than read out
     * of a message: every fixture locked by an outside tool with a real crypt
     * filter produced **no** rewritten file (it was refused), and both controls —
     * the unlocked document and this app's own `/None` gate — still produced all
     * three. Before the guard this was 18 produced files, 18 of them judged
     * `silent-loss` by five readers; see `encrypted-inputs-findings.md` §3 for the
     * pre-guard logs, kept beside this file as `*-pre-guard.log`.
     */
    const dumped = readdirSync(OUT_DIR).filter((entry) => entry.endsWith('.pdf'));
    for (const fixture of source.fixtures) {
      const stem = fixture.file.replace(/\.pdf$/, '');
      expect(dumped.filter((entry) => entry.startsWith(`${stem}--`)), `${fixture.file} was rewritten`).toEqual([]);
    }
    for (const control of ['base', 'own-protected']) {
      for (const op of OPS) {
        expect(dumped, `${control} produced no ${op.id} output`).toContain(`${control}--${op.id}.pdf`);
      }
    }
    writeFileSync(path.join(DIR, 'app-claims.json'), `${JSON.stringify(rows, null, 1)}\n`);
    writeFileSync(path.join(DIR, 'app-probe.log'), `${transcripts.join('\n\n')}\n`);
  }, 900_000);
});
