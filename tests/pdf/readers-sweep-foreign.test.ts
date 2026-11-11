/**
 * The three reader-sweep rows that had never been measured, measured per shape.
 *
 * `docs/research/foreign-structure-audit.md` counted 13 readers that parse a structure
 * this app's own writer also produces and asked, of each, whether it had ever met a PDF
 * this repo did not write. `docs/research/reader-sweep-reconciliation.md` re-counted
 * that list against the code and found the residue: **three rows with no CI test and no
 * measured verdict at all** — `metadata.ts listFonts` / `listImages`, `sanitize.ts
 * inspectScript` / `stripScript`, and `signature.ts readSignatures`. This file is that
 * measurement, in the shape the attachments and readers passes used (foreign fixtures,
 * an outside column beside ours, one row per shape, negative controls pinned), plus the
 * four rows the audit measured by hand and never pinned.
 *
 * **Read before believing any claim here.** Every input is in `tests/fixtures/foreign/`
 * and was written outside this repo by `scripts/foreign-structure-fixtures.py`: MuPDF
 * 1.28.2 (PyMuPDF) writes the pages, faces and rasters; libqpdf 12.3.2 (pikepdf 10.9.1)
 * writes the resource layouts, the script actions and the `/Sig` dictionaries; OpenSSL
 * 3.6.5 generated the key pair and verifies every PKCS#7 (`openssl cms -verify`); the
 * PKCS#7 itself is assembled by `scripts/pdf_fixture_pkcs7.py` because nothing that can
 * *write* a signed PDF is installed here — **`qpdf`, `mutool`, veraPDF and Java are
 * absent**, and PyMuPDF 1.28.2 exposes no `sign_file`, so OpenSSL is the outside signer
 * and MuPDF/pypdf/poppler are the outside parsers. `census.json` holds each outside
 * answer for every file and is asserted against below, so a column in this file cannot
 * drift from the bytes the generator recorded. The fixtures are byte-reproducible
 * (`--check`: 28 files identical across two rebuilds in separate processes), and every
 * committed file is re-hashed against `MANIFEST.json` here.
 *
 * What the measurement found is written up in
 * `docs/research/reader-sweep-reconciliation.md`: two of the three rows are **broken on
 * shapes a foreign producer writes** — the resource inventories do not descend into a
 * Form XObject, and the script walk does not enter a `/Kids` JavaScript name tree — and
 * both are pinned as broken here rather than fixed, because this pass was the measuring.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFName } from '@maxwbh/pdf-lib';
import { openPDF, savePDF, type PDFDocument } from '@/lib/pdf/core/doc';
import { listFonts, listImages, readInfo, readXmp, metadataReport, infoDict } from '@/lib/pdf/core/metadata';
import { listLayers } from '@/lib/pdf/core/layers';
import { listAnnotations, annotationCount } from '@/lib/pdf/core/annotations';
import { listFormFields } from '@/lib/pdf/core/forms';
import { inspectScript, stripScript } from '@/lib/pdf/core/sanitize';
import { readSignatures } from '@/lib/pdf/core/signature';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/foreign');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const open = (name: string) =>
  openPDF(fixtureBytes(name), { updateMetadata: false, ignoreEncryption: true });

/** `/Foo` in the census, `Foo` in this app's answers. */
const bare = (value: string | null | undefined): string | null =>
  value === null || value === undefined ? null : value.replace(/^\//, '');

// ---------------------------------------------------------------------------
// The generator's records: what each file is, who wrote it, what they say
// ---------------------------------------------------------------------------

interface ManifestEntry {
  sha256: string;
  shape: string;
  producer: string;
}

interface CensusFont {
  page: number;
  key: string;
  via: string;
  referenced: boolean;
  subtype: string | null;
  baseFont: string | null;
  encoding: string | null;
  descendantSubtype?: string | null;
  descendantBaseFont?: string | null;
  fontFile: string | null;
}

interface CensusImage {
  page: number;
  key: string;
  via: string;
  referenced: boolean;
  width: number;
  height: number;
  bitsPerComponent: number;
  filter: string | null;
  colorSpace: string | null;
  bytes: number;
  xref: number | null;
}

interface CensusSignature {
  name: string;
  subFilter: string;
  byteRange: number[];
  byteRangeSpelled: string[];
  fileLength: number;
  spansAddUp: boolean;
  opensslVerifies: boolean;
  opensslError: string | null;
  opensslSignatureAlgorithm: string | null;
  derBytes: number;
  contentsHexChars: number;
  contentsWrapped: boolean;
  valueIsIndirect: boolean;
}

interface Census {
  intended: Record<string, unknown>;
  outside: Record<string, unknown>;
  outside_after_freeze: {
    pages: number;
    poppler_opens: boolean;
    poppler_javascript: string | null;
    qpdf_inventory?: { fonts: CensusFont[]; images: CensusImage[] };
    mupdf_resources?: { fonts: unknown[][][]; images: unknown[][][]; xobjects: unknown[][][] };
    qpdf_script_sites?: { entries: string[]; count: number; xfa: boolean };
    signatures?: {
      fields: CensusSignature[];
      perms: boolean;
      certificate: { subject: string | null; issuer: string | null; serial: string | null;
                     notBefore: string | null; notAfter: string | null };
    };
    ocgs?: number[];
    ocg_names?: string[];
    annots?: string[];
    widgets?: string[];
    title?: string | null;
    xmp?: number;
  };
}

const MANIFEST = JSON.parse(
  readFileSync(resolve(FIXTURES, 'MANIFEST.json'), 'utf8'),
) as Record<string, ManifestEntry>;

const CENSUS = JSON.parse(
  readFileSync(resolve(FIXTURES, 'census.json'), 'utf8'),
) as Record<string, Census>;

/** Every file this pass added, by family. */
const RESOURCE_FILES = [
  'resources-plain.pdf',
  'resources-inherited.pdf',
  'resources-xobject.pdf',
  'resources-shared.pdf',
  'resources-subset.pdf',
];

const SCRIPT_FILES = [
  'script-openaction-inline.pdf',
  'script-openaction-ref.pdf',
  'script-openaction-array.pdf',
  'script-js-key-only.pdf',
  'script-names-flat.pdf',
  'script-names-kids.pdf',
  'script-hosts-aa.pdf',
  'script-xfa.pdf',
];

const SIGNATURE_FILES = [
  'sig-detached.pdf',
  'sig-contents-wrapped.pdf',
  'sig-two-fields.pdf',
  'sig-perms.pdf',
  'sig-tampered.pdf',
];

/** The four rows the audit rig measured by hand but never asserted in CI. */
const ALREADY_MEASURED = ['layers.pdf', 'annotations.pdf', 'form.pdf', 'metadata.pdf'];

const NEW_FILES = [...RESOURCE_FILES, ...SCRIPT_FILES, ...SIGNATURE_FILES];

// ---------------------------------------------------------------------------
// The fixtures are the bytes the generator recorded
// ---------------------------------------------------------------------------

describe('the sweep\'s unmeasured fixtures are the bytes the generator recorded', () => {
  it('covers every new shape, and MANIFEST.json holds no other new file', () => {
    const recorded = Object.keys(MANIFEST).filter(
      (name) => name.startsWith('resources-') || name.startsWith('script-') || name.startsWith('sig-'),
    );
    expect(recorded.sort()).toEqual([...NEW_FILES].sort());
    const asserted = [...NEW_FILES, ...ALREADY_MEASURED].sort();
    for (const file of asserted) expect(MANIFEST[file]).toBeDefined();
  });

  it.each([...NEW_FILES, ...ALREADY_MEASURED])('%s still hashes to its recorded digest', (file) => {
    expect(sha256(fixtureBytes(file))).toBe(MANIFEST[file].sha256);
  });

  it('names a producer that is not this repo, for every new shape', () => {
    for (const file of NEW_FILES) {
      expect(MANIFEST[file].producer).toMatch(/MuPDF|libqpdf|pikepdf|OpenSSL|pypdf/);
      expect(MANIFEST[file].producer).not.toMatch(/pdf-lib/);
    }
  });

  it('is censused by the outside readers for every shape it asserts on', () => {
    for (const file of NEW_FILES) {
      const census = CENSUS[file];
      expect(census, `no census entry for ${file}`).toBeDefined();
      expect(census.outside_after_freeze.pages).toBe(3);
      // poppler is the parse witness here: a shape it cannot open is a made-up shape.
      expect(census.outside_after_freeze.poppler_opens).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Row 11 — `listFonts` / `listImages`, the inventories the `view-metadata` card prints
// ---------------------------------------------------------------------------

interface FontExpectation {
  name: string;
  type: string;
  embedded: boolean;
  subset?: string;
  encoding?: string | null;
}

interface ImageExpectation {
  width: number;
  height: number;
  bitsPerComponent: number;
  filter: string | null;
  colorSpace: string;
  bytes: number;
  pages: number[];
}

interface ResourceCase {
  file: string;
  shape: string;
  fonts: FontExpectation[];
  images: ImageExpectation[];
  /** Faces and rasters the outside readers count on a page this app's walk does not see. */
  misses: { via: string; names: string[]; images: number }[];
}

/** The three faces `doc_with_resources` draws with, as the file names them. */
const CFF_FACE: FontExpectation = {
  name: 'Fixture Sans Regular', type: 'Type0', embedded: true, encoding: 'Identity-H',
};
const HELVETICA: FontExpectation = {
  name: 'Helvetica', type: 'Type1', embedded: false, encoding: 'WinAnsiEncoding',
};
const NOTO_FACE: FontExpectation = {
  name: 'NotoSans-Regular', type: 'Type0', embedded: true, encoding: 'Identity-H',
};

const RAW_IMAGE: ImageExpectation = {
  width: 40, height: 24, bitsPerComponent: 8, filter: 'FlateDecode', colorSpace: 'ICCBased',
  bytes: 47, pages: [1],
};
const JPEG_IMAGE: ImageExpectation = {
  width: 40, height: 24, bitsPerComponent: 8, filter: 'DCTDecode', colorSpace: 'ICCBased',
  bytes: 619, pages: [1],
};

const acrossPages = (image: ImageExpectation, pages: number[]): ImageExpectation => ({
  ...image, pages,
});

const RESOURCE_CASES: ResourceCase[] = [
  {
    file: 'resources-plain.pdf',
    shape: 'every page names its own /Resources — the control',
    fonts: [CFF_FACE, HELVETICA, NOTO_FACE],
    images: [JPEG_IMAGE, RAW_IMAGE],
    misses: [],
  },
  {
    file: 'resources-inherited.pdf',
    shape: '/Resources on the /Pages node, none on the page (§7.7.3.3)',
    fonts: [CFF_FACE, HELVETICA, NOTO_FACE],
    images: [acrossPages(JPEG_IMAGE, [1, 2, 3]), acrossPages(RAW_IMAGE, [1, 2, 3])],
    misses: [],
  },
  {
    file: 'resources-xobject.pdf',
    shape: 'the page draws one Form XObject that carries the fonts and images',
    // Only what a page-level walk can see: Helvetica, which pages 2 and 3 name.
    fonts: [HELVETICA],
    images: [],
    misses: [{ via: 'form-xobject:/Fm0',
               names: ['Fixture Sans Regular', 'Helvetica', 'NotoSans-Regular'], images: 2 }],
  },
  {
    file: 'resources-shared.pdf',
    shape: 'three pages naming the same /Resources object — the deduplication case',
    fonts: [CFF_FACE, HELVETICA, NOTO_FACE],
    images: [acrossPages(JPEG_IMAGE, [1, 2, 3]), acrossPages(RAW_IMAGE, [1, 2, 3])],
    misses: [],
  },
  {
    file: 'resources-subset.pdf',
    shape: 'the two embedded faces renamed with a BCDFEE+/ABCDEA+ subsetting tag',
    fonts: [
      { ...CFF_FACE, name: 'ABCDEA+Fixture Sans Regular', subset: 'ABCDEA' },
      { ...NOTO_FACE, name: 'BCDFEE+NotoSans-Regular', subset: 'BCDFEE' },
      HELVETICA,
    ],
    images: [JPEG_IMAGE, RAW_IMAGE],
    misses: [],
  },
];

/** The outside inventory for a file, reduced the way `listFonts` presents it. */
const censusFonts = (file: string): FontExpectation[] => {
  const inventory = CENSUS[file].outside_after_freeze.qpdf_inventory?.fonts ?? [];
  const seen = new Map<string, FontExpectation>();
  for (const entry of inventory) {
    const name = bare(entry.descendantBaseFont ?? entry.baseFont) ?? 'unnamed';
    if (seen.has(name)) continue;
    const subset = /^([A-Z]{6})\+/.exec(name)?.[1];
    seen.set(name, {
      name,
      type: bare(entry.subtype) ?? 'unknown',
      embedded: entry.fontFile !== null,
      ...(subset ? { subset } : {}),
      encoding: bare(entry.encoding),
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
};

const censusImages = (file: string): ImageExpectation[] => {
  const inventory = CENSUS[file].outside_after_freeze.qpdf_inventory?.images ?? [];
  const seen = new Map<string, ImageExpectation>();
  for (const entry of inventory) {
    const key = `${entry.xref ?? `${entry.width}x${entry.height}:${entry.bytes}`}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.pages.includes(entry.page)) existing.pages.push(entry.page);
      continue;
    }
    seen.set(key, {
      width: entry.width,
      height: entry.height,
      bitsPerComponent: entry.bitsPerComponent || 1,
      filter: bare(entry.filter),
      colorSpace: bare(entry.colorSpace) ?? 'unknown',
      bytes: entry.bytes,
      pages: [entry.page],
    });
  }
  return [...seen.values()].sort((a, b) => b.bytes - a.bytes);
};

describe('listFonts / listImages, on files this repo did not write', () => {
  it.each(RESOURCE_CASES)('$shape — the inventory is what the readers that wrote it count', async ({
    file, fonts, images, misses,
  }) => {
    const doc = await open(file);
    expect(listFonts(doc)).toEqual(fonts);
    expect(listImages(doc)).toEqual(images);
    // A row that claims the walk sees everything must name what it does not: the
    // outside column carries the faces the app's page-level walk never reaches.
    for (const miss of misses) {
      const hidden = (CENSUS[file].outside_after_freeze.qpdf_inventory?.fonts ?? [])
        .filter((entry) => entry.via === miss.via);
      expect(hidden.map((entry) => bare(entry.descendantBaseFont ?? entry.baseFont)).sort())
        .toEqual(miss.names.sort());
      const hiddenImages = (CENSUS[file].outside_after_freeze.qpdf_inventory?.images ?? [])
        .filter((entry) => entry.via === miss.via);
      expect(new Set(hiddenImages.map((entry) => entry.xref)).size).toBe(miss.images);
    }
  });

  it('agrees with the outside inventory on every shape it claims to read whole', () => {
    for (const testCase of RESOURCE_CASES) {
      if (testCase.misses.length > 0) continue;
      // The `subset` row names the terminal face, which is the descendant's `/BaseFont`;
      // the outside column carries both spellings, so compare on that basis.
      const outside = censusFonts(testCase.file).map((font) => ({
        ...font, name: font.name.replace(/^\w{6}\+/, ''),
      }));
      const ours = testCase.fonts.map((font) => ({ ...font, name: font.name.replace(/^\w{6}\+/, '') }));
      expect(ours.map((font) => font.name).sort()).toEqual(outside.map((font) => font.name).sort());
      expect(censusImages(testCase.file)).toEqual(testCase.images);
    }
  });

  it('counts a Form XObject\'s faces and rasters in the census but not in this app', async () => {
    const file = 'resources-xobject.pdf';
    const doc = await open(file);
    const inventory = CENSUS[file].outside_after_freeze.qpdf_inventory;
    const hidden = (inventory?.fonts ?? []).filter((entry) => entry.via.startsWith('form-xobject'));
    const imagesViaForm = (inventory?.images ?? []).filter((entry) => entry.via.startsWith('form-xobject'));
    // libqpdf, reading the page's resources through the form object, finds three faces
    // and two rasters on sheet 1 — the page's own `/Resources` holds only the form.
    expect(hidden.map((entry) => bare(entry.descendantBaseFont ?? entry.baseFont)).sort())
      .toEqual(['Fixture Sans Regular', 'Helvetica', 'NotoSans-Regular']);
    expect(new Set(imagesViaForm.map((entry) => entry.xref))).toHaveLength(2);
    // MuPDF, a second implementation, agrees sheet 1 places them: its per-page lists
    // carry the same counts whether or not a form object sits in between.
    expect(CENSUS[file].outside_after_freeze.mupdf_resources?.fonts?.[0]).toHaveLength(3);
    expect(CENSUS[file].outside_after_freeze.mupdf_resources?.images?.[0]).toHaveLength(2);
    expect(CENSUS[file].outside_after_freeze.mupdf_resources?.xobjects?.[0]).toHaveLength(1);
    // This app sees the two images in no page at all, and one face — the Helvetica
    // pages 2 and 3 name directly, which is not the one sheet 1 draws with.
    expect(listFonts(doc).map((font) => font.name)).toEqual(['Helvetica']);
    expect(listImages(doc)).toEqual([]);
  });

  it('the view-metadata card prints the inventory, so the miss is what a user reads', async () => {
    const file = 'resources-xobject.pdf';
    const doc = await open(file);
    // `metadataReport` reads `/Info` through `infoDict`, which asks pdf-lib for a
    // `PDFDict` at a trailer key that is absent — and the fork throws instead of
    // answering undefined, even with `create` set. That is the open seam
    // `docs/research/foreign-structure-audit.md` names for `redact-pdf`; the inspect
    // card is its second user-visible consequence, so both halves are pinned.
    expect(() => metadataReport(doc, fixtureBytes(file))).toThrow(/PDFDict/);
    expect(() => infoDict(doc, true)).toThrow(/PDFDict/);
    // Give the document the one dictionary it was missing, by hand, and the card renders
    // — printing exactly what the two walks saw.
    doc.context.trailerInfo.Info = doc.context.register(PDFDict.withContext(doc.context));
    const sections = metadataReport(doc, fixtureBytes(file));
    const fonts = sections.find((section) => section.title === 'Fonts');
    const images = sections.find((section) => section.title === 'Images');
    expect(fonts?.rows.map((row) => row.label)).toEqual(['Helvetica']);
    // The card says there are no raster images at all in a file MuPDF draws two from.
    expect(images?.rows).toEqual([{ label: 'None', value: 'no raster images are embedded' }]);
  });

  it.each(RESOURCE_CASES)('%s: every resource pointer is an indirect reference', async ({ file }) => {
    // The shape that broke `collectNameTree` and `/PageLabels` was a reader that only
    // accepted one of "inline" and "reference". Both spellings are recorded here; the
    // committed files use references, so `resolve()` is exercised on every entry.
    const inventory = CENSUS[file].outside_after_freeze.qpdf_inventory;
    expect(inventory?.fonts.length ?? 0).toBeGreaterThan(0);
    for (const entry of [...(inventory?.fonts ?? []), ...(inventory?.images ?? [])]) {
      expect(entry.referenced).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Row 12 — `inspectScript` / `stripScript`, the walk behind `sanitize-pdf`
// ---------------------------------------------------------------------------

const CODES = {
  open: 'app.alert',
  page: 'this.syncDDE',
  annot: 'event.target.fillColor',
  field: 'event.value',
  named: 'console.clear',
  xfa: 'xfa.host.messageBox',
} as const;

interface ScriptCase {
  file: string;
  shape: string;
  present: number;
  places: string[];
  /** Every JS action the outside walk counts, however the file points at it. */
  outsideSites: number;
  /** poppler's own `pdfinfo` answer for the same bytes. */
  popplerSees: boolean;
  /** Planted code that survives `stripScript`, in the bytes it wrote. */
  survives: string[];
}

const SCRIPT_CASES: ScriptCase[] = [
  {
    file: 'script-openaction-inline.pdf',
    shape: 'catalogue /OpenAction with the action dictionary inline',
    present: 1, places: ['catalogue /OpenAction'], outsideSites: 1, popplerSees: true, survives: [],
  },
  {
    file: 'script-openaction-ref.pdf',
    shape: 'catalogue /OpenAction naming one action behind a reference',
    present: 1, places: ['catalogue /OpenAction'], outsideSites: 1, popplerSees: true, survives: [],
  },
  {
    file: 'script-openaction-array.pdf',
    shape: '/OpenAction naming two actions in one array entry',
    present: 1, places: ['catalogue /OpenAction'], outsideSites: 1, popplerSees: false, survives: [],
  },
  {
    file: 'script-js-key-only.pdf',
    shape: 'an action with /JS and no /S at all',
    present: 1, places: ['catalogue /OpenAction'], outsideSites: 1, popplerSees: false, survives: [],
  },
  {
    file: 'script-names-flat.pdf',
    shape: '/Names » /JavaScript as a flat /Names array, one value inline and one referenced',
    present: 1, places: ['the JavaScript name tree'], outsideSites: 2, popplerSees: true, survives: [],
  },
  {
    file: 'script-names-kids.pdf',
    shape: 'the same named scripts inside a /Kids + /Limits subtree — recorded as broken',
    present: 1,
    places: ['a dictionary in the file /JS'],
    outsideSites: 2,
    popplerSees: true,
    survives: [CODES.named],
  },
  {
    file: 'script-hosts-aa.pdf',
    shape: 'page /AA /O, annotation /AA /E, field /AA /K, field /A, and a field with neither',
    present: 4,
    places: [
      'page 1 /AA /O',
      'form field “totals” /AA /K',
      'form field “heading” /A',
      'the annotation on page 1 /AA /E',
    ],
    outsideSites: 4,
    popplerSees: true,
    survives: [],
  },
  {
    file: 'script-xfa.pdf',
    shape: 'an /AcroForm /XFA packet whose script lives in its own XML',
    present: 0,
    places: [],
    outsideSites: 0,
    popplerSees: false,
    survives: [CODES.xfa],
  },
];

/** Every printable string in a file, with each Flate stream inflated first. */
const visibleText = (input: Uint8Array): string => {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const latin = new TextDecoder('latin1').decode(input);
  let all = decoder.decode(input);
  const pattern = /stream\r?\n?/g;
  let match: RegExpExecArray | null = pattern.exec(latin);
  while (match) {
    const from = match.index + match[0].length;
    const to = latin.indexOf('endstream', from);
    const slice = input.subarray(from, to === -1 ? undefined : to);
    try {
      all += `\n${decoder.decode(inflateSync(slice))}`;
    } catch {
      // Not a deflate stream: its bytes are already inside `all`.
    }
    match = pattern.exec(latin);
  }
  return all;
};

describe('inspectScript / stripScript, on files this repo did not write', () => {
  it.each(SCRIPT_CASES)('$shape — the walk counts what the file runs', async ({
    file, present, places, survives,
  }) => {
    const doc = await open(file);
    const report = inspectScript(doc);
    expect(report.present).toBe(present);
    expect(report.places).toEqual(places);

    const stripped = stripScript(doc);
    expect(stripped.removed).toBe(present);
    expect(stripped.where).toEqual(places);

    const saved = await savePDF(doc, { useObjectStreams: false });
    // Re-asking the saved bytes is the module's own promise: one walk counts, the same
    // walk removes, so nothing it saw can still be in the file.
    const again = await openPDF(saved, { updateMetadata: false, ignoreEncryption: true });
    expect(inspectScript(again).present).toBe(0);
    const text = visibleText(saved);
    for (const code of survives) expect(text).toContain(code);
    for (const code of Object.values(CODES)) {
      if (!survives.includes(code)) expect(text, `${code} survived a strip that claimed it`).not.toContain(code);
    }
  });

  it('reports the XFA packet as out of reach, in words, on the XFA file', async () => {
    const doc = await open('script-xfa.pdf');
    expect(inspectScript(doc).unreachable).toContain('XFA');
  });

  it('is told by poppler which files run script, and by libqpdf where they live', () => {
    for (const testCase of SCRIPT_CASES) {
      const seen = CENSUS[testCase.file].outside_after_freeze.poppler_javascript === 'yes';
      expect(seen, `${testCase.file}: poppler's answer moved`).toBe(testCase.popplerSees);
      const outside = CENSUS[testCase.file].outside_after_freeze.qpdf_script_sites?.count ?? 0;
      expect(outside, `${testCase.file}: the outside walk moved`).toBe(testCase.outsideSites);
    }
    // `/Kids` subtrees: poppler walks the JavaScript name tree with its own code and
    // says the file runs script; the independent libqpdf walk counts two entry points.
    // This app names one, and it is not the tree.
    const kids = CENSUS['script-names-kids.pdf'];
    expect(kids.outside_after_freeze.poppler_javascript).toBe('yes');
    expect(kids.outside_after_freeze.qpdf_script_sites?.entries).toEqual([
      'javascript name tree entry Fold',
      'javascript name tree entry Startup',
    ]);
  });

  it('counts one entry per tree where the outside walk counts one per script', async () => {
    // Not a defect, a unit difference, pinned so the two columns are never confused:
    // the flat tree is one entry point holding two actions, and this app reports the
    // entry. The `/Kids` tree is the same two actions behind one entry it does not see.
    const flat = await open('script-names-flat.pdf');
    expect(inspectScript(flat).present).toBe(1);
    expect(CENSUS['script-names-flat.pdf'].outside_after_freeze.qpdf_script_sites?.count).toBe(2);
    const kids = await open('script-names-kids.pdf');
    expect(inspectScript(kids).present).toBeLessThan(
      CENSUS['script-names-kids.pdf'].outside_after_freeze.qpdf_script_sites?.count ?? 0,
    );
  });
});

// ---------------------------------------------------------------------------
// Row 13 — `readSignatures`, over a PKCS#7 this repo assembled and OpenSSL verified
// ---------------------------------------------------------------------------

interface SignatureCase {
  file: string;
  shape: string;
  /** `digestMatches` per field, in `/Fields` order. */
  digestMatches: boolean[];
  fieldNames: string[];
  /** Whether the `/ByteRange`'s last span is empty, i.e. a signature frozen in an earlier generation. */
  prefixOnly: boolean[];
}

const SIGNATURE_CASES: SignatureCase[] = [
  {
    file: 'sig-detached.pdf',
    shape: '/Sig with /V behind a reference and adbe.pkcs7.detached over the two spans',
    digestMatches: [true], fieldNames: ['Signature1'], prefixOnly: [false],
  },
  {
    file: 'sig-contents-wrapped.pdf',
    shape: 'the same, with the /Contents hex string wrapped across lines as Acrobat writes it',
    digestMatches: [true], fieldNames: ['Signature1'], prefixOnly: [false],
  },
  {
    file: 'sig-two-fields.pdf',
    shape: 'two /Sig fields: the first covers its own generation, the second the whole file',
    digestMatches: [true, true], fieldNames: ['Signature1', 'Signature2'], prefixOnly: [true, false],
  },
  {
    file: 'sig-perms.pdf',
    shape: 'a signed file that also declares /Perms /DocMDP with /P 1',
    digestMatches: [true], fieldNames: ['Signature1'], prefixOnly: [false],
  },
  {
    file: 'sig-tampered.pdf',
    shape: 'one byte of the field name changed after signing — the negative control',
    digestMatches: [false], fieldNames: ['Signature7'], prefixOnly: [false],
  },
];

describe('readSignatures, on a signature this repo did not sign', () => {
  it.each(SIGNATURE_CASES)('$shape — the verdict matches OpenSSL per field', async ({
    file, digestMatches, fieldNames, prefixOnly,
  }) => {
    const results = await readSignatures(fixtureBytes(file));
    expect(results.map((entry) => entry.fieldName)).toEqual(fieldNames);
    expect(results.map((entry) => entry.digestMatches)).toEqual(digestMatches);
    const census = CENSUS[file].outside_after_freeze.signatures;
    expect(census?.fields).toHaveLength(digestMatches.length);
    (census?.fields ?? []).forEach((entry, index) => {
      // This app's digest verdict is OpenSSL's verdict, field for field, and so is the
      // range it says it covered.
      expect(results[index].digestMatches).toBe(entry.opensslVerifies);
      expect(results[index].byteRange).toEqual(entry.byteRange);
      expect(results[index].byteRange?.[3] === 0).toBe(prefixOnly[index]);
      expect(results[index].digestAlgorithm).toBe('SHA-256');
      expect(entry.opensslSignatureAlgorithm).toBe(':sha256WithRSAEncryption');
    });
  });

  it('reads the identity out of the certificate, the way OpenSSL prints it', async () => {
    const results = await readSignatures(fixtureBytes('sig-detached.pdf'));
    const certificate = CENSUS['sig-detached.pdf'].outside_after_freeze.signatures?.certificate;
    expect(results[0].signer).toBe('Foreign Signer');
    expect(certificate?.subject).toContain('CN=Foreign Signer');
    expect(certificate?.issuer).toBe(certificate?.subject);
    expect(results[0].issuer).toBe('Foreign Signer');
    expect(results[0].notBefore?.toISOString()).toBe('2023-01-01T00:00:00.000Z');
    expect(results[0].notAfter?.toISOString()).toBe('2046-01-01T00:00:00.000Z');
    // The `signingTime` signed attribute, fixed in the fixture, not the clock.
    expect(results[0].signedAt?.toISOString()).toBe('2024-01-01T12:00:00.000Z');
  });

  it('takes the /Contents hex string in either layout, and reports the padded width it read', async () => {
    for (const [file, wrapped] of [['sig-detached.pdf', false], ['sig-contents-wrapped.pdf', true]] as const) {
      const census = CENSUS[file].outside_after_freeze.signatures?.fields[0];
      expect(census?.contentsWrapped).toBe(wrapped);
      expect(census?.contentsHexChars).toBe(4096);
      const results = await readSignatures(fixtureBytes(file));
      expect(results[0].error).toBeUndefined();
      expect(results[0].digestMatches).toBe(true);
    }
  });

  it('follows a /ByteRange whose last span is empty, and one that reaches the file end', async () => {
    const census = CENSUS['sig-two-fields.pdf'].outside_after_freeze.signatures?.fields;
    expect(census?.map((entry) => entry.byteRange.map((value) => value > 0))).toEqual([
      [false, true, true, false],
      [false, true, true, true],
    ]);
    const results = await readSignatures(fixtureBytes('sig-two-fields.pdf'));
    expect(results.every((entry) => entry.digestMatches)).toBe(true);
    expect(results[0].byteRange?.[3]).toBe(0);
  });

  it('says nothing about /Perms, so a doc-MDP lock is invisible in its answer', async () => {
    const census = CENSUS['sig-perms.pdf'].outside_after_freeze.signatures;
    expect(census?.perms).toBe(true);
    const results = await readSignatures(fixtureBytes('sig-perms.pdf'));
    // The signature itself verifies; the `/Perms /DocMDP /TransformParams << /P 1 >>`
    // that forbids any change after signing is not part of what the reader reports.
    expect(results[0].digestMatches).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/Perms|DocMDP|modification/i);
    const doc: PDFDocument = await open('sig-perms.pdf');
    const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
    expect(perms?.lookupMaybe(PDFName.of('DocMDP'), PDFDict)).toBeDefined();
  });

  it('reports the tampered file as failing, and names it by the byte that changed', async () => {
    const results = await readSignatures(fixtureBytes('sig-tampered.pdf'));
    expect(results[0].fieldName).toBe('Signature7');
    expect(results[0].digestMatches).toBe(false);
    expect(results[0].error).toBeUndefined();
    // The other four fixtures share this reader; only this one is refused by OpenSSL.
    const refused = Object.keys(CENSUS).filter(
      (name) => name.startsWith('sig-') && CENSUS[name].outside_after_freeze.signatures
        ?.fields.some((entry) => !entry.opensslVerifies),
    );
    expect(refused).toEqual(['sig-tampered.pdf']);
  });
});

// ---------------------------------------------------------------------------
// The four rows the audit rig measured by hand and never pinned in CI
// ---------------------------------------------------------------------------

describe('the rows the rig measured once, pinned to the census', () => {
  it('lists the two OCGs MuPDF wrote, on and off', async () => {
    const doc = await open('layers.pdf');
    const layers = listLayers(doc);
    expect(layers.map((layer) => ({ name: layer.name, on: layer.on }))).toEqual([
      { name: 'DrawnLayer', on: true },
      { name: 'HiddenLayer', on: false },
    ]);
    expect(CENSUS['layers.pdf'].outside_after_freeze.ocg_names).toEqual(['DrawnLayer', 'HiddenLayer']);
    expect(layers.map((layer) => layer.xref).sort()).toEqual(CENSUS['layers.pdf'].outside_after_freeze.ocgs);
  });

  it('lists every annotation, including the pop-up and the link MuPDF hides', async () => {
    const doc = await open('annotations.pdf');
    expect(listAnnotations(doc).map((entry) => entry.kind)).toEqual([
      'Text', 'Popup', 'FreeText', 'Highlight', 'Link',
    ]);
    expect(annotationCount(doc)).toBe(5);
    // The outside reader lists three: the difference is this walk's completeness, and it
    // is pinned so a future "match MuPDF" change cannot pass silently.
    expect(CENSUS['annotations.pdf'].outside_after_freeze.annots)
      .toEqual(['FreeText', 'Highlight', 'Text']);
  });

  it('reads the form MuPDF built, with its values', async () => {
    const doc = await open('form.pdf');
    const fields = listFormFields(doc);
    expect(fields.map((field) => ({ name: field.name, type: field.type }))).toEqual([
      { name: 'answer', type: 'text' },
      { name: 'tick', type: 'checkbox' },
    ]);
    expect(fields[1].checked).toBe(true);
    expect(CENSUS['form.pdf'].outside_after_freeze.widgets).toEqual(['answer', 'tick']);
  });

  it('reads /Info and the XMP packet another tool wrote', async () => {
    const doc = await open('metadata.pdf');
    const info = readInfo(doc);
    expect(info.title).toBe('Foreign structures');
    expect(info.author).toBe('PyMuPDF 1.28.2');
    const xmp = readXmp(doc);
    expect(xmp?.title).toBe('Foreign structures');
    expect(CENSUS['metadata.pdf'].outside_after_freeze.title).toBe('Foreign structures');
    // The census counts the packet's UTF-8 bytes; `raw.length` is characters.
    expect(new TextEncoder().encode(xmp?.raw ?? '').length)
      .toBe(CENSUS['metadata.pdf'].outside_after_freeze.xmp);
  });
});

/**
 * Optional dump for the reconciliation table: run with
 * `BROWSERSNIP_SWEEP_DUMP=/tmp/sweep npx vitest run tests/pdf/readers-sweep-foreign.test.ts`.
 */
describe('records what each shape produces, for the reconciliation table', () => {
  it('writes the app columns out when asked', async () => {
    const target = process.env.BROWSERSNIP_SWEEP_DUMP;
    if (!target) return;
    const dump: Record<string, unknown> = {};
    for (const file of RESOURCE_FILES) {
      const doc = await open(file);
      dump[file] = { fonts: listFonts(doc), images: listImages(doc) };
    }
    for (const file of SCRIPT_FILES) {
      const doc = await open(file);
      dump[file] = { report: inspectScript(doc) };
    }
    for (const file of SIGNATURE_FILES) {
      dump[file] = { signatures: await readSignatures(fixtureBytes(file)) };
    }
    writeFileSync(`${target}.json`, `${JSON.stringify(dump, null, 1)}\n`);
    expect(Object.keys(dump)).toHaveLength(NEW_FILES.length);
  });
});
