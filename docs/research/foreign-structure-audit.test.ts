/**
 * The sweep: every reader that parses a structure **this app's writer also
 * produces**, run over a file it did not write.
 *
 * `docs/research/attachments-foreign-repro.md` closed one instance — a name-tree
 * reader that only recognised what pdf-lib emits, which is why
 * `extract-attachments` said "This PDF contains no embedded files" about a file that
 * has one (`docs/TOOL-TRIAGE.md` ERRORS 4). This rig asks the same question of the
 * five sibling readers named in that pass, over `tests/fixtures/foreign/` — one file
 * per structure, each written by MuPDF 1.28.2 or libqpdf 12.3.2 and re-verified by an
 * outside reader after the fixtures were frozen:
 *
 *   reader            structure            also written here by
 *   readOutline       /Outlines, /Dests    add-bookmarks, organise, the outline editor
 *   readPageLabels    /PageLabels          page-labels tool
 *   listLayers        /OCProperties        layer tools, removeHiddenLayerContent
 *   listFormFields    /AcroForm, widgets   fill-form, the form editors, flatten
 *   listAnnotations   /Annots              add-stamps, annotate, flatten, redact
 *   readInfo/readXmp  /Info, XMP           set-metadata, sanitize
 *   listAttachments   /EmbeddedFiles       add-attachments (reference case, now green)
 *
 * It reports; it fixes nothing. `docs/research/foreign-structure-audit.md` is the
 * table, and a shape this app cannot read is recorded there rather than quietly
 * widened into.
 *
 *   npx vitest run --config docs/research/foreign-structure.vitest.config.ts
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPDF } from '@/lib/pdf/core/doc';
import { listAttachments } from '@/lib/pdf/core/attachments';
import { listFormFields } from '@/lib/pdf/core/forms';
import { listLayers } from '@/lib/pdf/core/layers';
import { listAnnotations, annotationCount } from '@/lib/pdf/core/annotations';
import { readInfo, readXmp } from '@/lib/pdf/core/metadata';
import { readOutline, readPageLabels, type OutlineNode } from '@/lib/pdf/core/bookmarks';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/foreign');
const OUT = process.env.BROWSERSNIP_FOREIGN_AUDIT;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function countTree(nodes: OutlineNode[]): { top: number; all: number; depth: number } {
  let all = 0;
  let depth = 0;
  const walk = (list: OutlineNode[], level: number) => {
    for (const node of list) {
      all += 1;
      depth = Math.max(depth, level);
      if (node.children?.length) walk(node.children, level + 1);
    }
  };
  walk(nodes, 1);
  return { top: nodes.length, all, depth };
}

/** Every outline node with the page it resolved to, for the two `/Dests` rows. */
function outlinePages(doc: Awaited<ReturnType<typeof openPDF>>): string {
  const nodes = readOutline(doc);
  const unresolved = nodes.filter((node) => node.page === null).length;
  return `${nodes.length} node(s), ${unresolved} without a page: `
    + JSON.stringify(nodes.map((node) => ({ title: node.title, page: node.page })));
}

