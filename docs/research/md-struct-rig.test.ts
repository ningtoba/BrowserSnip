/**
 * The `markdown-to-pdf` structure rig.
 *
 * `text-tail-rig.test.ts` covers length; `txt-enc-rig.test.ts` covers the bytes a
 * text file is made of. This one asks the markdown question the campaign keeps
 * finding unanswered: is the *structure* the card promises still there in the
 * finished file? Every case writes its PDF plus the sentence and the warnings the
 * run produced, and `md-struct-measure.py` judges the sheets with MuPDF — font per
 * run, size, position, `/Annots`, `/Image`, drawn rules — against the markdown the
 * fixture started from:
 *
 *   - headings (ATX and setext), emphasis, strikethrough, inline code;
 *   - bullet, ordered and task lists, nesting, numbering across a page break;
 *   - tables: alignment rows, escaped pipes, a pipe inside a code span, ragged rows;
 *   - links (where did the URL go?), images (`data:` vs remote), `<br>`, hard breaks;
 *   - maths, footnotes and Mermaid, which the card says are not rendered;
 *   - entities, CJK, emoji and astral characters;
 *   - the six controls: font size, line height, columns, page numbers, header, footer.
 *
 * Nothing here asserts a number:
 *
 *   npx vitest run --config docs/research/md-struct.vitest.config.ts
 *   python3 docs/research/md-struct-measure.py /tmp/mdstruct before-fix \
 *     | tee docs/research/md-struct-before.txt
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

const DIR = '/tmp/mdstruct';

/** A 1×1 red PNG, for the data-URL image case. */
const RED_PNG = `data:image/png;base64,${Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
).toString('base64')}`;

const LONG_ROWS = Array.from({ length: 40 }, (_, i) => `| row ${i + 1} | value ${i + 1} | ${i * 3} |`).join('\n');

interface Case {
  label: string;
  md: string;
  values?: Record<string, unknown>;
}

