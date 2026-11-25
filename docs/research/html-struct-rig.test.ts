/**
 * The `html-to-pdf` structure-and-markup rig.
 *
 * The HTML card promises "Document structure — headings, paragraphs, lists, tables,
 * inline styles and data-URL images — as selectable text", plus four scope sentences
 * (detached parse, no CSS layout engine, no print CSS, `data:` images only). Each
 * case writes its PDF plus the sentence and the warnings the run produced, and
 * `md-struct-measure.py` (the same reader, pointed at this directory) judges the
 * sheets with MuPDF: run position, size and font, `/Annots` and links, placed
 * images, drawn rules, ink inside every code band, and the marker gutter.
 *
 * The fixtures are the ones the campaign keeps finding unanswered: entity forms
 * (named, numeric, hexadecimal, invalid, unknown), comments including a multi-line
 * one, a `<style>` rule a class actually uses, inline `style=` attributes against
 * the card's promise, `<pre>` and `<br>` whitespace, tab-delimited content, the
 * image skip-count, malformed markup against the leniency a detached DOMParser
 * really has, and a document whose only content is a script.
 *
 *   npx vitest run --config docs/research/html-struct.vitest.config.ts
 *   python3 docs/research/md-struct-measure.py /tmp/htmlstruct before-fix \
 *     | tee docs/research/html-struct-before.txt
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  restoreConvertToEnv,
  run,
  textRuns,
} from '../../tests/pdf/convert-to-harness';

const DIR = '/tmp/htmlstruct';
const PNG_1PX_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

interface Case {
  label: string;
  html: string;
  values?: Record<string, unknown>;
}

const cases: Case[] = [
  { label: 'headings', html: '<h1>H1 MKSTART</h1><h2>H2</h2><h3>H3</h3><h4>H4</h4><h5>H5</h5><h6>H6 MKEND</h6><p>body paragraph</p>' },
  { label: 'nest-list', html: '<ul><li>level one alpha<ul><li>level two bravo<ul><li>level three charlie</li></ul></li></ul></li><li>level one echo MKEND</li></ul>' },
  { label: 'ol-start', html: '<p>MKSTART</p><ol start="5"><li>five</li><li>six</li><li>seven MKEND</li></ol>' },
  { label: 'ol-twelve', html: `<p>MKSTART</p><ol>${Array.from({ length: 12 }, (_, i) => `<li>step ${i + 1} of the guide</li>`).join('')}</ol><p>MKEND</p>` },
  { label: 'table-span', html: '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td colspan="2">MKSTART merged cell</td></tr><tr><td>Widget</td><td>3 MKEND</td></tr></tbody></table>' },
  { label: 'entities', html: '<p>MKSTART A&amp;B &copy; &#8212; &#x41; &#65; &#; &bareword; &lt;tag&gt; &nbsp;x MKEND</p>' },
  { label: 'comment', html: '<p>MKSTART visible <!-- a hidden note --> text MKEND</p>' },
  { label: 'comment-multi', html: '<p>MKSTART visible</p>\n<!-- opened here\nstill a comment\n--> \n<p>after the comment MKEND</p>' },
  { label: 'style-attr', html: '<p>MKSTART <span style="color:#ff0000;font-size:24px">styled words</span> <b>bold</b> <i>italic</i> <u>under</u> <s>struck</s> <big>big</big> <small>small</small> MKEND</p>' },
  { label: 'css-class', html: '<head><style>.big{font-size:30px;color:#00f}p{margin:0}</style></head><body><p class="big">MKSTART classed words MKEND</p></body>' },
  { label: 'pre', html: '<p>MKSTART</p><pre>first line\n  indented two\tdelimited\tfields\nlast MKEND</pre>' },
  { label: 'br-hr', html: '<p>MKSTART line one<br>line two<br/>line three MKEND</p><hr><p>after the rule</p>' },
  { label: 'scripts', html: '<p>MKSTART visible text MKEND</p><script>document.write("created by script")</script><script>var b = 2;</script>' },
  { label: 'malformed-unclosed', html: '<div><p>MKSTART an unclosed paragraph<div>nested div with no closing tags MKEND' },
  { label: 'malformed-stray', html: '<p>MKSTART words</p></div></span><<<p>>weird> MKEND' },
  { label: 'malformed-implicit', html: '<ul><li>MKSTART first item<li>second item<li>third item MKEND</ul>' },
  { label: 'empty-body', html: '<html><head><title>Only a title</title><meta charset="utf-8"></head><body></body></html>' },
  { label: 'script-only', html: '<html><body><div id="app"></div><script>document.getElementById("app").textContent="built at runtime"</script></body></html>' },
  { label: 'plain-words', html: 'MKSTART just plain words with no markup at all MKEND\nsecond line\n' },
  { label: 'img-mixed', html: `<p>MKSTART</p><img src="${PNG_1PX_DATA}" alt="a red pixel"><img src="https://example.com/a.png" alt="first remote"><img src="https://example.com/b.png">img<p>text with an <img src="https://example.com/c.png" alt="inline pic"> inside MKEND</p>` },
  { label: 'img-off', html: `<p>MKSTART</p><img src="${PNG_1PX_DATA}" alt="a red pixel"><p>MKEND</p>`, values: { embedImages: false } },
  { label: 'links', html: '<p>MKSTART <a href="https://example.com/spec.html">the spec</a> and <a href="mailto:bob@example.com">mail</a> and <a name="anchor">named target</a> MKEND</p>' },
  { label: 'unicode', html: '<p>MKSTART 日本語のテキスト한국어 café naïve 😀 𠀀 ‏right-left‎ MKEND</p>' },
  { label: 'longword', html: '<p>MKSTART ' + 'supercalifragilistic'.repeat(150) + ' MKEND</p>' },
  {
    label: 'controls-large',
    html: '<h1>Heading MKSTART</h1><p>Body paragraph, long enough to wrap onto a second line of its own when it reaches the margin of the page.</p><ul><li>first bullet</li></ul><p>MKEND</p>',
    values: { fontSize: 18, lineHeight: 2.2, pageNumbers: true },
  },
  {
    label: 'controls-small',
    html: '<h1>Heading MKSTART</h1><p>Body paragraph, long enough to wrap onto a second line of its own when it reaches the margin of the page.</p><ul><li>first bullet</li></ul><p>MKEND</p>',
    values: { fontSize: 8, lineHeight: 1.1, pageNumbers: false },
  },
];

let inner: typeof fetch;
let fetched: string[];

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  installConvertToEnv();
  inner = globalThis.fetch;
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith('data:')) fetched.push(url);
    return inner(input as never);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = inner;
  restoreConvertToEnv();
});

describe('html structure', () => {
  it('writes one PDF per fixture with what the run said', { timeout: 300_000 }, async () => {
    for (const testCase of cases) {
      fetched = [];
      let message = '';
      let warnings: string[] = [];
      let bytes = new Uint8Array(0);
      try {
        const outcome = await run('html-to-pdf', testCase.values ?? {}, [fileFrom(testCase.html, 'doc.html', 'text/html')]);
        bytes = await firstPdf(outcome);
        message = String(outcome.message);
        warnings = outcome.warnings ?? [];
      } catch (error) {
        message = `REFUSED: ${(error as Error).message}`;
      }
      const record: Record<string, unknown> = { label: testCase.label, values: testCase.values ?? {}, message, warnings, fetched: [...fetched] };
      if (bytes.length > 0) {
        writeFileSync(`${DIR}/${testCase.label}.pdf`, bytes);
        const runs = await textRuns(bytes);
        const sizes = await pageSizes(bytes);
        record.sheets = sizes.length;
        record.streamRuns = runs.length;
        record.runsOutsideBox = runs.filter((run) => {
          const [w, h] = sizes[run.page] ?? [595.28, 841.89];
          return run.x < 0 || run.y < 0 || run.x > w || run.y > h;
        }).length;
      }
      writeFileSync(`${DIR}/${testCase.label}.src.md`, testCase.html, 'utf8');
      writeFileSync(`${DIR}/${testCase.label}.json`, JSON.stringify(record, null, 2), 'utf8');
    }
  });
});