/** One row per fixture: what the file holds, and what this app's reader says. */
const CASES: {
  file: string;
  structure: string;
  reader: string;
  /** What an outside reader does with the same bytes, measured by hand per row. */
  outside: string;
  /** Anything the row needs to say that the two columns cannot carry. */
  note?: string;
  read: (doc: Awaited<ReturnType<typeof openPDF>>) => string;
}[] = [
  {
    file: 'outlines.pdf',
    structure: '/Outlines, 3 entries, one of them a child',
    reader: 'readOutline',
    outside: 'MuPDF get_toc(): 3 entries, 2 levels; pypdf 6.14.2 lists the same 3',
    read: (doc) => {
      const nodes = readOutline(doc);
      const { top, all, depth } = countTree(nodes);
      const titles = (list: OutlineNode[], level = 1): string =>
        list
          .map((node) => `${'  '.repeat(level - 1)}${node.title}${node.children?.length ? `\n${titles(node.children, level + 1)}` : ''}`)
          .join('\n');
      return `${all} node(s), ${top} at the top level, depth ${depth}:\n${titles(nodes)}`;
    },
  },
  {
    file: 'outlines-dests-flat-direct.pdf',
    structure: '/Dests /Names with the destination arrays written inline',
    reader: 'readOutline',
    outside: 'pypdf 6.14.2 resolves both to pages 1 and 2',
    read: outlinePages,
  },
  {
    file: 'outlines-dests-flat-ref.pdf',
    structure: '/Dests /Names with each destination behind a reference',
    reader: 'readOutline',
    outside: 'pypdf 6.14.2 resolves both to pages 1 and 2',
    read: outlinePages,
  },
  {
    file: 'outlines-dests-tree-ref.pdf',
    structure: 'a /Kids + /Limits /Dests tree, destinations behind references',
    reader: 'readOutline',
    outside: 'pypdf 6.14.2 walks the tree and resolves both to pages 1 and 2',
    read: outlinePages,
  },
  {
    file: 'page-labels.pdf',
    structure: '/PageLabels as a /Kids number tree (i-1, i-2 roman / arabic ranges)',
    reader: 'readPageLabels',
    outside: 'MuPDF get_page_labels(): 3 ranges — i-1 (decimal), 1..2 (upper roman), 3 (lower alpha)',
    read: (doc) => JSON.stringify(readPageLabels(doc).map((entry) => entry.label)),
  },
  {
    file: 'page-labels-flat.pdf',
    structure: '/PageLabels as a flat /Nums array — the control for the row above',
    reader: 'readPageLabels',
    outside: 'MuPDF get_page_labels(): the same three ranges as above',
    read: (doc) => JSON.stringify(readPageLabels(doc).map((entry) => entry.label)),
  },
  {
    file: 'layers.pdf',
    structure: 'two /OCGs, one on and one off, one drawn through',
    reader: 'listLayers',
    outside: 'MuPDF get_ocgs(): 2 groups',
    read: (doc) => {
      const layers = listLayers(doc);
      return `${layers.length} layer(s): ${JSON.stringify(layers.map((l) => ({ name: l.name, on: l.on })))}`;
    },
  },
  {
    file: 'annotations.pdf',
    structure: 'note + free-text + highlight + link on one page',
    reader: 'listAnnotations / annotationCount',
    outside: "MuPDF's annots() lists 3 (Text, FreeText, Highlight; it hides the link and the"
      + " pop-up); the raw /Annots array holds 5 entries",
    read: (doc) => {
      const marks = listAnnotations(doc);
      const kinds = marks.map((mark) => mark.kind);
      return `${marks.length} listed (count ${annotationCount(doc)}): ` + JSON.stringify(kinds);
    },
  },
  {
    file: 'form.pdf',
    structure: 'AcroForm with a text field and a checkbox',
    reader: 'listFormFields',
    outside: "MuPDF widgets(): ['answer', 'tick']; the file stores /V /Yes on `tick` and no /V on `answer`",
    read: (doc) => {
      const fields = listFormFields(doc);
      return `${fields.length} field(s): `
        + JSON.stringify(fields.map((f) => ({ name: f.name, type: f.type, value: f.value, checked: f.checked })));
    },
  },
  {
    file: 'metadata.pdf',
    structure: '/Info written by MuPDF, XMP packet written beside it',
    reader: 'readInfo / readXmp',
    outside: 'MuPDF metadata.title: "Foreign structures"',
    read: (doc) => {
      const info = readInfo(doc);
      const xmp = readXmp(doc);
      return `title=${JSON.stringify(info.title ?? null)} author=${JSON.stringify(info.author ?? null)} `
        + `props=${Object.keys(info).length} xmp=${xmp ? `${Object.keys(xmp).length} key(s)` : 'none'}`;
    },
  },
  {
    file: 'attachment.pdf',
    structure: 'enclosure MuPDF writes into the name tree (the reference case)',
    reader: 'listAttachments',
    outside: 'MuPDF embfile_names(): ["enclosure.txt"], poppler: 1 embedded file',
    read: (doc) => {
      const files = listAttachments(doc);
      return `${files.length} attachment(s): `
        + JSON.stringify(files.map((f) => ({ name: f.name, bytes: f.bytes.length, sha256: sha256(f.bytes).slice(0, 12) })));
    },
  },
];

describe('the other readers, over files they did not write', () => {
  it('reports one row per structure', async () => {
    const rows: string[] = [
      '| fixture | structure | reader | outside reader says | this app says |',
      '| --- | --- | --- | --- | --- |',
    ];
    const details: Record<string, string> = {};
    for (const testCase of CASES) {
      const bytes = new Uint8Array(readFileSync(resolve(FIXTURES, testCase.file)));
      const doc = await openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });
      let said: string;
      try {
        said = testCase.read(doc);
      } catch (error) {
        said = `threw ${(error as Error).message.slice(0, 90)}`;
      }
      details[testCase.file] = said;
      const verdict = `${said}${testCase.note ? `\n\n> ${testCase.note}` : ''}`;
      rows.push(`| \`${testCase.file}\` | ${testCase.structure} | \`${testCase.reader}\` | ${testCase.outside} | ${verdict} |`);
    }
    if (OUT) writeFileSync(OUT, `${rows.join('\n')}\n`);
    // Every fixture must at least parse: a row that says "threw" is a finding, and a
    // file the engine cannot open at all would make the whole table meaningless.
    for (const testCase of CASES) {
      expect(details[testCase.file], testCase.file).toBeTruthy();
      expect(details[testCase.file], testCase.file).not.toMatch(/^threw /);
    }
    console.log(rows.join('\n'));
  }, 120_000);
});
