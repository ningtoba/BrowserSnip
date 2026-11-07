/**
 * The copy and contract invariants of the ~124 tool definitions.
 *
 * Every rule here is something a reader notices across two tools rather than
 * inside one: a missing `promise`, a primary action still labelled "Run", the
 * same number called `Resolution` in one rail and `Annotation quality` in
 * another, a page field that only some tools check against the document, or a
 * download name that falls apart on `发票 2024 draft.pdf`. Definitions are data,
 * so the rules are asserted as data instead of being reviewed by eye.
 *
 * What is *not* asserted here: that a promise is true. That is a code-reading
 * job (`docs/UX-BRIEF.md` "a promise the engine cannot keep is a bug, not
 * copy"); this file keeps the vocabulary, the bounds and the shape consistent.
 */
import { describe, expect, it } from 'vitest';
import { PDF_CATEGORIES, PDF_TOOLS } from '@/lib/pdf/tools/registry';
import { PAGES_FIELD_HELP, downloadName, resolutionField } from '@/lib/pdf/tools/helpers';
import { validateFields } from '@/lib/pdf/core/guard';
import { defaultValues, type PdfToolDefinition, type ToolField } from '@/lib/pdf/tools/types';

const tools = PDF_TOOLS;
const allFields = (list: PdfToolDefinition[] = tools) =>
  list.flatMap((tool) => (tool.fields ?? []).map((field) => ({ tool, field })));

/** Words that name one concept; a definition may not invent a fifth spelling. */
const CANONICAL_LABELS: Record<string, { label: string; unit?: string }> = {
  dpi: { label: 'Resolution', unit: 'dpi' },
  pages: { label: 'Pages' },
  opacity: { label: 'Opacity' },
  fontSize: { label: 'Font size', unit: 'pt' },
  color: { label: 'Colour' },
  margin: { label: 'Margin', unit: 'pt' },
  grayscale: { label: 'Greyscale' },
  landscape: { label: 'Landscape sheet' },
  gutter: { label: 'Gutter', unit: 'pt' },
  stripMetadata: { label: 'Remove metadata' },
  minRows: { label: 'Minimum rows' },
  pageSize: { label: 'Page size' },
  orientation: { label: 'Orientation' },
  position: { label: 'Position' },
  prefix: { label: 'Prefix' },
  suffix: { label: 'Suffix' },
  ownerPassword: { label: 'Owner password' },
  userPassword: { label: 'Open password' },
  allowPrinting: { label: 'Allow printing' },
  allowModifying: { label: 'Allow modifying' },
  allowCopying: { label: 'Allow copying text and images' },
  allowAnnotating: { label: 'Allow comments' },
  allowFillingForms: { label: 'Allow filling forms' },
  allowAccessibility: { label: 'Allow screen readers' },
  allowAssembling: { label: 'Allow page reorganisation' },
};

/** Terms that must never be the only word for a quality control. */
const BARE_QUALITY_LABELS = ['Quality', 'Resolution', 'Settings', 'Options', 'Advanced', 'Other'];

/** `actionLabel` is a verb. "Run" is what the panel fell back to for years. */
const GENERIC_ACTIONS = ['run', 'process', 'go', 'ok', 'submit', 'apply', 'execute', 'start'];

// The banned kind of note: a claim about the product rather than an admission
// about the output. "Free of charge" wording is fine in principle, but no
// offline tool needs to say it, and it is where marketing copy starts.
const MARKETING = /\b(powerful|seamless|blazing|lightning[- ]fast|ultimate|supercharge|delight|effortless|state-of-the-art|best[- ]in|100%|for free|free of charge)\b/i;