const cases: Case[] = [
  { label: 'headings', md: '# H1 MKSTART\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6 MKEND\n' },
  { label: 'setext', md: 'Title Underline\n===\n\nSubtitle Underline\n---\n\nbody paragraph MKEND\n' },
  {
    label: 'emphasis',
    md: 'MKSTART **bold words** *italic words* ***both*** ~~struck~~ `inline code` and a _snake_case_word_ MKEND\n',
  },
  { label: 'hashtag', md: '#NoSpaceAfterHash\n\n# real heading MKEND\n' },
  { label: 'lists', md: '- MKSTART alpha\n- beta\n  - nested gamma\n    - deep delta\n- epsilon MKEND\n' },
  {
    label: 'ordered',
    md: 'MKSTART\n\n1. first\n2. second\n3. third\n\n1) one\n2) two\n3) three MKEND\n',
  },
  { label: 'tasks', md: '- [ ] MKSTART unchecked\n- [x] checked lower\n- [X] checked upper\n- incomplete bracket MKEND\n' },
  {
    label: 'numbering-tail',
    md: `MKSTART\n\n${Array.from({ length: 46 }, (_, i) => `${i + 1}. numbered item that is long enough to wrap a little`).join('\n')}\n\nMKEND\n`,
  },
  { label: 'table-align', md: '| Left | Center | Right |\n|:---|:---:|---:|\n| a MKSTART | b | c |\n| long text here | mid | 9 MKEND |\n' },
  { label: 'table-pipes', md: '| Cmd | Note |\n| --- | --- |\n| `a|b` MKSTART | escaped \\| pipe |\n| plain | last MKEND |\n' },
  { label: 'table-ragged', md: '| A | B | C |\n| --- | --- | --- |\n| 1 |\n| 1 | 2 | 3 | extra |\n\nMKEND\n' },
  { label: 'table-long', md: `| Name | Value | N |\n| --- | --- | --- |\n${LONG_ROWS}\n\nMKEND\n` },
  { label: 'ordered-start', md: 'MKSTART\n\n5. five\n6. six\n7. seven MKEND\n' },
  {
    label: 'deep-nest',
    md: 'MKSTART\n\n- level one alpha\n  - level two bravo\n    - level three charlie\n      - level four delta\n- level one echo MKEND\n',
  },
  { label: 'fence-script', md: 'MKSTART\n\n```html\n<script>alert(1)</script>\n<br>\n<div>kept</div>\n```\n\nafter the fence MKEND\n' },
  { label: 'links', md: 'MKSTART see [the spec](https://example.com/spec.html) and [mailto](bob@example.com) plus <https://autolink.example/x> MKEND\n' },
  { label: 'images', md: `![a red pixel](${RED_PNG})\n\n![remote chart](https://example.com/chart.png)\n\nText with an ![inline pic](https://example.com/i.png) inside the sentence. MKEND\n` },
  { label: 'breaks', md: 'MKSTART line one with two trailing spaces  \nline two after the hard break<br>line three after a br tag MKEND\n' },
  { label: 'quote', md: '> MKSTART quoted first line\n> quoted second line\n>\n> > nested quote MKEND\n' },
  { label: 'rules', md: 'MKSTART above\n\n---\n\nbetween\n\n***\n\nbelow MKEND\n' },
  { label: 'math', md: 'MKSTART inline $x^2 + y_1 = \\alpha$ maths and a block:\n\n$$\\frac{a}{b} = c$$\n\nand \\(x \\ne y\\) MKEND\n' },
  { label: 'footnotes', md: 'MKSTART a claim with a note[^1] and another[^b].\n\n[^1]: The first footnote text.\n[^b]: The second footnote text. MKEND\n' },
  { label: 'mermaid', md: 'MKSTART\n\n```mermaid\ngraph TD;\nA-->B;\n```\n\nend MKEND\n' },
  { label: 'entities', md: 'MKSTART amp &amp; copy &copy; dash &#8212; nbsp:&nbsp;end quote &quot; lt &lt; hex &#x41; MKEND\n' },
  { label: 'unicode-mix', md: 'MKSTART 日本語のテキスト 한국말 中文 café naïve 😀 𠀀 ‏right-left‎ ‮flip‬ MKEND\n' },
  { label: 'html-in-md', md: 'MKSTART <div class="box"><p>Div paragraph</p><script>var x = "<b>not printed?</b>";</script><style>p{color:red}</style></div>\n\nafter the html MKEND\n' },
  {
    label: 'front-matter',
    md: '---\ntitle: The Document\nauthor: Someone\n---\n\nMKSTART body after front matter MKEND\n',
  },
  { label: 'code-blocks', md: 'MKSTART\n\n```js\nconst a = 1;\nfunction b() {\n  return a;  // indented two columns\n}\n```\n\n    indented code block\n    second line MKEND\n' },
  {
    label: 'controls-large',
    md: '# Heading MKSTART\n\nBody paragraph, long enough to wrap onto a second line of its own when it reaches the margin of the page.\n\n- first bullet\n- second bullet\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nMKEND\n',
    values: { fontSize: 18, lineHeight: 2.2, pageNumbers: true, header: 'HEADER TEXT MKH', footer: 'FOOTER TEXT MKF' },
  },
  {
    label: 'controls-small',
    md: '# Heading MKSTART\n\nBody paragraph, long enough to wrap onto a second line of its own when it reaches the margin of the page.\n\n- first bullet\n- second bullet\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nMKEND\n',
    values: { fontSize: 8, lineHeight: 1.1, pageNumbers: false, header: '', footer: '' },
  },
  {
    label: 'controls-columns',
    md: `MKSTART\n\n${Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: body text long enough to need several lines in a narrow column before it reaches the margin.`).join('\n\n')}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nMKEND\n`,
    values: { columns: 2 },
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
    // A `data:` image is decoded through `fetch` in this app; keep those out of the
    // record so the network column means "requests that could leave the device".
    if (!url.startsWith('data:')) fetched.push(url);
    return inner(input as never);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = inner;
  restoreConvertToEnv();
});

describe('markdown structure', () => {
  it('writes one PDF per fixture with what the run said', { timeout: 300_000 }, async () => {
    for (const testCase of cases) {
      fetched = [];
      let message = '';
      let warnings: string[] = [];
      let bytes = new Uint8Array(0);
      try {
        const outcome = await run('markdown-to-pdf', testCase.values ?? {}, [fileFrom(testCase.md, 'doc.md', 'text/markdown')]);
        bytes = await firstPdf(outcome);
        message = String(outcome.message);
        warnings = outcome.warnings ?? [];
      } catch (error) {
        message = `REFUSED: ${(error as Error).message}`;
      }
      const record: Record<string, unknown> = { label: testCase.label, values: testCase.values ?? {}, message, warnings, fetched: [...fetched] };
      if (bytes.length > 0) {
        writeFileSync(`${DIR}/${testCase.label}.pdf`, bytes);
        const [runs, sizes] = [await textRuns(bytes), await pageSizes(bytes)];
        record.sheets = sizes.length;
        record.streamRuns = runs.length;
        record.runsOutsideBox = runs.filter((run) => {
          const [w, h] = sizes[run.page] ?? [595.28, 841.89];
          return run.x < 0 || run.y < 0 || run.x > w || run.y > h;
        }).length;
      }
      writeFileSync(`${DIR}/${testCase.label}.src.md`, testCase.md, 'utf8');
      writeFileSync(`${DIR}/${testCase.label}.json`, JSON.stringify(record, null, 2), 'utf8');
      // eslint-disable-next-line no-console -- the rig reports on stdout
      console.log(`${testCase.label.padEnd(17)} ${bytes.length ? `${String(record.sheets ?? '?').padStart(3)} sheets` : 'no file '} ${message.slice(0, 72)}`);
    }
  });
});