/** Verbs a primary action may start with — the panel must never say "Run". */
const ACTION_VERBS = new Set([
  'add', 'apply', 'build', 'change', 'clean', 'collate', 'compress', 'convert', 'create', 'crop',
  'delete', 'deskew', 'divide', 'extract', 'fill', 'flatten', 'generate', 'insert', 'invert',
  'lay', 'linearize', 'make', 'measure', 'merge', 'mix', 'number', 'optimize', 'outline', 'pack',
  'paint', 'place', 'print', 'protect', 'rasterize', 'recognise', 'recolour', 'redact', 'remove',
  'repair', 'report', 'reflow', 'resize', 'reverse', 'rotate', 'sanitize', 'save', 'scan', 'sign',
  'split', 'stamp', 'stitch', 'tabulate', 'timestamp', 'turn', 'typeset', 'unlock', 'update', 'validate',
  'attach', 'chunk', 'compare', 'export', 'overlay', 'read', 'render', 'adjust', 'straighten',
]);

/** Characters no filesystem or unzipped entry tolerates. */
const ILLEGAL_IN_A_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

const SOURCE_NAMES = [
  'Quarterly Report Q3.pdf',
  '发票 2024 draft.pdf',
  '  weird   name  .pdf',
  'a/b:c*?.pdf',
  'archive.tar.gz',
  'no-extension',
  '.pdf',
  'مرحبا.doc.pdf',
  'emoji-📄-file.pdf',
];

describe('tool promises and primary actions', () => {
  it('tells every tool what the user gets', () => {
    const missing = tools.filter((tool) => !tool.promise?.trim()).map((tool) => tool.id);
    expect(missing).toEqual([]);
  });

  it('phrases a promise as an output, not a restatement or a slogan', () => {
    const bad: string[] = [];
    for (const tool of tools) {
      const promise = (tool.promise ?? '').trim();
      if (promise === tool.description.trim()) bad.push(`${tool.id}: promise repeats the description`);
      if (!/[.!?]$/.test(promise)) bad.push(`${tool.id}: promise is not a sentence (${promise})`);
      if (promise.split(/\s+/).length < 6) bad.push(`${tool.id}: promise too thin (${promise})`);
      if (MARKETING.test(promise)) bad.push(`${tool.id}: promise sells rather than states (${promise})`);
      if (/\bwe\b|\bour\b/i.test(promise)) bad.push(`${tool.id}: promise speaks as the app (${promise})`);
    }
    expect(bad).toEqual([]);
  });

  it('gives every tool a verb for its primary action', () => {
    const missing = tools.filter((tool) => !tool.actionLabel?.trim()).map((tool) => tool.id);
    expect(missing).toEqual([]);
  });

  it('never leaves a primary action on the generic fallback', () => {
    const generic = tools
      .filter((tool) => GENERIC_ACTIONS.includes((tool.actionLabel ?? '').trim().toLowerCase()))
      .map((tool) => `${tool.id}:${tool.actionLabel}`);
    expect(generic).toEqual([]);
  });

  it('starts every action label with a verb, not with the noun it acts on', () => {
    const bad: string[] = [];
    for (const tool of tools) {
      const label = (tool.actionLabel ?? '').trim();
      if (label.endsWith('.')) bad.push(`${tool.id}: period on a button (${label})`);
      if (label.split(/\s+/).length > 4) bad.push(`${tool.id}: action label too long (${label})`);
      if (!/^[A-Z]/.test(label)) bad.push(`${tool.id}: action label not capitalised (${label})`);
      const first = label.split(/\s+/)[0].toLowerCase();
      if (!ACTION_VERBS.has(first)) bad.push(`${tool.id}: "${label}" does not start with a verb`);
    }
    expect(bad).toEqual([]);
  });
});

describe('field vocabulary', () => {
  it('names each shared concept the same way everywhere', () => {
    const wrong: string[] = [];
    for (const { tool, field } of allFields()) {
      const canon = CANONICAL_LABELS[field.key];
      if (!canon) continue;
      if (field.label !== canon.label) {
        wrong.push(`${tool.id}.${field.key}: "${field.label}" should be "${canon.label}"`);
      }
      if (canon.unit && field.unit !== canon.unit) {
        wrong.push(`${tool.id}.${field.key}: unit ${field.unit ?? 'missing'} should be ${canon.unit}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('never labels a control by the bare concept it belongs to', () => {
    const vague = allFields()
      .filter(({ field }) => BARE_QUALITY_LABELS.includes(field.label) && field.type !== 'segmented')
      .map(({ tool, field }) => `${tool.id}.${field.key}: "${field.label}"`);
    // `Quality` alone is meaningless next to `JPEG quality`; `Resolution` alone
    // is only allowed where the field really is the resolution slider.
    expect(vague.filter((entry) => !entry.endsWith(': "Resolution"'))).toEqual([]);
  });

  it('calls every format picker by one name', () => {
    const containers = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'gif', 'csv', 'json', 'md', 'svg']);
    const off = allFields()
      .filter(({ field }) => field.key === 'format')
      .filter(({ field }) => (field.options ?? []).some((option) => containers.has(String(option.value))))
      .filter(({ field }) => field.label !== 'File format')
      .map(({ tool, field }) => `${tool.id}.${field.key}: "${field.label}"`);
    expect(off).toEqual([]);
  });

  it('shows a unit on every field that carries one', () => {
    const hidden = allFields()
      // The rail prints `unit` beside a number or slider; a select, text or
      // colour field has nowhere for it to appear.
      .filter(({ field }) => field.unit && !['number', 'slider'].includes(field.type))
      .filter(({ field }) => !field.label.toLowerCase().includes(String(field.unit).toLowerCase()))
      .map(({ field, tool }) => `${tool.id}.${field.key}: "${field.label}" carries unit ${field.unit}`);
    expect(hidden).toEqual([]);
  });

  it('does not reuse one label for two options inside a tool', () => {
    const clashes: string[] = [];
    for (const tool of tools) {
      const byLabel = new Map<string, string[]>();
      for (const field of tool.fields ?? []) {
        const key = field.label.toLowerCase();
        byLabel.set(key, [...(byLabel.get(key) ?? []), field.key]);
      }
      for (const [label, keys] of byLabel) if (keys.length > 1) clashes.push(`${tool.id}: "${label}" on ${keys.join(', ')}`);
    }
    expect(clashes).toEqual([]);
  });

  it('does not use one label with two units inside a category', () => {
    const clashes: string[] = [];
    for (const category of PDF_CATEGORIES) {
      const byLabel = new Map<string, Set<string>>();
      for (const { field } of allFields(tools.filter((tool) => tool.category === category.id))) {
        byLabel.set(field.label.toLowerCase(), (byLabel.get(field.label.toLowerCase()) ?? new Set()).add(field.unit ?? ''));
      }
      for (const [label, units] of byLabel) {
        if (units.size > 1) clashes.push(`${category.id}: "${label}" is ${[...units].map((u) => u || 'unitless').join(' and ')}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('writes labels in sentence case without trailing punctuation', () => {
    const allowlisted = /\b(URIs|URI|PDF|PNG|JPG|JPEG|WebP|SVG|CSV|XMP|JSON|XML|HTML|RTF|DOCX|XLSX|PPTX|EPUB|MOBI|FB2|XPS|ODT|ODS|ODP|ODG|CBZ|ZIP|BMP|HEIC|PSD|AcroForm|XFA|OCG|A4|A3|A5|ISO|RFC|PKCS|PEM|LlamaIndex|Markdown|Word|Excel|PowerPoint|Pages|Publisher|Visio|WordPerfect|WPS|Bates|GPS|EXIF|URL|API|RAG|OCR|NUL|AES|RC4|DPI|Noto|Helvetica|Times|Courier|Web|OpenDocument|Kingsoft|Apple|Microsoft|Calibre|SRGB|sRGB|UTF)/;
    const bad: string[] = [];
    for (const { tool, field } of allFields()) {
      const label = field.label;
      if (/[.!?]$/.test(label)) bad.push(`${tool.id}.${field.key}: "${label}" ends in punctuation`);
      if (/^\s|\s$/.test(label)) bad.push(`${tool.id}.${field.key}: "${label}" has stray spaces`);
      const words = label.split(/\s+/);
      const offenders = words.slice(1).filter((word) => /^[A-Z]{2,}/.test(word) && !allowlisted.test(word));
      if (offenders.length > 0) bad.push(`${tool.id}.${field.key}: "${label}" shouts ${offenders.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('puts every field in a rail section', () => {
    const orphaned = allFields()
      .filter(({ field }) => !field.group?.trim())
      .map(({ tool, field }) => `${tool.id}.${field.key}`);
    expect(orphaned).toEqual([]);
  });

  it('gives each option a group that reads as a section, not a wall', () => {
    // A long panel must break into headings; a four-option panel that is
    // genuinely one question ("how should this file be cut?") may stay as one.
    const flat = tools
      .filter((tool) => (tool.fields?.length ?? 0) > 5)
      .filter((tool) => new Set((tool.fields ?? []).map((field) => field.group)).size < 2)
      .map((tool) => `${tool.id} (${tool.fields?.length} fields, ${new Set((tool.fields ?? []).map((f) => f.group)).size} group)`);
    expect(flat).toEqual([]);
  });

  it('explains a consequence in help, or says nothing', () => {
    const bad: string[] = [];
    for (const { tool, field } of allFields()) {
      const help = field.help?.trim();
      if (!help) continue;
      if (help.toLowerCase().replace(/[^a-z]/g, '') === field.label.toLowerCase().replace(/[^a-z]/g, '')) {
        bad.push(`${tool.id}.${field.key}: help restates the label`);
      }
      if (help.startsWith(field.label)) bad.push(`${tool.id}.${field.key}: help starts by repeating the label`);
      if (/\n/.test(help)) bad.push(`${tool.id}.${field.key}: help is not one line`);
      if (help.length > 220) bad.push(`${tool.id}.${field.key}: help is a paragraph`);
      if (/\bclick the button below\b/i.test(help)) bad.push(`${tool.id}.${field.key}: help points at chrome`);
    }
    expect(bad).toEqual([]);
  });
});

describe('page selection is one control with one promise', () => {
  it('uses the shared pages field everywhere a document is picked', () => {
    const off = allFields()
      .filter(({ field }) => field.type === 'pages')
      .filter(({ field }) => field.label !== 'Pages' || field.help !== PAGES_FIELD_HELP)
      .map(({ tool, field }) => `${tool.id}.${field.key}: "${field.label}" / ${field.help}`);
    expect(off).toEqual([]);
  });

  it('lets the rail refuse a page outside the document, for every tool that asks', () => {
    // E15/E6: the guard checks a `pages` field against `pageTotal`, which the
    // rail fills from the open file. A tool that opts out of the shared field
    // shape loses that check, so it is asserted through the real validator.
    const unguarded = tools.filter((tool) => {
      const field = (tool.fields ?? []).find((candidate) => candidate.type === 'pages');
      if (!field) return false;
      const values = { ...defaultValues(tool.fields), [field.key]: '9999', pageTotal: 3 };
      return !validateFields(tool.fields, values).some((issue) => issue.code === 'BAD_PAGE_RANGE');
    }).map((tool) => tool.id);
    expect(unguarded).toEqual([]);
  });

  it('defaults a page selection to the whole document unless it is a placement tool', () => {
    // `add-stamps` starts on page 1 because the pane is about clicking a page;
    // anything else that defaults narrower is an accident waiting to happen.
    const exceptions = ['add-stamps'];
    const narrow = allFields()
      .filter(({ field }) => field.type === 'pages')
      .filter(({ tool, field }) => field.default !== 'all' && !exceptions.includes(tool.id))
      .map(({ tool, field }) => `${tool.id}.${field.key}: ${JSON.stringify(field.default)}`);
    expect(narrow).toEqual([]);
  });
});

describe('numbers declare their bounds before the click (E15)', () => {
  it('gives every numeric field a min, a max and a step', () => {
    const unbounded = allFields()
      .filter(({ field }) => field.type === 'number' || field.type === 'slider')
      .filter(({ field }) => field.min === undefined || field.max === undefined || field.step === undefined)
      .map(({ tool, field }) => {
        const missing = [
          field.min === undefined ? 'min' : '',
          field.max === undefined ? 'max' : '',
          field.step === undefined ? 'step' : '',
        ].filter(Boolean);
        return `${tool.id}.${field.key} is missing ${missing.join(', ')}`;
      });
    expect(unbounded).toEqual([]);
  });

  it('declares bounds that are usable, and a default inside them', () => {
    const wrong: string[] = [];
    for (const { tool, field } of allFields()) {
      if (field.type !== 'number' && field.type !== 'slider') continue;
      if (field.min !== undefined && field.max !== undefined && field.min >= field.max) {
        wrong.push(`${tool.id}.${field.key}: min ${field.min} is not below max ${field.max}`);
      }
      if (field.step !== undefined && field.step <= 0) wrong.push(`${tool.id}.${field.key}: step ${field.step}`);
      if (typeof field.default === 'number' && field.min !== undefined && field.max !== undefined) {
        if (field.default < field.min || field.default > field.max) {
          wrong.push(`${tool.id}.${field.key}: default ${field.default} is outside ${field.min}-${field.max}`);
        }
      }
      if (field.integer && field.step !== undefined && !Number.isInteger(field.step)) {
        wrong.push(`${tool.id}.${field.key}: integer field with a ${field.step} step`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('declares bounds only where there is a number to bound', () => {
    const stray = allFields()
      .filter(({ field }) => field.type !== 'number' && field.type !== 'slider')
      .filter(({ field }) => field.min !== undefined || field.max !== undefined || field.step !== undefined)
      .map(({ tool, field }) => `${tool.id}.${field.key} (${field.type})`);
    expect(stray).toEqual([]);
  });

  it('renders a resolution the same way whether it is shared or declared inline', () => {
    // The factory is the single spelling of "how many pixels per point"; an
    // inline copy must not drift away from it.
    const shared = resolutionField();
    const off = allFields()
      .filter(({ field }) => field.key === 'dpi')
      .filter((entry) => entry.field.label !== shared.label || entry.field.unit !== shared.unit)
      .map(({ tool, field }) => `${tool.id}.${field.key}: "${field.label}" (${field.unit ?? 'no unit'})`);
    expect(off).toEqual([]);
  });
});

describe('notes are disclosures, not copy', () => {
  it('never uses a note to sell the tool', () => {
    const bad: string[] = [];
    for (const tool of tools) {
      for (const note of tool.notes ?? []) {
        if (MARKETING.test(note)) bad.push(`${tool.id}: "${note}"`);
        if (note.trim().length < 30) bad.push(`${tool.id}: note is a fragment ("${note}")`);
        if (!/[.!?]$/.test(note.trim())) bad.push(`${tool.id}: note is not a sentence ("${note}")`);
        if (/undefined|NaN|\[object/.test(note)) bad.push(`${tool.id}: note leaks a value ("${note}")`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('admits an optional engine in the notes, not only in the log pane', () => {
    const quiet = tools
      .filter((tool) => (tool.engines ?? []).length > 0)
      .filter((tool) => !(tool.notes ?? []).some((note) => /CDN|engine|Ghostscript|CoherentPDF|PyMuPDF|unreachable|cannot be reached|offline/i.test(note)))
      .map((tool) => tool.id);
    expect(quiet).toEqual([]);
  });

  it('names what a container or a degraded path costs, wherever a tool needs one', () => {
    // Tools whose whole output is a container (zip/cbz) or a picture must say
    // what the user gives up; that is a `notes` job, not a `promise` job.
    const containerish = tools.filter((tool) => /\.(zip|cbz)$/.test(tool.outputSuffix));
    for (const tool of containerish) {
      expect(
        (tool.notes ?? []).some((note) => /archive|ZIP|container|stored|extract/i.test(note)),
        `${tool.id} ships a container without saying so`,
      ).toBe(true);
    }
    const rasterish = tools.filter((tool) => /image|cbz|rasteriz|scan|poster/i.test(`${tool.id} ${tool.name}`));
    for (const tool of rasterish) {
      expect(
        (tool.notes ?? []).some((note) => /selectable|search|text layer|picture|image/i.test(note)),
        `${tool.id} rasterises without admitting it`,
      ).toBe(true);
    }
  });
});

describe('output names survive real file names (E17)', () => {
  it('declares a suffix for every tool', () => {
    expect(tools.filter((tool) => !tool.outputSuffix).map((tool) => tool.id)).toEqual([]);
  });

  it('builds a usable download name from every kind of source name', () => {
    const bad: string[] = [];
    for (const tool of tools) {
      for (const source of SOURCE_NAMES) {
        const name = downloadName(source, tool.outputSuffix);
        if (ILLEGAL_IN_A_NAME.test(name)) bad.push(`${tool.id}: "${name}" from "${source}"`);
        if (/\s$|\.$/.test(name)) bad.push(`${tool.id}: "${name}" ends in a space or dot`);
        if (/^[-._ ]/.test(name)) bad.push(`${tool.id}: "${name}" starts with a separator`);
        if (/\.pdf\.pdf$/i.test(name)) bad.push(`${tool.id}: "${name}" doubles the extension`);
        if (/\s{2,}/.test(name)) bad.push(`${tool.id}: "${name}" keeps a run of spaces`);
        if (name.length > 160) bad.push(`${tool.id}: "${name}" is ${name.length} characters`);
        if (source.includes('发票') && !name.includes('发票')) bad.push(`${tool.id}: "${name}" dropped the unicode stem`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps multi-file downloads distinct', () => {
    const collision = tools
      .filter((tool) => !tool.outputSuffix.startsWith('.'))
      .map((tool) => [tool.id, new Set([0, 1, 2].map((i) => downloadName('report.pdf', tool.outputSuffix, i, 3)))])
      .filter((entry) => (entry[1] as Set<string>).size !== 3)
      .map((entry) => entry[0]);
    expect(collision).toEqual([]);
  });

  it('names a fragment so the stem still reads as the user’s file', () => {
    expect(downloadName('Quarterly Report Q3.pdf', '_merged.pdf')).toBe('Quarterly Report Q3_merged.pdf');
    expect(downloadName('发票 2024 draft.pdf', '_split')).toBe('发票 2024 draft_split');
    expect(downloadName('a/b:c*?.pdf', '.zip')).toBe('a-b-c.zip');
    expect(downloadName('archive.tar.gz', '.pdf')).toBe('archive.tar.pdf');
    expect(downloadName('  weird   name  .pdf', '_edited.pdf')).toBe('weird name_edited.pdf');
    expect(downloadName('no-extension', '_rotated.pdf')).toBe('no-extension_rotated.pdf');
  });
});

describe('the catalogue as a whole', () => {
  it('is large enough that these checks mean anything', () => {
    expect(tools.length).toBeGreaterThan(100);
  });

  it('describes every tool in a sentence a user could act on', () => {
    const thin = tools
      .filter((tool) => tool.description.trim().split(/\s+/).length < 5)
      .map((tool) => tool.id);
    expect(thin).toEqual([]);
  });

  it('names a resolution in words a user reads, not in the unit', () => {
    // `dpi` is the internal name of the field; the rail prints the unit beside
    // the number, so a label of "300 dpi" or "Max dpi" duplicates it twice.
    const wrong = allFields()
      .filter(({ field }) => /\b(dpi|ppi|px|pt)\b/i.test(field.label))
      .map(({ tool, field }) => `${tool.id}.${field.key}: "${field.label}"`);
    expect(wrong).toEqual([]);
  });
});
